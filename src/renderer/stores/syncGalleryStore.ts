import { create } from 'zustand'
import { fetchAssetPage, MEDIA_PAGE_SIZE, ASSET_PAGE_LIMIT_MAX } from './mediaStore'
import type { AssetMediaFile } from '../utils/assetViewModel'

/**
 * 阶段 5 · A2：同步图库（`sync-gallery` 视图）的列表状态。
 *
 * 为什么不复用 `mediaStore`：图库页 keep-alive 常驻，其 effect 依赖 `currentView`，
 * 导航就会触发一次 `fetchMediaFromDatabase()`；而数据源分流发生在**调用时刻**，
 * 若新页也写同一份 `mediaFiles`，两个源的请求会互相覆盖列表、游标串味。
 * 因此这里只持有一份**独立列表**，取数链则与图库共用 `fetchAssetPage()`（一处实现）。
 *
 * 依赖方向刻意单向：本文件 import `mediaStore` 的取数函数，`mediaStore` **绝不**反向
 * import 本文件（历史上 `uiStore ↔ mediaStore` 的循环依赖教训，见 renderer/AGENTS.md §2）。
 *
 * `error` 存的是 **i18n key** 而非译文：store 层不引 i18next，文案由页面 `t()` 展开，
 * 这样 store 测试可以直接断言键名，也不必 mock 翻译。
 */

/** 与 `mediaStore.MediaState` 对齐的页大小（同一道 1..500 上界）。 */
const PAGE_SIZE = Math.min(MEDIA_PAGE_SIZE, ASSET_PAGE_LIMIT_MAX)

export type SyncGalleryErrorKey = 'syncGallery.error.bridgeMissing' | 'syncGallery.error.loadFailed'

export interface SyncGalleryState {
  files: AssetMediaFile[]
  /** 上游 base64url 游标；`null` 表示没有下一页 */
  cursor: string | null
  libraryRevision: number | null
  hasMore: boolean
  loading: boolean
  loadingMore: boolean
  error: SyncGalleryErrorKey | null
}

export interface SyncGalleryActions {
  loadFirst: () => Promise<void>
  loadMore: () => Promise<void>
  reset: () => void
}

const initialState: SyncGalleryState = {
  files: [],
  cursor: null,
  libraryRevision: null,
  hasMore: false,
  loading: false,
  loadingMore: false,
  error: null
}

export const useSyncGalleryStore = create<SyncGalleryState & SyncGalleryActions>((set, get) => ({
  ...initialState,

  async loadFirst() {
    if (!window.electronAPI?.nikkisync?.getAssets) {
      set({ ...initialState, error: 'syncGallery.error.bridgeMissing' })
      return
    }
    set({ loading: true, error: null })
    const page = await fetchAssetPage({ limit: PAGE_SIZE })
    if (!page) {
      // 取数失败保留既有列表：清屏比报错更糟
      set({ loading: false, error: 'syncGallery.error.loadFailed' })
      return
    }
    set({
      files: page.files,
      cursor: page.nextCursor,
      libraryRevision: page.libraryRevision,
      hasMore: page.hasMore,
      loading: false,
      error: null
    })
  },

  async loadMore() {
    const { loadingMore, loading, hasMore, cursor } = get()
    // 并发保护：网格触底在一次滚动里可能连续触发多次；首屏（loading）在途时也不续页
    if (loadingMore || loading || !hasMore) return
    if (!window.electronAPI?.nikkisync?.getAssets) {
      set({ error: 'syncGallery.error.bridgeMissing' })
      return
    }
    set({ loadingMore: true })
    const page = await fetchAssetPage({ limit: PAGE_SIZE, cursor })
    if (!page) {
      set({ loadingMore: false, error: 'syncGallery.error.loadFailed' })
      return
    }
    // await 之后必须重读最新列表：loadFirst 可能在续页在途期间把列表整体替换，
    // 用 await 前的过期快照合并会让旧条目复活（对齐 mediaStore.loadNextAssetPage 惯例）
    const { files, loading: refreshing } = get()
    if (refreshing) {
      // 刷新尚未落定：由 loadFirst 负责回写列表，这里只收尾并发标志
      set({ loadingMore: false })
      return
    }
    // 游标分页在两次请求之间可能因扫描新增/删除而错位，按 asset_id 去重
    const seen = new Set(files.map((file) => file.id))
    const fresh = page.files.filter((file) => !seen.has(file.id))
    set({
      files: fresh.length > 0 ? [...files, ...fresh] : files,
      cursor: page.nextCursor,
      libraryRevision: page.libraryRevision,
      hasMore: page.hasMore,
      loadingMore: false,
      error: null
    })
  },

  reset() {
    set({ ...initialState })
  }
}))
