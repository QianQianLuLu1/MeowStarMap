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

/** cause 链遍历深度上限：异常构造的超长链不得把归类拖成死循环 */
const MAX_CAUSE_DEPTH = 8

/** 把 unknown 收窄成可读对象（非对象返回空壳，保证本函数永不抛错） */
function asRecord(err: unknown): Record<string, unknown> {
  return typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {}
}

/**
 * 安全读属性：throwing getter / Proxy 的 get trap 抛错时返回 undefined。
 * 「本函数永不抛错」的契约靠它兜住——归类器面对任意 unknown 输入只做读取，不能被损坏/恶意
 * getter 带崩。用 try/catch 而非 getOwnPropertyDescriptor：后者对 Proxy 仍会触发 get 陷阱。
 */
function safeGet(rec: Record<string, unknown>, key: string): unknown {
  try {
    return rec[key]
  } catch {
    return undefined
  }
}

/**
 * 沿 cause 链收集节点（含起点）：seen 集合挡循环引用，深度上限挡超长链。
 * 只读属性、不改入参；调用方据此把 statusCode / status / code 的判定铺到整条链。
 */
function causeChain(err: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = []
  const seen = new Set<unknown>()
  let cur: unknown = err
  let depth = 0
  while (typeof cur === 'object' && cur !== null && depth < MAX_CAUSE_DEPTH && !seen.has(cur)) {
    seen.add(cur)
    const rec = asRecord(cur)
    chain.push(rec)
    cur = safeGet(rec, 'cause')
    depth += 1
  }
  return chain
}

/** 汇总 name + code + message（字符串入参本身也当 message 看） */
function textOf(err: unknown): string {
  const rec = asRecord(err)
  const name = safeGet(rec, 'name')
  const code = safeGet(rec, 'code')
  const message = safeGet(rec, 'message')
  return `${typeof name === 'string' ? name : ''} ${typeof code === 'string' ? code : ''} ${
    typeof message === 'string' ? message : typeof err === 'string' ? err : ''
  }`
}

/** 读 HTTP 状态码：沿 cause 链逐节点查 statusCode/status，缺失时从 `Response code 404` 文案里取 */
function statusOf(err: unknown): number | null {
  for (const node of [err, ...causeChain(err).slice(1)]) {
    const rec = asRecord(node)
    const statusCode = safeGet(rec, 'statusCode')
    if (typeof statusCode === 'number') return statusCode
    const status = safeGet(rec, 'status')
    if (typeof status === 'number') return status
    const matched = /Response code (\d{3})/i.exec(textOf(node))
    if (matched) return Number(matched[1])
  }
  return null
}

/** 归类一次更新失败；入参形状不受限（Error / 字符串 / null / 裸对象都不抛） */
export function classifyUpdateError(err: unknown): UpdateErrorKind {
  const nodes: unknown[] = [err, ...causeChain(err).slice(1)]
  const haystack = nodes.map(textOf).join(' ').toUpperCase()

  // 1) 传输层信号（含整条 cause 链）——先于更新器自己的错误码判定
  if (NETWORK_SIGNAL.test(haystack)) return 'network'
  if (NETWORK_CODES.some((code) => haystack.includes(code))) return 'network'

  // 2) HTTP 状态码：服务端故障 / 超时 / 限流算「现在连不上」，其余 4xx 属源内容问题。
  //    403/407 单列：GitHub 限流（secondary rate limit）返 403，不是发布内容缺失，
  //    与 429 同属「现在连不上」；若归 source 会把限流误报成「更新源未就绪」。
  const status = statusOf(err)
  if (status !== null) {
    if (status >= 500 || status === 408 || status === 429 || status === 403 || status === 407)
      return 'network'
    if (status >= 400) return 'source'
  }

  // 3) 更新器语义错误码：沿整条 cause 链找 ERR_UPDATER_ 前缀（缺 channel 文件 / 无已发布版本 /
  //    feed 解析失败 / 版本号非法）
  if (
    nodes.some((node) => {
      const code = safeGet(asRecord(node), 'code')
      return typeof code === 'string' && code.startsWith('ERR_UPDATER_')
    })
  )
    return 'source'

  // 4) 兜底 source
  return 'source'
}
