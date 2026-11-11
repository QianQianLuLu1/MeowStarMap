/**
 * 出站请求 URL 安全守卫（自 cloth-data-service 泛化，供多个远程数据服务共用）。
 *
 * 约束来源（Mimosa 安全约束 + 总计划 §8.1）：仅允许 http/https；显式拒绝 localhost、
 * 环回、私有与保留地址。本模块只做「协议 + 危险地址段」兜底防线，业务级 host 白名单
 * （如 cloth-data 的 allowedHosts、参考数据的镜像域）由调用方在守卫之后自行追加。
 *
 * 放在 utils 叶子层：零依赖、无状态、不感知任何服务配置。
 */

/** 守卫拦截类错误（内部控制流用；调用方决定是否向用户透出） */
export class RemoteUrlGuardError extends Error {
  constructor(category: string) {
    super(category)
    this.name = 'RemoteUrlGuardError'
  }
}

/**
 * 出站 URL 安全守卫：解析 + 仅 http/https + 拒绝 localhost/环回/私网/保留地址。
 * @throws RemoteUrlGuardError URL 不可解析、协议越界或 host 危险时
 */
export function assertSafeRemoteUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new RemoteUrlGuardError(`URL 解析失败`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new RemoteUrlGuardError(`协议不在 http/https 白名单内：${parsed.protocol}`)
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (isForbiddenHost(host)) {
    throw new RemoteUrlGuardError(`host 属于 localhost/环回/私网/保留地址：${host}`)
  }
}

/** 环回/私网/保留地址判定（IPv4 字面量 + 常见 IPv6 形态；白名单场景下的兜底防线） */
export function isForbiddenHost(host: string): boolean {
  const h = host.replace(/^\[/, '').replace(/\]$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    // 0/8、10/8、127/8、169.254/16、172.16/12、192.168/16、240/4（含广播段）
    return /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|2(?:4[0-9]|5[0-5])\.)/.test(
      h
    )
  }
  if (h === '::' || h === '::1') return true
  if (h.startsWith('::ffff:')) {
    const v4 = h.slice('::ffff:'.length)
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
      return /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|2(?:4[0-9]|5[0-5])\.)/.test(
        v4
      )
    }
  }
  if (/^f[cd]/.test(h)) return true // fc00::/7 唯一本地地址
  if (/^fe[89ab]/.test(h)) return true // fe80::/10 链路本地地址
  return false
}
