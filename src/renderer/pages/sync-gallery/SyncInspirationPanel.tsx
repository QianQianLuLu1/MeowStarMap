import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  NikkiSyncInspirationEntryInfo,
  NikkiSyncInspirationImageInfo,
  NikkiSyncInspirationVersionedInfo
} from '../../../shared/types/electron-api'

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

/** 组装上游 `validate()` 接受的最小合法条目（其余字段沿用被编辑条目或给缺省）。 */
function buildEntry(
  draft: Draft,
  base: NikkiSyncInspirationEntryInfo | undefined
): NikkiSyncInspirationEntryInfo {
  return {
    id: draft.id || newUuid(),
    title: draft.title,
    notes: draft.notes,
    tags: base?.tags ?? [],
    categories: base?.categories ?? [],
    status: base?.status ?? 'want',
    createdAt: base?.createdAt ?? Date.now(),
    deletedAt: 0,
    code: base?.code ?? emptyCode(),
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

export const SyncInspirationPanel: React.FC = () => {
  const { t } = useTranslation()
  const [items, setItems] = useState<NikkiSyncInspirationVersionedInfo[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [imageError, setImageError] = useState(false)
  const listGenerationRef = useRef(0)
  const saveGenerationRef = useRef(0)
  const imageGenerationRef = useRef(0)
  const loadedRef = useRef(false)
  const detailsRef = useRef<HTMLDetailsElement | null>(null)

  const api = window.electronAPI?.nikkisync
  const bridgeMissing =
    typeof api?.listInspirations !== 'function' ||
    typeof api?.saveInspiration !== 'function' ||
    typeof api?.putInspirationImage !== 'function' ||
    typeof api?.getInspirationImage !== 'function'

  const loadList = useCallback(async (): Promise<void> => {
    const client = window.electronAPI?.nikkisync
    if (!client?.listInspirations) return
    const generation = ++listGenerationRef.current
    try {
      const res = await client.listInspirations({ limit: 100 })
      if (generation !== listGenerationRef.current) return
      setItems(parseList(res))
      setLoadFailed(false)
    } catch {
      if (generation !== listGenerationRef.current) return
      setItems([])
      setLoadFailed(true)
    }
  }, [])

  // 库变更 ⇒ 列表可能是旧的；折叠态只复位缓存等下次展开，展开态立刻重取
  useEffect(() => {
    const subscribe = window.electronAPI?.nikkisync?.onLibraryChanged
    if (!subscribe) return
    return subscribe(() => {
      loadedRef.current = false
      setLoadFailed(false)
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

  if (bridgeMissing) return null

  const openDraft = (row?: NikkiSyncInspirationVersionedInfo): void => {
    const entry = row?.entry
    setDraft({
      id: typeof entry?.id === 'string' ? entry.id : '',
      title: typeof entry?.title === 'string' ? entry.title : '',
      notes: typeof entry?.notes === 'string' ? entry.notes : '',
      baseRevision: typeof row?.revision === 'number' ? row.revision : 0,
      images: parseImages(entry?.images)
    })
    setSaveError(false)
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

  /** 上游软删语义：`deletedAt` 非 0 时 `validate()` 会把 images 清空。 */
  const handleDelete = async (row: NikkiSyncInspirationVersionedInfo): Promise<void> => {
    const client = window.electronAPI?.nikkisync
    if (!client?.saveInspiration || !isRecord(row.entry ?? {})) return
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
          ) : (
            <ul className="space-y-2">
              {items.map((row) => {
                const images = parseImages(row.entry?.images)
                return (
                  <li
                    key={`${String(row.entry?.id ?? 'row')}-${row.revision}`}
                    data-testid="inspiration-item"
                    className="rounded-md border px-2 py-1"
                    style={{ borderColor: 'var(--border-subtle)' }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
                        {String(row.entry?.title ?? '')}
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
                          onClick={() => void handleDelete(row)}
                        >
                          {t('syncGallery.inspiration.delete')}
                        </button>
                      </span>
                    </div>
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
