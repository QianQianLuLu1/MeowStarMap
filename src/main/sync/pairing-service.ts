import { createHash, createPublicKey, randomBytes } from 'node:crypto'
import {
  PROTOCOL_VERSION,
  buildPairingUri,
  type PairRequest,
  type PairResponse,
  type PairingQrPayload
} from '../../shared/sync/protocol'
import type { UpsertPairDeviceInput } from '../database/sync-metadata-repository'
import type { SyncLogger } from './identity-service'

/**
 * 配对服务 — 一次性配对令牌的生成与兑换、设备公钥入库、配对二维码内容生成。
 *
 * 协议契约（冻结于 src/shared/sync/protocol.ts，对齐上游 PairingService）：
 * - 令牌：24 随机字节 base64url；默认 TTL 5 分钟；仓储只存 sha256(token)，
 *   原始令牌仅出现在返回值/QR 内容中
 * - 一次性消费：SyncPairingRepository.consumeSession 事务内置位 used_at；
 *   expired → pairing_expired、missing/used → pairing_invalid（HTTP 状态码映射属阶段4）
 * - 参数校验先于令牌消费：请求体非法抛 bad_request 且不占号（可修正后重试）
 * - QR 内容：NS1|serverId|host|port|token|expiresEpochSec|指纹64hex
 *   （buildPairingUri，客户端 PairingUri.java 双格式解析的 compact 形式）
 * - serverId/serverName 来自 SyncMetadataRepository.ensureServerIdentity（DB 侧），
 *   serverPublicKey 来自 SyncIdentityService（文件侧 Ed25519 密钥对）
 */

export interface PairingSessionsRepo {
  createSession(input: { tokenHash: string; serverId: string; expiresAt: string }): Promise<void>
  consumeSession(tokenHash: string, nowIso: string): Promise<'ok' | 'missing' | 'used' | 'expired'>
}

export interface PairingDevicesRepo {
  upsertPairDevice(input: UpsertPairDeviceInput): Promise<void>
  ensureServerIdentity(): Promise<{ serverId: string; serverName: string }>
}

/** 结构化接口：由 SyncIdentityService 实现（文件侧身份），测试可注入桩 */
export interface PairingIdentityProvider {
  getOrCreateTlsIdentity(): {
    keyPem: string
    certPem: string
    fingerprintSha256: string
    createdAt: string
  }
  getOrCreateServerIdentity(): { publicKeyPem: string; privateKeyPem: string }
}

export interface PairingServiceDeps {
  sessions: PairingSessionsRepo
  devices: PairingDevicesRepo
  identity: PairingIdentityProvider
  /** 令牌默认 TTL（毫秒）；默认 5 分钟 */
  ttlMs?: number
  /** 时钟注入（测试用）；默认 Date.now */
  now?: () => number
  /** P6：关键结果留痕（装配层接统一 logger）；缺省静默，异常不外抛 */
  logger?: SyncLogger
}

export interface PairingTokenOffer {
  token: string
  expiresAt: string
  serverId: string
}

export interface PairingQrOffer extends PairingTokenOffer {
  /** NS1|... 七段二维码内容（客户端可直接扫描） */
  content: string
}

export type PairingErrorCode = 'pairing_expired' | 'pairing_invalid' | 'bad_request'

export class PairingError extends Error {
  constructor(readonly code: PairingErrorCode) {
    super(`pairing failed: ${code}`)
    this.name = 'PairingError'
  }
}

const DEFAULT_TTL_MS = 5 * 60_000
const TOKEN_BYTES = 24
const CREDENTIAL_BYTES = 32

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function assertNonEmpty(value: unknown, _label: string): asserts value is string {
  if (typeof value !== 'string' || value === '') {
    throw new PairingError('bad_request')
  }
}

/** 设备公钥必须可解析（PEM 或 base64url SPKI DER，与认证侧 parsePublicKey 同规则） */
function assertParseablePublicKey(value: string): void {
  try {
    if (value.includes('BEGIN PUBLIC KEY')) {
      createPublicKey(value)
    } else {
      createPublicKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'spki' })
    }
  } catch {
    throw new PairingError('bad_request')
  }
}

function assertValidPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PairingError('bad_request')
  }
}

export class PairingService {
  private readonly deps: PairingServiceDeps
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(deps: PairingServiceDeps) {
    this.deps = deps
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
    this.now = deps.now ?? Date.now
  }

  /** P6：诊断留痕 fail-open——logger 缺席或抛错都不得影响配对主流程 */
  private log(level: 'info' | 'warn', message: string): void {
    try {
      const singleLine = message.replace(/\r/g, '\\r').replace(/\n/g, '\\n')
      this.deps.logger?.[level](singleLine)
    } catch {
      // 日志通道故障静默降级
    }
  }

  /** 生成一次性配对令牌（返回原始令牌；仓储只存其 sha256） */
  async createPairingToken(options: { ttlMs?: number } = {}): Promise<PairingTokenOffer> {
    const ttlMs = options.ttlMs ?? this.ttlMs
    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    const expiresAt = new Date(this.now() + ttlMs).toISOString()
    const { serverId } = await this.deps.devices.ensureServerIdentity()
    await this.deps.sessions.createSession({ tokenHash: sha256Hex(token), serverId, expiresAt })
    this.log(
      'info',
      `[NikkiSync] pairing token created: serverId=${serverId} expiresAt=${expiresAt} tokenHash=${sha256Hex(token)}`
    )
    return { token, expiresAt, serverId }
  }

  /**
   * 生成一次完整配对邀约：一次性令牌 + NS1 二维码内容。
   * host/port 为 PC 局域网地址（阶段4 由 HTTP 服务器绑定结果提供）。
   */
  async buildPairingQrContent(input: {
    host: string
    port: number
    ttlMs?: number
  }): Promise<PairingQrOffer> {
    assertNonEmpty(input.host, 'host')
    assertValidPort(input.port)
    const created = await this.createPairingToken({ ttlMs: input.ttlMs })
    const payload: PairingQrPayload = {
      scheme: 'nikki-sync',
      action: 'pair',
      serverId: created.serverId,
      host: input.host,
      port: input.port,
      pairingToken: created.token,
      protocolVersion: PROTOCOL_VERSION,
      expiresAt: created.expiresAt,
      tlsFingerprintSha256: this.deps.identity.getOrCreateTlsIdentity().fingerprintSha256
    }
    return { ...created, content: buildPairingUri(payload) }
  }

  /**
   * 兑换配对令牌：消费（一次性）→ 生成 deviceCredential → 设备公钥入库（UPSERT，
   * 重复配对换钥并清撤销态）→ 返回 PairResponse。
   * 参数校验先于令牌消费：bad_request 不占号。
   * P6：成功/失败均留痕（设备/配对标识全量，用户已批准不脱敏；密钥材料仍不进日志）。
   */
  async redeemToken(request: PairRequest): Promise<PairResponse> {
    try {
      const response = await this.redeemTokenCore(request)
      this.log(
        'info',
        `[NikkiSync] pairing succeeded: deviceId=${request.device.deviceId} ` +
          `deviceName=${request.device.deviceName} platform=${request.device.platform} ` +
          `serverId=${response.serverId}`
      )
      return response
    } catch (error) {
      this.log(
        'warn',
        `[NikkiSync] pairing failed: code=${error instanceof PairingError ? error.code : 'unexpected'} ` +
          `deviceId=${request?.device?.deviceId ?? 'unknown'} error=${String(error)}`
      )
      throw error
    }
  }

  private async redeemTokenCore(request: PairRequest): Promise<PairResponse> {
    assertNonEmpty(request?.pairingToken, 'pairingToken')
    const device = request.device
    if (!device) throw new PairingError('bad_request')
    assertNonEmpty(device.deviceId, 'device.deviceId')
    assertNonEmpty(device.deviceName, 'device.deviceName')
    if (device.platform !== 'ios' && device.platform !== 'android') {
      throw new PairingError('bad_request')
    }
    assertNonEmpty(device.publicKey, 'device.publicKey')
    assertParseablePublicKey(device.publicKey)

    const tokenHash = sha256Hex(request.pairingToken)
    const state = await this.deps.sessions.consumeSession(
      tokenHash,
      new Date(this.now()).toISOString()
    )
    if (state !== 'ok') {
      throw new PairingError(state === 'expired' ? 'pairing_expired' : 'pairing_invalid')
    }

    const deviceCredential = randomBytes(CREDENTIAL_BYTES).toString('base64url')
    await this.deps.devices.upsertPairDevice({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      platform: device.platform,
      publicKey: device.publicKey,
      credentialHash: sha256Hex(deviceCredential),
      appVersion: device.appVersion
    })
    const [{ serverId, serverName }, serverKeys] = await Promise.all([
      this.deps.devices.ensureServerIdentity(),
      Promise.resolve(this.deps.identity.getOrCreateServerIdentity())
    ])
    return {
      serverId,
      serverName,
      serverPublicKey: serverKeys.publicKeyPem,
      deviceCredential,
      protocolVersion: PROTOCOL_VERSION
    }
  }
}
