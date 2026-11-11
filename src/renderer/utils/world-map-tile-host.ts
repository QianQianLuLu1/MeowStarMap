/**
 * 阶段 4：瓦片来源合规校验（纯函数，零 IO）。
 *
 * 授权事实（nikki_albums #20）：
 * - 游戏官方「奇迹大陆大地图」瓦片（assets.papegames.com）不要求额外 User-Agent，
 *   可按现有方式直连；本模块只放行这一 host。
 * - 上游作者自有 CDN（cdn.nikkialbums.com）的授权范围仅为**图片资源**，瓦片不在其中；
 *   cdn.gongeo.us 同属既有图片热链。二者及任何未登记主机一律 fail-closed。
 *
 * 本允许集与 `src/main/services/reference-data/image-url.ts` 的图片主机注册表
 * 物理隔离：即便图片侧授权范围变化，也不会把瓦片资源偷偷接入。
 * 应用不缓存、不代理、不镜像、不二次分发瓦片，也不改写模板的 protocol+host。
 */

/** 已核实授权的瓦片主机封闭集；新增主机前必须先取得权利方明确授权 */
export const AUTHORIZED_WORLD_MAP_TILE_HOSTS: ReadonlySet<string> = new Set([
  'assets.papegames.com'
])

const REQUIRED_PLACEHOLDERS = ['{z}', '{x}', '{y}'] as const

export type TileTemplateRejection =
  | 'empty'
  | 'unparsable'
  | 'insecure-protocol'
  | 'non-standard-port'
  | 'unauthorized-host'
  | 'missing-placeholders'

export type TileTemplateResult =
  { ok: true; host: string } | { ok: false; reason: TileTemplateRejection }

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '')
}

function reject(reason: TileTemplateRejection): TileTemplateResult {
  return { ok: false, reason }
}

/**
 * 按 resolved URL 的实际 hostname 核实授权，而非按字段或前缀硬编码信任。
 * 校验链：非空 → 可解析 → 仅 https 且无 userinfo → 仅 443/缺省端口 →
 * host 精确匹配封闭集 → 三个占位符齐全。
 */
export function isAuthorizedTileTemplate(template: unknown): TileTemplateResult {
  if (typeof template !== 'string' || !template.trim()) return reject('empty')
  const raw = template.trim()

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return reject('unparsable')
  }
  if (url.protocol !== 'https:') return reject('insecure-protocol')
  if (url.username || url.password) return reject('unparsable')
  // 授权主机 + 非标端口仍可能是代理/劫持入口；CSP 默认端口匹配只是浏览器兜底，
  // 守卫层显式拒绝，不依赖下游拦截
  if (url.port !== '' && url.port !== '443') return reject('non-standard-port')

  const host = normalizeHost(url.hostname)
  if (!AUTHORIZED_WORLD_MAP_TILE_HOSTS.has(host)) return reject('unauthorized-host')

  if (!REQUIRED_PLACEHOLDERS.every((placeholder) => raw.includes(placeholder))) {
    return reject('missing-placeholders')
  }
  return { ok: true, host }
}
