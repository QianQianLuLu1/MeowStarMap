/**
 * 共鸣录处理层类型（逻辑复用自 gongeo.us-nikki-tracker，MIT, dastrokes 的
 * shared/types/pull.ts 与 shared/types/banner.ts，按宿主习惯重述）。
 */

/** 卡池类型：1=常驻 2=限定5★(含4★) 3=限定4★ */
export type BannerType = 1 | 2 | 3

export interface BannerRun {
  version: string
  start: string
  end: string
}

export interface Banner {
  bannerId: number
  bannerType: BannerType
  outfit4StarId: string[]
  outfit5StarId: string[]
  runs: BannerRun[]
  rewardIds?: string[]
}

/** 抽卡记录原始二元组：[获得时间, 物品 id] */
export type PullRecord = [string, string]
/** 手动补录二元组，与 PullRecord 同构 */
export type EditRecord = [string, string]
/** 进化覆盖记录：[套装 id, 等级 0-4] */
export type EvoRecord = [string, number]

export interface PullItem {
  pullIndex: number
  itemId: string
  outfitId: string
  quality: number
  pullsToObtain: number
  obtainedAt: string
  bannerId: number
  count: number
}

export interface OutfitStatus {
  id: string
  quality: number
  items: string[]
  completion: number
  totalItems: number
  obtainedItems: number
}

export interface BannerStats {
  lastPull: string
  totalPulls: number
  totalItems: number
  pity4Star: number
  pity5Star: number
  avg4StarPulls: number
  avg5StarPulls: number
  avg4StarOnlyPulls: number
  total4StarItems: number
  total5StarItems: number
  total4StarOnlyItems: number
  total4StarPulls: number
  total5StarPulls: number
  total4StarOnlyPulls: number
  completion: number
}

export interface ProcessedBanner {
  pulls: PullItem[]
  outfits: OutfitStatus[]
  stats: BannerStats
  bannerId: number
  bannerType: BannerType
}

export interface GlobalStats {
  totalPulls: number
  total4StarItems: number
  total5StarItems: number
  total4StarOnlyItems: number
  avg5StarPulls: number
  avg4StarPulls: number
  avg4StarOnlyPulls: number
}

/** Pearpal 手账单条记录（仅承接本地文件导入） */
export interface PearpalTrackerItem {
  card_pool_id: string
  pool_cnt: number
  result: string
  times_from_last_five_stars: number
  times_from_last_four_stars: number
  rarity: string
}

/** 静态数据依赖：卡池信息与套装→部件映射（process.ts 注入用） */
export interface ProcessDeps {
  getBanner(bannerId: number): Banner | undefined
  getOutfitItems(outfitId: string): string[] | undefined
}
