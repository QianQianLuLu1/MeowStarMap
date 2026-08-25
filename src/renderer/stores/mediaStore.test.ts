import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  useMediaStore,
  updateMediaFileAndPersist,
  fetchMediaFromDatabase,
  loadMoreMedia,
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
      recycleBinLoading: false
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
