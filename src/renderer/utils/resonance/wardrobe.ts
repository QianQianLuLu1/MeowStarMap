/**
 * 衣橱模型与汇总（逻辑复用自 gongeo.us-nikki-tracker 的
 * shared/utils/{wardrobe,wardrobeSummary,wardrobeTrackerImport}.ts 与
 * shared/utils/bannerCompletionLevels.ts，MIT, dastrokes）。
 *
 * 持久化语义由宿主 SQLite 承载（resonance_wardrobe_items 表）；本模块只处理
 * 内存中的 WardrobeData 同构形态与纯计算。
 */
import { isCatalogEntryAvailableInScope, normalizeCatalogRegionScope } from './catalogAvailability'
import { getItemVariantType, getOutfitVariantType, type VariantType } from './variants'
import type { Banner, EvoRecord, ProcessedBanner } from './types'

// ============ 基础模型 ============

export const WARDROBE_DATA_VERSION = 1 as const

export interface WardrobeData {
  version: typeof WARDROBE_DATA_VERSION
  ownedItemIds: number[]
  ownedMakeupIds: number[]
  ownedMomoIds: number[]
  ownedPropIds: number[]
  ownedEurekaColorIds: number[]
  updatedAt: string
}

export type WardrobeOutfitStatus = 'owned' | 'partial' | 'missing'

export interface WardrobeOutfitProgress {
  status: WardrobeOutfitStatus
  owned: number
  total: number
}

export const createEmptyWardrobeData = (): WardrobeData => ({
  version: WARDROBE_DATA_VERSION,
  ownedItemIds: [],
  ownedMakeupIds: [],
  ownedMomoIds: [],
  ownedPropIds: [],
  ownedEurekaColorIds: [],
  updatedAt: ''
})

const normalizeWardrobeItemId = (value: unknown): number | null => {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : null

  if (parsed === null || !Number.isInteger(parsed) || parsed <= 0) return null
  return parsed
}

export const normalizeWardrobeItemIds = (values: unknown): number[] => {
  if (!Array.isArray(values)) return []

  return Array.from(
    new Set(values.map(normalizeWardrobeItemId).filter((value): value is number => value !== null))
  ).sort((left, right) => left - right)
}

export const normalizeWardrobeData = (value: unknown): WardrobeData => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createEmptyWardrobeData()
  }

  const candidate = value as Partial<WardrobeData>
  const updatedAt = typeof candidate.updatedAt === 'string' ? candidate.updatedAt : ''

  return {
    version: WARDROBE_DATA_VERSION,
    ownedItemIds: normalizeWardrobeItemIds(candidate.ownedItemIds),
    ownedMakeupIds: normalizeWardrobeItemIds(candidate.ownedMakeupIds),
    ownedMomoIds: normalizeWardrobeItemIds(candidate.ownedMomoIds),
    ownedPropIds: normalizeWardrobeItemIds(candidate.ownedPropIds),
    ownedEurekaColorIds: normalizeWardrobeItemIds(candidate.ownedEurekaColorIds),
    updatedAt
  }
}

export const getWardrobeSetProgress = (
  itemIds: readonly number[],
  ownedItemIds: ReadonlySet<number>
): WardrobeOutfitProgress => {
  const normalizedItemIds = normalizeWardrobeItemIds([...itemIds])
  const total = normalizedItemIds.length
  const owned = normalizedItemIds.reduce(
    (count, itemId) => count + (ownedItemIds.has(itemId) ? 1 : 0),
    0
  )
  const status: WardrobeOutfitStatus =
    owned === total && total > 0 ? 'owned' : owned > 0 ? 'partial' : 'missing'

  return {
    status,
    owned,
    total
  }
}

export const getWardrobeOutfitProgress = getWardrobeSetProgress

// ============ 进化等级推断 ============

export type BannerOutfitVariantLevel = 'base' | 'glowup' | 'evo1' | 'evo2' | 'evo3'

export type BannerOutfitVariantLevelInput = {
  quality: number
  totalPulls: number
  outfitCompletion: number
  manualEvoLevel: number
}

export const getBannerOutfitVariantLevels = ({
  quality,
  totalPulls,
  outfitCompletion,
  manualEvoLevel
}: BannerOutfitVariantLevelInput): BannerOutfitVariantLevel[] => {
  if (outfitCompletion < 1 && manualEvoLevel < 1) return []

  const levels: BannerOutfitVariantLevel[] = ['base', 'glowup']

  if (quality === 5) {
    if (totalPulls >= 180 || manualEvoLevel >= 2) levels.push('evo1')
    if (totalPulls >= 230 || manualEvoLevel >= 3) levels.push('evo2')
    if (outfitCompletion >= 2 || manualEvoLevel >= 4) levels.push('evo3')
    return levels
  }

  if (quality === 4 && outfitCompletion >= 2) {
    levels.push('evo1')
  }

  return levels
}

export const toBannerDisplayLevelKey = (level: BannerOutfitVariantLevel) => {
  if (level === 'base') return '0'
  if (level === 'glowup') return '1'
  if (level === 'evo1') return '2'
  if (level === 'evo2') return '3'
  return '4'
}

// ============ 从共鸣记录推断衣橱 ============

export type WardrobeTrackerCatalogIndex = {
  itemById: ReadonlyMap<number, unknown>
  outfitItemsById: ReadonlyMap<number, readonly number[]>
  makeupById: ReadonlyMap<number, unknown>
  makeupItemsById: ReadonlyMap<number, readonly number[]>
  momoById: ReadonlyMap<number, unknown>
  fullMakeupIdsByOutfitId: ReadonlyMap<number, readonly number[]>
  momoIdsByOutfitId: ReadonlyMap<number, readonly number[]>
}

export type PropCatalogEntryLite = {
  id: number
  variantRootId?: number
  sources?: string[]
  bannerIds?: number[]
}

export type WardrobeTrackerImportInference = {
  itemIds: number[]
  makeupIds: number[]
  momoIds: number[]
  propIds: number[]
  found: {
    items: number
    makeups: number
    momo: number
    props: number
  }
  skipped: {
    partialFiveStarMakeupOutfits: number
  }
}

const toSafeId = (value: unknown) => {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

const getBaseOutfitIdNumber = (outfitId: string | number) => {
  const raw = String(outfitId)
  return raw.length === 7 ? Number(raw.slice(0, 5)) : Number(raw)
}

const getOutfitIdForVariantLevel = (outfitId: string | number, level: BannerOutfitVariantLevel) => {
  const baseId = getBaseOutfitIdNumber(outfitId)
  if (!Number.isSafeInteger(baseId)) return null

  if (level === 'base') return baseId
  if (level === 'glowup') return Number(`${baseId}01`)
  if (level === 'evo1') return Number(`${baseId}02`)
  if (level === 'evo2') return Number(`${baseId}03`)
  return Number(`${baseId}04`)
}

const isObtainedTrackerPull = (pull: { obtainedAt: string }) =>
  typeof pull.obtainedAt === 'string' && pull.obtainedAt.length > 0

const addValidId = (ids: Set<number>, catalogIds: ReadonlyMap<number, unknown>, value: unknown) => {
  const id = toSafeId(value)
  if (id !== null && catalogIds.has(id)) {
    ids.add(id)
  }
}

const getManualEvoLevel = (
  evoData: Record<number, EvoRecord[]> | undefined,
  bannerId: number,
  outfitId: string
) => evoData?.[bannerId]?.find(([id]) => id === outfitId)?.[1] ?? 0

export const mergeProcessedBannerSources = (
  sources: readonly Record<string, ProcessedBanner>[]
) => {
  const merged: Record<string, ProcessedBanner> = {}

  sources.forEach((source) => {
    Object.entries(source).forEach(([bannerId, banner]) => {
      const existing = merged[bannerId]
      if (!existing) {
        merged[bannerId] = banner
        return
      }

      const outfitsById = new Map(existing.outfits.map((outfit) => [outfit.id, outfit]))
      banner.outfits.forEach((outfit) => {
        const previous = outfitsById.get(outfit.id)
        if (!previous || outfit.completion > previous.completion) {
          outfitsById.set(outfit.id, outfit)
        }
      })

      merged[bannerId] = {
        ...existing,
        outfits: Array.from(outfitsById.values()),
        stats: {
          ...existing.stats,
          totalPulls: Math.max(existing.stats.totalPulls, banner.stats.totalPulls)
        }
      }
    })
  })

  return merged
}

export const inferWardrobeIdsFromTracker = ({
  processedBanners,
  evoData,
  catalogIndex,
  propEntries = [],
  bannerData
}: {
  processedBanners: Record<string, ProcessedBanner>
  evoData?: Record<number, EvoRecord[]>
  catalogIndex: WardrobeTrackerCatalogIndex
  propEntries?: readonly PropCatalogEntryLite[]
  bannerData: Record<string, Banner>
}): WardrobeTrackerImportInference => {
  const itemIds = new Set<number>()
  const makeupIds = new Set<number>()
  const momoIds = new Set<number>()
  const propIds = new Set<number>()
  let skippedPartialFiveStarMakeupOutfits = 0

  Object.values(processedBanners).forEach((banner) => {
    const bannerInfo = bannerData[String(banner.bannerId)]
    const isPermanent = bannerInfo?.bannerType === 1

    banner.pulls.forEach((pull) => {
      if (!isObtainedTrackerPull(pull)) return
      addValidId(itemIds, catalogIndex.itemById, pull.itemId)
    })

    if (!bannerInfo || isPermanent) return

    banner.outfits.forEach((outfit) => {
      const manualEvoLevel = getManualEvoLevel(evoData, banner.bannerId, outfit.id)
      const levels = getBannerOutfitVariantLevels({
        quality: outfit.quality,
        totalPulls: banner.stats.totalPulls,
        outfitCompletion: outfit.completion,
        manualEvoLevel
      })

      levels.forEach((level) => {
        const variantOutfitId = getOutfitIdForVariantLevel(outfit.id, level)
        if (variantOutfitId === null) return

        catalogIndex.outfitItemsById
          .get(variantOutfitId)
          ?.forEach((itemId) => addValidId(itemIds, catalogIndex.itemById, itemId))
      })

      if (outfit.quality === 5) {
        const baseOutfitId = getBaseOutfitIdNumber(outfit.id)
        const relatedFullMakeupIds = catalogIndex.fullMakeupIdsByOutfitId.get(baseOutfitId) ?? []

        if (banner.stats.totalPulls >= 100) {
          relatedFullMakeupIds.forEach((fullMakeupId) => {
            addValidId(makeupIds, catalogIndex.makeupById, fullMakeupId)
            catalogIndex.makeupItemsById
              .get(fullMakeupId)
              ?.forEach((makeupId) => addValidId(makeupIds, catalogIndex.makeupById, makeupId))
          })
        } else if (relatedFullMakeupIds.length > 0) {
          skippedPartialFiveStarMakeupOutfits += 1
        }

        if (banner.stats.totalPulls >= 140) {
          catalogIndex.momoIdsByOutfitId
            .get(baseOutfitId)
            ?.forEach((momoId) => addValidId(momoIds, catalogIndex.momoById, momoId))
        }
      }
    })

    if (bannerInfo.bannerType === 3 && bannerInfo.rewardIds?.length) {
      bannerInfo.rewardIds
        .slice(0, Math.floor(banner.stats.totalPulls / 5))
        .forEach((rewardId) => addValidId(itemIds, catalogIndex.itemById, rewardId))
    }

    const relatedBaseProps = propEntries.filter(
      (prop) =>
        prop.sources?.includes('resonance') &&
        prop.bannerIds?.includes(banner.bannerId) &&
        prop.variantRootId === undefined
    )
    if (banner.stats.totalPulls >= 160) {
      relatedBaseProps.forEach((prop) => propIds.add(prop.id))
    }

    if (banner.stats.totalPulls >= 230) {
      const relatedBasePropIds = new Set(relatedBaseProps.map((prop) => prop.id))
      propEntries
        .filter(
          (prop) => prop.variantRootId !== undefined && relatedBasePropIds.has(prop.variantRootId)
        )
        .forEach((prop) => propIds.add(prop.id))
    }
  })

  return {
    itemIds: Array.from(itemIds).sort((left, right) => left - right),
    makeupIds: Array.from(makeupIds).sort((left, right) => left - right),
    momoIds: Array.from(momoIds).sort((left, right) => left - right),
    propIds: Array.from(propIds).sort((left, right) => left - right),
    found: {
      items: itemIds.size,
      makeups: makeupIds.size,
      momo: momoIds.size,
      props: propIds.size
    },
    skipped: {
      partialFiveStarMakeupOutfits: skippedPartialFiveStarMakeupOutfits
    }
  }
}

// ============ 汇总 ============

export type WardrobeSummaryCatalogIndex = {
  items: Array<{
    id: number
    quality: number
    type: string
    catalogGroupRootId?: number
  }>
  outfits: Array<{
    id: number
  }>
  makeups: Array<{
    id: number
    type: string
    /**
     * 整妆基底性由调用方在构建索引时算出（对应上游 app/utils/catalogLocalIndex.ts：
     * fullMakeup 取部件前缀 getFullMakeupVariantType，其余取 getItemVariantType(id, catalogGroupRootId)）。
     */
    variantType: VariantType
  }>
  momo: Array<{
    id: number
  }>
  outfitItemsById: ReadonlyMap<number, number[]>
  makeupItemsById: ReadonlyMap<number, number[]>
}

export type WardrobeSummaryScope = 'base' | 'all'

export type WardrobeSummaryProgress = {
  total: number
  owned: number
  missing: number
  completionPercent: number
}

export type WardrobeSummaryOutfitProgress = {
  total: number
  owned: number
  partial: number
  missing: number
  completionPercent: number
}

export type WardrobeSummaryQualityRow = WardrobeSummaryProgress & {
  quality: number
}

export type WardrobeSummaryTypeRow = WardrobeSummaryProgress & {
  type: string
}

export type WardrobeSummaryNearCompleteOutfit = {
  id: number
  itemIds: number[]
  missingItemIds: number[]
  owned: number
  total: number
  missing: number
  completionPercent: number
}

export type WardrobeSummaryNearCompleteFullMakeup = {
  id: number
  makeupIds: number[]
  missingMakeupIds: number[]
  owned: number
  total: number
  missing: number
  completionPercent: number
}

export type WardrobeSummary = {
  items: WardrobeSummaryProgress
  outfits: WardrobeSummaryOutfitProgress
  makeups: WardrobeSummaryProgress
  fullMakeups: WardrobeSummaryOutfitProgress
  momo: WardrobeSummaryProgress
  qualityRows: WardrobeSummaryQualityRow[]
  typeRows: WardrobeSummaryTypeRow[]
  nearCompleteOutfits: WardrobeSummaryNearCompleteOutfit[]
  nearCompleteFullMakeups: WardrobeSummaryNearCompleteFullMakeup[]
}

const getCompletionPercent = (owned: number, total: number) => {
  if (total <= 0) return 0
  if (owned >= total) return 100

  return Math.min(Math.round((owned / total) * 100), 99)
}

const normalizeSummaryItemIds = (values: unknown): number[] => {
  if (!Array.isArray(values)) return []

  return Array.from(
    new Set(
      values
        .map((value) => {
          const parsed =
            typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : null

          return parsed !== null && Number.isInteger(parsed) && parsed > 0 ? parsed : null
        })
        .filter((value): value is number => value !== null)
    )
  ).sort((left, right) => left - right)
}

const createProgress = (owned: number, total: number): WardrobeSummaryProgress => {
  const missing = Math.max(total - owned, 0)

  return {
    total,
    owned,
    missing,
    completionPercent: getCompletionPercent(owned, total)
  }
}

const incrementGroup = <TKey extends string | number>(
  groups: Map<TKey, { total: number; owned: number }>,
  key: TKey,
  owned: boolean
) => {
  const current = groups.get(key) ?? { total: 0, owned: 0 }
  current.total += 1
  if (owned) {
    current.owned += 1
  }
  groups.set(key, current)
}

const isBaseSummaryItem = (item: { id: number; catalogGroupRootId?: number }) =>
  getItemVariantType(item.id, item.catalogGroupRootId) === 'base'

const isBaseSummaryOutfit = (outfit: { id: number }) =>
  getOutfitVariantType(String(outfit.id)) === 'base'

export const createWardrobeSummary = ({
  index,
  ownedItemIds,
  ownedMakeupIds = [],
  ownedMomoIds = [],
  nearCompleteLimit = 6,
  scope = 'base',
  regionScope = 'global'
}: {
  index: WardrobeSummaryCatalogIndex
  ownedItemIds: readonly number[]
  ownedMakeupIds?: readonly number[]
  ownedMomoIds?: readonly number[]
  nearCompleteLimit?: number
  scope?: WardrobeSummaryScope
  regionScope?: Parameters<typeof normalizeCatalogRegionScope>[0]
}): WardrobeSummary => {
  const normalizedRegionScope = normalizeCatalogRegionScope(regionScope)
  const items = (scope === 'all' ? index.items : index.items.filter(isBaseSummaryItem)).filter(
    (item) => isCatalogEntryAvailableInScope('item', item.id, normalizedRegionScope)
  )
  const makeups = (
    scope === 'all'
      ? index.makeups
      : index.makeups.filter((makeup) => makeup.variantType === 'base')
  ).filter((makeup) => isCatalogEntryAvailableInScope('makeup', makeup.id, normalizedRegionScope))
  const momoEntries = index.momo.filter((momo) =>
    isCatalogEntryAvailableInScope('momo', momo.id, normalizedRegionScope)
  )
  const makeupItems = makeups.filter((makeup) => makeup.type !== 'fullMakeup')
  const itemIdSet = new Set(items.map((item) => item.id))
  const outfits = (
    scope === 'all' ? index.outfits : index.outfits.filter(isBaseSummaryOutfit)
  ).filter((outfit) =>
    normalizeSummaryItemIds(index.outfitItemsById.get(outfit.id) ?? []).some((itemId) =>
      itemIdSet.has(itemId)
    )
  )
  const makeupItemIdSet = new Set(makeupItems.map((makeup) => makeup.id))
  const ownedItemIdSet = new Set(normalizeSummaryItemIds([...ownedItemIds]))
  const ownedMakeupIdSet = new Set(normalizeSummaryItemIds([...ownedMakeupIds]))
  const ownedMomoIdSet = new Set(normalizeSummaryItemIds([...ownedMomoIds]))
  let ownedItemCount = 0
  let ownedMakeupCount = 0
  let ownedMomoCount = 0
  const qualityGroups = new Map<number, { total: number; owned: number }>()
  const typeGroups = new Map<string, { total: number; owned: number }>()

  items.forEach((item) => {
    const owned = ownedItemIdSet.has(item.id)
    if (owned) {
      ownedItemCount += 1
    }

    incrementGroup(qualityGroups, item.quality, owned)
    incrementGroup(typeGroups, item.type, owned)
  })

  let ownedOutfitCount = 0
  let partialOutfitCount = 0
  let missingOutfitCount = 0
  const nearCompleteOutfits: WardrobeSummaryNearCompleteOutfit[] = []

  outfits.forEach((outfit) => {
    const itemIds = normalizeSummaryItemIds(index.outfitItemsById.get(outfit.id) ?? []).filter(
      (itemId) => itemIdSet.has(itemId)
    )
    const ownedCount = itemIds.reduce(
      (count, itemId) => count + (ownedItemIdSet.has(itemId) ? 1 : 0),
      0
    )
    const status =
      ownedCount === itemIds.length && itemIds.length > 0
        ? 'owned'
        : ownedCount > 0
          ? 'partial'
          : 'missing'

    if (status === 'owned') {
      ownedOutfitCount += 1
    } else if (status === 'partial') {
      partialOutfitCount += 1
      const missingItemIds = itemIds.filter((itemId) => !ownedItemIdSet.has(itemId))

      nearCompleteOutfits.push({
        id: outfit.id,
        itemIds,
        missingItemIds,
        owned: ownedCount,
        total: itemIds.length,
        missing: missingItemIds.length,
        completionPercent: getCompletionPercent(ownedCount, itemIds.length)
      })
    } else {
      missingOutfitCount += 1
    }
  })

  makeupItems.forEach((makeup) => {
    if (ownedMakeupIdSet.has(makeup.id)) {
      ownedMakeupCount += 1
    }
  })

  let ownedFullMakeupCount = 0
  let partialFullMakeupCount = 0
  let missingFullMakeupCount = 0
  const nearCompleteFullMakeups: WardrobeSummaryNearCompleteFullMakeup[] = []

  makeups
    .filter((makeup) => makeup.type === 'fullMakeup')
    .forEach((makeup) => {
      const makeupIds = normalizeSummaryItemIds(index.makeupItemsById.get(makeup.id) ?? []).filter(
        (makeupId) => makeupItemIdSet.has(makeupId)
      )
      const ownedCount = makeupIds.reduce(
        (count, makeupId) => count + (ownedMakeupIdSet.has(makeupId) ? 1 : 0),
        0
      )
      const status =
        ownedCount === makeupIds.length && makeupIds.length > 0
          ? 'owned'
          : ownedCount > 0
            ? 'partial'
            : 'missing'

      if (status === 'owned') {
        ownedFullMakeupCount += 1
      } else if (status === 'partial') {
        partialFullMakeupCount += 1
        const missingMakeupIds = makeupIds.filter((makeupId) => !ownedMakeupIdSet.has(makeupId))

        nearCompleteFullMakeups.push({
          id: makeup.id,
          makeupIds,
          missingMakeupIds,
          owned: ownedCount,
          total: makeupIds.length,
          missing: missingMakeupIds.length,
          completionPercent: getCompletionPercent(ownedCount, makeupIds.length)
        })
      } else {
        missingFullMakeupCount += 1
      }
    })

  momoEntries.forEach((momo) => {
    if (ownedMomoIdSet.has(momo.id)) {
      ownedMomoCount += 1
    }
  })

  return {
    items: createProgress(ownedItemCount, items.length),
    outfits: {
      total: outfits.length,
      owned: ownedOutfitCount,
      partial: partialOutfitCount,
      missing: missingOutfitCount,
      completionPercent: getCompletionPercent(ownedOutfitCount, outfits.length)
    },
    makeups: createProgress(ownedMakeupCount, makeupItems.length),
    fullMakeups: {
      total: ownedFullMakeupCount + partialFullMakeupCount + missingFullMakeupCount,
      owned: ownedFullMakeupCount,
      partial: partialFullMakeupCount,
      missing: missingFullMakeupCount,
      completionPercent: getCompletionPercent(
        ownedFullMakeupCount,
        ownedFullMakeupCount + partialFullMakeupCount + missingFullMakeupCount
      )
    },
    momo: createProgress(ownedMomoCount, momoEntries.length),
    qualityRows: Array.from(qualityGroups.entries())
      .map(([quality, progress]) => ({
        quality,
        ...createProgress(progress.owned, progress.total)
      }))
      .sort((left, right) => right.quality - left.quality),
    typeRows: Array.from(typeGroups.entries())
      .map(([type, progress]) => ({
        type,
        ...createProgress(progress.owned, progress.total)
      }))
      .sort(
        (left, right) =>
          right.total - left.total ||
          right.owned - left.owned ||
          left.type.localeCompare(right.type)
      ),
    nearCompleteOutfits: nearCompleteOutfits
      .sort(
        (left, right) =>
          left.missing - right.missing ||
          right.completionPercent - left.completionPercent ||
          left.id - right.id
      )
      .slice(0, nearCompleteLimit),
    nearCompleteFullMakeups: nearCompleteFullMakeups
      .sort(
        (left, right) =>
          left.missing - right.missing ||
          right.completionPercent - left.completionPercent ||
          left.id - right.id
      )
      .slice(0, nearCompleteLimit)
  }
}
