import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  useMediaStore,
  updateMediaFileAndPersist,
  fetchMediaFromDatabase,
  getMediaRefreshAbortKind,
  refreshMediaAfterScan,
  loadMoreMedia,
  loadNextMediaPage,
  loadRecycleBin,
  type MediaFile
} from './mediaStore'
import { useUIStore } from './uiStore'

function makeFile(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    id: '1',
    file_path: '/test/img.jpg',
    file_name: 'img.jpg',
    file_type: 'image',
    file_ext: '.jpg',
    file_size: 1024,
    created_at: '2026-01-01T00:00:00.000Z',
    modified_at: '2026-01-01T00:00:00.000Z',
    tags: [],
    rating: 0,
    is_favorite: false,
    notes: '',
    scene_category: 'other',
    ...overrides
  }
}

interface MockMediaApi {
  list: ReturnType<typeof vi.fn>
  findDuplicates: ReturnType<typeof vi.fn>
  findSimilar: ReturnType<typeof vi.fn>
  onUpdated: ReturnType<typeof vi.fn>
}

interface MockMediaActionApi {
  updateTags: ReturnType<typeof vi.fn>
  updateRating: ReturnType<typeof vi.fn>
  updateFavorite: ReturnType<typeof vi.fn>
  updateNotes: ReturnType<typeof vi.fn>
  updateCategory: ReturnType<typeof vi.fn>
  updateOutfit: ReturnType<typeof vi.fn>
}

interface MockCategoryApi {
  list: ReturnType<typeof vi.fn>
}

function setMockApi(
  overrides: {
    media?: Partial<MockMediaApi>
    mediaAction?: Partial<MockMediaActionApi>
    category?: Partial<MockCategoryApi>
  } = {}
): void {
  const media: MockMediaApi = {
    // preload call() 已解包 IpcResponse，mock 返回值不应含 success 字段
    list: vi.fn().mockResolvedValue({ files: [], total: 0, hasMore: false }),
    findDuplicates: vi.fn(),
    findSimilar: vi.fn(),
    onUpdated: vi.fn().mockReturnValue(() => {}),
    ...overrides.media
  }
  const mediaAction: MockMediaActionApi = {
    updateTags: vi.fn().mockResolvedValue({ success: true }),
    updateRating: vi.fn().mockResolvedValue({ success: true }),
    updateFavorite: vi.fn().mockResolvedValue({ success: true }),
    updateNotes: vi.fn().mockResolvedValue({ success: true }),
    updateCategory: vi.fn().mockResolvedValue({ success: true }),
    updateOutfit: vi.fn().mockResolvedValue({ success: true }),
    ...overrides.mediaAction
  }
  const category: MockCategoryApi = {
    list: vi.fn().mockResolvedValue({ categories: [] }),
    ...overrides.category
  }
  ;(globalThis as { window?: { electronAPI?: Record<string, unknown> } }).window = {
    electronAPI: { media, mediaAction, category }
  }
}

function clearMockApi(): void {
  // 设置 window 为空对象（无 electronAPI），模拟无 Electron 环境
  // 不能直接置 undefined，因为源码 `window.electronAPI` 在 window 本身为 undefined 时会抛错
  ;(globalThis as { window?: { electronAPI?: Record<string, unknown> } }).window = {}
}

/**
 * mock media:list 的 keyset 游标分页，语义对齐 media-repository.listMedia 的 DESC 分支：
 * 首页（cursor=null）取最新 pageSize 条，续页取「排序键 < 锚点」的下一页。
 * 刻意按**传入的 pageSize** 切片——深度取数正是靠这个观测每页请求量是否越过主进程 zod 上界。
 */
function setPagedListMock(total: number): void {
  const sorted = Array.from({ length: total }, (_, i) => makeFile({ id: String(i + 1) })).sort(
    (a, b) => Number(b.id) - Number(a.id)
  )
  const list = vi.fn(async (args?: { cursor?: { id: number } | null; pageSize?: number }) => {
    const afterId = args?.cursor?.id ?? null
    const pageSize = args?.pageSize ?? 500
    const startIdx = afterId === null ? 0 : sorted.findIndex((f) => Number(f.id) < afterId)
    const page = startIdx === -1 ? [] : sorted.slice(startIdx, startIdx + pageSize)
    const hasMore = startIdx !== -1 && startIdx + page.length < sorted.length
    const last = page[page.length - 1]
    return {
      files: page,
      total,
      hasMore,
      nextCursor: hasMore && last ? { sortValue: last.created_at, id: Number(last.id) } : null
    }
  })
  setMockApi({ media: { list } })
}

/** 取回当前注入的 media.list mock，便于断言每次调用的入参 */
function listMockFn(): ReturnType<typeof vi.fn> {
  return (globalThis as { window?: { electronAPI?: { media?: MockMediaApi } } }).window!
    .electronAPI!.media!.list as ReturnType<typeof vi.fn>
}

/**
 * 与 setPagedListMock 同语义，但每次 media:list 返回一个**手动放行**的 promise。
 * 存在理由：要观测「深度取数卡在某一页的 await 上」与「触底续页同时起来」这两条链的交错，
 * 自动 resolve 的 mock 会让两条链在同一个微任务批次里跑完，时序根本分不开。
 */
function setGatedPagedListMock(total: number): {
  list: ReturnType<typeof vi.fn>
  /** 放行第 `index` 次未决请求（默认最早的一次）；下标越界或无请求在等时返回 false */
  release: (index?: number) => boolean
} {
  const sorted = Array.from({ length: total }, (_, i) => makeFile({ id: String(i + 1) })).sort(
    (a, b) => Number(b.id) - Number(a.id)
  )
  const queue: Array<() => void> = []
  const list = vi.fn((args?: { cursor?: { id: number } | null; pageSize?: number }) => {
    const afterId = args?.cursor?.id ?? null
    const pageSize = args?.pageSize ?? 500
    const startIdx = afterId === null ? 0 : sorted.findIndex((f) => Number(f.id) < afterId)
    const page = startIdx === -1 ? [] : sorted.slice(startIdx, startIdx + pageSize)
    const hasMore = startIdx !== -1 && startIdx + page.length < sorted.length
    const last = page[page.length - 1]
    const payload = {
      files: page,
      total,
      hasMore,
      nextCursor: hasMore && last ? { sortValue: last.created_at, id: Number(last.id) } : null
    }
    return new Promise((resolve) => {
      queue.push(() => resolve(payload))
    })
  })
  setMockApi({ media: { list } })
  return {
    list,
    release: (index = 0) => {
      if (index < 0 || index >= queue.length) return false
      const next = queue.splice(index, 1)[0]
      next()
      return true
    }
  }
}

/** 排空一轮微任务（链上有多个 await，单次 Promise.resolve 不够） */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('mediaStore', () => {
  beforeEach(() => {
    useMediaStore.setState({
      mediaFiles: [],
      categories: [],
      loading: false,
      scanProgress: {
        scanning: false,
        scanned: 0,
        found: 0,
        currentPath: '',
        status: 'idle'
      },
      editingMedia: null,
      recycleBinFiles: [],
      recycleBinLoading: false,
      // 深度取数与计数用例都断言这几个字段的终值，必须逐例复位，否则上一例的残留会让断言假绿
      hasMoreMedia: false,
      mediaCursor: null,
      loadingMore: false,
      mediaTotalCount: null,
      mediaImageCount: null,
      mediaVideoCount: null
    })
    // 图库目录限制测试依赖 currentView：恢复默认视图，避免用例间相互污染
    useUIStore.setState({ currentView: 'gallery' })
  })

  afterEach(() => {
    clearMockApi()
    vi.restoreAllMocks()
  })

  describe('setMediaFiles', () => {
    it('替换整个媒体列表', () => {
      const { setMediaFiles } = useMediaStore.getState()
      const files = [makeFile({ id: '1' }), makeFile({ id: '2' })]
      setMediaFiles(files)
      expect(useMediaStore.getState().mediaFiles).toEqual(files)
    })

    it('传空数组清空列表', () => {
      const { setMediaFiles } = useMediaStore.getState()
      setMediaFiles([makeFile()])
      setMediaFiles([])
      expect(useMediaStore.getState().mediaFiles).toEqual([])
    })
  })

  describe('addMediaFiles', () => {
    it('在末尾追加新文件', () => {
      const { setMediaFiles, addMediaFiles } = useMediaStore.getState()
      setMediaFiles([makeFile({ id: '1' })])
      addMediaFiles([makeFile({ id: '2' }), makeFile({ id: '3' })])
      expect(useMediaStore.getState().mediaFiles.map((f) => f.id)).toEqual(['1', '2', '3'])
    })

    it('空列表上追加也正常', () => {
      const { addMediaFiles } = useMediaStore.getState()
      addMediaFiles([makeFile({ id: 'a' })])
      expect(useMediaStore.getState().mediaFiles.length).toBe(1)
    })
  })

  describe('updateMediaFile', () => {
    it('按 id 更新指定文件的字段', () => {
      const { setMediaFiles, updateMediaFile } = useMediaStore.getState()
      setMediaFiles([makeFile({ id: '1', rating: 0 }), makeFile({ id: '2', rating: 0 })])
      updateMediaFile('1', { rating: 5 })
      const state = useMediaStore.getState().mediaFiles
      expect(state[0].rating).toBe(5)
      expect(state[1].rating).toBe(0)
    })

    it('id 不存在时列表不变', () => {
      const { setMediaFiles, updateMediaFile } = useMediaStore.getState()
      const files = [makeFile({ id: '1' })]
      setMediaFiles(files)
      updateMediaFile('nonexistent', { rating: 5 })
      expect(useMediaStore.getState().mediaFiles).toEqual(files)
    })

    it('部分更新不会丢失其他字段', () => {
      const { setMediaFiles, updateMediaFile } = useMediaStore.getState()
      setMediaFiles([makeFile({ id: '1', rating: 3, notes: 'old' })])
      updateMediaFile('1', { rating: 5 })
      const file = useMediaStore.getState().mediaFiles[0]
      expect(file.rating).toBe(5)
      expect(file.notes).toBe('old')
    })
  })

  describe('deleteMediaFiles', () => {
    it('按 id 数组移除文件', () => {
      const { setMediaFiles, deleteMediaFiles } = useMediaStore.getState()
      setMediaFiles([makeFile({ id: '1' }), makeFile({ id: '2' }), makeFile({ id: '3' })])
      deleteMediaFiles(['1', '3'])
      expect(useMediaStore.getState().mediaFiles.map((f) => f.id)).toEqual(['2'])
    })

    it('空数组时列表不变', () => {
      const { setMediaFiles, deleteMediaFiles } = useMediaStore.getState()
      const files = [makeFile({ id: '1' })]
      setMediaFiles(files)
      deleteMediaFiles([])
      expect(useMediaStore.getState().mediaFiles).toEqual(files)
    })
  })

  describe('setCategories', () => {
    it('替换分类列表', () => {
      const { setCategories } = useMediaStore.getState()
      const cats = [{ id: 1, name: 'cat1', icon: '', color: '', sort_order: 0, is_system: false }]
      setCategories(cats)
      expect(useMediaStore.getState().categories).toEqual(cats)
    })
  })

  describe('setLoading', () => {
    it('切换 loading 状态', () => {
      const { setLoading } = useMediaStore.getState()
      expect(useMediaStore.getState().loading).toBe(false)
      setLoading(true)
      expect(useMediaStore.getState().loading).toBe(true)
      setLoading(false)
      expect(useMediaStore.getState().loading).toBe(false)
    })
  })

  describe('setScanProgress', () => {
    it('部分更新 scanProgress 对象', () => {
      const { setScanProgress } = useMediaStore.getState()
      setScanProgress({ scanning: true, scanned: 10 })
      const progress = useMediaStore.getState().scanProgress
      expect(progress.scanning).toBe(true)
      expect(progress.scanned).toBe(10)
      // 未更新的字段保留原值
      expect(progress.status).toBe('idle')
    })

    it('多次部分更新累积生效', () => {
      const { setScanProgress } = useMediaStore.getState()
      setScanProgress({ scanning: true, status: 'running' })
      setScanProgress({ scanned: 50, found: 30 })
      setScanProgress({ status: 'completed' })
      const progress = useMediaStore.getState().scanProgress
      expect(progress).toEqual({
        scanning: true,
        scanned: 50,
        found: 30,
        currentPath: '',
        status: 'completed'
      })
    })
  })

  describe('setEditingMedia', () => {
    it('设置当前编辑的媒体', () => {
      const { setEditingMedia } = useMediaStore.getState()
      const file = makeFile({ id: '99' })
      setEditingMedia(file)
      expect(useMediaStore.getState().editingMedia).toEqual(file)
    })

    it('传 null 清空', () => {
      const { setEditingMedia } = useMediaStore.getState()
      setEditingMedia(makeFile())
      setEditingMedia(null)
      expect(useMediaStore.getState().editingMedia).toBeNull()
    })
  })

  describe('setRecycleBinFiles / setRecycleBinLoading', () => {
    it('设置回收站文件列表', () => {
      const { setRecycleBinFiles } = useMediaStore.getState()
      const files = [makeFile({ id: 'r1', is_deleted: true })]
      setRecycleBinFiles(files)
      expect(useMediaStore.getState().recycleBinFiles).toEqual(files)
    })

    it('设置回收站加载状态', () => {
      const { setRecycleBinLoading } = useMediaStore.getState()
      setRecycleBinLoading(true)
      expect(useMediaStore.getState().recycleBinLoading).toBe(true)
    })
  })

  describe('updateMediaFileAndPersist', () => {
    it('无 window.electronAPI 时仅更新本地状态', async () => {
      clearMockApi()
      useMediaStore.getState().setMediaFiles([makeFile({ id: '1', rating: 0 })])
      const result = await updateMediaFileAndPersist('1', { rating: 5 })
      expect(result.success).toBe(true)
      expect(useMediaStore.getState().mediaFiles[0].rating).toBe(5)
    })

    it('更新 tags 调用 mediaAction.updateTags', async () => {
      setMockApi({
        mediaAction: {
          updateTags: vi.fn().mockResolvedValue({ success: true })
        }
      })
      useMediaStore.getState().setMediaFiles([makeFile({ id: '1', tags: [] })])
      await updateMediaFileAndPersist('1', { tags: ['a', 'b'] })
      const mockFn = (
        globalThis as { window?: { electronAPI?: { mediaAction?: MockMediaActionApi } } }
      ).window!.electronAPI!.mediaAction!.updateTags
      expect(mockFn).toHaveBeenCalledWith(1, ['a', 'b'])
      expect(useMediaStore.getState().mediaFiles[0].tags).toEqual(['a', 'b'])
    })

    it('更新 rating 调用 mediaAction.updateRating', async () => {
      setMockApi({
        mediaAction: {
          updateRating: vi.fn().mockResolvedValue({ success: true })
        }
      })
      useMediaStore.getState().setMediaFiles([makeFile({ id: '5', rating: 0 })])
      await updateMediaFileAndPersist('5', { rating: 4 })
      const mockFn = (
        globalThis as { window?: { electronAPI?: { mediaAction?: MockMediaActionApi } } }
      ).window!.electronAPI!.mediaAction!.updateRating
      expect(mockFn).toHaveBeenCalledWith(5, 4)
    })

    it('更新 is_favorite 调用 mediaAction.updateFavorite', async () => {
      setMockApi({
        mediaAction: {
          updateFavorite: vi.fn().mockResolvedValue({ success: true })
        }
      })
      useMediaStore.getState().setMediaFiles([makeFile({ id: '1', is_favorite: false })])
      await updateMediaFileAndPersist('1', { is_favorite: true })
      const mockFn = (
        globalThis as { window?: { electronAPI?: { mediaAction?: MockMediaActionApi } } }
      ).window!.electronAPI!.mediaAction!.updateFavorite
      expect(mockFn).toHaveBeenCalledWith(1, true)
    })

    it('更新 outfit 调用 mediaAction.updateOutfit', async () => {
      setMockApi({
        mediaAction: {
          updateOutfit: vi.fn().mockResolvedValue({ success: true })
        }
      })
      useMediaStore.getState().setMediaFiles([makeFile({ id: '1' })])
      await updateMediaFileAndPersist('1', { outfit: '星海' })
      const mockFn = (
        globalThis as { window?: { electronAPI?: { mediaAction?: MockMediaActionApi } } }
      ).window!.electronAPI!.mediaAction!.updateOutfit
      expect(mockFn).toHaveBeenCalledWith(1, '星海')
    })

    it('更新 category_id 传 null 时调用 updateCategory(id, null)', async () => {
      setMockApi({
        mediaAction: {
          updateCategory: vi.fn().mockResolvedValue({ success: true })
        }
      })
      useMediaStore.getState().setMediaFiles([makeFile({ id: '1' })])
      await updateMediaFileAndPersist('1', { category_id: undefined })
      const mockFn = (
        globalThis as { window?: { electronAPI?: { mediaAction?: MockMediaActionApi } } }
      ).window!.electronAPI!.mediaAction!.updateCategory
      expect(mockFn).toHaveBeenCalledWith(1, null)
    })

    it('多个字段同时更新时并行调用对应 IPC', async () => {
      setMockApi({
        mediaAction: {
          updateRating: vi.fn().mockResolvedValue({ success: true }),
          updateNotes: vi.fn().mockResolvedValue({ success: true }),
          updateFavorite: vi.fn().mockResolvedValue({ success: true })
        }
      })
      useMediaStore.getState().setMediaFiles([makeFile({ id: '1' })])
      await updateMediaFileAndPersist('1', {
        rating: 5,
        notes: 'test',
        is_favorite: true
      })
      const api = (
        globalThis as { window?: { electronAPI?: { mediaAction?: MockMediaActionApi } } }
      ).window!.electronAPI!.mediaAction!
      expect(api.updateRating).toHaveBeenCalledWith(1, 5)
      expect(api.updateNotes).toHaveBeenCalledWith(1, 'test')
      expect(api.updateFavorite).toHaveBeenCalledWith(1, true)
    })

    it('IPC 抛错时返回失败，本地状态不更新', async () => {
      setMockApi({
        mediaAction: {
          updateRating: vi.fn().mockRejectedValue(new Error('IPC error'))
        }
      })
      useMediaStore.getState().setMediaFiles([makeFile({ id: '1', rating: 0 })])
      const result = await updateMediaFileAndPersist('1', { rating: 5 })
      expect(result.success).toBe(false)
      expect(result.message).toContain('IPC error')
      // 本地状态未更新
      expect(useMediaStore.getState().mediaFiles[0].rating).toBe(0)
    })
  })

  describe('fetchMediaFromDatabase', () => {
    it('从数据库加载文件与分类', async () => {
      const files = [makeFile({ id: '1' })]
      const categories = [
        { id: 1, name: 'cat', icon: '', color: '', sort_order: 0, is_system: false }
      ]
      setMockApi({
        media: {
          list: vi.fn().mockResolvedValue({
            files,
            total: 1,
            hasMore: false
          })
        },
        category: {
          list: vi.fn().mockResolvedValue({ categories })
        }
      })

      const result = await fetchMediaFromDatabase()
      expect(result).not.toBeNull()
      expect(result!.files).toEqual(files)
      expect(result!.categories).toEqual(categories)
      expect(result!.total).toBe(1)
      expect(result!.hasMore).toBe(false)
    })

    it('media.list 抛出异常时返回 null', async () => {
      setMockApi({
        media: {
          list: vi.fn().mockRejectedValue(new Error('db error'))
        }
      })
      const result = await fetchMediaFromDatabase()
      expect(result).toBeNull()
    })

    it('category.list 抛出异常时返回 null', async () => {
      setMockApi({
        media: {
          list: vi.fn().mockResolvedValue({ files: [] })
        },
        category: {
          list: vi.fn().mockRejectedValue(new Error('category error'))
        }
      })
      const result = await fetchMediaFromDatabase()
      expect(result).toBeNull()
    })

    it('无 electronAPI 时返回 null', async () => {
      clearMockApi()
      const result = await fetchMediaFromDatabase()
      expect(result).toBeNull()
    })

    it('首次加载使用 keyset 游标（cursor:null）+ pageSize=500', async () => {
      setMockApi()
      await fetchMediaFromDatabase()
      const mockFn = (globalThis as { window?: { electronAPI?: { media?: MockMediaApi } } }).window!
        .electronAPI!.media!.list
      // 性能重构：首屏使用 keyset 游标（cursor:null），取代 page=0 偏移分页
      expect(mockFn).toHaveBeenCalledWith(expect.objectContaining({ cursor: null, pageSize: 500 }))
    })

    it('N6 深度取数：按 keyset 游标逐页循环，单次 pageSize 绝不越过主进程 zod 上界 500', async () => {
      // 缺陷（R-2）：本函数把调用方传的 limit（media:updated 时为「当前已加载条数」，可 > 500）
      // 原样写成 pageSize 直传 media:list ⇒ 被 media-handler 的 z….max(500) 判 VALIDATION_ERROR
      // ⇒ preload 抛 IpcError ⇒ 本函数的 catch 吞成 null ⇒ 整表刷新静默失效，新扫描到的文件进不了列表。
      // 修复：limit 的语义是「目标深度」，内部按页循环取到该深度，每页 pageSize 恒 ≤ 500。
      //（对照：nikkisync 分支在 fetchMediaFromRuntime 里做了同款 clamp，本地分支当初漏了。）
      setPagedListMock(1200)
      const result = await fetchMediaFromDatabase({ limit: 1200 })
      const listMock = listMockFn()

      expect(result).not.toBeNull()
      expect(result!.files).toHaveLength(1200)
      // 500 + 500 + 200：三次调用，每次都在线上界之内
      const callCount = listMock.mock.calls.length
      expect(callCount).toBe(3)
      const pageSizes = listMock.mock.calls.map((c) => {
        const arg = c[0] as { pageSize?: number } | undefined
        return arg?.pageSize ?? 0
      })
      expect(pageSizes).toEqual([500, 500, 200])
      for (const size of pageSizes) {
        expect(size).toBeLessThanOrEqual(500)
      }
      // 首页仍是 cursor:null（整表刷新语义），续页才带游标
      expect((listMock.mock.calls[0][0] as { cursor?: unknown }).cursor).toBeNull()
      // 取到全部 ⇒ 游标与 hasMoreMedia 收口，避免下一次 effect 又从陈旧游标续页
      expect(result!.hasMore).toBe(false)
      expect(useMediaStore.getState().hasMoreMedia).toBe(false)
    })

    it('深度取数在途时触底续页不得并发取数（防两条写者交错写坏 mediaCursor）', async () => {
      // 缺陷：fetchMediaFromDatabase 的逐页循环只在**循环结束后**写 mediaCursor/hasMoreMedia，全程不设屏障；
      // loadNextMediaPage 的守卫只看 loadingMore/hasMoreMedia ⇒ 用户在整刷在途时触底，会拿**刷新前的旧游标**
      // 并发取数，两条写者先后覆写 mediaCursor ⇒ 下一次触底从「循环快照边界的下一页」起取，中间那页静默丢失。
      const gated = setGatedPagedListMock(1200)
      // 复刻真实前置态：用户已触底滚过一页（库里 1200、屏上 500），此刻 media:updated 按深度整刷
      useMediaStore.setState({
        mediaFiles: Array.from({ length: 500 }, (_, i) => makeFile({ id: String(1200 - i) })),
        hasMoreMedia: true,
        mediaCursor: { sortValue: '2026-01-01T00:00:00.000Z', id: 701 },
        loadingMore: false
      })

      const refreshing = fetchMediaFromDatabase({ limit: 600 })
      await flushMicrotasks()
      expect(gated.list).toHaveBeenCalledTimes(1)
      // 放行首页 ⇒ 循环发现只到 500、未达目标深度 600，发出第二页（额度收口为 100）
      expect(gated.release()).toBe(true)
      await flushMicrotasks()
      expect(gated.list).toHaveBeenCalledTimes(2)
      expect((gated.list.mock.calls[1][0] as { pageSize?: number }).pageSize).toBe(100)

      // 关键窗口：循环仍卡在第二页的 await 上，用户此时触底
      void loadNextMediaPage()
      await flushMicrotasks()
      // 修复前这里是 3：触底钻进来与循环并发取数
      expect(gated.list).toHaveBeenCalledTimes(2)

      // 放行第二页让整刷正常结束，并证明屏障随之释放（否则一次整刷就把触底永久打死）
      expect(gated.release()).toBe(true)
      const result = await refreshing
      expect(result!.files).toHaveLength(600)
      expect(result!.hasMore).toBe(true)
      expect(useMediaStore.getState().hasMoreMedia).toBe(true)
      expect(useMediaStore.getState().loadingMore).toBe(false)
      // 真实调用方（GalleryPage / Sidebar）拿到结果后会写回 store，这里对齐该动作再触底
      useMediaStore.getState().setMediaFiles(result!.files)

      void loadNextMediaPage()
      await flushMicrotasks()
      expect(gated.list).toHaveBeenCalledTimes(3)
      // 续页要从循环写完的那个游标接着走，不能回退到刷新前的旧游标 701
      const thirdCursor = (gated.list.mock.calls[2][0] as { cursor?: { id: number } }).cursor
      expect(thirdCursor?.id).toBe(601)
      gated.release()
      await flushMicrotasks()
      expect(useMediaStore.getState().mediaFiles).toHaveLength(1100)
    })

    it('迟到的触底页在整刷写完游标之后落地时不得覆写游标（§10 残留 1 闭合）', async () => {
      // 缺陷：上一轮的 depthFetchActive 屏障只在**起跑时刻**拦触底，拦不住「已经起跑、尚未收尾」的那一页。
      // 整刷启动时若在途已有一次 loadNextMediaPage，它不受屏障约束，其 finally 会照常清 loadingMore，
      // 而它的 setState 落在整刷写游标**之后** ⇒ 用刷新前的旧游标（下一页 201）覆写整刷刚写入的新游标，
      // 同时把旧快照的 400 条追加进新列表 —— 数组与游标跨在两轮之间。
      const gated = setGatedPagedListMock(1200)
      useMediaStore.setState({
        mediaFiles: Array.from({ length: 500 }, (_, i) => makeFile({ id: String(1200 - i) })),
        hasMoreMedia: true,
        mediaCursor: { sortValue: '2026-01-01T00:00:00.000Z', id: 701 },
        loadingMore: false
      })

      // ① 触底先起跑：此刻还没有屏障，它必须放行（这正是上一轮修的行为，不得回归）
      const late = loadNextMediaPage()
      await flushMicrotasks()
      expect(gated.list).toHaveBeenCalledTimes(1)

      // ② 随后整刷启动 ⇒ 屏障立起，但拦不住已在途的那一页
      const refreshing = fetchMediaFromDatabase({ limit: 600 })
      await flushMicrotasks()
      expect(gated.list).toHaveBeenCalledTimes(2)
      // 队首是迟到页的请求，整刷的两页在其后 ⇒ 用下标逆序放行，让整刷先落地
      expect(gated.release(1)).toBe(true)
      await flushMicrotasks()
      expect(gated.list).toHaveBeenCalledTimes(3)
      expect(gated.release(1)).toBe(true)
      const result = await refreshing
      expect(result!.files).toHaveLength(600)
      useMediaStore.getState().setMediaFiles(result!.files)
      const cursorAfterRefresh = useMediaStore.getState().mediaCursor
      expect(cursorAfterRefresh?.id).toBe(601)

      // ③ 迟到页此刻才落地：它带的还是刷新前那一刻的下一页游标
      expect(gated.release(0)).toBe(true)
      await late

      // 牙 1：游标必须仍是整刷写入的那一个，不得被迟到的旧页覆写
      expect(useMediaStore.getState().mediaCursor).toEqual(cursorAfterRefresh)
      // 牙 2：列表不得再混入旧快照的追加（守卫必须放在 addMediaFiles **之前**，不止游标之前）
      expect(useMediaStore.getState().mediaFiles).toHaveLength(600)
      // 保险索（非缺陷复现，修复前也是绿的）：弃权不得留下跨轮状态，否则一次迟到页就把触底永久打死
      expect(useMediaStore.getState().loadingMore).toBe(false)
      // 弃权路径没有额外代价：没有为这一页再发第四次请求
      expect(gated.list).toHaveBeenCalledTimes(3)
    })

    it('整刷收尾不得清空在途触底的 loadingMore（复位责任归触底自己的 finally，DEBT-056）', async () => {
      // 缺陷：整刷收尾的 setState 块无条件写 loadingMore:false。在途触底（已置 loadingMore=true、
      // 请求未落地）被它顺带清标记 ⇒ 触底的并发闸被提前拆除，迟到的页还没落地用户就能再起一条
      // 触底，用旧游标并发取数。复位责任完全归属触底自己的 finally（无条件、连弃权路径也不漏）。
      const gated = setGatedPagedListMock(1200)
      useMediaStore.setState({
        mediaFiles: Array.from({ length: 500 }, (_, i) => makeFile({ id: String(1200 - i) })),
        hasMoreMedia: true,
        mediaCursor: { sortValue: '2026-01-01T00:00:00.000Z', id: 701 },
        loadingMore: false
      })

      // ① 触底先起跑：loadingMore=true，请求卡在 gated 队首
      const late = loadNextMediaPage()
      await flushMicrotasks()
      expect(gated.list).toHaveBeenCalledTimes(1)
      expect(useMediaStore.getState().loadingMore).toBe(true)

      // ② 整刷起来：请求排在队首之后（逆序放行的前提）
      const refreshing = fetchMediaFromDatabase({ limit: 500 })
      await flushMicrotasks()
      expect(gated.list).toHaveBeenCalledTimes(2)

      // ③ 放行整刷首页 ⇒ 整刷完整落地（写游标/计数；DEBT-056 缺陷在此顺带清掉 loadingMore）
      expect(gated.release(1)).toBe(true)
      const result = await refreshing
      expect(result).not.toBeNull()
      // 完整性锚：整刷确实写完了（计数落地），不是中途失败提前返回
      expect(useMediaStore.getState().mediaTotalCount).toBe(1200)
      // 牙（修复前红）：在途触底还在，整刷不得替它复位 loadingMore
      expect(useMediaStore.getState().loadingMore).toBe(true)

      // ④ 迟到页此刻落地（弃权）⇒ 它自己的 finally 无条件复位 —— 对照（修复前亦绿）
      expect(gated.release(0)).toBe(true)
      await late
      expect(useMediaStore.getState().loadingMore).toBe(false)
    })

    it('深度取数：limit 不超过一页时只发一次请求（不产生额外 IPC 往返）', async () => {
      setPagedListMock(300)
      const result = await fetchMediaFromDatabase({ limit: 1200 })
      expect(listMockFn()).toHaveBeenCalledTimes(1)
      expect(result!.files).toHaveLength(300)
    })

    it('深度取数：中途某页失败时保留已取数据，hasMoreMedia 维持 true 供下轮重试', async () => {
      const all = Array.from({ length: 1200 }, (_, i) => makeFile({ id: String(i + 1) }))
      let call = 0
      const list = vi.fn(async () => {
        call += 1
        if (call === 1) {
          return {
            files: all.slice(0, 500),
            total: 1200,
            hasMore: true,
            nextCursor: { sortValue: '2026-01-01T00:00:00.000Z', id: 500 }
          }
        }
        throw new Error('VALIDATION_ERROR')
      })
      setMockApi({ media: { list } })

      const result = await fetchMediaFromDatabase({ limit: 1200 })
      // 不整刷丢弃：首页 500 条仍然交付
      expect(result).not.toBeNull()
      expect(result!.files).toHaveLength(500)
      // 且不得谎报「已到齐」——否则 useGallerySummaryCounts 会改用数组长度，真值计数失去兜底
      expect(useMediaStore.getState().hasMoreMedia).toBe(true)
    })

    it('首屏把服务端 total / typeCounts 写入 store 计数字段（R-1 的落库口）', async () => {
      setMockApi({
        media: {
          list: vi.fn().mockResolvedValue({
            files: [makeFile({ id: '1' })],
            total: 1200,
            typeCounts: { image: 900, video: 300 },
            hasMore: true
          })
        }
      })
      await fetchMediaFromDatabase()
      expect(useMediaStore.getState().mediaTotalCount).toBe(1200)
      expect(useMediaStore.getState().mediaImageCount).toBe(900)
      expect(useMediaStore.getState().mediaVideoCount).toBe(300)
    })

    it('服务端未给 typeCounts 时计数字段置 null，不残留上一次的旧真值', async () => {
      useMediaStore.setState({
        mediaTotalCount: 1200,
        mediaImageCount: 900,
        mediaVideoCount: 300
      })
      setMockApi({
        media: { list: vi.fn().mockResolvedValue({ files: [], total: 0, hasMore: false }) }
      })
      await fetchMediaFromDatabase()
      expect(useMediaStore.getState().mediaTotalCount).toBe(0)
      expect(useMediaStore.getState().mediaImageCount).toBeNull()
      expect(useMediaStore.getState().mediaVideoCount).toBeNull()
    })

    it('图库视图调用 list 时传 galleryHighQualityOnly: true', async () => {
      useUIStore.setState({ currentView: 'gallery' })
      setMockApi()
      await fetchMediaFromDatabase()
      const mockFn = (globalThis as { window?: { electronAPI?: { media?: MockMediaApi } } }).window!
        .electronAPI!.media!.list
      // 图库板块启用高质量照片目录过滤（mediaStore.ts：galleryHighQualityOnly = isGalleryView），
      // 传 true 仅显示 GamePlayPhotos/{uid}/NikkiPhotos_HighQuality 下的图片
      expect(mockFn).toHaveBeenCalledWith(expect.objectContaining({ galleryHighQualityOnly: true }))
    })

    it('非图库视图（launcher-cache）调用 list 时传 galleryHighQualityOnly: false', async () => {
      useUIStore.setState({ currentView: 'launcher-cache' })
      setMockApi()
      await fetchMediaFromDatabase()
      const mockFn = (globalThis as { window?: { electronAPI?: { media?: MockMediaApi } } }).window!
        .electronAPI!.media!.list
      // 缓存板块不限制游戏高质量照片目录，传 false 展示所有非 HQ 路径下的图片
      expect(mockFn).toHaveBeenCalledWith(
        expect.objectContaining({ galleryHighQualityOnly: false })
      )
    })

    it("截图视图（screenshots）调用 list 时传 mediaSource:'local_screenshot' 且 galleryHighQualityOnly:false", async () => {
      useUIStore.setState({ currentView: 'screenshots' })
      setMockApi()
      await fetchMediaFromDatabase()
      const mockFn = (globalThis as { window?: { electronAPI?: { media?: MockMediaApi } } }).window!
        .electronAPI!.media!.list
      // 截图板块复用 launcher-cache 过滤模式，仅展示 X6Game/ScreenShot 路径下媒体（media_source='local_screenshot'）
      expect(mockFn).toHaveBeenCalledWith(
        expect.objectContaining({ mediaSource: 'local_screenshot', galleryHighQualityOnly: false })
      )
    })
  })

  describe('getMediaRefreshAbortKind（DEBT-053 契约钉：null 的两种语义在访问器层可分）', () => {
    it('被新一轮整刷顶掉的弃权记 superseded', async () => {
      const gated = setGatedPagedListMock(1000)
      // 第一轮卡在首页 await 上（无 limit ⇒ 目标深度恰一页，不进深度循环）
      const first = fetchMediaFromDatabase()
      await flushMicrotasks()
      // 第二轮起来并完整落地 ⇒ 第一轮被顶掉
      const second = fetchMediaFromDatabase()
      expect(gated.release(1)).toBe(true)
      await flushMicrotasks()
      await second
      // 放行第一轮的首页 ⇒ 它在弃权判据处返回 null 且不写 store
      expect(gated.release(0)).toBe(true)
      expect(await first).toBeNull()
      expect(getMediaRefreshAbortKind()).toBe('superseded')
    })

    it('取数失败记 failed；下一次调用先在入口复位，成功后不残留旧语义', async () => {
      const list = vi.fn(async () => {
        throw new Error('boom')
      })
      setMockApi({ media: { list } })
      expect(await fetchMediaFromDatabase()).toBeNull()
      expect(getMediaRefreshAbortKind()).toBe('failed')
      // 成功路径 ⇒ 入口复位生效，语义保持 'none'（不残留上一次的 failed）
      setPagedListMock(10)
      expect(await fetchMediaFromDatabase()).not.toBeNull()
      expect(getMediaRefreshAbortKind()).toBe('none')
    })
  })

  describe('refreshMediaAfterScan', () => {
    it('按已加载深度取数：扫描完成不把列表整体缩回首屏一页', async () => {
      // 用户已滚到 1200 条，扫描完成触发本函数 ⇒ 应把 1200 条整表重取，
      // 而不是只取首页 500 条再整体替换（游标复位 + 列表闪回开头）。
      setPagedListMock(1200)
      useMediaStore.setState({
        mediaFiles: Array.from({ length: 1200 }, (_, i) => makeFile({ id: String(i + 1) }))
      })
      await refreshMediaAfterScan()
      expect(listMockFn().mock.calls.length).toBe(3)
      for (const call of listMockFn().mock.calls) {
        expect((call[0] as { pageSize?: number })?.pageSize ?? 0).toBeLessThanOrEqual(500)
      }
      expect(useMediaStore.getState().mediaFiles).toHaveLength(1200)
    })

    it('尚未滚动（列表不超过一页）时只发一次请求，不产生额外 IPC 往返', async () => {
      setPagedListMock(300)
      useMediaStore.setState({ mediaFiles: [makeFile({ id: '1' })] })
      await refreshMediaAfterScan()
      expect(listMockFn()).toHaveBeenCalledTimes(1)
      expect(useMediaStore.getState().mediaFiles).toHaveLength(300)
    })
  })

  describe('loadMoreMedia', () => {
    it('按 keyset 游标加载更多（取代页码）', async () => {
      setMockApi({
        media: {
          list: vi.fn().mockResolvedValue({
            files: [makeFile({ id: 'p2-1' })],
            hasMore: true,
            nextCursor: { sortValue: '2026-01-01 00:00:00', id: 42 }
          })
        }
      })
      const result = await loadMoreMedia({ sortValue: '2026-01-02 00:00:00', id: 99 })
      const mockFn = (globalThis as { window?: { electronAPI?: { media?: MockMediaApi } } }).window!
        .electronAPI!.media!.list
      // 性能重构：续页改用 cursor 游标，不再传 page/pageSize 偏移
      expect(mockFn).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: { sortValue: '2026-01-02 00:00:00', id: 99 },
          pageSize: 500
        })
      )
      expect(result!.files.length).toBe(1)
      expect(result!.hasMore).toBe(true)
      expect(result!.nextCursor).toEqual({ sortValue: '2026-01-01 00:00:00', id: 42 })
    })

    it('加载更多时图库视图传 galleryHighQualityOnly: true', async () => {
      useUIStore.setState({ currentView: 'gallery' })
      setMockApi()
      await loadMoreMedia(null)
      const mockFn = (globalThis as { window?: { electronAPI?: { media?: MockMediaApi } } }).window!
        .electronAPI!.media!.list
      expect(mockFn).toHaveBeenCalledWith(expect.objectContaining({ galleryHighQualityOnly: true }))
    })

    it("加载更多时截图视图传 mediaSource:'local_screenshot'", async () => {
      useUIStore.setState({ currentView: 'screenshots' })
      setMockApi()
      await loadMoreMedia(null)
      const mockFn = (globalThis as { window?: { electronAPI?: { media?: MockMediaApi } } }).window!
        .electronAPI!.media!.list
      expect(mockFn).toHaveBeenCalledWith(
        expect.objectContaining({ mediaSource: 'local_screenshot' })
      )
    })

    it('加载失败返回 null', async () => {
      setMockApi({
        media: {
          list: vi.fn().mockRejectedValue(new Error('fail'))
        }
      })
      const result = await loadMoreMedia(null)
      expect(result).toBeNull()
    })
  })

  describe('loadRecycleBin', () => {
    it('加载已软删除的文件并设置 recycleBinFiles', async () => {
      setMockApi({
        media: {
          list: vi.fn().mockResolvedValue({
            files: [makeFile({ id: 'r1', is_deleted: true })]
          })
        }
      })
      const result = await loadRecycleBin()
      expect(result).not.toBeNull()
      expect(result!.length).toBe(1)
      expect(useMediaStore.getState().recycleBinFiles.length).toBe(1)
      expect(useMediaStore.getState().recycleBinLoading).toBe(false)
    })

    it('调用 list 时传 deletedOnly: true 并使用 keyset 游标（cursor:null）分页', async () => {
      setMockApi()
      await loadRecycleBin()
      const mockFn = (globalThis as { window?: { electronAPI?: { media?: MockMediaApi } } }).window!
        .electronAPI!.media!.list
      // 性能重构：回收站首屏使用 keyset 游标（cursor:null），取代 page=0 偏移分页
      expect(mockFn).toHaveBeenCalledWith({ deletedOnly: true, cursor: null, pageSize: 200 })
    })

    it('加载前设置 recycleBinLoading=true，完成后设为 false', async () => {
      setMockApi({
        media: {
          list: vi.fn().mockResolvedValue({ files: [] })
        }
      })
      const promise = loadRecycleBin()
      // 同步阶段已设置 loading=true
      expect(useMediaStore.getState().recycleBinLoading).toBe(true)
      await promise
      expect(useMediaStore.getState().recycleBinLoading).toBe(false)
    })

    it('加载失败时 recycleBinLoading 恢复为 false', async () => {
      setMockApi({
        media: {
          list: vi.fn().mockRejectedValue(new Error('IPC fail'))
        }
      })
      await loadRecycleBin()
      expect(useMediaStore.getState().recycleBinLoading).toBe(false)
    })

    it('异常时 recycleBinLoading 恢复为 false 且返回 null', async () => {
      setMockApi({
        media: {
          list: vi.fn().mockRejectedValue(new Error('crash'))
        }
      })
      const result = await loadRecycleBin()
      expect(result).toBeNull()
      expect(useMediaStore.getState().recycleBinLoading).toBe(false)
    })
  })
})
