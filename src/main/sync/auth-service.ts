import { createHash, createPublicKey, verify } from 'node:crypto'
import type { SyncPairedDeviceRow } from '../database/sync-metadata-repository'

/**
 * 同步请求认证服务 — NikkiSync 协议 Ed25519 请求签名验证。
 *
 * 协议契约（与上游 AuthService / Android SignedHttpClient 逐字对齐，
 * 冻结于 src/shared/sync/protocol.ts）：
 * - 四头齐全：X-NikkiSync-{Device-Id, Timestamp(毫秒), Nonce(16B base64url), Signature(base64url)}
 * - 签名基串：`METHOD\n原始path+query\n时间戳原值\nnonce原值\nlowercase-hex(sha256(body))`
 *   （'\n' 分隔，UTF-8；空 body 哈希 = sha256("")；query 参与签名且不做规范化）
 * - 验签：Ed25519（crypto.verify 首参 null），设备公钥兼容 PEM / base64url(SPKI DER)
 * - 时间窗：±clockSkewMs（默认 5 分钟，硬约束上限）
 * - nonce 防重放：内存 Map（键 deviceId:nonce，TTL = 时间窗，惰性清理；
 *   进程重启清空，重放防护由时间窗兜底——与上游一致）
 * - 所有失败原因内部区分（reason，供测试与日志），对外统一映射 401 unauthorized
 *   （协议不区分原因；HTTP 层属阶段4）
 *
 * 框架接缝：verifyRequest 只依赖 {method, url, headers, body} 纯数据，
 * 阶段4 的 node:http 服务器直接传入 IncomingMessage 的对应字段即可
 * （node:http 头名已小写，此处做大小写不敏感兼容）。
 */

export type AuthFailureReason =
  | 'missing_headers'
  | 'malformed_timestamp'
  | 'clock_skew'
  | 'replayed_nonce'
  | 'unknown_device'
  | 'revoked_device'
  | 'invalid_signature'

export type AuthResult = { ok: true; deviceId: string } | { ok: false; reason: AuthFailureReason }

export interface AuthRequestInput {
  /** 大写 HTTP 方法（如 'GET'；进入签名基串前不做转换） */
  method: string
  /** 原始请求目标（path + query，未规范化；与请求行逐字节一致） */
  url: string
  /** 请求头（大小写不敏感；数组值取第一个，对齐 node:http 行为） */
  headers: Record<string, string | string[] | undefined>
  /** 原始请求体；缺省按空 body 签名验证 */
  body?: Uint8Array
}

export interface AuthServiceDeps {
  /** 设备查询（SyncMetadataRepository.getPairedDevice） */
  getDevice: (deviceId: string) => SyncPairedDeviceRow | null
  /** last_seen 记录（SyncMetadataRepository.touchDevice）；失败不影响认证结果 */
  touchDevice?: (deviceId: string) => Promise<void> | void
}

export interface AuthServiceOptions {
  /** 时钟偏移容许窗口（毫秒）；默认 5 分钟（协议硬约束上限） */
  clockSkewMs?: number
  /** 时钟注入（测试用）；默认 Date.now */
  now?: () => number
}

const DEFAULT_CLOCK_SKEW_MS = 5 * 60_000
const EMPTY_BODY = Buffer.alloc(0)
const AUTH_HEADERS = [
  'x-nikkisync-device-id',
  'x-nikkisync-timestamp',
  'x-nikkisync-nonce',
  'x-nikkisync-signature'
] as const

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 头读取：大小写不敏感；数组值取第一个（对齐上游 header() 行为） */
function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  lowerName: string
): string | undefined {
  const direct = headers[lowerName]
  if (direct !== undefined) return Array.isArray(direct) ? direct[0] : direct
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      if (value === undefined) return undefined
      return Array.isArray(value) ? value[0] : value
    }
  }
  return undefined
}

/** 设备公钥解析：PEM 优先，否则 base64url(SPKI DER)（Android 客户端格式） */
function parsePublicKey(value: string): ReturnType<typeof createPublicKey> {
  if (value.includes('BEGIN PUBLIC KEY')) return createPublicKey(value)
  return createPublicKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'spki' })
}

export class AuthService {
  private readonly deps: AuthServiceDeps
  private readonly clockSkewMs: number
  private readonly now: () => number
  /** deviceId:nonce → 过期时刻（仅内存；TTL = 时间窗） */
  private readonly nonces = new Map<string, number>()

  constructor(deps: AuthServiceDeps, options: AuthServiceOptions = {}) {
    this.deps = deps
    this.clockSkewMs = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS
    this.now = options.now ?? Date.now
  }

  async verifyRequest(input: AuthRequestInput): Promise<AuthResult> {
    const deviceId = pickHeader(input.headers, AUTH_HEADERS[0])
    const timestamp = pickHeader(input.headers, AUTH_HEADERS[1])
    const nonce = pickHeader(input.headers, AUTH_HEADERS[2])
    const signature = pickHeader(input.headers, AUTH_HEADERS[3])
    if (!deviceId || !timestamp || !nonce || !signature) {
      return { ok: false, reason: 'missing_headers' }
    }

    const now = this.now()
    const ts = Number(timestamp)
    if (!Number.isFinite(ts)) return { ok: false, reason: 'malformed_timestamp' }
    if (Math.abs(now - ts) > this.clockSkewMs) return { ok: false, reason: 'clock_skew' }

    this.pruneNonces(now)
    const nonceKey = `${deviceId}:${nonce}`
    if (this.nonces.has(nonceKey)) return { ok: false, reason: 'replayed_nonce' }

    const device = this.deps.getDevice(deviceId)
    if (!device) return { ok: false, reason: 'unknown_device' }
    if (device.revoked_at) return { ok: false, reason: 'revoked_device' }

    const body = input.body ?? EMPTY_BODY
    const canonical = [
      input.method || 'GET',
      input.url || '/',
      timestamp,
      nonce,
      sha256Hex(body)
    ].join('\n')
    try {
      const ok = verify(
        null,
        Buffer.from(canonical, 'utf8'),
        parsePublicKey(String(device.public_key)),
        Buffer.from(signature, 'base64url')
      )
      if (!ok) return { ok: false, reason: 'invalid_signature' }
    } catch {
      // 公钥解析失败 / 签名 base64url 非法 / 验签异常——一律拒绝且不外抛
      return { ok: false, reason: 'invalid_signature' }
    }

    // 验签成功才消费 nonce（失败请求不占号，修正后可重试）
    this.nonces.set(nonceKey, now + this.clockSkewMs)
    try {
      await this.deps.touchDevice?.(deviceId)
    } catch {
      // last_seen 记录失败不影响认证结果
    }
    return { ok: true, deviceId }
  }

  private pruneNonces(now: number): void {
    for (const [key, expiry] of this.nonces) {
      if (expiry <= now) this.nonces.delete(key)
    }
  }
}
