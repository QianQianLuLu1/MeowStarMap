import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useSyncGalleryStore } from './syncGalleryStore'
import { fetchAssetPage } from './mediaStore'
import type { AssetSummary, MediaResource } from '../../shared/sync/protocol'

/**
 * 阶段 5 · A2：同步图库独立入口的取数与状态测试。
 *
 * 为什么新页不复用 `mediaStore` 的列表：图库页是 keep-alive 常驻，其 effect 依赖
 * `currentView`，导航即触发一次 `fetchMediaFromDatabase()`；而源分流发生在**调用时刻**，
 * 两源的请求会互相覆盖 `mediaFiles`、翻页游标串味。因此 `fetchAssetPage()` 只做取数
 * （不写任何 store），图库继续用 `mediaStore`，同步图库用本 store —— 一份取数链，两份列表状态。
 *
 * 运行在 node 环境（`.test.ts` 不进 jsdom project），与 `mediaStore.nikkisync.test.ts`
 * 同惯例：手动给 globalThis.window 打桥桩。
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

interface Bridge {
  getAssets: ReturnType<typeof vi.fn>
  getResourceRecords: ReturnType<typeof vi.fn>
  edits: ReturnType<typeof vi.fn>
}

function setBridge(over: Partial<{ getAssets: ReturnType<typeof vi.fn> }> = {}): Bridge {
  const bridge: Bridge = {
    getAssets: over.getAssets ?? vi.fn().mockResolvedValue({ items: [], libraryRevision: 0 }),
    getResourceRecords: vi.fn((input: { mode: string }) =>
      Promise.resolve(
        input.mode === 'meta'
          ? {
              byAsset: Object.fromEntries(
                (input as unknown as { assetIds: string[] }).assetIds.map((id) => [
                  id,
                  [metaResource(id)]
                ])
              )
            }
          : {
              byAsset: Object.fromEntries(
                (input as unknown as { assetIds: string[] }).assetIds.map((id) => [
                  id,
                  { [`r-${id}`]: `D:/Game/${id}.png` }
                ])
              )
            }
      )
    ),
    edits: vi.fn().mockResolvedValue({ edits: [] })
  }
  ;(globalThis as { window?: { electronAPI?: Record<string, unknown> } }).window = {
    electronAPI: {
      nikkisync: { getAssets: bridge.getAssets, getResourceRecords: bridge.getResourceRecords },
      assetEdits: { list: bridge.edits }
    }
  }
  return bridge
}

function clearBridge(): void {
  ;(globalThis as { window?: unknown }).window = {}
}

beforeEach(() => {
  useSyncGalleryStore.getState().reset()
})

afterEach(() => {
  clearBridge()
})

describe('fetchAssetPage 取数层（不写任何 store）', () => {
  it('单页恰好 4 次往返：get-assets + meta + path + asset-edits', async () => {
    const bridge = setBridge({
      getAssets: vi.fn().mockResolvedValue({ items: [summary('a/1')], libraryRevision: 7 })
    })
    const page = await fetchAssetPage({ limit: 500 })
    expect(page?.files.map((file) => file.id)).toEqual(['a/1'])
    expect(bridge.getAssets).toHaveBeenCalledTimes(1)
    expect(bridge.getResourceRecords).toHaveBeenCalledTimes(2)
    expect(bridge.edits).toHaveBeenCalledTimes(1)
    // 取数层不得写 store：本用例执行后 store 仍应是初始态
    expect(useSyncGalleryStore.getState().files).toEqual([])
  })

  it('cursor 为 null/缺省时不把 cursor 键发给主进程（optional 展开语义）', async () => {
    const bridge = setBridge()
    await fetchAssetPage({ limit: 500 })
    expect(bridge.getAssets.mock.calls[0][0]).not.toHaveProperty('cursor')
    await fetchAssetPage({ limit: 500, cursor: null })
    expect(bridge.getAssets.mock.calls[1][0]).not.toHaveProperty('cursor')
    await fetchAssetPage({ limit: 500, cursor: 'cur-9' })
    expect(bridge.getAssets.mock.calls[2][0]).toEqual({ limit: 500, cursor: 'cur-9' })
  })

  it('空页返回 { files: [], hasMore: false } 而不是 null', async () => {
    setBridge({ getAssets: vi.fn().mockResolvedValue({ items: [], libraryRevision: 3 }) })
    const page = await fetchAssetPage({ limit: 500 })
    expect(page).not.toBeNull()
    expect(page?.files).toEqual([])
    expect(page?.hasMore).toBe(false)
    expect(page?.libraryRevision).toBe(3)
  })

  it('limit 越界（上游 zod 上界 500）在发请求前就被拒绝', async () => {
    const bridge = setBridge()
    await expect(fetchAssetPage({ limit: 0 })).rejects.toBeInstanceOf(Error)
    await expect(fetchAssetPage({ limit: 501 })).rejects.toBeInstanceOf(Error)
    expect(bridge.getAssets).not.toHaveBeenCalled()
  })

  it('profileUid 给定时按 account_uid 过滤该页（服务端不支持 uid 过滤，只能页内筛）', async () => {
    setBridge({
      getAssets: vi.fn().mockResolvedValue({
        items: [summary('a/1', { uid: 'u1' }), summary('a/2', { uid: 'u2' })],
        libraryRevision: 7
      })
    })
    const page = await fetchAssetPage({ limit: 500, profileUid: 'u1' })
    expect(page?.files.map((file) => file.id)).toEqual(['a/1'])
  })

  it('桥缺失时如实返回 null，不抛错', async () => {
    clearBridge()
    await expect(fetchAssetPage({ limit: 500 })).resolves.toBeNull()
  })
})

describe('useSyncGalleryStore', () => {
  it('loadFirst 写入 files/cursor/libraryRevision/hasMore 并复位 loading', async () => {
    setBridge({
      getAssets: vi
        .fn()
        .mockResolvedValue({ items: [summary('a/1')], nextCursor: 'cur-1', libraryRevision: 42 })
    })
    await useSyncGalleryStore.getState().loadFirst()
    const state = useSyncGalleryStore.getState()
    expect(state.files.map((file) => file.id)).toEqual(['a/1'])
    expect(state.cursor).toBe('cur-1')
    expect(state.libraryRevision).toBe(42)
    expect(state.hasMore).toBe(true)
    expect(state.loading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('loadMore 追加并去重，游标随页推进', async () => {
    const bridge = setBridge({
      getAssets: vi
        .fn()
        .mockResolvedValueOnce({
          items: [summary('a/1')],
          nextCursor: 'cur-1',
          libraryRevision: 42
        })
        .mockResolvedValueOnce({ items: [summary('a/1'), summary('a/2')], libraryRevision: 43 })
    })
    await useSyncGalleryStore.getState().loadFirst()
    await useSyncGalleryStore.getState().loadMore()
    expect(useSyncGalleryStore.getState().files.map((file) => file.id)).toEqual(['a/1', 'a/2'])
    expect(bridge.getAssets.mock.calls[1][0]).toEqual({ limit: 500, cursor: 'cur-1' })
    expect(useSyncGalleryStore.getState().hasMore).toBe(false)
  })

  it('loadMore 并发保护：loadingMore 期间重复调用只发一次请求', async () => {
    const bridge = setBridge({
      getAssets: vi
        .fn()
        .mockResolvedValueOnce({ items: [summary('a/1')], nextCursor: 'cur-1', libraryRevision: 1 })
        .mockResolvedValue({ items: [], libraryRevision: 2 })
    })
    await useSyncGalleryStore.getState().loadFirst()
    useSyncGalleryStore.setState({ loadingMore: true })
    await useSyncGalleryStore.getState().loadMore()
    expect(bridge.getAssets).toHaveBeenCalledTimes(1)
    useSyncGalleryStore.setState({ loadingMore: false })
    await useSyncGalleryStore.getState().loadMore()
    expect(bridge.getAssets).toHaveBeenCalledTimes(2)
  })

  it('hasMore 为假时 loadMore 直接返回，不再请求', async () => {
    const bridge = setBridge({
      getAssets: vi.fn().mockResolvedValue({ items: [summary('a/1')], libraryRevision: 1 })
    })
    await useSyncGalleryStore.getState().loadFirst()
    const before = bridge.getAssets.mock.calls.length
    await useSyncGalleryStore.getState().loadMore()
    expect(bridge.getAssets).toHaveBeenCalledTimes(before)
  })

  it('请求失败：error 置为 i18n 键，已加载列表不被清空', async () => {
    setBridge({
      getAssets: vi
        .fn()
        .mockResolvedValueOnce({ items: [summary('a/1')], nextCursor: 'c', libraryRevision: 1 })
        .mockRejectedValueOnce(new Error('database is locked'))
    })
    await useSyncGalleryStore.getState().loadFirst()
    await useSyncGalleryStore.getState().loadMore()
    const state = useSyncGalleryStore.getState()
    expect(state.error).toBe('syncGallery.error.loadFailed')
    expect(state.files).toHaveLength(1)
    expect(state.loadingMore).toBe(false)
  })

  it('桥缺失：error 置为 syncGallery.error.bridgeMissing，files 保持空', async () => {
    clearBridge()
    await useSyncGalleryStore.getState().loadFirst()
    const state = useSyncGalleryStore.getState()
    expect(state.error).toBe('syncGallery.error.bridgeMissing')
    expect(state.files).toEqual([])
    expect(state.loading).toBe(false)
  })

  it('loadMore 与 loadFirst 并发：await 后重读列表，await 前的过期快照不得复活', async () => {
    const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
      let resolve!: (value: T) => void
      const promise = new Promise<T>((r) => {
        resolve = r
      })
      return { promise, resolve }
    }
    type Page = { items: AssetSummary[]; nextCursor?: string; libraryRevision: number }
    const firstPage = deferred<Page>()
    const morePage = deferred<Page>()
    const reFirstPage = deferred<Page>()
    setBridge({
      getAssets: vi
        .fn()
        .mockReturnValueOnce(firstPage.promise)
        .mockReturnValueOnce(morePage.promise)
        .mockReturnValueOnce(reFirstPage.promise)
    })
    const p1 = useSyncGalleryStore.getState().loadFirst()
    firstPage.resolve({ items: [summary('a/1')], nextCursor: 'cur-1', libraryRevision: 1 })
    await p1
    const pMore = useSyncGalleryStore.getState().loadMore()
    // 续页在途时插入一次整表刷新（loadFirst），它会把列表整体替换掉
    const pFirst2 = useSyncGalleryStore.getState().loadFirst()
    reFirstPage.resolve({ items: [summary('b/1')], nextCursor: 'cur-9', libraryRevision: 2 })
    await pFirst2
    morePage.resolve({ items: [summary('a/2')], libraryRevision: 3 })
    await pMore
    // a/1 已被刷新替换：续页合并必须基于重读后的最新列表，绝不能把 a/1 复活
    expect(useSyncGalleryStore.getState().files.map((file) => file.id)).toEqual(['b/1', 'a/2'])
    expect(useSyncGalleryStore.getState().loadingMore).toBe(false)
  })
})
