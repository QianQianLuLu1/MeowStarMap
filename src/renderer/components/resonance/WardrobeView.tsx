import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso } from 'react-virtuoso'
import { EmptyState } from '../common/EmptyState'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { IconOutfit } from '../../icons'
import { useGlobalToast } from '../../pages/settings/shared'
import { MAX_WARDROBE_BATCH } from '../../../shared/types/resonance'
import type { ResonanceWardrobeCategory } from '../../../shared/types/resonance'
import { updateWardrobeItems, useResonanceStore } from '../../stores/resonanceStore'
import {
  BANNER_DATA,
  getStaticProcessDeps,
  loadCatalog,
  loadNames,
  type CatalogData,
  type NamePack
} from '../../utils/resonance/staticData'
import { processBannerPullData } from '../../utils/resonance/process'
import type {
  CatalogItemEntry,
  CatalogMakeupEntry,
  CatalogMomoEntry,
  CatalogOutfitEntry,
  EurekaCatalogEntry,
  PropCatalogEntry
} from '../../utils/resonance/catalogCompactFormat'
import {
  getPearpalCompletedOutfitItemIds,
  getWardrobeSetProgress,
  inferWardrobeIdsFromTracker,
  type WardrobeOutfitStatus,
  type WardrobeTrackerCatalogIndex
} from '../../utils/resonance/wardrobe'
import { parsePearpalSuitIdsFromText } from '../../utils/resonance/importParse'
import type { EvoRecord, ProcessedBanner } from '../../utils/resonance/types'

/**
 * 我的衣橱子页：五分类（部件 / 妆容 / Momo / 道具 / 共鸣色）拥有状态管理。
 * 纯文字模式：无任何物品图片，稀有度用色点表达；套装/系列聚合 + 名称搜索 +
 * 拥有状态与稀有度筛选 + 批量勾选 + 「从共鸣记录推断」。全部数据本地，零联网。
 */

type StatusFilter = 'all' | 'owned' | 'missing'
type QualityFilter = 0 | 3 | 4 | 5

interface WardrobeEntity {
  id: number
  name: string
  quality: number
  owned: boolean
  /** 共鸣色色块（仅 eureka_color 分类；取本地 palettes 静态色板） */
  swatch: string | null
}

interface WardrobeGroup {
  key: string
  id: number | null
  name: string
  quality: number
  status: WardrobeOutfitStatus
  ownedCount: number
  total: number
  entities: WardrobeEntity[]
}

const CATEGORIES: Array<{ key: ResonanceWardrobeCategory; labelKey: string }> = [
  { key: 'item', labelKey: 'resonance.wardrobe.cat.item' },
  { key: 'makeup', labelKey: 'resonance.wardrobe.cat.makeup' },
  { key: 'momo', labelKey: 'resonance.wardrobe.cat.momo' },
  { key: 'prop', labelKey: 'resonance.wardrobe.cat.prop' },
  { key: 'eureka_color', labelKey: 'resonance.wardrobe.cat.eurekaColor' }
]

const FIELD_BY_CATEGORY = {
  item: 'ownedItemIds',
  makeup: 'ownedMakeupIds',
  momo: 'ownedMomoIds',
  prop: 'ownedPropIds',
  eureka_color: 'ownedEurekaColorIds'
} as const satisfies Record<ResonanceWardrobeCategory, string>

function qualityColor(quality: number): string {
  if (quality === 5) return 'var(--warning)'
  if (quality === 4) return 'var(--accent)'
  return 'var(--text-tertiary)'
}

/** 从本地 palettes 静态色板取共鸣色色块（损坏/缺失一律降级 null，绝不抛出） */
function getEurekaSwatchHex(palettes: unknown, colorType: number, order: number): string | null {
  if (!palettes || typeof palettes !== 'object') return null
  const root = (palettes as { palettes?: unknown }).palettes
  if (!root || typeof root !== 'object') return null
  const entry = (root as Record<string, unknown>)[String(colorType)]
  const colors = entry && typeof entry === 'object' ? (entry as { colors?: unknown }).colors : null
  if (!Array.isArray(colors) || colors.length === 0) return null
  const hex = colors[(order - 1) % colors.length]
  return typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : null
}

function asEntryArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

export const WardrobeView: React.FC = () => {
  const { t, i18n } = useTranslation()
  const showMessage = useGlobalToast()
  const wardrobe = useResonanceStore((s) => s.wardrobe)
  const pulls = useResonanceStore((s) => s.pulls)
  const edits = useResonanceStore((s) => s.edits)
  const evo = useResonanceStore((s) => s.evo)

  const [catalog, setCatalog] = useState<CatalogData | null>(null)
  const [catalogFailed, setCatalogFailed] = useState(false)
  const [names, setNames] = useState<NamePack | null>(null)
  const [category, setCategory] = useState<ResonanceWardrobeCategory>('item')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>(0)
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const [inferOpen, setInferOpen] = useState(false)
  const [inferBusy, setInferBusy] = useState(false)
  const [pearpalBusy, setPearpalBusy] = useState(false)

  // 图鉴目录懒加载（损坏/缺失降级提示，不崩溃）；名称包跟随界面语言
  useEffect(() => {
    let cancelled = false
    void loadCatalog().then((data) => {
      if (cancelled) return
      if (data) setCatalog(data)
      else setCatalogFailed(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void loadNames(i18n.language).then((pack) => {
      if (!cancelled) setNames(pack)
    })
    return () => {
      cancelled = true
    }
  }, [i18n])

  const ownedIds = wardrobe[FIELD_BY_CATEGORY[category]]
  const ownedSet = useMemo(() => new Set(ownedIds), [ownedIds])

  // ============ 分类数据构建 ============

  const groups = useMemo<WardrobeGroup[]>(() => {
    if (!catalog) return []

    const entityOf = (
      id: number,
      quality: number,
      name: string,
      swatch: string | null = null
    ): WardrobeEntity => ({
      id,
      name,
      quality,
      owned: ownedSet.has(id),
      swatch
    })

    if (category === 'item') {
      const itemMeta = new Map<number, CatalogItemEntry>(
        asEntryArray<CatalogItemEntry>(catalog.items).map((entry) => [entry.id, entry])
      )
      const setGroups = asEntryArray<CatalogOutfitEntry>(catalog.outfits)
        .map<WardrobeGroup>((outfit) => {
          const ids = catalog.outfitItems[String(outfit.id)] ?? []
          const entities = ids.map((id) =>
            entityOf(id, itemMeta.get(id)?.quality ?? 0, names?.item[String(id)] ?? String(id))
          )
          const progress = getWardrobeSetProgress(ids, ownedSet)
          return {
            key: `outfit-${outfit.id}`,
            id: outfit.id,
            name: names?.outfit[String(outfit.id)] ?? `#${outfit.id}`,
            quality: outfit.quality,
            status: progress.status,
            ownedCount: progress.owned,
            total: progress.total,
            entities
          }
        })
        .filter((group) => group.total > 0)
      const groupedIds = new Set(Object.values(catalog.outfitItems).flatMap((ids) => ids))
      const looseEntities = [...itemMeta.keys()]
        .filter((id) => !groupedIds.has(id))
        .map((id) =>
          entityOf(id, itemMeta.get(id)?.quality ?? 0, names?.item[String(id)] ?? String(id))
        )
      if (looseEntities.length > 0) {
        setGroups.push({
          key: 'loose-items',
          id: null,
          name: t('resonance.wardrobe.looseSet'),
          quality: 0,
          status: getWardrobeSetProgress(
            looseEntities.map((entity) => entity.id),
            ownedSet
          ).status,
          ownedCount: looseEntities.filter((entity) => entity.owned).length,
          total: looseEntities.length,
          entities: looseEntities
        })
      }
      return setGroups
    }

    if (category === 'makeup') {
      const makeups = asEntryArray<CatalogMakeupEntry>(catalog.makeups)
      const makeupMeta = new Map(makeups.map((entry) => [entry.id, entry]))
      const setGroups = makeups
        .filter((entry) => entry.type === 'fullMakeup')
        .map<WardrobeGroup>((fullMakeup) => {
          const ids = catalog.makeupItems[String(fullMakeup.id)] ?? []
          const entities = ids.map((id) =>
            entityOf(id, makeupMeta.get(id)?.quality ?? 0, names?.makeup[String(id)] ?? String(id))
          )
          const progress = getWardrobeSetProgress(ids, ownedSet)
          return {
            key: `full-makeup-${fullMakeup.id}`,
            id: fullMakeup.id,
            name: names?.makeup[String(fullMakeup.id)] ?? `#${fullMakeup.id}`,
            quality: fullMakeup.quality,
            status: progress.status,
            ownedCount: progress.owned,
            total: progress.total,
            entities
          }
        })
        .filter((group) => group.total > 0)
      const groupedIds = new Set(
        setGroups.flatMap((group) => group.entities.map((entity) => entity.id))
      )
      const looseEntities = makeups
        .filter((entry) => entry.type !== 'fullMakeup' && !groupedIds.has(entry.id))
        .map((entry) =>
          entityOf(entry.id, entry.quality, names?.makeup[String(entry.id)] ?? String(entry.id))
        )
      if (looseEntities.length > 0) {
        setGroups.push({
          key: 'loose-makeups',
          id: null,
          name: t('resonance.wardrobe.looseSet'),
          quality: 0,
          status: getWardrobeSetProgress(
            looseEntities.map((entity) => entity.id),
            ownedSet
          ).status,
          ownedCount: looseEntities.filter((entity) => entity.owned).length,
          total: looseEntities.length,
          entities: looseEntities
        })
      }
      return setGroups
    }

    if (category === 'momo' || category === 'prop') {
      const entries =
        category === 'momo'
          ? asEntryArray<CatalogMomoEntry>(catalog.momo)
          : asEntryArray<PropCatalogEntry>(catalog.props)
      const entities = entries.map((entry) =>
        entityOf(
          entry.id,
          entry.quality,
          (category === 'momo' ? names?.momo[String(entry.id)] : names?.prop[String(entry.id)]) ??
            String(entry.id)
        )
      )
      if (entities.length === 0) return []
      return [
        {
          key: `flat-${category}`,
          id: null,
          name: t(`resonance.wardrobe.cat.${category === 'momo' ? 'momo' : 'prop'}`),
          quality: 0,
          status: getWardrobeSetProgress(
            entities.map((entity) => entity.id),
            ownedSet
          ).status,
          ownedCount: entities.filter((entity) => entity.owned).length,
          total: entities.length,
          entities
        }
      ]
    }

    // eureka_color：按共鸣条目（头/手/脚）分组，颜色 chip 内联展示
    const eurekas = asEntryArray<EurekaCatalogEntry>(catalog.eurekas)
    return eurekas.map<WardrobeGroup>((entry) => {
      const entities = entry.colors.map((color) =>
        entityOf(
          color.id,
          entry.quality,
          names?.eureka[String(entry.id)] ?? `#${entry.id}`,
          getEurekaSwatchHex(catalog.palettes, color.colorType, color.order)
        )
      )
      const progress = getWardrobeSetProgress(
        entities.map((entity) => entity.id),
        ownedSet
      )
      return {
        key: `eureka-${entry.id}`,
        id: entry.id,
        name: names?.eureka[String(entry.id)] ?? `#${entry.id}`,
        quality: entry.quality,
        status: progress.status,
        ownedCount: progress.owned,
        total: progress.total,
        entities
      }
    })
  }, [category, catalog, names, ownedSet, t])

  // ============ 过滤 ============

  const normalizedQuery = query.trim().toLowerCase()

  const filteredGroups = useMemo(() => {
    return groups
      .map((group) => {
        const groupMatch =
          normalizedQuery === '' || group.name.toLowerCase().includes(normalizedQuery)
        const entities = group.entities.filter((entity) => {
          const queryMatch =
            normalizedQuery === '' ||
            groupMatch ||
            entity.name.toLowerCase().includes(normalizedQuery)
          const statusMatch =
            statusFilter === 'all' || (statusFilter === 'owned' ? entity.owned : !entity.owned)
          const qualityMatch = qualityFilter === 0 || entity.quality === qualityFilter
          return queryMatch && statusMatch && qualityMatch
        })
        return { ...group, entities }
      })
      .filter((group) => group.entities.length > 0)
  }, [groups, normalizedQuery, statusFilter, qualityFilter])

  const totals = useMemo(() => {
    const all = groups.flatMap((group) => group.entities)
    return { owned: all.filter((entity) => entity.owned).length, total: all.length }
  }, [groups])

  // ============ 增删改 ============

  const handleToggle = async (itemId: number, owned: boolean): Promise<void> => {
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      showMessage(t('resonance.records.invalidInput'), 'error')
      return
    }
    const entry = { category, itemId }
    try {
      await updateWardrobeItems(owned ? [] : [entry], owned ? [entry] : [])
    } catch (error) {
      showMessage(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  /** 组级快捷操作：全部拥有 / 全部取消（自动按 5000/批分片，schema 双重防线） */
  const handleBatch = async (
    targetCategory: ResonanceWardrobeCategory,
    entities: WardrobeEntity[],
    targetOwned: boolean
  ): Promise<void> => {
    const diff = entities.filter(
      (entity) => Number.isSafeInteger(entity.id) && entity.id > 0 && entity.owned !== targetOwned
    )
    if (diff.length === 0) return
    const entries = diff.map((entity) => ({ category: targetCategory, itemId: entity.id }))
    try {
      for (let offset = 0; offset < entries.length; offset += MAX_WARDROBE_BATCH) {
        const chunk = entries.slice(offset, offset + MAX_WARDROBE_BATCH)
        await updateWardrobeItems(targetOwned ? chunk : [], targetOwned ? [] : chunk)
      }
    } catch (error) {
      showMessage(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  // ============ 从共鸣记录推断 ============

  const processedBanners = useMemo<Record<string, ProcessedBanner>>(() => {
    const byPulls: Record<string, Array<[string, string]>> = {}
    const byEdits: Record<string, Array<[string, string]>> = {}
    for (const row of pulls) (byPulls[row.banner_id] ??= []).push([row.obtained_at, row.item_id])
    for (const row of edits) (byEdits[row.banner_id] ??= []).push([row.obtained_at, row.item_id])
    if (Object.keys(byPulls).length === 0 && Object.keys(byEdits).length === 0) return {}
    return processBannerPullData(byPulls, byEdits, getStaticProcessDeps())
  }, [pulls, edits])

  const inference = useMemo(() => {
    const emptyIndex: WardrobeTrackerCatalogIndex = {
      itemById: new Map(),
      outfitItemsById: new Map(),
      makeupById: new Map(),
      makeupItemsById: new Map(),
      momoById: new Map(),
      fullMakeupIdsByOutfitId: new Map(),
      momoIdsByOutfitId: new Map()
    }
    if (!catalog || Object.keys(processedBanners).length === 0) {
      return inferWardrobeIdsFromTracker({
        processedBanners: {},
        evoData: undefined,
        catalogIndex: emptyIndex,
        propEntries: [],
        bannerData: BANNER_DATA
      })
    }
    const catalogIndex: WardrobeTrackerCatalogIndex = {
      itemById: new Map(
        asEntryArray<CatalogItemEntry>(catalog.items).map((entry) => [entry.id, entry])
      ),
      outfitItemsById: new Map(
        Object.entries(catalog.outfitItems).map(([id, ids]) => [Number(id), ids])
      ),
      makeupById: new Map(
        asEntryArray<CatalogMakeupEntry>(catalog.makeups).map((entry) => [entry.id, entry])
      ),
      makeupItemsById: new Map(
        Object.entries(catalog.makeupItems).map(([id, ids]) => [Number(id), ids])
      ),
      momoById: new Map(
        asEntryArray<CatalogMomoEntry>(catalog.momo).map((entry) => [entry.id, entry])
      ),
      fullMakeupIdsByOutfitId: new Map(
        Object.entries(catalog.makeupOutfits).map(([id, ids]) => [Number(id), ids])
      ),
      momoIdsByOutfitId: new Map(
        Object.entries(catalog.momoOutfits).map(([id, ids]) => [Number(id), ids])
      )
    }
    const evoData: Record<number, EvoRecord[]> = {}
    for (const row of evo) (evoData[Number(row.banner_id)] ??= []).push([row.outfit_id, row.level])
    return inferWardrobeIdsFromTracker({
      processedBanners,
      evoData,
      catalogIndex,
      propEntries: asEntryArray<PropCatalogEntry>(catalog.props),
      bannerData: BANNER_DATA
    })
  }, [catalog, processedBanners, evo])

  const handleInferApply = async (): Promise<void> => {
    if (!inference || inferBusy) return
    setInferBusy(true)
    try {
      const current = useResonanceStore.getState().wardrobe
      const adds: Array<{ category: ResonanceWardrobeCategory; itemId: number }> = []
      const pushDiff = (
        targetCategory: ResonanceWardrobeCategory,
        ownedList: number[],
        inferred: number[]
      ): void => {
        const owned = new Set(ownedList)
        for (const id of inferred) {
          if (Number.isSafeInteger(id) && id > 0 && !owned.has(id)) {
            adds.push({ category: targetCategory, itemId: id })
          }
        }
      }
      pushDiff('item', current.ownedItemIds, inference.itemIds)
      pushDiff('makeup', current.ownedMakeupIds, inference.makeupIds)
      pushDiff('momo', current.ownedMomoIds, inference.momoIds)
      pushDiff('prop', current.ownedPropIds, inference.propIds)

      if (adds.length === 0) {
        showMessage(t('resonance.wardrobe.inferNothing'), 'success')
        setInferOpen(false)
        return
      }
      for (let offset = 0; offset < adds.length; offset += MAX_WARDROBE_BATCH) {
        await updateWardrobeItems(adds.slice(offset, offset + MAX_WARDROBE_BATCH), [])
      }
      showMessage(t('resonance.wardrobe.inferResult', { count: adds.length }), 'success')
      setInferOpen(false)
    } catch (error) {
      showMessage(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setInferBusy(false)
    }
  }

  /**
   * 从共鸣笔记（Pearpal notebook）导入「已完成套装」的部件为已拥有。
   * 对应上游 65bb3d8f 的 import.vue wardrobe ownership 分支（info_from_self.suit_list）；
   * 复用既有 resonance:readImportFile 与 resonance:updateWardrobe 通道，零新增 IPC、零联网。
   */
  const handlePearpalImport = async (): Promise<void> => {
    if (pearpalBusy || !catalog) return
    let filePath: string | null = null
    try {
      filePath =
        (await window.electronAPI?.dialog?.openFile({
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })) ?? null
    } catch (error) {
      showMessage(error instanceof Error ? error.message : String(error), 'error')
      return
    }
    if (!filePath) return

    setPearpalBusy(true)
    try {
      const file = await window.electronAPI?.resonance?.readImportFile(filePath)
      const suitIds = parsePearpalSuitIdsFromText(file?.content ?? '')
      if (suitIds.length === 0) {
        showMessage(t('resonance.wardrobe.pearpalImportNothing'), 'error')
        return
      }
      const itemIds = getPearpalCompletedOutfitItemIds(suitIds, {
        itemById: new Map(
          asEntryArray<CatalogItemEntry>(catalog.items).map((entry) => [entry.id, entry])
        ),
        outfitItemsById: new Map(
          Object.entries(catalog.outfitItems).map(([id, ids]) => [Number(id), ids])
        )
      })
      const owned = new Set(useResonanceStore.getState().wardrobe.ownedItemIds)
      const adds = itemIds
        .filter((itemId) => owned.has(itemId) === false)
        .map((itemId) => ({ category: 'item' as const, itemId }))
      for (let offset = 0; offset < adds.length; offset += MAX_WARDROBE_BATCH) {
        await updateWardrobeItems(adds.slice(offset, offset + MAX_WARDROBE_BATCH), [])
      }
      showMessage(t('resonance.wardrobe.pearpalImportDone', { count: adds.length }), 'success')
    } catch (error) {
      showMessage(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setPearpalBusy(false)
    }
  }

  // ============ 渲染 ============

  const isFlatCategory = category === 'momo' || category === 'prop'

  const renderEntityRow = (entity: WardrobeEntity, rowKey: string): React.ReactNode => (
    <label
      key={`${rowKey}-${entity.id}`}
      className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg cursor-pointer"
      style={{ color: 'var(--text-primary)' }}
    >
      <input
        type="checkbox"
        className="w-4 h-4 flex-shrink-0"
        style={{ accentColor: 'var(--accent)' }}
        checked={entity.owned}
        onChange={() => void handleToggle(entity.id, entity.owned)}
        aria-label={entity.name}
      />
      {entity.swatch ? (
        <span
          className="w-3.5 h-3.5 rounded flex-shrink-0"
          style={{ background: entity.swatch, border: '1px solid var(--divider)' }}
          aria-hidden
        />
      ) : (
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ background: qualityColor(entity.quality) }}
          aria-hidden
        />
      )}
      <span className="text-sm flex-1 min-w-0 truncate">{entity.name}</span>
      {entity.swatch && (
        <span
          className="text-xs tabular-nums flex-shrink-0"
          style={{ color: 'var(--text-tertiary)' }}
        >
          #{entity.id}
        </span>
      )}
    </label>
  )

  const renderGroupCard = (group: WardrobeGroup): React.ReactNode => {
    const expanded = expandedKeys.has(group.key)
    return (
      <div key={group.key} className="rounded-xl" style={{ background: 'var(--bg-tertiary)' }}>
        <button
          type="button"
          onClick={() =>
            setExpandedKeys((prev) => {
              const next = new Set(prev)
              if (next.has(group.key)) next.delete(group.key)
              else next.add(group.key)
              return next
            })
          }
          className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left"
        >
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ background: qualityColor(group.quality) }}
            aria-hidden
          />
          <span
            className="text-sm flex-1 min-w-0 truncate"
            style={{ color: 'var(--text-primary)' }}
          >
            {group.name}
          </span>
          <span
            className="text-xs px-1.5 py-0.5 rounded flex-shrink-0"
            style={{
              background: 'var(--bg-secondary)',
              color:
                group.status === 'owned'
                  ? 'var(--success, var(--text-secondary))'
                  : 'var(--text-tertiary)'
            }}
          >
            {t(`resonance.wardrobe.outfitStatus.${group.status}`)}
          </span>
          <span
            className="text-xs tabular-nums flex-shrink-0"
            style={{ color: 'var(--text-secondary)' }}
          >
            {group.ownedCount}/{group.total}
          </span>
          <span
            className="text-xs flex-shrink-0"
            style={{ color: 'var(--text-tertiary)' }}
            aria-hidden
          >
            {expanded ? '▾' : '▸'}
          </span>
        </button>
        {expanded && (
          <div className="px-2 pb-2 space-y-0.5">
            <div className="flex gap-2 px-1 pb-1">
              <button
                type="button"
                className="btn-secondary text-xs px-2 py-1"
                onClick={() => void handleBatch(category, group.entities, true)}
              >
                {t('resonance.wardrobe.quickOwned')}
              </button>
              <button
                type="button"
                className="btn-secondary text-xs px-2 py-1"
                onClick={() => void handleBatch(category, group.entities, false)}
              >
                {t('resonance.wardrobe.quickMissing')}
              </button>
            </div>
            {group.entities.map((entity) => renderEntityRow(entity, group.key))}
          </div>
        )}
      </div>
    )
  }

  const renderEurekaCard = (group: WardrobeGroup): React.ReactNode => (
    <div
      key={group.key}
      className="rounded-xl px-3 py-2.5"
      style={{ background: 'var(--bg-tertiary)' }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ background: qualityColor(group.quality) }}
          aria-hidden
        />
        <span className="text-sm flex-1 min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>
          {group.name}
        </span>
        <span
          className="text-xs tabular-nums flex-shrink-0"
          style={{ color: 'var(--text-secondary)' }}
        >
          {group.ownedCount}/{group.total}
        </span>
      </div>
      <div className="flex flex-wrap gap-2 pt-2">
        {group.entities.map((entity) => (
          <button
            key={entity.id}
            type="button"
            onClick={() => void handleToggle(entity.id, entity.owned)}
            title={`${entity.name} · #${entity.id}`}
            aria-label={`${entity.name} #${entity.id}${entity.owned ? '' : ` · ${t('resonance.wardrobe.statusMissing')}`}`}
            className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{
              background: entity.swatch ?? 'var(--bg-secondary)',
              border: entity.owned ? '2px solid var(--accent)' : '1px solid var(--divider)',
              opacity: entity.owned ? 1 : 0.55
            }}
          >
            {entity.owned && (
              <span
                className="text-xs font-bold text-white"
                style={{ textShadow: '0 0 3px rgba(0,0,0,.8)' }}
              >
                ✓
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      {/* 工具条：分类 + 搜索 + 筛选 + 汇总 + 推断 */}
      <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.key}
              type="button"
              className="px-2.5 py-1.5 text-sm rounded-lg"
              style={
                category === cat.key
                  ? { background: 'var(--accent)', color: 'var(--text-on-accent)' }
                  : { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }
              }
              onClick={() => setCategory(cat.key)}
            >
              {t(cat.labelKey)}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('resonance.wardrobe.searchPlaceholder')}
          aria-label={t('resonance.wardrobe.searchPlaceholder')}
          className="px-2 py-1.5 text-sm rounded-lg w-44"
          style={{
            background: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--divider)'
          }}
        />
        <select
          aria-label={t('resonance.wardrobe.statusFilterLabel')}
          className="px-2 py-1.5 text-sm rounded-lg"
          style={{
            background: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--divider)'
          }}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
        >
          <option value="all">{t('resonance.wardrobe.statusAll')}</option>
          <option value="owned">{t('resonance.wardrobe.statusOwned')}</option>
          <option value="missing">{t('resonance.wardrobe.statusMissing')}</option>
        </select>
        <select
          aria-label={t('resonance.wardrobe.qualityFilterLabel')}
          className="px-2 py-1.5 text-sm rounded-lg"
          style={{
            background: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--divider)'
          }}
          value={qualityFilter}
          onChange={(e) => setQualityFilter(Number(e.target.value) as QualityFilter)}
        >
          <option value={0}>{t('resonance.wardrobe.qualityAll')}</option>
          <option value={5}>5★</option>
          <option value={4}>4★</option>
          <option value={3}>3★</option>
        </select>
        <span
          className="px-2 py-1 rounded-md text-xs flex-shrink-0"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
        >
          {t('resonance.wardrobe.summaryOwned', {
            owned: totals.owned,
            total: totals.total
          })}
        </span>
        {category !== 'eureka_color' && (
          <button
            type="button"
            className="btn-secondary flex-shrink-0"
            onClick={() => setInferOpen(true)}
            disabled={inferBusy}
          >
            {t('resonance.wardrobe.inferButton')}
          </button>
        )}
        {catalog && category !== 'eureka_color' && (
          <button
            type="button"
            className="btn-secondary flex-shrink-0"
            onClick={() => void handlePearpalImport()}
            disabled={pearpalBusy}
          >
            {t('resonance.wardrobe.pearpalImportButton')}
          </button>
        )}
      </div>

      {/* 内容区 */}
      {catalogFailed ? (
        <EmptyState
          icon={<IconOutfit size={48} />}
          title={t('resonance.wardrobe.catalogUnavailable')}
          subtitle={t('resonance.wardrobe.catalogUnavailableHint')}
        />
      ) : catalog === null || names === null ? (
        <EmptyState icon={<IconOutfit size={48} />} title={t('resonance.wardrobe.loading')} />
      ) : filteredGroups.length === 0 ? (
        <EmptyState
          icon={<IconOutfit size={48} />}
          title={t('resonance.wardrobe.empty')}
          subtitle={t('resonance.wardrobe.emptyHint')}
        />
      ) : isFlatCategory ? (
        <div className="flex-1 min-h-0 rounded-xl" style={{ background: 'var(--bg-tertiary)' }}>
          <Virtuoso
            data={filteredGroups[0]!.entities}
            className="h-full"
            itemContent={(_, entity) => renderEntityRow(entity, `flat-${category}`)}
          />
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <Virtuoso
            data={filteredGroups}
            className="h-full"
            itemContent={(_, group) =>
              category === 'eureka_color' ? renderEurekaCard(group) : renderGroupCard(group)
            }
          />
        </div>
      )}

      <ConfirmDialog
        open={inferOpen}
        title={t('resonance.wardrobe.inferTitle')}
        message={t('resonance.wardrobe.inferMessage', {
          items: inference?.found.items ?? 0,
          makeups: inference?.found.makeups ?? 0,
          momo: inference?.found.momo ?? 0,
          props: inference?.found.props ?? 0
        })}
        confirmText={inferBusy ? t('resonance.wardrobe.inferBusy') : undefined}
        onConfirm={() => void handleInferApply()}
        onCancel={() => {
          if (!inferBusy) setInferOpen(false)
        }}
      />
    </div>
  )
}
