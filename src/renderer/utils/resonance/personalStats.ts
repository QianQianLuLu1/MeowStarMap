/**
 * 个人统计（逻辑复用自 gongeo.us-nikki-tracker 的
 * app/composables/usePersonalStats.ts，MIT, dastrokes）。
 *
 * 与源实现的差异：源为 Pinia computed 集合，此处改为纯函数——入参为
 * processBannerPullData 的产物与百分位快照（可为 null 降级），便于测试与复用。
 */
import {
  getAvg4StarType3Percentile,
  getAvg5StarPercentile,
  getBannerAvg4StarType3Percentile,
  getBannerAvg5StarPercentile,
  type PercentileData
} from './percentile'
import type { Banner, ProcessedBanner } from './types'

export interface BannerLuckEntry {
  bannerId: number
  bannerType: number
  totalPulls: number
  avg5StarPulls: number
  percentile: number | null
}

export interface BannerLuckType3Entry {
  bannerId: number
  totalPulls: number
  avg4StarPulls: number
  percentile: number | null
}

export interface PullActivityPoint {
  bannerId: number
  count: number
  cumulative: number
}

export interface PersonalStatsInput {
  processedPulls: Record<string, ProcessedBanner>
  banners: Record<string, Banner>
  percentileData: PercentileData | null
}

export interface PersonalStatsOverview {
  pulls5StarBanners: number
  pulls4StarBanners: number
  bannersPulled5Star: number
  bannersPulled4Star: number
  outfitsObtained5Star: number
  outfitsObtained4Star: number
}

export const computeOverview = ({
  processedPulls,
  banners
}: Pick<PersonalStatsInput, 'processedPulls' | 'banners'>): PersonalStatsOverview => {
  const obtained5 = new Set<string>()
  const obtained4 = new Set<string>()
  const available5 = new Set<string>()
  const available4 = new Set<string>()

  Object.values(banners).forEach((banner) => {
    if (banner.bannerType === 1) return
    banner.outfit5StarId?.forEach((id) => available5.add(id))
    banner.outfit4StarId?.forEach((id) => available4.add(id))
  })

  Object.entries(processedPulls).forEach(([idStr, banner]) => {
    const bannerId = Number.parseInt(idStr, 10)
    if (bannerId === 1 || banner.bannerType === 1) return

    if (!banner?.outfits) return
    banner.outfits.forEach((outfit) => {
      if (outfit.obtainedItems > 0) {
        if (available5.has(outfit.id)) {
          obtained5.add(outfit.id)
        } else if (available4.has(outfit.id)) {
          obtained4.add(outfit.id)
        }
      }
    })
  })

  return {
    pulls5StarBanners: Object.values(processedPulls)
      .filter((banner) => banner.bannerType === 2)
      .reduce((acc, banner) => acc + (banner.stats?.totalPulls || 0), 0),
    pulls4StarBanners: Object.values(processedPulls)
      .filter((banner) => banner.bannerType === 3)
      .reduce((acc, banner) => acc + (banner.stats?.totalPulls || 0), 0),
    bannersPulled5Star: Object.values(processedPulls).filter(
      (banner) => banner.bannerType === 2 && (banner?.stats?.totalPulls ?? 0) > 0
    ).length,
    bannersPulled4Star: Object.values(processedPulls).filter(
      (banner) => banner.bannerType === 3 && (banner?.stats?.totalPulls ?? 0) > 0
    ).length,
    outfitsObtained5Star: obtained5.size,
    outfitsObtained4Star: obtained4.size
  }
}

/**
 * 总欧非百分位：5★ 百分位 ×0.8 + 限定4★池百分位 ×0.2；缺一项以 50 代入；
 * 两者皆无或快照缺失返回 null（UI 隐藏区块）。
 */
export const computeOverallLuckPercentile = ({
  processedPulls,
  percentileData
}: Pick<PersonalStatsInput, 'processedPulls' | 'percentileData'>): number | null => {
  if (!percentileData) return null

  const stats = Object.values(processedPulls)
  const total5StarPulls = stats
    .filter((b) => b.bannerType === 2)
    .reduce((acc, b) => acc + (b.stats?.total5StarPulls || 0), 0)
  const total5StarItems = stats
    .filter((b) => b.bannerType === 2)
    .reduce((acc, b) => acc + (b.stats?.total5StarItems || 0), 0)
  const total4StarOnlyPulls = stats
    .filter((b) => b.bannerType === 3)
    .reduce((acc, b) => acc + (b.stats?.total4StarOnlyPulls || 0), 0)
  const total4StarOnlyItems = stats
    .filter((b) => b.bannerType === 3)
    .reduce((acc, b) => acc + (b.stats?.total4StarOnlyItems || 0), 0)

  const avg5Star = total5StarItems > 0 ? total5StarPulls / total5StarItems : 0
  const avg4StarType3 = total4StarOnlyItems > 0 ? total4StarOnlyPulls / total4StarOnlyItems : 0

  const has5Star = avg5Star > 0
  const has4StarType3 = avg4StarType3 > 0

  if (!has5Star && !has4StarType3) return 50

  const p5 = has5Star ? (getAvg5StarPercentile(avg5Star, percentileData) ?? 50) : 50
  const p4 = has4StarType3 ? (getAvg4StarType3Percentile(avg4StarType3, percentileData) ?? 50) : 50

  if (has5Star && !has4StarType3) return p5
  if (!has5Star && has4StarType3) return p4

  return p5 * 0.8 + p4 * 0.2
}

/** 欧非档位：百分位六等分 → 1..6（越高越欧） */
export const computeLuckTier = (percentile: number | null): number | null => {
  if (percentile === null) return null
  const p = percentile
  if (p < 100 / 6) return 1
  if (p < 200 / 6) return 2
  if (p < 300 / 6) return 3
  if (p < 400 / 6) return 4
  if (p < 500 / 6) return 5
  return 6
}

export const computeBannerLuckRanking = ({
  processedPulls,
  percentileData
}: Pick<PersonalStatsInput, 'processedPulls' | 'percentileData'>): BannerLuckEntry[] => {
  const entries: BannerLuckEntry[] = []
  Object.entries(processedPulls).forEach(([idStr, banner]) => {
    if (!banner?.stats || banner.bannerType !== 2) return
    if (banner.stats.total5StarItems === 0) return
    const percentile = getBannerAvg5StarPercentile(banner.stats.avg5StarPulls, percentileData)
    entries.push({
      bannerId: Number.parseInt(idStr, 10),
      bannerType: banner.bannerType,
      totalPulls: banner.stats.totalPulls,
      avg5StarPulls: banner.stats.avg5StarPulls,
      percentile
    })
  })
  return entries.sort((a, b) => (b.percentile ?? -1) - (a.percentile ?? -1))
}

export const computeBannerLuckRankingType3 = ({
  processedPulls,
  percentileData
}: Pick<PersonalStatsInput, 'processedPulls' | 'percentileData'>): BannerLuckType3Entry[] => {
  const entries: BannerLuckType3Entry[] = []
  Object.entries(processedPulls).forEach(([idStr, banner]) => {
    if (!banner?.stats || banner.bannerType !== 3) return
    if (banner.stats.total4StarOnlyItems === 0) return
    const percentile = getBannerAvg4StarType3Percentile(
      banner.stats.avg4StarOnlyPulls,
      percentileData
    )
    entries.push({
      bannerId: Number.parseInt(idStr, 10),
      totalPulls: banner.stats.totalPulls,
      avg4StarPulls: banner.stats.avg4StarOnlyPulls,
      percentile
    })
  })
  return entries.sort((a, b) => (b.percentile ?? -1) - (a.percentile ?? -1))
}

/** 出货分布直方图：以 pullsToObtain 为桶（不含未获得占位与手动补录） */
export const computeDistribution = (
  processedPulls: Record<string, ProcessedBanner>,
  quality: 4 | 5
): { pullsToObtain: number; count: number }[] => {
  const buckets = new Map<number, number>()
  Object.values(processedPulls).forEach((banner) => {
    banner.pulls.forEach((pull) => {
      if (pull.quality !== quality) return
      if (pull.pullIndex <= 0) return // 手动补录（负）与未获得占位（0）
      if (pull.pullsToObtain <= 0) return
      buckets.set(pull.pullsToObtain, (buckets.get(pull.pullsToObtain) ?? 0) + 1)
    })
  })
  return Array.from(buckets.entries())
    .map(([pullsToObtain, count]) => ({ pullsToObtain, count }))
    .sort((a, b) => a.pullsToObtain - b.pullsToObtain)
}

/** 按卡池顺序的抽数与累计曲线（按卡池 id 升序） */
export const computePullActivity = (
  processedPulls: Record<string, ProcessedBanner>
): PullActivityPoint[] => {
  const points: PullActivityPoint[] = []
  let cumulative = 0
  Object.values(processedPulls)
    .slice()
    .sort((a, b) => a.bannerId - b.bannerId)
    .forEach((banner) => {
      if (banner.stats.totalPulls <= 0) return
      cumulative += banner.stats.totalPulls
      points.push({
        bannerId: banner.bannerId,
        count: banner.stats.totalPulls,
        cumulative
      })
    })
  return points
}
