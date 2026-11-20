import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  NikkiSyncInspirationEntryInfo,
  NikkiSyncInspirationImageInfo,
  NikkiSyncInspirationVersionedInfo
} from '../../../shared/types/electron-api'
import { useUIStore } from '../../stores/uiStore'
import {
  INSPIRATION_STATUSES,
  filterEntries,
  insCandidates,
  splitListInput,
  type InspirationStatus
} from './inspiration-filter'

/**
 * N4：灵感库列表/编辑器（上游 `/v1/inspiration*`，v1.0.29）。
 *
 * 复用 `SyncInsightPanel` 的既有设计：`<details>` 折叠 + 首次展开才发 IPC +
 * 在途请求各自代次计数（IPC 无顺序保证，「后发先至」是常态）+ 桥面存在性守卫。
 * 本仓不重写 HTTP/协议：四条 IPC 通道逐字转发上游 `InspirationRepository`，
 * 条目形态由上游 `validate()` 单真相源判定，冲突/大小限制/坏 sha256 都只在主进程
 * 拦一次后映射成错误码；渲染层只把失败内联在本面板，不弹全局 toast 打断浏览。
 *
 * 新增 UI 文案一律走 syncGallery.inspiration 命名空间（不硬编码中文）；本节点已随实现
 * 同步补齐 12 个 locale 语言包的对应文案。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 上游 `validate()` 用 UUID 正则校验 id/code.id；无 crypto.randomUUID 时退化为同形态随机串。 */
function newUuid(): string {
  const cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16)
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

interface Draft {
  /** 空串 = 新建；否则为被编辑条目的 id */
  id: string
  title: string
  notes: string
  baseRevision: number
  images: NikkiSyncInspirationImageInfo[]
  /** T9：逗号分隔输入态（保存时经 splitListInput 拆分为数组，上游拆分判据） */
  tags: string
  categories: string
  /** T9：五态枚举（上游 InspirationPanel.ts:7 同款 option 集） */
  status: InspirationStatus
  /** T9：分享码原文。type/parsedState/snapshotJson 不臆造——沿用基线条目值 */
  rawCode: string
}

function emptyCode(): NikkiSyncInspirationEntryInfo['code'] {
  return {
    id: newUuid(),
    rawCode: '',
    type: 'unknown',
    sourceText: '',
    sourceUrl: null,
    parsedState: 'pending',
    snapshotJson: null,
    resolverVersion: null,
    dictionaryVersion: null,
    resolvedAt: 0
  }
}

/**
 * T9：分享码变更语义（上游 InspirationPanel.ts 保存分支逐字对齐）：
 * rawCode 相对基线有变 ⇒ parsedState 回 'pending'、快照/解析版本/解析时间清空，
 * 交由上游解析链重跑；未变则原样保留基线 code（绝不臆造 type/快照）。
 */
function buildCode(
  rawCode: string,
  base: NikkiSyncInspirationEntryInfo | undefined
): NikkiSyncInspirationEntryInfo['code'] {
  const old = base?.code
  if (!old) return { ...emptyCode(), rawCode }
  if (old.rawCode === rawCode) return old
  return {
    ...old,
    rawCode,
    parsedState: 'pending',
    snapshotJson: null,
    resolverVersion: null,
    dictionaryVersion: null,
    resolvedAt: 0
  }
}

/** 组装上游 `validate()` 接受的最小合法条目（其余字段沿用被编辑条目或给缺省）。 */
function buildEntry(
  draft: Draft,
  base: NikkiSyncInspirationEntryInfo | undefined
): NikkiSyncInspirationEntryInfo {
  return {
    id: draft.id || newUuid(),
    title: draft.title,
    notes: draft.notes,
    tags: splitListInput(draft.tags),
    categories: splitListInput(draft.categories),
    status: draft.status,
    createdAt: base?.createdAt ?? Date.now(),
    deletedAt: 0,
    code: buildCode(draft.rawCode, base),
    images: draft.images
  }
}

/** 外部 IPC 返回体一律当 unknown：判空 + 逐项收敛后再进 state。 */
function parseList(value: unknown): NikkiSyncInspirationVersionedInfo[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return []
  return value.items.filter(isRecord) as unknown as NikkiSyncInspirationVersionedInfo[]
}

/** 外部 IPC 图片数组逐项收敛：判空 + id/sha256 类型守卫，脏元素一律丢弃。 */
function parseImages(value: unknown): NikkiSyncInspirationImageInfo[] {
  if (!Array.isArray(value)) return []
  const images: NikkiSyncInspirationImageInfo[] = []
  for (const item of value.filter(isRecord)) {
    if (typeof item.id !== 'string' || typeof item.sha256 !== 'string') continue
    images.push({
      id: item.id,
      sha256: item.sha256,
      mimeType: typeof item.mimeType === 'string' ? item.mimeType : '',
      bytes: typeof item.bytes === 'number' ? item.bytes : 0,
      addedAt: typeof item.addedAt === 'number' ? item.addedAt : 0
    })
  }
  return images
}

/** T8：自动刷新节流（上游 maybeRefresh 的 `Date.now()-insLastLoad>=15000` 判据）。 */
const AUTO_REFRESH_THROTTLE_MS = 15000
/** 节流检查心跳：5s 一跳，到点且距上次拉取 ≥15s 才真正重取（编辑器打开时跳过）。 */
const AUTO_REFRESH_TICK_MS = 5000
/**
 * 单轮 fetch-all 的页数硬顶（100 条/页 ⇒ 5000 条）。
 * 存在理由：服务端游标异常时逐页链必须**有界**，否则一次打开面板就能把 IPC 打满。
 */
const MAX_LIST_PAGES = 50

interface SyncInspirationPanelProps {
  /**
   * T8：自动刷新的可见性门控。缺省 = 独立灵感库页（currentView==='sync-inspiration'）；
   * 控制台灵感视图显式传 currentView==='sync-service'。keep-alive 下不可见一律不刷。
   */
  autoRefreshVisible?: boolean
}

export const SyncInspirationPanel: React.FC<SyncInspirationPanelProps> = ({
  autoRefreshVisible
}) => {
  const { t } = useTranslation()
  const [items, setItems] = useState<NikkiSyncInspirationVersionedInfo[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [imageError, setImageError] = useState(false)
  // T8：过滤条（搜索/分类/状态），判据走 inspiration-filter 纯函数（上游逐字）
  const [filterQ, setFilterQ] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  // F16：上游列表按 after 游标翻页（limit 1..100 缺省 100）。首屏只取一页，
  // nextCursor 非空时给「加载更多」；不再静默截断 100 条之后的条目。
  const [listCursor, setListCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreFailed, setLoadMoreFailed] = useState(false)
  const listGenerationRef = useRef(0)
  const saveGenerationRef = useRef(0)
  const imageGenerationRef = useRef(0)
  const loadedRef = useRef(false)
  const detailsRef = useRef<HTMLDetailsElement | null>(null)
  /** T8：上次成功拉取时刻（节流基准）；编辑器开关态经 ref 读，避免心跳定时器反复重建。 */
  const lastLoadRef = useRef(0)
  const draftRef = useRef<Draft | null>(null)
  draftRef.current = draft
  const currentView = useUIStore((s) => s.currentView)
  const visible = autoRefreshVisible ?? currentView === 'sync-inspiration'

  const api = window.electronAPI?.nikkisync
  const bridgeMissing =
    typeof api?.listInspirations !== 'function' ||
    typeof api?.saveInspiration !== 'function' ||
    typeof api?.putInspirationImage !== 'function' ||
    typeof api?.getInspirationImage !== 'function'

  /** F16：返回体逐项收敛后另取游标（非串一律视为无游标，绝不做目录遍历式的盲拼）。 */
  const parseCursor = (value: unknown): string | null =>
    isRecord(value) && typeof value.nextCursor === 'string' && value.nextCursor.length > 0
      ? value.nextCursor
      : null

  /**
   * T8：fetch-all——沿 after 游标逐页取全量（limit=100），按 id+revision 去重；
   * 游标为空 / 已走过同一游标 / 页数触顶即停，绝不盲拼目录。
   * 「已走过」用整条链的游标集合判：只比对相邻游标挡不住服务端 A→B→A 的往复。
   * F16 兼容：停止时若游标仍非空，保留「加载更多」入口供用户显式续翻。
   */
  const loadList = useCallback(async (): Promise<void> => {
    const client = window.electronAPI?.nikkisync
    if (!client?.listInspirations) return
    const generation = ++listGenerationRef.current
    // 新代次接管：在途 loadMore 的代次就此作废，它的 finally 按代次门闩不会再复位，
    // 这里必须补一次——否则「加载更多」被 disabled 与 loadMore 守卫双封，非重挂载不可恢复。
    setLoadingMore(false)
    try {
      const collected: NikkiSyncInspirationVersionedInfo[] = []
      const seen = new Set<string>()
      const visitedCursors = new Set<string>()
      let after: string | null = null
      let cursor: string | null = null
      let pages = 0
      for (;;) {
        const res = await client.listInspirations(after ? { limit: 100, after } : { limit: 100 })
        if (generation !== listGenerationRef.current) return
        pages += 1
        for (const row of parseList(res)) {
          const key = `${String(row.entry?.id ?? 'row')}-${row.revision}`
          if (!seen.has(key)) {
            seen.add(key)
            collected.push(row)
          }
        }
        const next = parseCursor(res)
        cursor = next
        if (!next || visitedCursors.has(next) || pages >= MAX_LIST_PAGES) break
        visitedCursors.add(next)
        after = next
      }
      if (generation !== listGenerationRef.current) return
      setItems(collected)
      setListCursor(cursor)
      setLoadFailed(false)
      setLoadMoreFailed(false)
      lastLoadRef.current = Date.now()
    } catch {
      if (generation !== listGenerationRef.current) return
      setItems([])
      setLoadFailed(true)
    }
  }, [])

  // F16：消费 after 游标追加下一页；追加按 id+revision 去重（游标抖动不得产出重复行）。
  const loadMore = useCallback(async (): Promise<void> => {
    const client = window.electronAPI?.nikkisync
    if (!client?.listInspirations || !listCursor || loadingMore) return
    const generation = ++listGenerationRef.current
    setLoadingMore(true)
    setLoadMoreFailed(false)
    try {
      const res = await client.listInspirations({ limit: 100, after: listCursor })
      if (generation !== listGenerationRef.current) return
      const page = parseList(res)
      setItems((current) => {
        const base = current ?? []
        const seen = new Set(base.map((row) => `${String(row.entry?.id ?? 'row')}-${row.revision}`))
        const merged = [...base]
        for (const row of page) {
          const key = `${String(row.entry?.id ?? 'row')}-${row.revision}`
          if (!seen.has(key)) {
            seen.add(key)
            merged.push(row)
          }
        }
        return merged
      })
      setListCursor(parseCursor(res))
      lastLoadRef.current = Date.now()
    } catch {
      if (generation !== listGenerationRef.current) return
      // 追加失败不清已有列表、不丢游标：用户可原位重试
      setLoadMoreFailed(true)
    } finally {
      if (generation === listGenerationRef.current) setLoadingMore(false)
    }
  }, [listCursor, loadingMore])

  // 库变更 ⇒ 列表可能是旧的；折叠态只复位缓存等下次展开，展开态立刻重取
  useEffect(() => {
    const subscribe = window.electronAPI?.nikkisync?.onLibraryChanged
    if (!subscribe) return
    return subscribe(() => {
      loadedRef.current = false
      setLoadFailed(false)
      // F16：库变更后游标下的分页内容也可能变了——回到首屏重新翻页
      setListCursor(null)
      setLoadMoreFailed(false)
      if (detailsRef.current?.open) void loadList()
    })
  }, [loadList])

  // 卸载后作废全部在途代次：过期响应不得回调已卸载组件
  useEffect(
    () => () => {
      listGenerationRef.current++
      saveGenerationRef.current++
      imageGenerationRef.current++
    },
    []
  )

  /**
   * T8：15s 节流自动刷新（上游 maybeRefresh 判据逐字）：
   * 仅「可见 + 面板展开 + 已拉过 + 编辑器关闭 + 距上次拉取 ≥15s」才重取。
   * 5s 心跳只做节流检查；不可见/桥缺失时不留任何定时器（keep-alive 纪律）。
   */
  useEffect(() => {
    if (!visible || bridgeMissing) return
    const timer = setInterval(() => {
      if (!detailsRef.current?.open) return
      if (draftRef.current) return
      if (!loadedRef.current) return
      if (Date.now() - lastLoadRef.current < AUTO_REFRESH_THROTTLE_MS) return
      void loadList()
    }, AUTO_REFRESH_TICK_MS)
    return () => clearInterval(timer)
  }, [visible, bridgeMissing, loadList])

  if (bridgeMissing) return null

  // T8：过滤后的可见列表（纯函数判据，上游逐字）；计数与空态都基于过滤结果
  const visibleItems = filterEntries(items ?? [], {
    q: filterQ,
    category: filterCategory,
    status: filterStatus
  })

  const openDraft = (row?: NikkiSyncInspirationVersionedInfo): void => {
    const entry = row?.entry
    const status = entry?.status
    setDraft({
      id: typeof entry?.id === 'string' ? entry.id : '',
      title: typeof entry?.title === 'string' ? entry.title : '',
      notes: typeof entry?.notes === 'string' ? entry.notes : '',
      baseRevision: typeof row?.revision === 'number' ? row.revision : 0,
      images: parseImages(entry?.images),
      // T9：数组 → 逗号分隔输入态；未知状态收敛为 'want'（不臆造枚举外值）
      tags: (Array.isArray(entry?.tags) ? entry.tags : []).join(', '),
      categories: (Array.isArray(entry?.categories) ? entry.categories : []).join(', '),
      status: (INSPIRATION_STATUSES as readonly string[]).includes(status ?? '')
        ? (status as InspirationStatus)
        : 'want',
      rawCode: typeof entry?.code?.rawCode === 'string' ? entry.code.rawCode : ''
    })
    setSaveError(false)
    // F13：上传失败标记与草稿同生命周期——开新/编辑别的条目时一并复位
    setImageError(false)
  }

  const handleSave = async (): Promise<void> => {
    const client = window.electronAPI?.nikkisync
    if (!draft || !client?.saveInspiration) return
    const generation = ++saveGenerationRef.current
    setBusy(true)
    setSaveError(false)
    try {
      const base = draft.id ? items?.find((row) => row.entry?.id === draft.id)?.entry : undefined
      await client.saveInspiration({
        entry: buildEntry(draft, base),
        baseRevision: draft.baseRevision
      })
      if (generation !== saveGenerationRef.current) return
      setDraft(null)
      void loadList()
    } catch {
      if (generation !== saveGenerationRef.current) return
      setSaveError(true)
    } finally {
      if (generation === saveGenerationRef.current) setBusy(false)
    }
  }

  /**
   * 上游软删语义：`deletedAt` 非 0 时 `validate()` 会把 images 清空。
   * F14：entry 非 record 的行直接短路——此前 `row.entry ?? {}` 让守卫恒真，
   * undefined entry 会以 `{deletedAt, images:[]}`（无 id）递给上游撞 invalid_entry。
   * F15：busy 期间不得插入删除——删除与保存共享 saveGenerationRef，删除会使在途
   * 保存的成功路径按代次早退，草稿不关但库已保存，再保存会以过期 baseRevision 撞 conflict。
   */
  const handleDelete = async (row: NikkiSyncInspirationVersionedInfo): Promise<void> => {
    const client = window.electronAPI?.nikkisync
    if (!client?.saveInspiration || busy || !isRecord(row.entry)) return
    const generation = ++saveGenerationRef.current
    setBusy(true)
    setSaveError(false)
    try {
      await client.saveInspiration({
        entry: {
          ...(row.entry as unknown as Record<string, unknown>),
          deletedAt: Date.now(),
          images: []
        },
        baseRevision: row.revision
      })
      if (generation !== saveGenerationRef.current) return
      void loadList()
    } catch {
      if (generation !== saveGenerationRef.current) return
      setSaveError(true)
    } finally {
      if (generation === saveGenerationRef.current) setBusy(false)
    }
  }

  const handleImage = async (file: File): Promise<void> => {
    const client = window.electronAPI?.nikkisync
    if (!draft || !client?.putInspirationImage || busy) return
    const generation = ++imageGenerationRef.current
    const targetId = draft.id
    setBusy(true)
    setImageError(false)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const cryptoObj = globalThis.crypto
      if (!cryptoObj?.subtle) {
        // 无 WebCrypto 时不臆造 sha256：明确报错，绝不把错摘要递给上游
        if (generation === imageGenerationRef.current) setImageError(true)
        return
      }
      const digest = await cryptoObj.subtle.digest('SHA-256', bytes)
      const sha256 = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
      let raw = ''
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) {
        raw += String.fromCharCode(...bytes.subarray(i, i + chunk))
      }
      const mimeType = file.type.startsWith('image/') ? file.type : 'image/png'
      await client.putInspirationImage({
        sha256,
        mimeType,
        bytesBase64: btoa(raw)
      })
      setDraft((current) => {
        if (generation !== imageGenerationRef.current) return current
        if (!current || current.id !== targetId) return current
        return {
          ...current,
          images: [
            ...current.images,
            { id: newUuid(), sha256, mimeType, bytes: bytes.length, addedAt: Date.now() }
          ]
        }
      })
    } catch {
      if (generation === imageGenerationRef.current) setImageError(true)
    } finally {
      if (generation === imageGenerationRef.current) setBusy(false)
    }
  }

  return (
    <div className="mt-2 space-y-2">
      <details
        ref={detailsRef}
        data-testid="sync-inspiration-panel"
        className="rounded-lg border"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-secondary)' }}
        onToggle={(event) => {
          const open = (event.currentTarget as HTMLDetailsElement).open
          if (open && !loadedRef.current && !loadFailed) {
            loadedRef.current = true
            void loadList()
          } else if (!open && loadFailed) {
            // 失败态折叠后复位，允许下次展开重试；成功态保留 loadedRef 缓存，不重复发 IPC
            loadedRef.current = false
            setLoadFailed(false)
          }
        }}
      >
        <summary
          data-testid="sync-inspiration-summary"
          className="cursor-pointer select-none px-3 py-2 text-sm"
          style={{ color: 'var(--text-secondary)' }}
        >
          {t('syncGallery.inspiration.title')}
        </summary>
        <div className="space-y-3 px-3 pb-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('syncGallery.inspiration.hint')}
            </p>
            <button
              type="button"
              data-testid="inspiration-new"
              className="icon-btn rounded-md border px-2 py-1 text-sm"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
              onClick={() => openDraft()}
            >
              {t('syncGallery.inspiration.new')}
            </button>
          </div>

          {/* T8：过滤条（搜索/分类/状态/刷新）——判据走 inspiration-filter 纯函数 */}
          <div className="flex flex-wrap items-center gap-2">
            <input
              data-testid="inspiration-search"
              type="text"
              className="min-w-32 flex-1 rounded-md border bg-transparent px-2 py-1 text-sm"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
              placeholder={t('syncGallery.inspiration.searchPlaceholder')}
              value={filterQ}
              onChange={(event) => setFilterQ(event.target.value)}
            />
            <input
              data-testid="inspiration-category-filter"
              type="text"
              className="w-28 rounded-md border bg-transparent px-2 py-1 text-sm"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
              placeholder={t('syncGallery.inspiration.categoryPlaceholder')}
              value={filterCategory}
              onChange={(event) => setFilterCategory(event.target.value)}
            />
            <select
              data-testid="inspiration-status-filter"
              className="rounded-md border bg-transparent px-2 py-1 text-sm"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
              aria-label={t('syncGallery.inspiration.statusLabel')}
              value={filterStatus}
              onChange={(event) => setFilterStatus(event.target.value)}
            >
              <option value="">{t('syncGallery.inspiration.statusAll')}</option>
              {INSPIRATION_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`syncGallery.inspiration.status.${status}`)}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="inspiration-refresh"
              className="icon-btn rounded-md border px-2 py-1 text-sm"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
              onClick={() => void loadList()}
            >
              {t('syncGallery.inspiration.refresh')}
            </button>
          </div>
          {items !== null && !loadFailed && (
            <p
              data-testid="inspiration-count-note"
              className="text-xs"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {t('syncGallery.inspiration.countNote', { count: visibleItems.length })}
            </p>
          )}

          {draft && (
            <div
              className="space-y-2 rounded-lg border p-2"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              <label
                className="flex flex-col gap-1 text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {t('syncGallery.inspiration.titleLabel')}
                <input
                  data-testid="inspiration-title-input"
                  type="text"
                  className="rounded-md border bg-transparent px-2 py-1 text-sm"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
              </label>
              <label
                className="flex flex-col gap-1 text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {t('syncGallery.inspiration.notesLabel')}
                <textarea
                  data-testid="inspiration-notes-input"
                  className="rounded-md border bg-transparent px-2 py-1 text-sm"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                  value={draft.notes}
                  onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                />
              </label>
              {/* T9：标签/分类（逗号分隔输入，保存时按上游判据拆分去重） */}
              <label
                className="flex flex-col gap-1 text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {t('syncGallery.inspiration.tagsLabel')}
                <input
                  data-testid="inspiration-tags-input"
                  type="text"
                  className="rounded-md border bg-transparent px-2 py-1 text-sm"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                  placeholder={t('syncGallery.inspiration.tagsPlaceholder')}
                  value={draft.tags}
                  onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
                />
              </label>
              <label
                className="flex flex-col gap-1 text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {t('syncGallery.inspiration.categoriesLabel')}
                <input
                  data-testid="inspiration-categories-input"
                  type="text"
                  className="rounded-md border bg-transparent px-2 py-1 text-sm"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                  placeholder={t('syncGallery.inspiration.categoriesPlaceholder')}
                  value={draft.categories}
                  onChange={(event) => setDraft({ ...draft, categories: event.target.value })}
                />
              </label>
              {/* T9：状态五态（上游枚举）；分享码原文 + 备注中的候选识别提示 */}
              <label
                className="flex flex-col gap-1 text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {t('syncGallery.inspiration.statusLabel')}
                <select
                  data-testid="inspiration-status-input"
                  className="rounded-md border bg-transparent px-2 py-1 text-sm"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                  value={draft.status}
                  onChange={(event) =>
                    setDraft({ ...draft, status: event.target.value as InspirationStatus })
                  }
                >
                  {INSPIRATION_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {t(`syncGallery.inspiration.status.${status}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label
                className="flex flex-col gap-1 text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {t('syncGallery.inspiration.codeLabel')}
                <input
                  data-testid="inspiration-code-input"
                  type="text"
                  className="rounded-md border bg-transparent px-2 py-1 text-sm"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                  value={draft.rawCode}
                  onChange={(event) => setDraft({ ...draft, rawCode: event.target.value })}
                />
              </label>
              {(() => {
                // T9：识别提示只做候选展示，点击采纳才写入 rawCode；不臆造解析结果
                const candidates = insCandidates(draft.notes)
                if (candidates.length === 0) return null
                const candidate = candidates[0]
                return (
                  <button
                    type="button"
                    data-testid="inspiration-code-hint"
                    className="text-left text-xs underline"
                    style={{ color: 'var(--text-tertiary)' }}
                    onClick={() => setDraft({ ...draft, rawCode: candidate })}
                  >
                    {t('syncGallery.inspiration.codeRecognized', { code: candidate })}
                  </button>
                )
              })()}
              <label
                className="flex flex-col gap-1 text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {t('syncGallery.inspiration.imageLabel')}
                <input
                  data-testid="inspiration-image-input"
                  type="file"
                  accept="image/*"
                  className="text-sm"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void handleImage(file)
                  }}
                />
              </label>
              {imageError && (
                <p
                  data-testid="inspiration-image-error"
                  className="text-xs"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  {t('syncGallery.inspiration.imageFailed')}
                </p>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="inspiration-save"
                  className="btn-primary text-sm"
                  disabled={busy || draft.title.trim() === ''}
                  onClick={() => void handleSave()}
                >
                  {t('syncGallery.inspiration.save')}
                </button>
                <button
                  type="button"
                  data-testid="inspiration-cancel"
                  className="btn-ghost text-sm"
                  onClick={() => {
                    setDraft(null)
                    setSaveError(false)
                    // F13：取消草稿同样复位上传失败标记
                    setImageError(false)
                  }}
                >
                  {t('syncGallery.inspiration.cancel')}
                </button>
              </div>
            </div>
          )}

          {saveError && (
            <p
              data-testid="inspiration-save-error"
              className="text-xs"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {t('syncGallery.inspiration.saveFailed')}
            </p>
          )}

          {loadFailed ? (
            <p
              data-testid="inspiration-load-error"
              className="text-xs"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {t('syncGallery.inspiration.loadFailed')}
            </p>
          ) : items === null ? (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('syncGallery.inspiration.loading')}
            </p>
          ) : items.length === 0 ? (
            <p
              data-testid="inspiration-empty"
              className="text-xs"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {t('syncGallery.inspiration.empty')}
            </p>
          ) : visibleItems.length === 0 ? (
            <p
              data-testid="inspiration-filter-empty"
              className="text-xs"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {t('syncGallery.inspiration.filterEmpty')}
            </p>
          ) : (
            <ul className="space-y-2">
              {visibleItems.map((row) => {
                const images = parseImages(row.entry?.images)
                const entry = row.entry
                const tags = Array.isArray(entry?.tags) ? entry.tags : []
                const rawCode = typeof entry?.code?.rawCode === 'string' ? entry.code.rawCode : ''
                const status =
                  typeof entry?.status === 'string' &&
                  (INSPIRATION_STATUSES as readonly string[]).includes(entry.status)
                    ? entry.status
                    : null
                return (
                  <li
                    key={`${String(row.entry?.id ?? 'row')}-${row.revision}`}
                    data-testid="inspiration-item"
                    className="rounded-md border px-2 py-1"
                    style={{ borderColor: 'var(--border-subtle)' }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
                          {String(row.entry?.title ?? '')}
                        </span>
                        {/* T9：状态徽标（未知状态不渲染，不谎报枚举外值） */}
                        {status && (
                          <span
                            data-testid="inspiration-status-badge"
                            className="rounded-full border px-1.5 text-xs"
                            style={{
                              borderColor: 'var(--border-subtle)',
                              color: 'var(--text-secondary)'
                            }}
                          >
                            {t(`syncGallery.inspiration.status.${status}`)}
                          </span>
                        )}
                      </span>
                      <span className="flex items-center gap-2">
                        <button
                          type="button"
                          data-testid="inspiration-edit"
                          className="icon-btn text-xs"
                          onClick={() => openDraft(row)}
                        >
                          {t('syncGallery.inspiration.edit')}
                        </button>
                        <button
                          type="button"
                          data-testid="inspiration-delete"
                          className="icon-btn text-xs"
                          disabled={busy}
                          onClick={() => void handleDelete(row)}
                        >
                          {t('syncGallery.inspiration.delete')}
                        </button>
                      </span>
                    </div>
                    {/* T9：标签 chips + 分享码片段（有则展示，无则不占位） */}
                    {(tags.length > 0 || rawCode !== '') && (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {tags.map((tag) => (
                          <span
                            key={tag}
                            data-testid="inspiration-tag-chip"
                            className="rounded-full border px-1.5 text-xs"
                            style={{
                              borderColor: 'var(--border-subtle)',
                              color: 'var(--text-tertiary)'
                            }}
                          >
                            {tag}
                          </span>
                        ))}
                        {rawCode !== '' && (
                          <code
                            data-testid="inspiration-code-snippet"
                            className="max-w-48 truncate text-xs"
                            style={{ color: 'var(--text-tertiary)' }}
                          >
                            {rawCode}
                          </code>
                        )}
                      </div>
                    )}
                    {images.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {images.map((image) => (
                          <InspirationImage key={image.id} sha256={image.sha256} />
                        ))}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {/* F16：nextCursor 非空才给加载更多（消费 after 游标翻页），失败原位可重试 */}
          {!loadFailed && items !== null && items.length > 0 && listCursor !== null && (
            <button
              type="button"
              data-testid="inspiration-load-more"
              className="icon-btn text-xs"
              disabled={loadingMore || busy}
              onClick={() => void loadMore()}
            >
              {t('syncGallery.inspiration.loadMore')}
            </button>
          )}
          {loadMoreFailed && (
            <p
              data-testid="inspiration-load-more-error"
              className="text-xs"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {t('syncGallery.inspiration.loadMoreFailed')}
            </p>
          )}
        </div>
      </details>
    </div>
  )
}

/** 列表项图片：经 getInspirationImage 取 base64 后转 data URL；失败置错误态并落 warn，不静默吞。 */
const InspirationImage: React.FC<{ sha256: string }> = ({ sha256 }) => {
  const { t } = useTranslation()
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    const client = window.electronAPI?.nikkisync
    if (!client?.getInspirationImage) return
    void client
      .getInspirationImage({ sha256 })
      .then((res) => {
        if (!alive || !res) return
        // F19：mimeType 缺失（空串）会拼出 `data:;base64,…` 非法 data URL 走浏览器破图，
        // 与「读图失败」无异——按失败态处理，不产出非法 URL。
        if (
          typeof res.mimeType !== 'string' ||
          res.mimeType.length === 0 ||
          typeof res.bytesBase64 !== 'string'
        ) {
          setFailed(true)
          return
        }
        setSrc(`data:${res.mimeType};base64,${res.bytesBase64}`)
      })
      .catch((error: unknown) => {
        console.warn('[SyncInspirationPanel] getInspirationImage failed:', error)
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [sha256])
  if (failed) {
    return (
      <span
        data-testid="inspiration-image-load-error"
        className="text-xs"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {t('syncGallery.inspiration.loadFailed')}
      </span>
    )
  }
  if (!src) {
    return (
      <span
        data-testid="inspiration-image-preview"
        className="text-xs"
        style={{ color: 'var(--text-tertiary)' }}
      >
        …
      </span>
    )
  }
  return (
    <img
      data-testid="inspiration-image-preview"
      src={src}
      alt=""
      className="h-12 w-12 rounded object-cover"
    />
  )
}
