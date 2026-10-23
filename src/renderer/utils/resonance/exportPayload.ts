/**
 * 导出载荷组装（逻辑复用自 gongeo.us-nikki-tracker 的
 * app/utils/profileDataExport.ts createProfileDataExportPayload，MIT, dastrokes）。
 *
 * 输入为宿主 SQLite 行（ResonanceGetDataResult），输出与源站导出格式同构的
 * JSON 对象：pulls 保持最新在前；pearpal 回传原始对象保证 round-trip 保真；
 * 全部数据段为空时返回 null（无可导出内容）。
 */
import type {
  ResonanceBannerWishlistData,
  ResonanceExportOptions,
  ResonanceGetDataResult
} from '../../../shared/types/resonance'
import type { EditRecord, EvoRecord, PearpalTrackerItem, PullRecord } from './types'
import type { WardrobeData } from './wardrobe'

export interface ResonanceExportPayload {
  version: 1
  app: 'nikkigallery'
  exportedAt: string
  pulls: Record<string, PullRecord[]>
  edits: Record<string, EditRecord[]>
  evo: Record<string, EvoRecord[]>
  pearpal: Record<string, PearpalTrackerItem[]>
  wardrobe?: WardrobeData
  /** 卡池心愿单（与上游导出格式同名键；未勾选或空表时不落段） */
  bannerWishlist?: ResonanceBannerWishlistData
}

const filterNonEmptyRecord = <T>(data: Record<string, T[]>): Record<string, T[]> =>
  Object.fromEntries(Object.entries(data).filter(([, entries]) => entries.length > 0))

/** 时间串降序 = 最新在前（格式固定为 YYYY-MM-DD HH:mm:ss，字符串比较安全） */
const newestFirst = (a: PullRecord, b: PullRecord) => b[0].localeCompare(a[0])

export function buildExportPayload(
  data: ResonanceGetDataResult,
  options: Pick<
    ResonanceExportOptions,
    | 'includePulls'
    | 'includeEdits'
    | 'includePearpal'
    | 'includeEvo'
    | 'includeWardrobe'
    | 'includeWishlist'
  >,
  now: Date = new Date()
): ResonanceExportPayload | null {
  const pulls: Record<string, PullRecord[]> = {}
  if (options.includePulls) {
    const byBanner = new Map<string, PullRecord[]>()
    for (const row of data.pulls) {
      const list = byBanner.get(row.banner_id) ?? []
      list.push([row.obtained_at, row.item_id])
      byBanner.set(row.banner_id, list)
    }
    for (const [bannerId, list] of byBanner) {
      pulls[bannerId] = list.sort(newestFirst)
    }
  }

  const edits: Record<string, EditRecord[]> = {}
  if (options.includeEdits) {
    const byBanner = new Map<string, EditRecord[]>()
    for (const row of data.edits) {
      const list = byBanner.get(row.banner_id) ?? []
      list.push([row.obtained_at, row.item_id])
      byBanner.set(row.banner_id, list)
    }
    for (const [bannerId, list] of byBanner) {
      edits[bannerId] = list
    }
  }

  const evo: Record<string, EvoRecord[]> = {}
  if (options.includeEvo) {
    const byBanner = new Map<string, EvoRecord[]>()
    for (const row of data.evo) {
      const list = byBanner.get(row.banner_id) ?? []
      list.push([row.outfit_id, row.level])
      byBanner.set(row.banner_id, list)
    }
    for (const [bannerId, list] of byBanner) {
      evo[bannerId] = list
    }
  }

  const pearpal: Record<string, PearpalTrackerItem[]> = {}
  if (options.includePearpal) {
    const byBanner = new Map<string, PearpalTrackerItem[]>()
    for (const row of data.pearpal) {
      const list = byBanner.get(row.banner_id) ?? []
      list.push({ ...row.raw, card_pool_id: row.banner_id })
      byBanner.set(row.banner_id, list)
    }
    for (const [bannerId, list] of byBanner) {
      pearpal[bannerId] = list
    }
  }

  const includeWardrobe =
    options.includeWardrobe &&
    (data.wardrobe.ownedItemIds.length > 0 ||
      data.wardrobe.ownedMakeupIds.length > 0 ||
      data.wardrobe.ownedMomoIds.length > 0 ||
      data.wardrobe.ownedPropIds.length > 0 ||
      data.wardrobe.ownedEurekaColorIds.length > 0)

  const filteredPulls = filterNonEmptyRecord(pulls)
  const filteredEdits = filterNonEmptyRecord(edits)
  const filteredEvo = filterNonEmptyRecord(evo)
  const filteredPearpal = filterNonEmptyRecord(pearpal)

  const wishlist = data.wishlist ?? null
  const includeWishlist = options.includeWishlist === true && (wishlist?.entries.length ?? 0) > 0

  const isEmpty =
    Object.keys(filteredPulls).length === 0 &&
    Object.keys(filteredEdits).length === 0 &&
    Object.keys(filteredEvo).length === 0 &&
    Object.keys(filteredPearpal).length === 0 &&
    !includeWardrobe &&
    !includeWishlist

  if (isEmpty) return null

  return {
    version: 1,
    app: 'nikkigallery',
    exportedAt: now.toISOString(),
    pulls: filteredPulls,
    edits: filteredEdits,
    evo: filteredEvo,
    pearpal: filteredPearpal,
    ...(includeWardrobe ? { wardrobe: data.wardrobe } : {}),
    ...(includeWishlist && wishlist ? { bannerWishlist: wishlist } : {})
  }
}

export function getResonanceExportFileName(now: Date = new Date()): string {
  const iso = now.toISOString().split('T')[0] ?? ''
  return `meow-star-map-resonance-${iso}.json`
}
