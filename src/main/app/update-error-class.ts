import type { UpdateErrorKind } from '../../shared/types/electron-api'

/**
 * 更新错误归类：把 electron-updater 抛出的任意失败分成「连不上更新源」与「连得上但更新源未就绪」。
 *
 * 为什么需要：`autoUpdater.on('error')` 此前对所有失败一律推 `stage:'error'`，渲染层把 error 写死成
 * 「当前网络繁忙，点击确定跳转官网」，于是「Release 里没人上传 latest.yml」这种发布问题被报成了用户的
 * 网络问题（2026-11-05 取证：`releases.atom` → 200，`.../download/MeowStarMap-Setup-2.5.6/latest.yml` → 404）。
 *
 * 判定顺序的意义：`GitHubProvider.getLatestTagName()` 会把 DNS / 拒连**包装**进
 * `ERR_UPDATER_LATEST_VERSION_NOT_FOUND` 的 message（`Unable to find latest version on GitHub (…):
 * Error: getaddrinfo ENOTFOUND github.com`），所以传输层信号必须先于 `ERR_UPDATER_` 前缀判定，
 * 否则真断网仍会被误报成「源未就绪」。
 *
 * 兜底方向取 `source`：兜底 `network` 会把任何内部异常都转译成「你的网络有问题」，正是本轮要消灭的形状。
 */

/** Node syscall / DNS / TLS 层失败码：任一出现即判定连不上更新源 */
const NETWORK_CODES = [
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'EPROTO',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_PROTOCOL_ERROR',
  'CERT_HAS_EXPIRED',
  'CERT_UNTRUSTED',
  'UNKNOWN_CA',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
]

/** 无错误码、只在 message 里露面的 TLS / Electron net 栈信号（统一按大写文本匹配） */
const NETWORK_SIGNAL = /NET::ERR_|SSL ROUTINES|UNABLE TO VERIFY THE FIRST CERTIFICATE|TLS HANDSHAKE/

/** 把 unknown 收窄成可读对象（非对象返回空壳，保证本函数永不抛错） */
function asRecord(err: unknown): Record<string, unknown> {
  return typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {}
}

/** 汇总 name + code + message（字符串入参本身也当 message 看） */
function textOf(err: unknown): string {
  const rec = asRecord(err)
  const name = typeof rec.name === 'string' ? rec.name : ''
  const code = typeof rec.code === 'string' ? rec.code : ''
  const message = typeof rec.message === 'string' ? rec.message : typeof err === 'string' ? err : ''
  return `${name} ${code} ${message}`
}

/** 读 HTTP 状态码：优先 statusCode/status 字段，缺失时从 `Response code 404` 文案里取 */
function statusOf(err: unknown): number | null {
  const rec = asRecord(err)
  if (typeof rec.statusCode === 'number') return rec.statusCode
  if (typeof rec.status === 'number') return rec.status
  const matched = /Response code (\d{3})/i.exec(textOf(err))
  return matched ? Number(matched[1]) : null
}

/** 归类一次更新失败；入参形状不受限（Error / 字符串 / null / 裸对象都不抛） */
export function classifyUpdateError(err: unknown): UpdateErrorKind {
  const cause = asRecord(err).cause
  const haystack = `${textOf(err)} ${cause === undefined ? '' : textOf(cause)}`.toUpperCase()

  // 1) 传输层信号（含 cause 链一层）——先于更新器自己的错误码判定
  if (NETWORK_SIGNAL.test(haystack)) return 'network'
  if (NETWORK_CODES.some((code) => haystack.includes(code))) return 'network'

  // 2) HTTP 状态码：服务端故障 / 超时 / 限流算「现在连不上」，其余 4xx 属源内容问题
  const status = statusOf(err)
  if (status !== null) {
    if (status >= 500 || status === 408 || status === 429) return 'network'
    if (status >= 400) return 'source'
  }

  // 3) 更新器语义错误码：缺 channel 文件 / 无已发布版本 / feed 解析失败 / 版本号非法
  const code = asRecord(err).code
  if (typeof code === 'string' && code.startsWith('ERR_UPDATER_')) return 'source'

  // 4) 兜底 source
  return 'source'
}
