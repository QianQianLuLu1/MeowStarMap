import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { fetchMediaFromDatabase, loadNextMediaPage, useMediaStore } from './mediaStore'
import type { AssetSummary, MediaResource } from '../../shared/sync/protocol'

/**
 * 图库数据源切换到 NikkiSync Runtime 的行为测试（阶段 4 · IPC 调用 → store 更新）。
 *
 * 断言的是「切源之后 store 里到底装了什么」，而不是组件渲染 —— 渲染口径由
 * `assetViewModel.test.ts`（字段映射）与 `ListView.nikkisync.test.tsx`（渲染）承担。
 *
 * 关键约束：本分支必须在 `fetchMediaFromDatabase` / `loadNextMediaPage` **内部**分流，
 * 这样 `useRefreshMedia` / `Sidebar` / `GalleryPage` 等所有既有调用点一行都不用改。
 */

const summary = (assetId: string, over: Partial<AssetSummary> = {}): AssetSummary => ({
  assetId,
  type: 'photo',
  state: 'ready',
  capturedAt: '2026-10-01T08:00:00.000Z',
  revision: 3,
  hasMotion: false,
  hasMetadata: false,
  ...over
})

const metaResource = (assetId: string): MediaResource => ({
  resourceId: `r-${assetId}`,
  role: 'source_high_quality',
  fileName: `${assetId}.png`,
  mimeType: 'image/png',
  fileExt: '.png',
  sizeBytes: 4096,
  sha256: 'aa',
  width: 100,
  height: 200
})

interface NikkisyncApi {
  getAssets: ReturnType<typeof vi.fn>
  getResourceRecords: ReturnType<typeof vi.fn>
  getChanges: ReturnType<typeof vi.fn>
  getRuntimeStatus: ReturnType<typeof vi.fn>
}

function setBridge(
  api: Partial<NikkisyncApi> & { edits?: ReturnType<typeof vi.fn> }
): NikkisyncApi & { mediaList: ReturnType<typeof vi.fn> } {
  const nikkisync: NikkisyncApi = {
    getAssets: vi.fn().mockResolvedValue({ items: [], libraryRevision: 0 }),
    getResourceRecords: vi.fn().mockResolvedValue({ byAsset: {} }),
    getChanges: vi
      .fn()
      .mockResolvedValue({ changes: [], libraryRevision: 0, fullResyncRequired: false }),
    getRuntimeStatus: vi.fn().mockResolvedValue({ state: 'running', dbPath: '', linkReady: true }),
    ...api
  }
  const mediaList = vi.fn().mockResolvedValue({ files: [], total: 0, hasMore: false })
  ;(globalThis as { window?: { electronAPI?: Record<string, unknown> } }).window = {
    electronAPI: {
      nikkisync,
      assetEdits: { list: api.edits ?? vi.fn().mockResolvedValue({ edits: [] }), set: vi.fn() },
      media: { list: mediaList },
      category: { list: vi.fn().mockResolvedValue({ categories: [] }) }
    }
  }
  return { ...nikkisync, mediaList }
}

beforeEach(() => {
  useMediaStore.setState({
    source: 'nikkisync',
    mediaFiles: [],
    mediaCursor: null,
    hasMoreMedia: false,
    nikkiCursor: null,
    nikkiRevision: null
  })
})

afterEach(() => {
  useMediaStore.setState({ source: 'local', nikkiCursor: null, nikkiRevision: null })
  ;(globalThis as { window?: unknown }).window = {}
})

describe('fetchMediaFromDatabase 走 NikkiSync 数据源', () => {
  it('调 get-assets 而不调 media.list，并按 asset_id 取回资源与路径', async () => {
    const api = setBridge({
      getAssets: vi.fn().mockResolvedValue({
        items: [summary('a/1'), summary('a/2')],
        libraryRevision: 7
      })
    })
    const result = await fetchMediaFromDatabase()
    expect(api.getAssets).toHaveBeenCalledTimes(1)
    const sent = api.getAssets.mock.calls[0][0] as { limit: number }
    expect(sent.limit).toBeGreaterThan(0)
    expect(api.getResourceRecords).toHaveBeenCalledWith(
      expect.objectContaining({ assetIds: ['a/1', 'a/2'], mode: 'meta' })
    )
    expect(api.getResourceRecords).toHaveBeenCalledWith(
      expect.objectContaining({ assetIds: ['a/1', 'a/2'], mode: 'path' })
    )
    expect(api.mediaList).not.toHaveBeenCalled()
    expect(result?.files.map((file) => file.id)).toEqual(['a/1', 'a/2'])
  })

  it('视图模型带正确路径与时长，缩略图留空交给按需生成流水线', async () => {
    setBridge({
      getAssets: vi.fn().mockResolvedValue({ items: [summary('a/1')], libraryRevision: 7 }),
      getResourceRecords: vi
        .fn()
        .mockResolvedValueOnce({ byAsset: { 'a/1': [metaResource('a/1')] } })
        .mockResolvedValueOnce({
          byAsset: { 'a/1': { 'r-a/1': 'D:/Game/X6Game/NikkiPhotos_HighQuality/a/1.png' } }
        })
    })
    const result = await fetchMediaFromDatabase()
    const file = result?.files[0]
    expect(file?.file_path).toBe('D:/Game/X6Game/NikkiPhotos_HighQuality/a/1.png')
    expect(file?.thumbnail).toBeUndefined()
    expect(file?.width).toBe(100)
    expect(file?.file_size).toBe(4096)
  })

  it('叠加层按 asset_id 合并收藏与评分', async () => {
    const edits = vi.fn().mockResolvedValue({
      edits: [
        {
          assetId: 'a/1',
          isFavorite: true,
          rating: 5,
          tags: ['花'],
          notes: '',
          categoryId: null,
          outfit: null,
          sceneCategory: null,
          sceneTime: null,
          isHidden: false,
          deletedAt: null,
          updatedAt: '2026-10-14'
        }
      ]
    })
    setBridge({
      getAssets: vi.fn().mockResolvedValue({ items: [summary('a/1')], libraryRevision: 7 }),
      edits
    })
    const result = await fetchMediaFromDatabase()
    expect(edits).toHaveBeenCalledWith(['a/1'])
    expect(result?.files[0].is_favorite).toBe(true)
    expect(result?.files[0].rating).toBe(5)
    expect(result?.files[0].tags).toEqual(['花'])
  })

  it('hasMore 由 nextCursor 决定，并把游标与 libraryRevision 写进 store', async () => {
    const api = setBridge({
      getAssets: vi.fn().mockResolvedValue({
        items: [summary('a/1')],
        nextCursor: 'cur-1',
        libraryRevision: 42
      })
    })
    const result = await fetchMediaFromDatabase()
    expect(result?.hasMore).toBe(true)
    expect(useMediaStore.getState().nikkiCursor).toBe('cur-1')
    expect(useMediaStore.getState().nikkiRevision).toBe(42)
    expect(api.getAssets).toHaveBeenCalled()
  })

  it('本地数据源下仍走 media.list（回归零破坏）', async () => {
    useMediaStore.setState({ source: 'local' })
    const api = setBridge({})
    const result = await fetchMediaFromDatabase()
    expect(api.getAssets).not.toHaveBeenCalled()
    expect(result?.files).toEqual([])
  })

  it('桥缺失时如实返回 null，不抛错也不清空列表', async () => {
    useMediaStore.setState({ source: 'nikkisync' })
    ;(globalThis as { window?: unknown }).window = {}
    await expect(fetchMediaFromDatabase()).resolves.toBeNull()
  })
})

describe('loadNextMediaPage 走 NikkiSync 数据源', () => {
  it('用 base64url 游标续页并追加，不重复已有条目', async () => {
    useMediaStore.setState({
      mediaFiles: [{ id: 'a/1' } as never],
      nikkiCursor: 'cur-1',
      hasMoreMedia: true
    })
    const api = setBridge({
      getAssets: vi.fn().mockResolvedValue({
        items: [summary('a/2')],
        nextCursor: 'cur-2',
        libraryRevision: 43
      })
    })
    await loadNextMediaPage()
    expect(api.getAssets).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'cur-1' }))
    expect(useMediaStore.getState().mediaFiles.map((file) => file.id)).toEqual(['a/1', 'a/2'])
    expect(useMediaStore.getState().nikkiCursor).toBe('cur-2')
    expect(useMediaStore.getState().hasMoreMedia).toBe(true)
  })

  it('末页（无 nextCursor）后 hasMore 置假，不再请求', async () => {
    useMediaStore.setState({ mediaFiles: [], nikkiCursor: 'cur-2', hasMoreMedia: true })
    const api = setBridge({
      getAssets: vi.fn().mockResolvedValue({ items: [summary('a/9')], libraryRevision: 44 })
    })
    await loadNextMediaPage()
    expect(api.getAssets).toHaveBeenCalledTimes(1)
    expect(useMediaStore.getState().hasMoreMedia).toBe(false)
  })
})
