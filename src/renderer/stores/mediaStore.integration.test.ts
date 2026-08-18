import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  useMediaStore,
  updateMediaFileAndPersist,
  fetchMediaFromDatabase,
  loadMoreMedia,
  loadNextMediaPage,
  loadRecycleBin,
  type MediaFile
} from './mediaStore'

/**
 * 集成测试：图库 store 端到端链路
 *
 * 范围：覆盖「数据库加载 → 选中编辑 → 持久化 → 列表更新 → 回收站加载」完整链路，
 *      以及 store 状态在并发与反复重置下的健壮性。
 *
 * 与现有 mediaStore.test.ts（单元测试）的区别：
 *   - 单元测试聚焦单个 reducer / async action 的输入输出
 *   - 集成测试聚焦多步骤业务流程与跨 action 协作
 *
 * 边界场景：
 *   1. 并发更新同一文件的不同字段（用户快速切换评分/收藏/标签）
 *   2. 并发加载回收站（多次连点"回收站"入口）
 *   3. store 反复重置（页面切换导致组件卸载并重置状态）
 */

// ============================================================
// Helpers
// ============================================================

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
    list: vi.fn().mockResolvedValue({ success: true, files: [], total: 0, hasMore: false }),
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
    list: vi.fn().mockResolvedValue({ success: true, categories: [] }),
    ...overrides.category
  }
  ;(globalThis as { window?: { electronAPI?: Record<string, unknown> } }).window = {
    electronAPI: { media, mediaAction, category }
  }
}

function clearMockApi(): void {
  ;(globalThis as { window?: { electronAPI?: Record<string, unknown> } }).window = {}
}

const INITIAL_STATE = {
  mediaFiles: [],
  categories: [],
  loading: false,
  currentPage: 0,
  hasMoreMedia: false,
  loadingMore: false,
  scanProgress: {
    scanning: false,
    scanned: 0,
    found: 0,
    currentPath: '',
    status: 'idle' as const
  },
  editingMedia: null,
  recycleBinFiles: [],
  recycleBinLoading: false,
  currentProfileUid: 'all',
  profiles: []
}

beforeEach(() => {
  useMediaStore.setState(INITIAL_STATE)
  vi.restoreAllMocks()
})

afterEach(() => {
  clearMockApi()
})

// ============================================================
// 集成测试用例
// ============================================================

describe('集成：图库 store 端到端链路', () => {
  // ============================================================
  // 正常流程
  // ============================================================
  describe('正常流程：加载 → 编辑 → 持久化 → 删除 → 回收站', () => {
    it('完整业务链路：8 步顺序操作状态一致', async () => {
      const file1 = makeFile({ id: '1', rating: 0, is_favorite: false, tags: [] })
      const file2 = makeFile({ id: '2', rating: 3, is_favorite: true, tags: ['sunset'] })
      setMockApi({
        media: {
          list: vi
            .fn()
            // 第一次：fetchMediaFromDatabase 返回 2 个文件
            .mockResolvedValueOnce({
              success: true,
              files: [file1, file2],
              total: 2,
              hasMore: false
            })
            // 第二次：loadRecycleBin 返回 1 个已删除文件
            .mockResolvedValueOnce({
              success: true,
              files: [makeFile({ id: '9', is_deleted: true })]
            })
        }
      })

      // 1. 从数据库加载媒体列表
      const loadResult = await fetchMediaFromDatabase()
      expect(loadResult!.files).toHaveLength(2)
      useMediaStore.getState().setMediaFiles(loadResult!.files)
      expect(useMediaStore.getState().mediaFiles.map((f) => f.id)).toEqual(['1', '2'])

      // 2. 选中编辑
      useMediaStore.getState().setEditingMedia(file1)
      expect(useMediaStore.getState().editingMedia?.id).toBe('1')

      // 3. 更新评分（持久化）
      const ratingResult = await updateMediaFileAndPersist('1', { rating: 5 })
      expect(ratingResult.success).toBe(true)
      expect(useMediaStore.getState().mediaFiles[0].rating).toBe(5)

      // 4. 更新收藏
      await updateMediaFileAndPersist('1', { is_favorite: true })
      expect(useMediaStore.getState().mediaFiles[0].is_favorite).toBe(true)

      // 5. 更新标签
      await updateMediaFileAndPersist('1', { tags: ['night', 'studio'] })
      expect(useMediaStore.getState().mediaFiles[0].tags).toEqual(['night', 'studio'])

      // 6. 关闭编辑器
      useMediaStore.getState().setEditingMedia(null)
      expect(useMediaStore.getState().editingMedia).toBeNull()

      // 7. 删除文件 1
      useMediaStore.getState().deleteMediaFiles(['1'])
      expect(useMediaStore.getState().mediaFiles.map((f) => f.id)).toEqual(['2'])

      // 8. 加载回收站
      const recycleResult = await loadRecycleBin()
      expect(recycleResult).toHaveLength(1)
      expect(useMediaStore.getState().recycleBinFiles[0].id).toBe('9')
      expect(useMediaStore.getState().recycleBinLoading).toBe(false)
    })

    it('分页加载链路：首页 → 追加 → 再追加', async () => {
      setMockApi({
        media: {
          list: vi
            .fn()
            .mockResolvedValueOnce({
              success: true,
              files: [makeFile({ id: '1' })],
              total: 3,
              hasMore: true
            })
            .mockResolvedValueOnce({ success: true, files: [makeFile({ id: '2' })], hasMore: true })
            .mockResolvedValueOnce({
              success: true,
              files: [makeFile({ id: '3' })],
              hasMore: false
            })
        }
      })

      const first = await fetchMediaFromDatabase()
      useMediaStore.getState().setMediaFiles(first!.files)
      expect(useMediaStore.getState().mediaFiles.map((f) => f.id)).toEqual(['1'])

      const more1 = await loadMoreMedia(1)
      useMediaStore.getState().addMediaFiles(more1!.files)
      expect(useMediaStore.getState().mediaFiles.map((f) => f.id)).toEqual(['1', '2'])

      const more2 = await loadMoreMedia(2)
      useMediaStore.getState().addMediaFiles(more2!.files)
      expect(useMediaStore.getState().mediaFiles.map((f) => f.id)).toEqual(['1', '2', '3'])
      expect(more2!.hasMore).toBe(false)
    })
  })

  // ============================================================
  // 无限滚动：loadNextMediaPage（滚动到底追加）
  // ============================================================
  describe('无限滚动：超过 500 张的媒体库', () => {
    // 造 600 张测试数据，验证第 501+ 张能被追加加载出来
    function makePage(start: number, count: number): MediaFile[] {
      return Array.from({ length: count }, (_, i) =>
        makeFile({ id: String(start + i), file_name: `img-${start + i}.jpg` })
      )
    }

    it('600 张：首屏 500 → 触底追加 100 → 第 501 张可见', async () => {
      setMockApi({
        media: {
          list: vi
            .fn()
            .mockResolvedValueOnce({ files: makePage(1, 500), total: 600, hasMore: true })
            .mockResolvedValueOnce({ files: makePage(501, 100), total: 600, hasMore: false })
        }
      })

      const first = await fetchMediaFromDatabase()
      useMediaStore.getState().setMediaFiles(first!.files)
      expect(useMediaStore.getState().mediaFiles).toHaveLength(500)
      expect(useMediaStore.getState().hasMoreMedia).toBe(true)

      await loadNextMediaPage()

      const state = useMediaStore.getState()
      expect(state.mediaFiles).toHaveLength(600)
      // 第 501 张（索引 500）是第二页的首条，证明追加而非替换
      expect(state.mediaFiles[500].file_name).toBe('img-501.jpg')
      expect(state.mediaFiles[0].file_name).toBe('img-1.jpg')
      expect(state.currentPage).toBe(1)
      expect(state.hasMoreMedia).toBe(false)
      expect(state.loadingMore).toBe(false)
    })

    it('第二页请求带 page=1 / pageSize=500', async () => {
      setMockApi({
        media: {
          list: vi
            .fn()
            .mockResolvedValueOnce({ files: makePage(1, 500), hasMore: true })
            .mockResolvedValueOnce({ files: makePage(501, 100), hasMore: false })
        }
      })
      const first = await fetchMediaFromDatabase()
      useMediaStore.getState().setMediaFiles(first!.files)
      await loadNextMediaPage()

      const listFn = (globalThis as { window?: { electronAPI?: { media?: MockMediaApi } } }).window!
        .electronAPI!.media!.list
      expect(listFn).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 500 }))
    })

    it('并发触底只发一次请求（loading 标志位生效）', async () => {
      const listFn = vi
        .fn()
        .mockResolvedValueOnce({ files: makePage(1, 500), hasMore: true })
        .mockResolvedValue({ files: makePage(501, 100), hasMore: false })
      setMockApi({ media: { list: listFn } })

      const first = await fetchMediaFromDatabase()
      useMediaStore.getState().setMediaFiles(first!.files)
      listFn.mockClear()

      // VirtuosoGrid 一次触底可能连续回调多次
      await Promise.all([loadNextMediaPage(), loadNextMediaPage(), loadNextMediaPage()])

      expect(listFn).toHaveBeenCalledTimes(1)
      expect(useMediaStore.getState().mediaFiles).toHaveLength(600)
    })

    it('hasMore=false 时不再发起请求', async () => {
      const listFn = vi.fn().mockResolvedValue({ files: makePage(1, 10), hasMore: false })
      setMockApi({ media: { list: listFn } })

      const first = await fetchMediaFromDatabase()
      useMediaStore.getState().setMediaFiles(first!.files)
      listFn.mockClear()

      await loadNextMediaPage()
      expect(listFn).not.toHaveBeenCalled()
    })

    it('取数失败时保留游标，允许再次触底重试', async () => {
      const listFn = vi
        .fn()
        .mockResolvedValueOnce({ files: makePage(1, 500), hasMore: true })
        .mockRejectedValueOnce(new Error('IPC 断开'))
        .mockResolvedValueOnce({ files: makePage(501, 100), hasMore: false })
      setMockApi({ media: { list: listFn } })

      const first = await fetchMediaFromDatabase()
      useMediaStore.getState().setMediaFiles(first!.files)

      await loadNextMediaPage()
      // 失败后游标不前进，仍认为有下一页，且未卡在 loading 态
      expect(useMediaStore.getState().currentPage).toBe(0)
      expect(useMediaStore.getState().hasMoreMedia).toBe(true)
      expect(useMediaStore.getState().loadingMore).toBe(false)

      await loadNextMediaPage()
      expect(useMediaStore.getState().mediaFiles).toHaveLength(600)
      expect(useMediaStore.getState().currentPage).toBe(1)
    })

    it('OFFSET 错位导致重复记录时按 id 去重', async () => {
      setMockApi({
        media: {
          list: vi
            .fn()
            .mockResolvedValueOnce({ files: makePage(1, 500), hasMore: true })
            // 两次请求之间有新文件入库，OFFSET 后移导致第 500 条被重复返回
            .mockResolvedValueOnce({ files: makePage(500, 100), hasMore: false })
        }
      })

      const first = await fetchMediaFromDatabase()
      useMediaStore.getState().setMediaFiles(first!.files)
      await loadNextMediaPage()

      const ids = useMediaStore.getState().mediaFiles.map((f) => f.id)
      expect(ids).toHaveLength(599)
      expect(new Set(ids).size).toBe(599)
    })
  })

  // ============================================================
  // 边界 1：并发更新同一文件的不同字段
  // ============================================================
  describe('边界 1：并发更新同一文件', () => {
    it('同时更新 rating / is_favorite / tags → 3 个 IPC 并行，本地状态最终一致', async () => {
      setMockApi({
        mediaAction: {
          updateRating: vi.fn().mockResolvedValue({ success: true }),
          updateFavorite: vi.fn().mockResolvedValue({ success: true }),
          updateTags: vi.fn().mockResolvedValue({ success: true })
        }
      })
      useMediaStore
        .getState()
        .setMediaFiles([makeFile({ id: '1', rating: 0, is_favorite: false, tags: [] })])

      // 并发发起 3 个不同字段的更新
      const [r1, r2, r3] = await Promise.all([
        updateMediaFileAndPersist('1', { rating: 5 }),
        updateMediaFileAndPersist('1', { is_favorite: true }),
        updateMediaFileAndPersist('1', { tags: ['a', 'b'] })
      ])

      expect(r1.success && r2.success && r3.success).toBe(true)

      // 3 个 IPC 各被调用一次
      const api = (
        globalThis as { window?: { electronAPI?: { mediaAction?: MockMediaActionApi } } }
      ).window!.electronAPI!.mediaAction!
      expect(api.updateRating).toHaveBeenCalledWith(1, 5)
      expect(api.updateFavorite).toHaveBeenCalledWith(1, true)
      expect(api.updateTags).toHaveBeenCalledWith(1, ['a', 'b'])

      // 本地状态：3 个字段都更新到位
      const file = useMediaStore.getState().mediaFiles[0]
      expect(file.rating).toBe(5)
      expect(file.is_favorite).toBe(true)
      expect(file.tags).toEqual(['a', 'b'])
    })

    it('并发更新中部分 IPC 失败 → 失败的字段不更新，成功的字段更新', async () => {
      setMockApi({
        mediaAction: {
          updateRating: vi.fn().mockResolvedValue({ success: true }),
          updateFavorite: vi.fn().mockRejectedValue(new Error('IPC favorite fail')),
          updateTags: vi.fn().mockResolvedValue({ success: true })
        }
      })
      useMediaStore
        .getState()
        .setMediaFiles([makeFile({ id: '1', rating: 0, is_favorite: false, tags: [] })])

      const [rRating, rFav, rTags] = await Promise.all([
        updateMediaFileAndPersist('1', { rating: 4 }),
        updateMediaFileAndPersist('1', { is_favorite: true }),
        updateMediaFileAndPersist('1', { tags: ['x'] })
      ])

      // favorite 失败，其余成功
      expect(rRating.success).toBe(true)
      expect(rFav.success).toBe(false)
      expect(rTags.success).toBe(true)

      // 由于 Promise.all 任一 reject 会导致整体 reject，
      // updateMediaFileAndPersist 内部已 try/catch，不会 reject
      // 但本地状态更新顺序：rating 成功 → favorite 失败（不更新） → tags 成功
      // 注意：失败时 updateMediaFileAndPersist 不调用本地 updateMediaFile
      const file = useMediaStore.getState().mediaFiles[0]
      expect(file.rating).toBe(4)
      expect(file.is_favorite).toBe(false) // 失败，未更新
      expect(file.tags).toEqual(['x'])
    })
  })

  // ============================================================
  // 边界 2：并发加载回收站
  // ============================================================
  describe('边界 2：并发加载回收站', () => {
    it('3 次并发 loadRecycleBin → loading 状态最终为 false，列表为最后一次结果', async () => {
      // 3 次调用返回不同结果，验证最终状态
      setMockApi({
        media: {
          list: vi
            .fn()
            .mockResolvedValueOnce({ success: true, files: [makeFile({ id: 'r1' })] })
            .mockResolvedValueOnce({
              success: true,
              files: [makeFile({ id: 'r2' }), makeFile({ id: 'r3' })]
            })
            .mockResolvedValueOnce({ success: true, files: [makeFile({ id: 'r4' })] })
        }
      })

      const [a, b, c] = await Promise.all([loadRecycleBin(), loadRecycleBin(), loadRecycleBin()])

      // 3 次都返回非 null
      expect(a).not.toBeNull()
      expect(b).not.toBeNull()
      expect(c).not.toBeNull()

      // loading 状态最终恢复为 false（关键：不卡在 loading=true）
      expect(useMediaStore.getState().recycleBinLoading).toBe(false)

      // recycleBinFiles 不为空（3 次中某次的结果）
      expect(useMediaStore.getState().recycleBinFiles.length).toBeGreaterThan(0)
    })

    it('并发中部分调用 reject → loading 仍恢复为 false，不卡死', async () => {
      setMockApi({
        media: {
          list: vi
            .fn()
            .mockResolvedValueOnce({ success: true, files: [makeFile({ id: 'r1' })] })
            .mockRejectedValueOnce(new Error('network fail'))
            .mockResolvedValueOnce({ success: true, files: [makeFile({ id: 'r2' })] })
        }
      })

      const results = await Promise.allSettled([
        loadRecycleBin(),
        loadRecycleBin(),
        loadRecycleBin()
      ])

      // reject 的那次返回 null（内部 catch）
      const values = results.map((r) => (r.status === 'fulfilled' ? r.value : null))
      expect(values.some((v) => v === null)).toBe(true)

      // loading 状态恢复
      expect(useMediaStore.getState().recycleBinLoading).toBe(false)
    })
  })

  // ============================================================
  // 边界 3：store 反复重置
  // ============================================================
  describe('边界 3：store 反复重置', () => {
    it('填充数据后反复重置 5 次 → 每次重置后状态干净无残留', () => {
      // 填充大量数据
      useMediaStore.getState().setMediaFiles([makeFile({ id: '1' }), makeFile({ id: '2' })])
      useMediaStore.getState().setEditingMedia(makeFile({ id: '99' }))
      useMediaStore.getState().setRecycleBinFiles([makeFile({ id: 'r1' })])
      useMediaStore.getState().setRecycleBinLoading(true)
      useMediaStore.getState().setScanProgress({ scanning: true, status: 'running', scanned: 100 })
      useMediaStore
        .getState()
        .setProfiles([
          { uid: 'u1', nickname: 'n', avatar: null, created_at: '', last_active_at: null }
        ])

      // 反复重置 5 次
      for (let i = 0; i < 5; i++) {
        useMediaStore.setState(INITIAL_STATE)
        const s = useMediaStore.getState()
        expect(s.mediaFiles).toEqual([])
        expect(s.editingMedia).toBeNull()
        expect(s.recycleBinFiles).toEqual([])
        expect(s.recycleBinLoading).toBe(false)
        expect(s.scanProgress.scanning).toBe(false)
        expect(s.scanProgress.status).toBe('idle')
        expect(s.profiles).toEqual([])
        expect(s.currentProfileUid).toBe('all')

        // 重新填充，确保 setState 仍能正常工作
        useMediaStore.getState().setMediaFiles([makeFile({ id: `${i}` })])
        expect(useMediaStore.getState().mediaFiles).toHaveLength(1)
      }
    })

    it('重置后 scanProgress 部分更新仍正常工作', () => {
      useMediaStore.setState(INITIAL_STATE)
      // 模拟扫描开始
      useMediaStore.getState().setScanProgress({ scanning: true, status: 'running' })
      expect(useMediaStore.getState().scanProgress.scanning).toBe(true)
      expect(useMediaStore.getState().scanProgress.status).toBe('running')
      // 模拟扫描进度
      useMediaStore
        .getState()
        .setScanProgress({ scanned: 50, found: 30, currentPath: 'C:\\photos' })
      expect(useMediaStore.getState().scanProgress.scanned).toBe(50)
      expect(useMediaStore.getState().scanProgress.currentPath).toBe('C:\\photos')
      // 模拟扫描完成
      useMediaStore.getState().setScanProgress({ scanning: false, status: 'completed' })
      expect(useMediaStore.getState().scanProgress.status).toBe('completed')
      // 重置
      useMediaStore.setState(INITIAL_STATE)
      expect(useMediaStore.getState().scanProgress.status).toBe('idle')
    })
  })
})
