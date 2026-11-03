import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  NikkiSyncClothingSearchInfo,
  NikkiSyncProfileStatsInfo,
  NikkiSyncSuitSearchInfo
} from '../../../shared/types/electron-api'

/**
 * 同步图库的「上游索引面」面板：套装/服装检索 + 角色档案统计。
 *
 * 这两个面早已存在于契约里（`nikkisync:search-suits` / `:search-clothing` / `:profile-stats`
 * 三条通道 + preload + DTO 全齐，链接态用例也验过上游返回），但渲染层零调用方 ⇒ 用户看不见。
 * 本面板只做**读**：不新建通道、不改分页协议、不注入缩略图链（要把命中照片铺进网格还需按
 * assetId 回捞资源记录并走 `media://` 授权，那是另一件事，本轮刻意不做）。
 *
 * 两段都是 `<details>` 折叠 + 首次展开才发请求：本页会 keep-alive 常驻，无条件拉取会让
 * 每次进图库多出两次 IPC。
 *
 * 两条在途请求各自带一个代次计数（同 `PairingQrDialog` 的口径）：IPC 无顺序保证，
 * 「后发先至」是常态（换关键词连按两次检索即是），不加计数则由到达顺序决定用户看见什么。
 */

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

export const SyncInsightPanel: React.FC = () => {
  const { t } = useTranslation()
  const [scope, setScope] = useState<SearchScope>('suits')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const [stats, setStats] = useState<NikkiSyncProfileStatsInfo | null>(null)
  const [statsFailed, setStatsFailed] = useState(false)
  const searchGenerationRef = useRef(0)
  const statsGenerationRef = useRef(0)
  /**
   * 面板节点：库变更到货时按 `open` 决定「立刻重取」还是「只复位缓存等下次展开」。
   * 直接读 DOM 而不是在 onToggle 里存一份布尔影子——toggle 是排队派发的，影子会比
   * 实际开合状态慢一拍，慢的那一拍里到货的事件会被当成展开态多拉一次 IPC。
   */
  const detailsRef = useRef<HTMLDetailsElement | null>(null)

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
        setSearching(false)
        return
      }
      setSearching(true)
      setSearchFailed(false)
      try {
        // 两个索引各查一遍再合并：上游它们是两套独立索引（SuitSearchIndex / ClothingSearchIndex），
        // 用户不会关心「星夜长发」属于服装还是套装。
        const collected: SearchHit[] = []
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
          }
        }
        if (generation !== searchGenerationRef.current) return
        setHits(collected.slice(0, MAX_HITS))
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
    [query, scope]
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
      if (detailsRef.current?.open) void loadStats()
    })
  }, [loadStats])

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
                  setHits(null)
                  setSearchFailed(false)
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
