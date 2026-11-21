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
 * 2026-11-21 补口（「网络可达 GitHub 仍弹『未获取到可用的更新信息』」取证）：传输层还有三种
 * 「无码可查」的失败会被兜底成 source——① httpExecutor.js:282 的 60s socket 超时抛
 * `Error("Request timed out")`，无 code 无 statusCode；② httpExecutor.js:145 服务端中途断开抛
 * `Error("Request has been aborted by the server")`，同样无码；③ getLatestTagName() 包装 HTTP 失败
 * 时把 statusCode 属性剥掉，只剩 message 内嵌的「HttpError: 403 …」文本。三者契约上都该判 network
 * （electron-api.ts:423：超时 ⇒ network），故 NETWORK_SIGNAL 增补两个无码信号、statusOf 增补
 * 包装内嵌状态码提取。
 *
 * 二轮（同日，用户口径「没有更新版本就别弹错误」）：404 归 source 按契约没错，错在呈现——线上
 * latest tag（MeowStarMap-Setup-2.5.6，实测 /releases/latest）的 release 只传了 exe、缺 latest.yml，
 * 404 弹「未获取到可用的更新信息」对「确实没有更新版本」的用户是误导。ERR_UPDATER_CHANNEL_FILE_NOT_FOUND
 * 的 message 内嵌 `…/download/<tag>/latest.yml`，tag 即远端发布版本：≤ 当前版本 ⇒ 应呈现
 * 「当前已是最新版本」（missingChannelUpToDateVersion），> 当前版本 ⇒ 维持 source 错误（元数据真缺失）。
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

/** 无错误码、只在 message 里露面的 TLS / Electron net 栈信号与超时/服务端断开信号（统一按大写文本匹配） */
const NETWORK_SIGNAL =
  /NET::ERR_|SSL ROUTINES|UNABLE TO VERIFY THE FIRST CERTIFICATE|TLS HANDSHAKE|REQUEST TIMED OUT|ABORTED BY THE SERVER/

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

/**
 * 读 HTTP 状态码：沿 cause 链逐节点查 statusCode/status，缺失时从错误文本里取——
 * 除 `Response code 404` 外还认 `HttpError: 403`：GitHubProvider.getLatestTagName()
 * （GitHubProvider.js:172-174）把 /releases/latest 的任何失败包装成 ERR_UPDATER_LATEST_VERSION_NOT_FOUND，
 * statusCode 属性丢失、只剩 e.stack 内嵌的「HttpError: <status> …」首行，限流（403）/网关故障（5xx）
 * 必须从这里捞回来才配得上「网络繁忙」。要求冒号后紧跟 3 位数字，「HttpError: Response code 404」
 * 这类既有形态不被误提取。
 */
function statusOf(err: unknown): number | null {
  for (const node of [err, ...causeChain(err).slice(1)]) {
    const rec = asRecord(node)
    const statusCode = safeGet(rec, 'statusCode')
    if (typeof statusCode === 'number') return statusCode
    const status = safeGet(rec, 'status')
    if (typeof status === 'number') return status
    const text = textOf(node)
    const matched = text.match(/Response code (\d{3})/i)
    if (matched) return Number(matched[1])
    const wrapped = text.match(/HttpError:\s*(\d{3})/i)
    if (wrapped) return Number(wrapped[1])
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

/** 版本三元组：取首个 `X.Y.Z` 数字段（`2.5.7-beta` 等后缀忽略），不可解析返回 null */
function versionTripleOf(version: string): [number, number, number] | null {
  const matched = version.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!matched) return null
  return [Number(matched[1]), Number(matched[2]), Number(matched[3])]
}

/** 远端发布版本 ≤ 当前版本 ⇒ true（等价即「没有更新版本」）；任一方不可解析 ⇒ false 保守走错误弹窗 */
function releaseVersionAtMost(currentVersion: string, releaseTag: string): boolean {
  const current = versionTripleOf(currentVersion)
  const release = versionTripleOf(releaseTag)
  if (!current || !release) return false
  for (let i = 0; i < 3; i += 1) {
    if (release[i] !== current[i]) return release[i] < current[i]
  }
  return true
}

/**
 * 缺通道文件（ERR_UPDATER_CHANNEL_FILE_NOT_FOUND）且远端发布版本不高于当前版本 ⇒ 返回远端发布
 * 版本号（主进程据此推 not-available「当前已是最新版本」，替代误导性错误弹窗）；其余一律 null
 * （维持 source 错误）。永不抛错：入参 unknown 经既有 safeGet / causeChain 收窄，只读不抛。
 *
 * 为什么比较用自研三元组而非 semver 依赖：semver 在依赖树中但未声明、@types/semver@6 断代；
 * 本函数只决定弹窗文案（真实更新决策仍由 electron-updater 的 semver 负责），保守失败即可。
 */
export function missingChannelUpToDateVersion(err: unknown, currentVersion: string): string | null {
  const nodes: unknown[] = [err, ...causeChain(err).slice(1)]
  const isMissingChannel = nodes.some((node) => {
    const code = safeGet(asRecord(node), 'code')
    return typeof code === 'string' && code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
  })
  if (!isMissingChannel) return null

  // tag 只在 GitHubProvider 形态的 message 里（…/download/<tag>/latest.yml）；generic 假源等
  // 无 tag 形态提取不到 ⇒ null 维持错误。首个命中的节点定结论，不得继续翻链（防误配其他 URL）。
  for (const node of nodes) {
    const matched = textOf(node).match(/\/download\/([^/]+)\/latest[^/]*\.yml/i)
    if (!matched) continue
    if (!releaseVersionAtMost(currentVersion, matched[1])) return null
    const release = versionTripleOf(matched[1])
    return release ? `${release[0]}.${release[1]}.${release[2]}` : null
  }
  return null
}
