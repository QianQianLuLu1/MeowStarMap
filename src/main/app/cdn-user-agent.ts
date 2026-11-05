/**
 * cdn.gongeo.us 请求的固定 User-Agent 标识。
 *
 * 背景：上游作者按 User-Agent 在网关侧对衣橱/搭配码 CDN 图片加白名单，要求本机发往
 * cdn.gongeo.us 的所有请求统一携带固定标识 MeowStarMap（固定字符串，不含版本号/空格/附加信息）。
 *
 * 约束：
 * - 仅当 URL 主机精确等于 cdn.gongeo.us 时改写，禁止子串匹配或通配；
 * - 其他主机请求头一律原样保留（零干预）；
 * - 不修改 CSP（window-manager.ts 的 CSP_POLICY / onHeadersReceived 均不动）；
 * - 不引入 cdn.gongeo.us 之外的任何主机，不新增依赖；
 * - 与 applyContentSecurityPolicy 同款处理：窗口 loadURL 之前注册、同一 hook 重复注册即覆盖，
 *   窗口重建无需清理；dev 与生产都生效。
 *
 * fail-open（src/main/utils/AGENTS.md）：URL 解析失败、requestHeaders 缺失或注册本身出错时，
 * 记录有含义的诊断信息后让请求继续发出，绝不向 createMainWindow 冒泡异常。
 */
import { session } from 'electron'
import { logger } from '../utils/logger'

/** 上游网关白名单约定的固定标识：固定字符串，不含版本号/空格/附加信息 */
export const CDN_USER_AGENT = 'MeowStarMap'

/** 唯一批准的 CDN 主机（hostname，不含协议/端口/路径） */
const CDN_HOST = 'cdn.gongeo.us'

const USER_AGENT_HEADER = 'User-Agent'

/**
 * 大小写不敏感地剔除所有既有 User-Agent 变体，再写入唯一的规范键。
 * Electron 给到的头名大小写不定，直接赋值会留下 'user-agent' 与 'User-Agent' 两个键，
 * 可能让 Chromium 发出重复 UA 头；不 mutate 入参，便于其他主机路径保持原样。
 */
function withCdnUserAgent(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'user-agent') next[key] = value
  }
  next[USER_AGENT_HEADER] = CDN_USER_AGENT
  return next
}

/** fail-open 诊断：不静默吞掉，调用方随后 callback({}) 零干预放行 */
function warnFailOpen(reason: string, err?: unknown): void {
  logger.warn(`[cdn-user-agent] ${reason}; request continues with original headers`, err)
}

/**
 * 在默认会话注册请求发出前的拦截点。
 * 不传 filter（WebRequestFilter.urls 是 glob 通配，既不满足「精确等于」，也无法对非目标主机
 * 做断言）；在 listener 内用 URL.hostname 精确比较：前缀/后缀/路径含该主机串均不匹配。
 * 与 onHeadersReceived 是不同 hook，互不覆盖。
 */
export function registerCdnUserAgent(): void {
  try {
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      // Electron webRequest 要求 callback 恰好一次：所有出口统一经 done，兜底重复调用直接弃权
      let settled = false
      const done: typeof callback = (response) => {
        if (settled) return
        settled = true
        callback(response)
      }
      try {
        let hostname: string
        try {
          hostname = new URL(details.url).hostname
        } catch (err) {
          warnFailOpen(`URL parse failed (url=${String(details.url)})`, err)
          done({})
          return
        }

        if (hostname !== CDN_HOST) {
          // 不提供 requestHeaders = Chromium 完全沿用原始头，不修改任何一台其他主机
          done({})
          return
        }

        const headers = details.requestHeaders
        if (!headers || typeof headers !== 'object') {
          // 不构造只含 UA 的新对象：那会丢掉 Accept/Referer 等全部既有头
          warnFailOpen('requestHeaders missing on target request, cannot set UA')
          done({})
          return
        }

        done({ requestHeaders: withCdnUserAgent(headers) })
      } catch (err) {
        // 兜底：任何未预期异常都不外抛、不挂起请求、不打断窗口创建（done 保证 callback 恰好一次）
        warnFailOpen('unexpected error in onBeforeSendHeaders listener', err)
        done({})
      }
    })
  } catch (err) {
    // 注册失败（session 未就绪 / webRequest 不可用）：记日志，绝不打断 createMainWindow
    logger.warn('[cdn-user-agent] failed to register onBeforeSendHeaders; UA tag inactive', err)
  }
}
