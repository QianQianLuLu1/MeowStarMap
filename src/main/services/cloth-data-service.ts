// @core-change: 新增服饰数据查询服务（阶段 2）

/**
 * 服饰数据服务（搭配码面板阶段 2）：服饰 ID → 用户可读信息（名称/图标 URL/标签）。
 *
 * 数据源为第三方 gongeo.us（契约 docs/plans/cloth-outfit-data-contract.md §6）：
 * - 名称：locale JSON 全量拉取后内存查表（一次性，惰性加载，失败冷却重试）
 * - 标签/属性：目录 API 按 ID 逐条 GET
 * - 图标：CDN URL 由 ID 直接构造（本服务不下载图片字节）
 *
 * 设计约束（任务书 + 契约 §6.3）：
 * - 查询永不 reject：超时/网络错误/4xx/5xx/解析失败/ID 未收录一律 resolve 空对象（静默降级）
 * - 失败语义分级：400/404（确认未收录）负缓存防重试风暴；其余失败不缓存（恢复后可重试）
 * - 进程内 Map-LRU（照 media-protocol 的 delete+set 模式），不做磁盘缓存（阶段 3）
 * - 出站请求统一过 URL 安全守卫（仅 http/https + host 白名单 + 显式拒绝环回/私网/保留地址）
 * - 日志：成功 debug、失败 warn；只记错误类别与状态码，不打完整 URL、不含 UID/networkData 内容
 *
 * 与 services/AGENTS.md 的偏差说明：本服务为「静默降级查询面」，参照 decryption-service 的
 * 结果对象风格——内部用私有错误类做控制流，对外不抛错；错误不经 AppError（无用户可见文案）。
 */

import { logger } from '../utils/logger'
import type { ClothDataInfo } from '../../shared/types/electron-api'
import { DEFAULT_CLOTH_DATA_CONFIG } from './cloth-data-config'
import type { ClothDataConfig } from './cloth-data-config'

export type { ClothDataInfo }

/** 名称映射种类：10 位单品（item）/ 5 位套装（outfit），与契约 §6.1 双 URL 模式对应 */
type NameMapKind = 'item' | 'outfit'

// ============================================================
// 模块级状态（测试经 disposeClothDataService 重置）
// ============================================================

let config: ClothDataConfig = { ...DEFAULT_CLOTH_DATA_CONFIG }
let fetcherOverride: typeof fetch | null = null

/** 查询结果缓存（正/负缓存共用，LRU） */
const resultCache = new Map<number, ClothDataInfo>()
/** 已加载的名称映射（kind → 全量 JSON） */
const nameMaps = new Map<NameMapKind, Record<string, unknown>>()
/** 进行中的名称映射加载（并发去重） */
const nameMapInFlight = new Map<NameMapKind, Promise<Record<string, unknown> | null>>()
/** 名称映射最近一次失败时间（冷却期内不重试） */
const nameMapFailedAt = new Map<NameMapKind, number>()

// ============================================================
// 对外 API
// ============================================================

/**
 * 批量查询服饰可读信息。
 *
 * - 内部去重（保持首次出现顺序），同一 ID 命中缓存不再发起网络请求
 * - 非正整数/非安全整数入参一律过滤为空对象条目，不发起网络请求
 * - 返回 Map 对每个入参 ID 均有条目；查询失败/未收录为空对象
 */
export async function lookupClothData(ids: number[]): Promise<Map<number, ClothDataInfo>> {
  const result = new Map<number, ClothDataInfo>()
  const pending: number[] = []
  const seen = new Set<number>()

  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      result.set(id, {})
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    const cached = cacheGet(id)
    if (cached) {
      const info = { ...cached }
      // 正缓存可能是在 name map 失败期间写入的（无 name）：冷却过后在命中路径补查并回写，
      // 否则同名 ID 会一直吃到无名称的旧结果，name map 恢复后也无法自愈。
      if (info.name === undefined) {
        const kind = routeKind(id)
        if (kind) {
          const name = await lookupName(kind, id)
          if (name !== undefined) {
            info.name = name
            cachePut(id, info)
          }
        }
      }
      result.set(id, info)
    } else {
      pending.push(id)
    }
  }

  if (pending.length > 0) {
    let next = 0
    const workers = Array.from(
      { length: Math.min(config.batchConcurrency, pending.length) },
      async () => {
        while (next < pending.length) {
          const id = pending[next++]
          try {
            result.set(id, { ...(await lookupOne(id)) })
          } catch (err) {
            // lookupOne 按设计不抛错，此处兜底保证批量整体 resolve
            logger.warn(`[clothData] 服饰数据查询出现未预期异常，静默降级：${describeError(err)}`)
            result.set(id, {})
          }
        }
      }
    )
    await Promise.all(workers)
  }

  return result
}

/** 注入配置覆盖（null 恢复默认）；测试用，生产代码不调用 */
export function setClothDataConfig(overrides: Partial<ClothDataConfig> | null): void {
  config = { ...DEFAULT_CLOTH_DATA_CONFIG, ...(overrides ?? {}) }
}

/** 注入 fetch 实现（null 恢复全局 fetch）；测试用，生产代码不调用 */
export function setClothDataFetcher(fetcher: typeof fetch | null): void {
  fetcherOverride = fetcher
}

/** 清空缓存与名称映射状态并恢复默认配置/注入；应用退出与测试重置用 */
export function disposeClothDataService(): void {
  resultCache.clear()
  nameMaps.clear()
  nameMapInFlight.clear()
  nameMapFailedAt.clear()
  config = { ...DEFAULT_CLOTH_DATA_CONFIG }
  fetcherOverride = null
}

// ============================================================
// 单 ID 查询链
// ============================================================

async function lookupOne(id: number): Promise<ClothDataInfo> {
  const kind = routeKind(id)
  if (!kind) {
    logger.debug(`[clothData] ID 位数不匹配（既非 10 位单品也非 5 位套装），跳过网络查询：${id}`)
    const empty: ClothDataInfo = {}
    cachePut(id, empty)
    return empty
  }

  try {
    const raw = await fetchJson(buildDataApiUrl(kind, id))
    const name = await lookupName(kind, id)
    const tags = extractTags(raw)
    const info: ClothDataInfo = { iconUrl: buildIconUrl(kind, id), raw }
    if (name !== undefined) info.name = name
    if (tags !== undefined) info.tags = tags
    cachePut(id, info)
    logger.debug(`[clothData] 服饰 ID 查询成功：${id}`)
    return info
  } catch (err) {
    if (err instanceof ClothDataHttpError && (err.status === 400 || err.status === 404)) {
      logger.debug(`[clothData] 服饰 ID 未收录（HTTP ${err.status}），负缓存：${id}`)
      const empty: ClothDataInfo = {}
      cachePut(id, empty)
      return empty
    }
    logger.warn(`[clothData] 服饰数据查询失败，静默降级：${describeError(err)}`)
    return {}
  }
}

/** 名称映射仅在目录 API 成功后加载（失败不浪费全量 JSON 下载） */
async function lookupName(kind: NameMapKind, id: number): Promise<string | undefined> {
  const map = await ensureNameMap(kind)
  if (!map) return undefined
  return readNameFromMap(map, kind, String(id))
}

async function ensureNameMap(kind: NameMapKind): Promise<Record<string, unknown> | null> {
  const cached = nameMaps.get(kind)
  if (cached) return cached

  const failedAt = nameMapFailedAt.get(kind)
  if (failedAt !== undefined && Date.now() - failedAt < config.nameMapRetryCooldownMs) {
    return null
  }

  const inFlight = nameMapInFlight.get(kind)
  if (inFlight) return inFlight

  const promise = (async () => {
    try {
      const body = await fetchJson(buildNameMapUrl(kind))
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new ClothDataProtocolError(`名称映射响应不是对象`)
      }
      const map = body as Record<string, unknown>
      nameMaps.set(kind, map)
      logger.debug(`[clothData] 服饰名称映射加载完成：${kind}`)
      return map
    } catch (err) {
      nameMapFailedAt.set(kind, Date.now())
      logger.warn(
        `[clothData] 服饰名称映射加载失败（冷却 ${Math.round(config.nameMapRetryCooldownMs / 1000)}s 后重试）：${describeError(err)}`
      )
      return null
    } finally {
      nameMapInFlight.delete(kind)
    }
  })()
  nameMapInFlight.set(kind, promise)
  return promise
}

// ============================================================
// URL 构造与安全守卫
// ============================================================

function buildDataApiUrl(kind: NameMapKind, id: number): string {
  return `${config.dataApiBase}/${kind === 'item' ? 'items' : 'outfits'}/${id}`
}

function buildIconUrl(kind: NameMapKind, id: number): string {
  return kind === 'item'
    ? `${config.cdnBase}/items/icons/${id}.png`
    : `${config.cdnBase}/outfits/${id}.png`
}

function buildNameMapUrl(kind: NameMapKind): string {
  return `${config.nameIndexBase}/${config.locale}/${kind}.json`
}

class ClothDataHttpError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`)
    this.name = 'ClothDataHttpError'
  }
}

class ClothDataGuardError extends Error {
  constructor(category: string) {
    super(category)
    this.name = 'ClothDataGuardError'
  }
}

/** 数据协议/解析类失败（响应形态不符、超出大小上限）——内部控制流用，对外不抛出 */
class ClothDataProtocolError extends Error {
  constructor(category: string) {
    super(category)
    this.name = 'ClothDataProtocolError'
  }
}

/**
 * 出站 URL 安全守卫（Mimosa 约束）：仅允许 http/https；host 精确白名单；
 * 显式拒绝 localhost、环回、私有与保留地址（白名单之外再兜底，防配置误填）。
 */
function assertSafeRemoteUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ClothDataGuardError(`URL 解析失败`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ClothDataGuardError(`协议不在 http/https 白名单内：${parsed.protocol}`)
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (isForbiddenHost(host)) {
    throw new ClothDataGuardError(`host 属于 localhost/环回/私网/保留地址：${host}`)
  }
  if (!config.allowedHosts.includes(host)) {
    throw new ClothDataGuardError(`host 不在白名单内：${host}`)
  }
}

/** 环回/私网/保留地址判定（IPv4 字面量 + 常见 IPv6 形态；白名单场景下的兜底防线） */
function isForbiddenHost(host: string): boolean {
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

// ============================================================
// 网络与解析
// ============================================================

async function fetchJson(url: string): Promise<unknown> {
  assertSafeRemoteUrl(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`请求超时`)), config.timeoutMs)
  try {
    const res = await getFetcher()(url, { signal: controller.signal, redirect: 'error' })
    if (!res.ok) throw new ClothDataHttpError(res.status)
    const text = await res.text()
    if (Buffer.byteLength(text) > config.maxResponseBytes) {
      throw new ClothDataProtocolError(`响应体超过大小上限`)
    }
    return JSON.parse(text) as unknown
  } finally {
    clearTimeout(timer)
  }
}

function getFetcher(): typeof fetch {
  if (fetcherOverride) return fetcherOverride
  return (...args: Parameters<typeof fetch>) => globalThis.fetch(...args)
}

// ============================================================
// 解析辅助
// ============================================================

function routeKind(id: number): NameMapKind | null {
  const digits = String(id).length
  if (digits === 10) return 'item'
  if (digits === 5) return 'outfit'
  return null
}

/**
 * 目录 API 响应 → 标签列表（category/subcategory/metadata 的字符串值，英文原样）。
 * props 为数字属性 ID 且无公开图例，仅保留在 raw 中。
 */
function extractTags(raw: unknown): string[] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const attrs = (raw as Record<string, unknown>).item_attributes
  if (typeof attrs !== 'object' || attrs === null) return undefined
  const { category, subcategory, metadata } = attrs as Record<string, unknown>
  const tags: string[] = []
  for (const value of [category, subcategory]) {
    if (typeof value === 'string' && value) tags.push(value)
  }
  if (typeof metadata === 'object' && metadata !== null) {
    for (const value of Object.values(metadata as Record<string, unknown>)) {
      if (typeof value === 'string' && value) tags.push(value)
    }
  }
  return tags.length > 0 ? tags : undefined
}

/** 名称映射查表：兼容 i18next 嵌套形态与 `item.<id>.name` 平铺键两种布局 */
function readNameFromMap(
  map: Record<string, unknown>,
  kind: NameMapKind,
  idStr: string
): string | undefined {
  const nested = map[kind]
  if (typeof nested === 'object' && nested !== null) {
    const entry = (nested as Record<string, unknown>)[idStr]
    if (typeof entry === 'object' && entry !== null) {
      const name = (entry as Record<string, unknown>).name
      if (typeof name === 'string' && name) return name
    }
  }
  const flat = map[`${kind}.${idStr}.name`]
  if (typeof flat === 'string' && flat) return flat
  return undefined
}

// ============================================================
// 缓存（进程内 Map-LRU，照 media-protocol 的 delete+set 移末尾模式）
// ============================================================

function cacheGet(id: number): ClothDataInfo | undefined {
  const cached = resultCache.get(id)
  if (cached === undefined) return undefined
  // 命中时 delete+set 把 key 移到 Map 末尾，实现 LRU 最近访问优先
  resultCache.delete(id)
  resultCache.set(id, cached)
  return cached
}

function cachePut(id: number, info: ClothDataInfo): void {
  const max = config.cacheMaxEntries
  if (max <= 0) return
  if (resultCache.has(id)) resultCache.delete(id)
  resultCache.set(id, info)
  while (resultCache.size > max) {
    const oldestKey = resultCache.keys().next().value
    if (oldestKey === undefined) break
    resultCache.delete(oldestKey)
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
