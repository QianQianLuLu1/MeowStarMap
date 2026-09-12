/**
 * 保底与统计核心处理（逻辑复用自 gongeo.us-nikki-tracker 的
 * app/composables/useBannerPullData.ts processBannerPullData、
 * app/utils/stats.ts computeGlobalStats、app/composables/usePearpalData.ts
 * processPearpalData 纯转换部分 —— MIT, dastrokes）。
 *
 * 与源实现的差异：
 * - 剥离 Pinia/composable 包装与联网的 useBannerPullApi 耦合，改为纯函数；
 * - 静态卡池/套装数据经 deps 注入，测试可注入合成数据；
 * - 常驻池 open-end 的 runs.end 快照由生成脚本固定，不影响计算。
 */
import type {
  Banner,
  BannerStats,
  BannerType,
  EditRecord,
  EvoRecord,
  GlobalStats,
  OutfitStatus,
  PearpalTrackerItem,
  ProcessedBanner,
  PullItem,
  PullRecord,
  ProcessDeps
} from './types'
import { maxOf } from '../../../shared/utils/extremum'

// 供既有测试与调用方沿用原导入路径
export type { ProcessDeps } from './types'

/** 物品 id（10 位）末 4 位加前缀 1 推导套装 id */
export function getOutfitIdFromItemId(itemId: string): string {
  const last4Digits = itemId.slice(-4)
  return `1${last4Digits}`
}

export function getBannerOutfitIds(banner: Banner | undefined): {
  outfit4StarId: string[]
  outfit5StarId: string[]
} {
  if (!banner) return { outfit4StarId: [], outfit5StarId: [] }
  return {
    outfit4StarId: banner.outfit4StarId || [],
    outfit5StarId: banner.outfit5StarId || []
  }
}

const EPOCH_ISO = new Date(0).toISOString()

function createEmptyBannerStats(): BannerStats {
  return {
    lastPull: EPOCH_ISO,
    totalPulls: 0,
    totalItems: 0,
    pity4Star: 0,
    pity5Star: 0,
    avg4StarPulls: 0,
    avg5StarPulls: 0,
    avg4StarOnlyPulls: 0,
    total4StarItems: 0,
    total5StarItems: 0,
    total4StarOnlyItems: 0,
    total4StarPulls: 0,
    total5StarPulls: 0,
    total4StarOnlyPulls: 0,
    completion: 0
  }
}

/**
 * 逐卡池处理抽卡记录：
 * - 每个卡池 4★/5★ 各自独立垫抽计数器，跨卡池不累计、互不继承；
 * - 命中卡池套装的记录记录 pullsToObtain（该品质当前垫抽数）并清零计数器；
 * - type-3（限定4★）池的 4★ 计入 4StarOnly 系列统计；
 * - edits（手动补录）不参与保底，pullIndex 用负数递减；
 * - pulls 数组保持最新在前；calculateStats（传入 edits）时补全完成度统计，
 *   并为卡池内未获得部件追加占位 PullItem（count=0，obtainedAt=''）。
 */
export function processBannerPullData(
  pullsByBanner: Record<number, PullRecord[]>,
  editsByBanner: Record<number, EditRecord[]> | undefined,
  deps: ProcessDeps
): Record<string, ProcessedBanner> {
  const calculateStats = !!editsByBanner
  const processedPulls: Record<string, ProcessedBanner> = {}
  const currentPity: Record<string, Record<number, number>> = {}

  const bannerIds = new Set<number>([
    ...Object.keys(pullsByBanner).map(Number),
    ...Object.keys(editsByBanner ?? {}).map(Number)
  ])

  for (const bannerId of bannerIds) {
    const bannerInfo = deps.getBanner(bannerId)
    const bannerType: BannerType = bannerInfo?.bannerType ?? 1
    const { outfit4StarId, outfit5StarId } = getBannerOutfitIds(bannerInfo)
    const outfit4StarSet = new Set(outfit4StarId)
    const outfit5StarSet = new Set(outfit5StarId)

    currentPity[bannerId] = { 4: 0, 5: 0 }
    const currentBanner: ProcessedBanner = {
      pulls: [],
      outfits: [],
      stats: createEmptyBannerStats(),
      bannerId,
      bannerType
    }
    processedPulls[String(bannerId)] = currentBanner

    for (const outfitId of [...outfit5StarId, ...outfit4StarId]) {
      const items = deps.getOutfitItems(outfitId)
      if (items) {
        currentBanner.outfits.push({
          id: outfitId,
          quality: outfit5StarSet.has(outfitId) ? 5 : 4,
          items,
          completion: 0,
          totalItems: items.length,
          obtainedItems: 0
        })
      }
    }

    const pulls = pullsByBanner[bannerId] || []
    const pullsArray: PullItem[] = []
    let pullIndex = 0

    let fourStarCount = 0
    let fiveStarCount = 0
    let fourStarPullsSum = 0
    let fiveStarPullsSum = 0
    let fourStarOnlyCount = 0
    let fourStarOnlyPullsSum = 0

    for (let i = pulls.length - 1; i >= 0; i--) {
      const pull = pulls[i]
      if (!pull) continue

      const [time, itemId] = pull

      currentBanner.stats.totalPulls++
      const pityRecord = currentPity[bannerId]!
      pityRecord[4] = (pityRecord[4] ?? 0) + 1
      pityRecord[5] = (pityRecord[5] ?? 0) + 1
      pullIndex++

      const outfitId = getOutfitIdFromItemId(itemId)
      let quality = 0

      if (outfit5StarSet.has(outfitId)) {
        quality = 5
      } else if (outfit4StarSet.has(outfitId)) {
        quality = 4
      }

      if (quality !== 0) {
        const pullsToObtain = pityRecord[quality] ?? 0
        pityRecord[quality] = 0

        pullsArray.push({
          pullIndex,
          itemId,
          outfitId,
          quality,
          pullsToObtain,
          obtainedAt: time,
          bannerId,
          count: 0
        })
        currentBanner.stats.totalItems++

        if (quality === 4) {
          if (bannerType === 3) {
            fourStarOnlyCount++
            fourStarOnlyPullsSum += pullsToObtain
          } else {
            fourStarCount++
            fourStarPullsSum += pullsToObtain
          }
        } else if (quality === 5) {
          fiveStarCount++
          fiveStarPullsSum += pullsToObtain
        }
      }

      currentBanner.stats.lastPull = time || currentBanner.stats.lastPull
    }

    currentBanner.pulls = pullsArray.reverse()

    const stats = currentBanner.stats
    if (bannerType === 1 || bannerType === 2) {
      stats.total4StarItems = fourStarCount
      stats.total5StarItems = fiveStarCount
      stats.total4StarPulls = fourStarPullsSum
      stats.total5StarPulls = fiveStarPullsSum
      stats.avg4StarPulls = fourStarCount > 0 ? fourStarPullsSum / fourStarCount : 0
      stats.avg5StarPulls = fiveStarCount > 0 ? fiveStarPullsSum / fiveStarCount : 0
      stats.total4StarOnlyItems = 0
      stats.avg4StarOnlyPulls = 0
    } else {
      stats.total4StarItems = 0
      stats.total5StarItems = 0
      stats.total4StarOnlyItems = fourStarOnlyCount
      stats.total4StarOnlyPulls = fourStarOnlyPullsSum
      stats.avg4StarPulls = 0
      stats.avg5StarPulls = 0
      stats.avg4StarOnlyPulls = fourStarOnlyCount > 0 ? fourStarOnlyPullsSum / fourStarOnlyCount : 0
    }

    stats.pity4Star = currentPity[bannerId]?.[4] ?? 0
    stats.pity5Star = currentPity[bannerId]?.[5] ?? 0

    if (calculateStats) {
      const edits = editsByBanner?.[bannerId] || []

      let editPullIndex = 0
      const editPulls: PullItem[] = []

      for (const edit of edits) {
        const [time, itemId] = edit
        const outfitId = getOutfitIdFromItemId(itemId)
        let quality = 0

        if (outfit5StarSet.has(outfitId)) {
          quality = 5
        } else if (outfit4StarSet.has(outfitId)) {
          quality = 4
        }

        editPullIndex--
        editPulls.push({
          pullIndex: editPullIndex,
          itemId,
          outfitId,
          quality,
          pullsToObtain: 0,
          obtainedAt: time,
          bannerId,
          count: 0
        })
      }

      const allPulls = [...currentBanner.pulls, ...editPulls].reverse()

      const itemCount: Record<string, number> = {}
      const pullsByOutfit: Record<string, Set<string>> = {}

      for (const pull of allPulls) {
        itemCount[pull.itemId] = (itemCount[pull.itemId] || 0) + 1
        pull.count = itemCount[pull.itemId]!

        if (!pullsByOutfit[pull.outfitId]) {
          pullsByOutfit[pull.outfitId] = new Set()
        }
        if (pull.count > 0) {
          pullsByOutfit[pull.outfitId]!.add(pull.itemId)
        }
      }

      currentBanner.pulls = allPulls

      let totalCompletion = 0
      for (const outfit of currentBanner.outfits) {
        const obtainedItemIds = pullsByOutfit[outfit.id]
        outfit.obtainedItems = obtainedItemIds ? obtainedItemIds.size : 0
        outfit.completion =
          outfit.totalItems > 0 ? Math.floor(outfit.obtainedItems / outfit.totalItems) : 0
        totalCompletion += Math.min(outfit.completion, 2)
      }

      const average =
        currentBanner.outfits.length > 0 ? totalCompletion / currentBanner.outfits.length : 0
      currentBanner.stats.completion = Math.floor(average)
    }
  }

  return processedPulls
}

/** 为卡池内未获得的部件追加占位 PullItem（count=0、obtainedAt=''），保持源站展示语义 */
export function addMissingItems(banner: ProcessedBanner, deps: ProcessDeps): void {
  const bannerInfo = deps.getBanner(banner.bannerId)
  if (!bannerInfo) return

  const existingItems = new Set(banner.pulls.map((pull) => pull.itemId))

  banner.outfits.forEach((outfit) => {
    outfit.items.forEach((itemId) => {
      if (!existingItems.has(itemId)) {
        banner.pulls.push({
          pullIndex: 0,
          itemId,
          outfitId: outfit.id,
          quality: outfit.quality,
          pullsToObtain: 0,
          obtainedAt: '',
          bannerId: banner.bannerId,
          count: 0
        })
      }
    })
  })
}

/** 全局聚合：限定 5★ 池贡献 4★/5★ 均值，限定 4★ 池贡献 4StarOnly 均值，常驻池不计入套装数 */
export function computeGlobalStats(processed: Record<string, ProcessedBanner>): GlobalStats {
  const globalStats: GlobalStats = {
    totalPulls: 0,
    total4StarItems: 0,
    total5StarItems: 0,
    total4StarOnlyItems: 0,
    avg5StarPulls: 0,
    avg4StarPulls: 0,
    avg4StarOnlyPulls: 0
  }

  let total4StarPulls = 0
  let total5StarPulls = 0
  let total4StarOnlyPulls = 0
  let fourStarCount = 0
  let fiveStarCount = 0
  let fourStarOnlyCount = 0

  Object.values(processed).forEach((banner) => {
    if (!banner?.stats) return

    globalStats.totalPulls += banner.stats.totalPulls

    if (banner.bannerType !== 1) {
      globalStats.total4StarItems += banner.stats.total4StarItems
      globalStats.total5StarItems += banner.stats.total5StarItems
    }

    globalStats.total4StarOnlyItems += banner.stats.total4StarOnlyItems

    if (banner.bannerType === 2) {
      total4StarPulls += banner.stats.total4StarPulls
      total5StarPulls += banner.stats.total5StarPulls
      fourStarCount += banner.stats.total4StarItems
      fiveStarCount += banner.stats.total5StarItems
    } else if (banner.bannerType === 3) {
      total4StarOnlyPulls += banner.stats.total4StarOnlyPulls
      fourStarOnlyCount += banner.stats.total4StarOnlyItems
    }
  })

  globalStats.avg4StarPulls = fourStarCount > 0 ? total4StarPulls / fourStarCount : 0
  globalStats.avg5StarPulls = fiveStarCount > 0 ? total5StarPulls / fiveStarCount : 0
  globalStats.avg4StarOnlyPulls =
    fourStarOnlyCount > 0 ? total4StarOnlyPulls / fourStarOnlyCount : 0

  return globalStats
}

/**
 * Pearpal 手账数据 → ProcessedBanner（纯转换；源数据来自本地导入文件而非 API）。
 * pullsToObtain 直接取官方载荷的 times_from_last_X_stars + 1；当前垫抽无法追踪（置 0）；
 * 时间用导入时刻充数（与源实现一致）；totalPulls = max(pool_cnt) + 1。
 */
export function processPearpalData(
  bannerData: Record<number, PearpalTrackerItem[]>,
  deps: ProcessDeps,
  now: Date = new Date()
): Record<string, ProcessedBanner> {
  Object.values(bannerData).forEach((items) => {
    items.sort((a, b) => a.pool_cnt - b.pool_cnt)
  })

  const processedBanners: Record<string, ProcessedBanner> = {}

  Object.entries(bannerData).forEach(([bannerIdStr, items]) => {
    const bannerId = Number.parseInt(bannerIdStr, 10)
    const bannerInfo = deps.getBanner(bannerId)

    if (!bannerInfo || items.length === 0) return

    const { outfit4StarId, outfit5StarId } = getBannerOutfitIds(bannerInfo)

    const processedPulls: PullItem[] = []
    let total4StarItems = 0
    let total5StarItems = 0
    let total4StarPulls = 0
    let total5StarPulls = 0
    let total4StarOnlyItems = 0
    let total4StarOnlyPulls = 0
    const timestamp = now.toISOString().slice(0, 19).replace('T', ' ')
    const lastPullTime = timestamp

    const itemCount: Record<string, number> = {}

    items.forEach((item) => {
      const outfitId = getOutfitIdFromItemId(item.result)
      const quality = Number.parseInt(item.rarity, 10)
      const pullsToObtain =
        quality === 5 ? item.times_from_last_five_stars + 1 : item.times_from_last_four_stars + 1

      itemCount[item.result] = (itemCount[item.result] || 0) + 1

      processedPulls.push({
        pullIndex: item.pool_cnt + 1,
        itemId: item.result,
        outfitId,
        quality,
        pullsToObtain,
        obtainedAt: timestamp,
        bannerId,
        count: itemCount[item.result]!
      })

      if (quality === 4) {
        if (bannerInfo.bannerType === 3) {
          total4StarOnlyItems++
          total4StarOnlyPulls += pullsToObtain
        } else {
          total4StarItems++
          total4StarPulls += pullsToObtain
        }
      } else if (quality === 5) {
        total5StarItems++
        total5StarPulls += pullsToObtain
      }
    })

    const totalPulls = maxOf(items, (item) => item.pool_cnt + 1)

    const pulledItemIds = new Set(processedPulls.map((pull) => pull.itemId))
    const outfits: OutfitStatus[] = []
    for (const outfitId of [...outfit5StarId, ...outfit4StarId]) {
      const outfitItems = deps.getOutfitItems(outfitId)
      if (!outfitItems) continue
      outfits.push({
        id: outfitId,
        quality: outfit5StarId.includes(outfitId) ? 5 : 4,
        items: outfitItems,
        completion: 0,
        totalItems: outfitItems.length,
        obtainedItems: 0
      })
      outfitItems.forEach((itemId) => {
        if (!pulledItemIds.has(itemId)) {
          processedPulls.push({
            pullIndex: 0,
            itemId,
            outfitId,
            quality: outfit5StarId.includes(outfitId) ? 5 : 4,
            pullsToObtain: 0,
            obtainedAt: '',
            bannerId,
            count: 0
          })
        }
      })
    }

    const is4StarOnlyBanner = bannerInfo.bannerType === 3

    const stats: BannerStats = {
      lastPull: lastPullTime,
      totalPulls,
      totalItems: total4StarItems + total5StarItems + total4StarOnlyItems,
      pity4Star: 0,
      pity5Star: 0,
      avg4StarPulls:
        !is4StarOnlyBanner && total4StarItems > 0 ? total4StarPulls / total4StarItems : 0,
      avg5StarPulls:
        !is4StarOnlyBanner && total5StarItems > 0 ? total5StarPulls / total5StarItems : 0,
      avg4StarOnlyPulls:
        is4StarOnlyBanner && total4StarOnlyItems > 0
          ? total4StarOnlyPulls / total4StarOnlyItems
          : 0,
      total4StarItems: is4StarOnlyBanner ? 0 : total4StarItems,
      total5StarItems: is4StarOnlyBanner ? 0 : total5StarItems,
      total4StarOnlyItems: is4StarOnlyBanner ? total4StarOnlyItems : 0,
      total4StarPulls: is4StarOnlyBanner ? 0 : total4StarPulls,
      total5StarPulls: is4StarOnlyBanner ? 0 : total5StarPulls,
      total4StarOnlyPulls: is4StarOnlyBanner ? total4StarOnlyPulls : 0,
      completion: 0
    }

    processedBanners[String(bannerId)] = {
      pulls: processedPulls,
      outfits,
      stats,
      bannerId,
      bannerType: bannerInfo.bannerType
    }
  })

  return processedBanners
}

/** evo 覆盖表：bannerId → outfitId → level */
export function buildEvoLevelMap(
  evoData: Record<number, EvoRecord[]>
): Map<number, Map<string, number>> {
  const map = new Map<number, Map<string, number>>()
  Object.entries(evoData).forEach(([bannerIdStr, records]) => {
    const inner = new Map<string, number>()
    records.forEach(([outfitId, level]) => inner.set(outfitId, level))
    map.set(Number(bannerIdStr), inner)
  })
  return map
}
