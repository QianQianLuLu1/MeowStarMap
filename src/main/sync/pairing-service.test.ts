import { describe, it, expect } from 'vitest'
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'

/**
 * PairingService 单元测试 —— 一次性令牌 / QR 内容 / 设备入库全流程。
 *
 * 注入假会话仓储 + 假设备仓储 + 真实 Ed25519 身份；过期场景经注入时钟实现。
 * 编号对应 docs/sync-integration/03-auth-pairing-plan.md §10（T3），
 * 场景映射验收标准：全流程通过 / 过期令牌拒绝 / 已用令牌拒绝。
 */

import { PairingService, PairingError } from './pairing-service'
import type { PairRequest } from '../../shared/sync/protocol'
import type { UpsertPairDeviceInput } from '../database/sync-metadata-repository'
import type { PairingSessionsRepo } from './pairing-service'
import type { PairingIdentityProvider } from './pairing-service'

const NOW = 1_700_000_000_000
const SERVER_ID = 'wxnn-test0000000000'
const SERVER_NAME = 'WXNN XiangCe'
const TLS_FINGERPRINT = 'a'.repeat(64)

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

// ============================================================================
// 假仓储（语义与 SyncPairingRepository / SyncMetadataRepository 对齐）
// ============================================================================

interface FakeSessionRow {
  serverId: string
  expiresAt: string
  usedAt: string | null
}

class FakeSessionsRepo implements PairingSessionsRepo {
  rows = new Map<string, FakeSessionRow>()

  async createSession(input: {
    tokenHash: string
    serverId: string
    expiresAt: string
  }): Promise<void> {
    this.rows.set(input.tokenHash, {
      serverId: input.serverId,
      expiresAt: input.expiresAt,
      usedAt: null
    })
  }

  async consumeSession(
    tokenHash: string,
    nowIso: string
  ): Promise<'ok' | 'missing' | 'used' | 'expired'> {
    const row = this.rows.get(tokenHash)
    if (!row) return 'missing'
    if (row.usedAt !== null) return 'used'
    if (row.expiresAt <= nowIso) return 'expired'
    row.usedAt = nowIso
    return 'ok'
  }

  /** 测试断言用：令牌是否已被消费 */
  isConsumed(tokenHash: string): boolean {
    return this.rows.get(tokenHash)?.usedAt !== null && this.rows.get(tokenHash) !== undefined
  }
}

interface FakeDeviceRow extends UpsertPairDeviceInput {
  revoked_at: string | null
}

class FakeDevicesRepo {
  rows = new Map<string, FakeDeviceRow>()
  identity = { serverId: SERVER_ID, serverName: SERVER_NAME }

  async ensureServerIdentity(): Promise<{ serverId: string; serverName: string }> {
    return this.identity
  }

  async upsertPairDevice(input: UpsertPairDeviceInput): Promise<void> {
    // 真实 UPSERT（INSERT OR REPLACE ... revoked_at=NULL）语义：重配对清撤销
    this.rows.set(input.deviceId, { ...input, revoked_at: null })
  }

  /** 测试夹具：模拟 revokeDevice 置位撤销 */
  revoke(deviceId: string): void {
    const row = this.rows.get(deviceId)
    if (row) row.revoked_at = iso(NOW)
  }
}

function makeIdentityStub() {
  const pair = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
  const provider: PairingIdentityProvider = {
    getOrCreateTlsIdentity: () => ({
      keyPem: 'key',
      certPem: 'cert',
      fingerprintSha256: TLS_FINGERPRINT,
      createdAt: iso(NOW)
    }),
    getOrCreateServerIdentity: () => ({
      publicKeyPem: pair.publicKey,
      privateKeyPem: pair.privateKey
    })
  }
  return { provider, publicKeyPem: pair.publicKey, privateKeyPem: pair.privateKey }
}

// ============================================================================
// 装配
// ============================================================================

function makeService(clock: number = NOW) {
  const sessions = new FakeSessionsRepo()
  const devices = new FakeDevicesRepo()
  const identity = makeIdentityStub()
  const service = new PairingService({
    sessions,
    devices,
    identity: identity.provider,
    now: () => clock
  })
  return { service, sessions, devices, ...identity }
}

function makePairRequest(
  overrides: Partial<PairRequest['device']> = {},
  pairingToken = 'token'
): PairRequest {
  const key = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
  return {
    pairingToken,
    device: {
      deviceId: 'android_0123456789abcdef0123456789abcdef',
      deviceName: 'Pixel Test',
      platform: 'android',
      publicKey: key.publicKey,
      appVersion: '1.2.3',
      ...overrides
    }
  }
}

async function expectPairingError(
  promise: Promise<unknown>,
  code: PairingError['code']
): Promise<void> {
  try {
    await promise
    expect.fail(`应抛出 PairingError(${code})`)
  } catch (err) {
    expect(err).toBeInstanceOf(PairingError)
    expect((err as PairingError).code).toBe(code)
  }
}

// ============================================================================
// 令牌生成与 QR 内容
// ============================================================================

describe('PairingService.createPairingToken', () => {
  it('返回 24 字节 base64url 令牌与 TTL 5 分钟的过期时间，仓储只存 sha256', async () => {
    const { service, sessions } = makeService()
    const { token, expiresAt, serverId } = await service.createPairingToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(expiresAt).toBe(iso(NOW + 5 * 60_000))
    expect(serverId).toBe(SERVER_ID)
    const stored = sessions.rows.get(sha256Hex(token))
    expect(stored).toBeTruthy()
    expect(stored!.usedAt).toBeNull()
    // 原始令牌明文不落库
    expect(JSON.stringify([...sessions.rows.keys()])).not.toContain(token)
  })

  it('自定义 ttlMs 生效', async () => {
    const { service, sessions } = makeService()
    await service.createPairingToken({ ttlMs: 60_000 })
    const [row] = [...sessions.rows.values()]
    expect(row!.expiresAt).toBe(iso(NOW + 60_000))
  })
})

describe('PairingService.buildPairingQrContent', () => {
  it('生成 NS1 七段二维码内容（与客户端 PairingUri 解析格式逐字对齐）', async () => {
    const { service } = makeService()
    const offer = await service.buildPairingQrContent({ host: '192.168.1.5', port: 8787 })
    const segments = offer.content.split('|')
    expect(segments).toHaveLength(7)
    expect(segments[0]).toBe('NS1')
    expect(segments[1]).toBe(SERVER_ID)
    expect(segments[2]).toBe('192.168.1.5')
    expect(segments[3]).toBe('8787')
    expect(segments[4]).toBe(offer.token)
    expect(segments[5]).toBe(String(Math.floor(Date.parse(offer.expiresAt) / 1000)))
    expect(segments[6]).toBe(TLS_FINGERPRINT)
    expect(segments[6]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('buildPairingUri（协议层）可原样解析回 payload', async () => {
    const { service } = makeService()
    const offer = await service.buildPairingQrContent({ host: '10.0.0.2', port: 443 })
    // 协议层 buildPairingUri 的输出形状：NS1|serverId|host|port|token|expiresEpochSec|fingerprint
    expect(offer.content).toContain(`NS1|${offer.serverId}|10.0.0.2|443|${offer.token}|`)
  })

  it('非法 host / port 拒绝（与客户端 PairingUri 校验对齐）', async () => {
    const { service } = makeService()
    await expect(service.buildPairingQrContent({ host: '', port: 8787 })).rejects.toThrow()
    await expect(service.buildPairingQrContent({ host: '192.168.1.5', port: 0 })).rejects.toThrow()
    await expect(
      service.buildPairingQrContent({ host: '192.168.1.5', port: 70000 })
    ).rejects.toThrow()
    await expect(
      service.buildPairingQrContent({ host: '192.168.1.5', port: 8787.5 })
    ).rejects.toThrow()
  })
})

// ============================================================================
// 兑换（redeemToken）
// ============================================================================

describe('PairingService.redeemToken — 全流程', () => {
  it('生成令牌 → 兑换 → 设备入库（公钥原串 / credential 只存哈希 / 未撤销）', async () => {
    const { service, sessions, devices } = makeService()
    const offer = await service.buildPairingQrContent({ host: '192.168.1.5', port: 8787 })
    const request = makePairRequest({}, offer.token)
    const response = await service.redeemToken(request)

    expect(response.serverId).toBe(SERVER_ID)
    expect(response.serverName).toBe(SERVER_NAME)
    expect(response.serverPublicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/)
    expect(response.protocolVersion).toBe(1)
    expect(response.deviceCredential).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 字节 base64url

    const row = devices.rows.get(request.device.deviceId)
    expect(row).toBeTruthy()
    expect(row!.publicKey).toBe(request.device.publicKey)
    expect(row!.deviceName).toBe(request.device.deviceName)
    expect(row!.platform).toBe('android')
    expect(row!.credentialHash).toBe(sha256Hex(response.deviceCredential))
    expect(row!.revoked_at).toBeNull()
    // 响应与 QR 的 serverId 一致
    expect(offer.serverId).toBe(SERVER_ID)
    // 令牌已消费
    expect(sessions.isConsumed(sha256Hex(offer.token))).toBe(true)
  })

  it('serverPublicKey 为服务端 Ed25519 公钥 PEM 且可解析', async () => {
    const { service, publicKeyPem } = makeService()
    const response = await service.redeemToken(
      makePairRequest({}, (await service.createPairingToken()).token)
    )
    expect(response.serverPublicKey).toBe(publicKeyPem)
    expect(() => createPublicKey(response.serverPublicKey)).not.toThrow()
  })
})

describe('PairingService.redeemToken — 拒绝场景', () => {
  it('过期令牌拒绝（pairing_expired），且令牌保持未消费语义', async () => {
    const first = makeService(NOW)
    const offer = await first.service.buildPairingQrContent({ host: 'h', port: 1 })
    // 10 分钟后（TTL 5 分钟已过）的另一服务实例共享同一仓储
    const later = new PairingService({
      sessions: first.sessions,
      devices: first.devices,
      identity: first.provider,
      now: () => NOW + 10 * 60_000
    })
    await expectPairingError(later.redeemToken(makePairRequest({}, offer.token)), 'pairing_expired')
  })

  it('已使用令牌拒绝（pairing_invalid）', async () => {
    const { service } = makeService()
    const { token } = await service.createPairingToken()
    await service.redeemToken(makePairRequest({}, token))
    // 新设备 + 同令牌
    await expectPairingError(
      service.redeemToken(makePairRequest({ deviceId: 'android_fff' }, token)),
      'pairing_invalid'
    )
  })

  it('未知令牌拒绝（pairing_invalid）', async () => {
    const { service } = makeService()
    await expectPairingError(
      service.redeemToken(makePairRequest({}, 'no-such-token')),
      'pairing_invalid'
    )
  })

  it('请求体非法拒绝（bad_request）且令牌未被消费（可重试）', async () => {
    const { service, sessions } = makeService()
    const { token } = await service.createPairingToken()
    const tokenHash = sha256Hex(token)

    await expectPairingError(
      service.redeemToken(makePairRequest({ platform: 'windows' as 'android' }, token)),
      'bad_request'
    )
    expect(sessions.isConsumed(tokenHash)).toBe(false)

    await expectPairingError(
      service.redeemToken(makePairRequest({ publicKey: 'not-a-key' }, token)),
      'bad_request'
    )
    await expectPairingError(
      service.redeemToken(makePairRequest({ deviceId: '' }, token)),
      'bad_request'
    )
    await expectPairingError(
      service.redeemToken(makePairRequest({ deviceName: '' }, token)),
      'bad_request'
    )
    await expectPairingError(service.redeemToken(makePairRequest({}, '')), 'bad_request')
    expect(sessions.isConsumed(tokenHash)).toBe(false)
    // 修正后同一令牌仍可正常兑换
    await expect(service.redeemToken(makePairRequest({}, token))).resolves.toMatchObject({
      serverId: SERVER_ID
    })
  })
})

describe('PairingService.redeemToken — 重复配对', () => {
  it('同 deviceId 重新配对换钥并清除撤销态', async () => {
    const { service, devices } = makeService()
    const first = makePairRequest({}, (await service.createPairingToken()).token)
    await service.redeemToken(first)
    devices.revoke(first.device.deviceId)
    expect(devices.rows.get(first.device.deviceId)!.revoked_at).not.toBeNull()

    const second = makePairRequest(
      { deviceId: first.device.deviceId, deviceName: 'Renamed Phone' },
      (await service.createPairingToken()).token
    )
    await service.redeemToken(second)
    const row = devices.rows.get(first.device.deviceId)!
    expect(row.publicKey).toBe(second.device.publicKey)
    expect(row.publicKey).not.toBe(first.device.publicKey)
    expect(row.deviceName).toBe('Renamed Phone')
    expect(row.revoked_at).toBeNull()
  })
})
