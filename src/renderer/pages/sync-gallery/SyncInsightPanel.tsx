import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  AssetEditsInfo,
  NikkiSyncClothingSearchInfo,
  NikkiSyncProfileStatsInfo,
  NikkiSyncSuitSearchInfo
} from '../../../shared/types/electron-api'
import type { AssetSummary, MediaResource } from '../../../shared/sync/protocol'
import { mapHitSummariesToFiles } from '../../utils/assetViewModel'
import type { AssetMediaFile } from '../../utils/assetViewModel'

/**
 * 同步图库的「上游索引面」面板：套装/服装检索 + 角色档案统计 + 命中照片回捞（N5）。
 *
 * 三个面早已存在于契约里（`nikkisync:search-suits` / `:search-clothing` / `:profile-stats`
 * 三条通道 + preload + DTO 全齐）。N5 闭环最后一环：命中 `photos[].asset` 经
 * `getResourceRecords({ assetIds, mode: 'meta' | 'path' })` 回捞，复用
 * `mapHitSummariesToFiles` / `toAssetViewModel` 口径（与 `mediaStore.mapAssetPageToFiles`
 * 同源），再经 `onHits` 交给 `SyncGalleryPage` 铺进网格。不新建通道、不新建 store、
 * 不改 `mediaStore.ts` 的源分流。
 *
 * `<details>` 折叠 + 首次展开才发请求 + 两条在途请求各自代次计数（同 `PairingQrDialog`
 * 口径，IPC 无顺序保证，「后发先至」是常态）的既有设计一律保留；回捞复用检索代次，
 * 另加一层「同一批 assetIds」结果去重，重复提交不重复发回捞 IPC。
 */

export interface SyncInsightPanelProps {
  /** N5：命中照片回捞成视图模型后交给页面铺进网格；缺省时只保留文本命中 */
  onHits?: (files: AssetMediaFile[]) => void
}

/** 外部 IPC 返回体一律当 unknown：判空 + 类型校验后再取字段。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type SearchScope = 'suits' | 'clothing'

interface SearchHit {
  key: string
  name: string
  category?: string
  photoCount: number
  /** 套装命中的部件名 / 服装命中的所属套装名，用于解释「为什么命中」 */
  detail?: string
}

const MAX_HITS = 20

export const SyncInsightPanel: React.FC<SyncInsightPanelProps> = ({ onHits }) => {
  const { t } = useTranslation()
  const [scope, setScope] = useState<SearchScope>('suits')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const [backfillFailed, setBackfillFailed] = useState(false)
  const [stats, setStats] = useState<NikkiSyncProfileStatsInfo | null>(null)
  const [statsFailed, setStatsFailed] = useState(false)
  const searchGenerationRef = useRef(0)
  const statsGenerationRef = useRef(0)
  /** 最近一次已发回捞的 assetIds 签名：相同命中重复提交不再发 IPC */
  const lastBackfillKeyRef = useRef<string | null>(null)
  /**
   * 面板节点：库变更到货时按 `open` 决定「立刻重取」还是「只复位缓存等下次展开」。
   * 直接读 DOM 而不是在 onToggle 里存一份布尔影子——toggle 是排队派发的，影子会比
   * 实际开合状态慢一拍，慢的那一拍里到货的事件会被当成展开态多拉一次 IPC。
   */
  const detailsRef = useRef<HTMLDetailsElement | null>(null)

  /**
   * N5：命中照片 → getResourceRecords(meta/path) → mapHitSummariesToFiles → onHits。
   * 与 mediaStore.mapAssetPageToFiles 同口径，不新建通道/store。失败只在本面板内联提示
   * 且保留文本命中；绝不把半截结果铺进网格，也不弹全局 toast 打断浏览。
   */
  const backfillHits = useCallback(
    async (summaries: AssetSummary[], generation: number): Promise<void> => {
      const api = window.electronAPI?.nikkisync
      // 同一 assetId 可能命中多个套装：按 assetId 去重，避免网格里出现重复卡片
      const uniqueSummaries: AssetSummary[] = []
      const seen = new Set<string>()
      for (const item of summaries) {
        const id = item?.assetId
        if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
          seen.add(id)
          uniqueSummaries.push(item)
        }
      }
      // 空命中不发 IPC；老桥面无 getResourceRecords / 页面未接 onHits ⇒ 静默跳过
      // （能力缺失不是运行期错误，对齐 resolveGameVersion 的存在性守卫）
      if (uniqueSummaries.length === 0) return
      if (typeof api?.getResourceRecords !== 'function' || !onHits) return
      const assetIds = uniqueSummaries.map((item) => item.assetId)
      const key = [...assetIds].sort().join('\u0000')
      if (lastBackfillKeyRef.current === key) return
      lastBackfillKeyRef.current = key
      const editsApi = window.electronAPI?.assetEdits
      try {
        const metaResponse = await api.getResourceRecords({ assetIds, mode: 'meta' })
        const pathResponse = await api.getResourceRecords({ assetIds, mode: 'path' })
        const editsResponse =
          typeof editsApi?.list === 'function' ? await editsApi.list(assetIds) : undefined
        // 关键词/作用域已换 ⇒ 过期代次不得把旧命中铺进网格
        if (generation !== searchGenerationRef.current) return
        // 外部输入不可信：判空 + 类型校验 + 缺省兜底
        const metaByAsset = (
          isRecord(metaResponse) && isRecord(metaResponse.byAsset) ? metaResponse.byAsset : {}
        ) as Record<string, MediaResource[]>
        const pathByAsset = (
          isRecord(pathResponse) && isRecord(pathResponse.byAsset) ? pathResponse.byAsset : {}
        ) as Record<string, Record<string, string>>
        const edits: AssetEditsInfo[] = Array.isArray(editsResponse?.edits)
          ? (editsResponse.edits as AssetEditsInfo[])
          : []
        onHits(
          mapHitSummariesToFiles({ summaries: uniqueSummaries, metaByAsset, pathByAsset, edits })
        )
        setBackfillFailed(false)
      } catch {
        if (generation !== searchGenerationRef.current) return
        setBackfillFailed(true)
        lastBackfillKeyRef.current = null // 允许下次提交重试
      }
    },
    [onHits]
  )

  const runSearch = useCallback(
    async (event: React.FormEvent): Promise<void> => {
      event.preventDefault()
      // 任何一次提交（含空关键词）都先作废在途请求，否则过期响应会把用户已换掉的面板改回去
      const generation = ++searchGenerationRef.current
      const term = query.trim()
      const api = window.electronAPI?.nikkisync
      if (!term || !api) {
        setHits(null)
        setSearchFailed(false)
        setBackfillFailed(false)
        setSearching(false)
        return
      }
      setSearching(true)
      setSearchFailed(false)
      setBackfillFailed(false)
      try {
        // 两个索引各查一遍再合并：上游它们是两套独立索引（SuitSearchIndex / ClothingSearchIndex），
        // 用户不会关心「星夜长发」属于服装还是套装。
        const collected: SearchHit[] = []
        // N5：命中的 AssetSummary 同步收集，检索成功后按 assetId 回捞资源记录
        const collectedSummaries: AssetSummary[] = []
        if (scope === 'suits') {
          const res = await api.searchSuits({ query: term })
          const payload = res as NikkiSyncSuitSearchInfo
          for (const item of payload.items ?? []) {
            const parts = (item.photos ?? [])
              .flatMap((photo) => photo.matchedParts ?? [])
              .map((part) => part.name ?? part.clothingId)
            collected.push({
              key: `suit:${item.suitId ?? item.suitName}`,
              name: item.suitName,
              photoCount: item.photoCount,
              detail: parts.length > 0 ? parts.slice(0, 3).join(' / ') : undefined
            })
            for (const photo of item.photos ?? []) {
              if (photo?.asset && typeof photo.asset.assetId === 'string') {
                collectedSummaries.push(photo.asset)
              }
            }
          }
        } else {
          const res = await api.searchClothing({ query: term })
          const payload = res as NikkiSyncClothingSearchInfo
          for (const item of payload.items ?? []) {
            collected.push({
              key: `clothing:${item.clothingId}`,
              name: item.name ?? item.clothingId,
              category: item.category,
              photoCount: item.photoCount,
              detail: item.suitName
            })
            for (const photo of item.photos ?? []) {
              if (photo?.asset && typeof photo.asset.assetId === 'string') {
                collectedSummaries.push(photo.asset)
              }
            }
          }
        }
        if (generation !== searchGenerationRef.current) return
        setHits(collected.slice(0, MAX_HITS))
        void backfillHits(collectedSummaries, generation)
      } catch {
        if (generation !== searchGenerationRef.current) return
        setHits(null)
        setSearchFailed(true)
        // 失败只影响本面板：用户仍在浏览图库，内联文案比全局 toast 更合适
        // （见渲染侧 searchFailed 分支）。原始错误留在主进程日志，不外泄到 UI。
      } finally {
        // loading 同样只认最新代次：过期响应不得掐掉仍在途的那次检索
        if (generation === searchGenerationRef.current) setSearching(false)
      }
    },
    [query, scope, backfillHits]
  )

  const loadStats = useCallback(async (): Promise<void> => {
    const api = window.electronAPI?.nikkisync
    if (!api?.profileStats) {
      setStatsFailed(true)
      return
    }
    const generation = ++statsGenerationRef.current
    try {
      const next = await api.profileStats()
      if (generation !== statsGenerationRef.current) return
      setStats(next)
    } catch {
      if (generation !== statsGenerationRef.current) return
      setStatsFailed(true)
    }
  }, [])

  // 库变更 ⇒ 榜单（与命中）都可能是旧的。本页 keep-alive 且网格会自行重取第一页，
  // 面板若永久缓存就与网格同时呈现两副面孔，同一个库存两个答案。
  useEffect(() => {
    const subscribe = window.electronAPI?.nikkisync?.onLibraryChanged
    if (!subscribe) return
    return subscribe(() => {
      setStats(null)
      setStatsFailed(false)
      // 库变更后同一批 assetIds 的路径/资源可能已变：作废回捞去重签名，允许下次检索重新回捞
      lastBackfillKeyRef.current = null
      if (detailsRef.current?.open) void loadStats()
    })
  }, [loadStats])

  // 卸载后作废全部在途代次：过期响应不得回调已卸载组件（订阅/代次配套清理）
  useEffect(
    () => () => {
      searchGenerationRef.current++
      statsGenerationRef.current++
    },
    []
  )

  const topSuits = useMemo(() => stats?.topSuits ?? [], [stats])
  const topClothing = useMemo(() => stats?.topClothing ?? [], [stats])
  const bridgeMissing = !window.electronAPI?.nikkisync?.searchSuits

  if (bridgeMissing) return null

  return (
    <div className="mt-2 space-y-2">
      <details
        ref={detailsRef}
        className="rounded-lg border"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-secondary)' }}
        onToggle={(event) => {
          const open = (event.currentTarget as HTMLDetailsElement).open
          // 「只做一次」的闸落在展开动作上而不是 loadStats 内部：库变更要能重新拉，
          // 但反复开合不得退化成每次开合一次 IPC
          if (open && stats === null && !statsFailed) void loadStats()
        }}
      >
        <summary
          className="cursor-pointer select-none px-3 py-2 text-sm"
          style={{ color: 'var(--text-secondary)' }}
        >
          {t('syncGallery.insight.title')}
        </summary>
        <div className="space-y-3 px-3 pb-3">
          <form onSubmit={runSearch} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label
                id="sync-insight-scope"
                className="text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {t('syncGallery.insight.scope')}
              </label>
              <select
                aria-labelledby="sync-insight-scope"
                className="rounded-md border bg-transparent px-2 py-1 text-sm"
                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value === 'clothing' ? 'clothing' : 'suits')
                  // 套装与服装是两套独立索引，命中行不可跨作用域复用：留着上一次的结果
                  // 等于把套装的部件名当「服装的所属套装」展示。顺带作废在途请求。
                  searchGenerationRef.current++
                  lastBackfillKeyRef.current = null
                  setHits(null)
                  setSearchFailed(false)
                  setBackfillFailed(false)
                  setSearching(false)
                }}
              >
                <option value="suits">{t('syncGallery.insight.scopeSuits')}</option>
                <option value="clothing">{t('syncGallery.insight.scopeClothing')}</option>
              </select>
            </div>
            <div className="flex min-w-40 flex-1 flex-col gap-1">
              <label
                id="sync-insight-query"
                className="text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {t('syncGallery.insight.queryLabel')}
              </label>
              <input
                type="search"
                aria-labelledby="sync-insight-query"
                className="rounded-md border bg-transparent px-2 py-1 text-sm"
                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                value={query}
                placeholder={t('syncGallery.insight.queryPlaceholder')}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <button
              type="submit"
              className="icon-btn rounded-md border px-3 py-1 text-sm"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
              disabled={searching || query.trim() === ''}
            >
              {searching ? t('syncGallery.insight.searching') : t('syncGallery.insight.submit')}
            </button>
          </form>

          {searchFailed ? (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('syncGallery.insight.searchFailed')}
            </p>
          ) : hits === null ? (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('syncGallery.insight.searchIdle')}
            </p>
          ) : hits.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('syncGallery.insight.searchEmpty')}
            </p>
          ) : (
            <ul className="space-y-1">
              {hits.map((hit) => (
                <li key={hit.key} className="flex flex-wrap items-baseline gap-2 text-sm">
                  <span style={{ color: 'var(--text-primary)' }}>{hit.name}</span>
                  {hit.category && (
                    <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {hit.category}
                    </span>
                  )}
                  <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {t('syncGallery.insight.photoCount', { n: hit.photoCount })}
                  </span>
                  {hit.detail && (
                    <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {hit.detail}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {backfillFailed ? (
            <p
              data-testid="insight-backfill-notice"
              className="text-xs"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {t('syncGallery.insight.backfillFailed')}
            </p>
          ) : null}

          <hr style={{ borderColor: 'var(--border-subtle)' }} />

          {statsFailed ? (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('syncGallery.insight.statsFailed')}
            </p>
          ) : stats === null ? (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('syncGallery.insight.statsLoading')}
            </p>
          ) : topSuits.length === 0 && topClothing.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('syncGallery.insight.statsEmpty')}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                  {t('syncGallery.insight.topSuits')}
                </p>
                <ul className="mt-1 space-y-1">
                  {topSuits.map((item) => (
                    <li
                      key={`${item.suitId ?? item.suitName}`}
                      className="flex items-baseline justify-between gap-2 text-sm"
                    >
                      <span style={{ color: 'var(--text-primary)' }}>{item.suitName}</span>
                      <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {t('syncGallery.insight.photoCount', { n: item.photoCount })}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                  {t('syncGallery.insight.topClothing')}
                </p>
                <ul className="mt-1 space-y-1">
                  {topClothing.map((item) => (
                    <li
                      key={item.clothingId}
                      className="flex items-baseline justify-between gap-2 text-sm"
                    >
                      <span style={{ color: 'var(--text-primary)' }}>
                        {item.name ?? item.clothingId}
                      </span>
                      <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {t('syncGallery.insight.photoCount', { n: item.photoCount })}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      </details>
    </div>
  )
}
