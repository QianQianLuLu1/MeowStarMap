import { describe, it, expect, vi } from 'vitest'
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

/**
 * AuthService 单元测试 —— Ed25519 请求签名验证 / 时间窗 / nonce 防重放。
 *
 * 注入假设备仓储 + 注入时钟（NOW 固定），过期/重放场景时间完全可控；
 * 不触数据库、不触网络。编号对应 docs/sync-integration/03-auth-pairing-plan.md §10（T2），
 * 场景映射验收标准：合法签名通过 / 非法签名拒绝 / 过期时间戳拒绝 / 重放 nonce 拒绝。
 */

import { AuthService, type AuthRequestInput } from './auth-service'
import type { SyncPairedDeviceRow } from '../database/sync-metadata-repository'

const NOW = 1_700_000_000_000
const FIVE_MIN = 5 * 60_000
const DEVICE_ID = 'android_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function makeDeviceRow(
  publicKey: string,
  overrides: Partial<SyncPairedDeviceRow> = {}
): SyncPairedDeviceRow {
  return {
    device_id: DEVICE_ID,
    device_name: 'Test Phone',
    platform: 'android',
    public_key: publicKey,
    credential_hash: 'c'.repeat(64),
    app_version: null,
    paired_at: new Date(NOW).toISOString(),
    last_seen_at: null,
    last_ack_revision: 0,
    revoked_at: null,
    ...overrides
  }
}

// ---- 签名请求构造（与上游 SignedHttpClient.java 的 signedHeaders 逻辑一致） ----

interface SignedRequestOptions {
  privateKeyPem: string
  deviceId?: string
  method?: string
  url?: string
  body?: string | Uint8Array
  /** 毫秒时间戳（默认 NOW） */
  timestamp?: number
  nonce?: string
  /** 覆盖签名值（伪造/篡改场景） */
  signature?: string
  /** 小写化全部头名（模拟 node:http 的行为） */
  lowercaseHeaders?: boolean
}

function buildSignedRequest(opts: SignedRequestOptions): AuthRequestInput {
  const method = opts.method ?? 'GET'
  const url = opts.url ?? '/v1/assets'
  const bodyBytes =
    typeof (opts.body ?? '') === 'string'
      ? Buffer.from(String(opts.body ?? ''), 'utf8')
      : (opts.body as Uint8Array)
  const ts = String(opts.timestamp ?? NOW)
  const nonce = opts.nonce ?? randomBytes(16).toString('base64url')
  const canonical = [method, url, ts, nonce, sha256Hex(bodyBytes)].join('\n')
  const signature =
    opts.signature ??
    sign(null, Buffer.from(canonical, 'utf8'), opts.privateKeyPem).toString('base64url')
  let headers: Record<string, string> = {
    'X-NikkiSync-Device-Id': opts.deviceId ?? DEVICE_ID,
    'X-NikkiSync-Timestamp': ts,
    'X-NikkiSync-Nonce': nonce,
    'X-NikkiSync-Signature': signature
  }
  if (opts.lowercaseHeaders) {
    headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  }
  return { method, url, headers, body: bodyBytes }
}

// ---- 服务装配 ----

function makeService(deviceRows: Array<SyncPairedDeviceRow>, clockSkewMs = FIVE_MIN) {
  const devices = new Map(deviceRows.map((row) => [row.device_id, row]))
  const touchDevice = vi.fn(async () => {})
  const service = new AuthService(
    { getDevice: (id) => devices.get(id) ?? null, touchDevice },
    { now: () => NOW, clockSkewMs }
  )
  return { service, devices, touchDevice }
}

// ---- 密钥夹具 ----

function makeDeviceKeyPair() {
  const pair = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
  const publicKeyBase64url = createPublicKey(pair.publicKey)
    .export({ format: 'der', type: 'spki' })
    .toString('base64url')
  return { publicKeyPem: pair.publicKey, privateKeyPem: pair.privateKey, publicKeyBase64url }
}

// ============================================================================
// 合法签名
// ============================================================================

describe('AuthService.verifyRequest — 合法签名', () => {
  it('PEM 公钥 + 合法签名通过', async () => {
    const key = makeDeviceKeyPair()
    const { service } = makeService([makeDeviceRow(key.publicKeyPem)])
    const request = buildSignedRequest({ privateKeyPem: key.privateKeyPem })
    await expect(service.verifyRequest(request)).resolves.toEqual({ ok: true, deviceId: DEVICE_ID })
  })

  it('base64url SPKI DER 公钥（Android 客户端格式）+ 合法签名通过', async () => {
    const key = makeDeviceKeyPair()
    const { service } = makeService([makeDeviceRow(key.publicKeyBase64url)])
    const request = buildSignedRequest({ privateKeyPem: key.privateKeyPem })
    await expect(service.verifyRequest(request)).resolves.toEqual({ ok: true, deviceId: DEVICE_ID })
  })

  it('头名大小写不敏感（node:http 小写头）+ 带 query 的 url', async () => {
    const key = makeDeviceKeyPair()
    const { service } = makeService([makeDeviceRow(key.publicKeyPem)])
    const request = buildSignedRequest({
      privateKeyPem: key.privateKeyPem,
      url: '/v1/assets?limit=10&cursor=abc',
      lowercaseHeaders: true
    })
    await expect(service.verifyRequest(request)).resolves.toEqual({ ok: true, deviceId: DEVICE_ID })
  })

  it('空 body 与非空 body（POST）都可通过', async () => {
    const key = makeDeviceKeyPair()
    const { service } = makeService([makeDeviceRow(key.publicKeyPem)])
    await expect(
      service.verifyRequest(buildSignedRequest({ privateKeyPem: key.privateKeyPem, body: '' }))
    ).resolves.toMatchObject({ ok: true })
    await expect(
      service.verifyRequest(
        buildSignedRequest({
          privateKeyPem: key.privateKeyPem,
          method: 'POST',
          url: '/v1/pair',
          body: '{"pairingToken":"t"}'
        })
      )
    ).resolves.toMatchObject({ ok: true })
  })

  it('成功后调用 touchDevice 记录 last_seen', async () => {
    const key = makeDeviceKeyPair()
    const { service, touchDevice } = makeService([makeDeviceRow(key.publicKeyPem)])
    await service.verifyRequest(buildSignedRequest({ privateKeyPem: key.privateKeyPem }))
    expect(touchDevice).toHaveBeenCalledWith(DEVICE_ID)
  })
})

// ============================================================================
// 头缺失与时间戳
// ============================================================================

describe('AuthService.verifyRequest — 头与时间戳校验', () => {
  it.each([
    ['X-NikkiSync-Device-Id'],
    ['X-NikkiSync-Timestamp'],
    ['X-NikkiSync-Nonce'],
    ['X-NikkiSync-Signature']
  ])('缺少 %s 拒绝（missing_headers）', async (headerName) => {
    const key = makeDeviceKeyPair()
    const { service } = makeService([makeDeviceRow(key.publicKeyPem)])
    const request = buildSignedRequest({ privateKeyPem: key.privateKeyPem })
    delete request.headers[headerName]
    await expect(service.verifyRequest(request)).resolves.toEqual({
      ok: false,
      reason: 'missing_headers'
    })
  })

  it('头为空字符串同样拒绝', async () => {
    const key = makeDeviceKeyPair()
    const { service } = makeService([makeDeviceRow(key.publicKeyPem)])
    const request = buildSignedRequest({ privateKeyPem: key.privateKeyPem })
    request.headers['X-NikkiSync-Nonce'] = ''
    await expect(service.verifyRequest(request)).resolves.toMatchObject({
      ok: false,
      reason: 'missing_headers'
    })
  })

  it('时间戳非数字拒绝（malformed_timestamp）', async () => {
    const key = makeDeviceKeyPair()
    const { service } = makeService([makeDeviceRow(key.publicKeyPem)])
    const request = buildSignedRequest({ privateKeyPem: key.privateKeyPem, timestamp: Number.NaN })
    // NaN String 化后仍会被服务端判为非有限数
    await expect(service.verifyRequest(request)).resolves.toMatchObject({
      ok: false,
      reason: 'malformed_timestamp'
    })
  })
})

// ============================================================================
// 时间窗（±5 分钟）
// ============================================================================

describe('AuthService.verifyRequest — 时间窗', () => {
  it('过去超窗（-6min）拒绝（clock_skew）', async () => {
    const key = makeDeviceKeyPair()
    const { service } = makeService([makeDeviceRow(key.publicKeyPem)])
    const request = buildSignedRequest({
      privateKeyPem: key.privateKeyPem,
      timestamp: NOW - 6 * 60_000
    })
    await expect(service.verifyRequest(request)).resolves.toMatchObject({
      ok: false,
      reason: 'clock_skew'
    })
  })

  it('未来超窗（+6min）拒绝（clock_skew）', async () => {
    const key = makeDeviceKeyPair()
    const { service } = makeService([makeDeviceRow(key.publicKeyPem)])
    const request = buildSignedRequest({
      privateKeyPem: key.privateKeyPem,
      timestamp: NOW + 6 * 60_000
    })
    await expect(service.verifyRequest(request)).resolves.toMatchObject({
      ok: false,
      reason: 'clock_skew'
    })
  })

  it('窗口边界：恰好 -5min 通过，-5min-1ms 拒绝', async () => {
    const key = makeDeviceKeyPair()
    const { service } = makeService([makeDeviceRow(key.publicKeyPem)])
    const edge = buildSignedRequest({ privateKeyPem: key.privateKeyPem, timestamp: NOW - FIVE_MIN })
    await expect(service.verifyRequest(edge)).resolves.toMatchObject({ ok: true })
    const beyond = buildSignedRequest({
      privateKeyPem: key.privateKeyPem,
      timestamp: NOW - FIVE_MIN - 1
    })
    await expect(service.verifyRequest(beyond)).resolves.toMatchObject({
      ok: false,
      reason: 'clock_skew'
    })
  })
})

// ============================================================================
// 签名与 body
// ============================================================================

describe('AuthService.verifyRequest — 签名校验', () => {
  it('非法签名（内容不符）拒绝（invalid_signature）', async () => {
    const key = makeDeviceKeyPair()
    const { service } = makeService([makeDeviceRow(key.publicKeyPem)])
    const request = buildSignedRequest({ privateKeyPem: key.privateKeyPem, signature: 'AAAA' })
    await expect(service.verifyRequest(request)).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_signature'
    })
  })

  it('其他设备密钥所签（公钥不匹配）拒绝', async () => {
    const deviceKey = makeDeviceKeyPair()
    const otherKey = makeDeviceKeyPair()
    const { service } = makeService([makeDeviceRow(deviceKey.publicKeyPem)])
    const request = buildSignedRequest({ privateKeyPem: otherKey.privateKeyPem })
    await expect(service.verifyRequest(request)).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_signature'
    })
  })

  it('body 篡改拒绝：签名单独验不过哈希', async () => {
    const key = makeDeviceKeyPair()
    const { service } = makeService([makeDeviceRow(key.publicKeyPem)])
    const request = buildSignedRequest({ privateKeyPem: key.privateKeyPem, body: 'original' })
    request.body = Buffer.from('tampered', 'utf8')
    await expect(service.verifyRequest(request)).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_signature'
    })
  })

  it('非 base64url 乱码签名拒绝且不抛异常', async () => {
    const key = makeDeviceKeyPair()
    const { service } = makeService([makeDeviceRow(key.publicKeyPem)])
    const request = buildSignedRequest({ privateKeyPem: key.privateKeyPem, signature: '%%%;;;===' })
    await expect(service.verifyRequest(request)).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_signature'
    })
  })

  it('设备公钥损坏（不可解析）拒绝且不抛异常', async () => {
    const key = makeDeviceKeyPair()
    const { service } = makeService([makeDeviceRow('not-a-valid-public-key')])
    const request = buildSignedRequest({ privateKeyPem: key.privateKeyPem })
    await expect(service.verifyRequest(request)).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_signature'
    })
  })
})

// ============================================================================
// nonce 防重放
// ============================================================================

describe('AuthService.verifyRequest — nonce 防重放', () => {
  it('同设备同 nonce 重放拒绝（replayed_nonce）', async () => {
    const key = makeDeviceKeyPair()
    const { service } = makeService([makeDeviceRow(key.publicKeyPem)])
    const request = buildSignedRequest({ privateKeyPem: key.privateKeyPem })
    await expect(service.verifyRequest(request)).resolves.toMatchObject({ ok: true })
    // 完全相同请求（同 nonce 同签名）重放
    await expect(service.verifyRequest(request)).resolves.toMatchObject({
      ok: false,
      reason: 'replayed_nonce'
    })
  })

  it('重放检查在设备查询与验签之前（缺头外的最早拒绝点之一）', async () => {
    const key = makeDeviceKeyPair()
    const { service, touchDevice } = makeService([makeDeviceRow(key.publicKeyPem)])
    const request = buildSignedRequest({ privateKeyPem: key.privateKeyPem })
    await service.verifyRequest(request)
    touchDevice.mockClear()
    const replay = buildSignedRequest({
      privateKeyPem: key.privateKeyPem,
      nonce: request.headers['X-NikkiSync-Nonce'],
      signature: 'forged-signature'
    })
    await expect(service.verifyRequest(replay)).resolves.toMatchObject({
      ok: false,
      reason: 'replayed_nonce'
    })
    expect(touchDevice).not.toHaveBeenCalled()
  })

  it('同 nonce 不同设备各自可用（nonce 键含 deviceId，与上游一致）', async () => {
    const keyA = makeDeviceKeyPair()
    const keyB = makeDeviceKeyPair()
    const deviceB = makeDeviceRow(keyB.publicKeyPem, {
      device_id: 'android_ffffffffffffffffffffffffffffffff'
    })
    const { service } = makeService([makeDeviceRow(keyA.publicKeyPem), deviceB])
    const sharedNonce = randomBytes(16).toString('base64url')
    const requestA = buildSignedRequest({ privateKeyPem: keyA.privateKeyPem, nonce: sharedNonce })
    const requestB = buildSignedRequest({
      privateKeyPem: keyB.privateKeyPem,
      deviceId: deviceB.device_id,
      nonce: sharedNonce
    })
    await expect(service.verifyRequest(requestA)).resolves.toMatchObject({ ok: true })
    await expect(service.verifyRequest(requestB)).resolves.toMatchObject({ ok: true })
  })

  it('验签失败不消费 nonce（修正签名后同 nonce 仍可用）', async () => {
    const key = makeDeviceKeyPair()
    const { service } = makeService([makeDeviceRow(key.publicKeyPem)])
    const bad = buildSignedRequest({ privateKeyPem: key.privateKeyPem, signature: 'AAAA' })
    await expect(service.verifyRequest(bad)).resolves.toMatchObject({ ok: false })
    const fixed = buildSignedRequest({
      privateKeyPem: key.privateKeyPem,
      nonce: bad.headers['X-NikkiSync-Nonce']
    })
    await expect(service.verifyRequest(fixed)).resolves.toMatchObject({ ok: true })
  })
})

// ============================================================================
// 设备状态
// ============================================================================

describe('AuthService.verifyRequest — 设备状态', () => {
  it('未知设备拒绝（unknown_device）', async () => {
    const key = makeDeviceKeyPair()
    const { service } = makeService([])
    const request = buildSignedRequest({ privateKeyPem: key.privateKeyPem })
    await expect(service.verifyRequest(request)).resolves.toMatchObject({
      ok: false,
      reason: 'unknown_device'
    })
  })

  it('已撤销设备拒绝（revoked_device）', async () => {
    const key = makeDeviceKeyPair()
    const { service } = makeService([
      makeDeviceRow(key.publicKeyPem, { revoked_at: new Date(NOW).toISOString() })
    ])
    const request = buildSignedRequest({ privateKeyPem: key.privateKeyPem })
    await expect(service.verifyRequest(request)).resolves.toMatchObject({
      ok: false,
      reason: 'revoked_device'
    })
  })
})
