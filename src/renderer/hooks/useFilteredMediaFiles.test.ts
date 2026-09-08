/**
 * @layer L3
 * @module src/renderer/hooks/useFilteredMediaFiles
 * @coverage 过滤排序链：视图过滤/丢失/重复/分组/类型/场景/时段/套装/分类/日期/评分/搜索 + 排序 + 缓存
 * @dependencies react, stores/uiStore, stores/mediaStore, utils/group-field
 * @remarks jsdom 环境，store 走真实路径，setState 直接驱动筛选
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import { useFilteredMediaFiles } from './useFilteredMediaFiles'
import { useMediaStore, type MediaFile } from '../stores/mediaStore'
import { useUIStore } from '../stores/uiStore'

// FIX(组20-1): hook 在筛选激活时会调用 loadNextMediaPage 拉齐全库，桩掉以断言触发时机
const loadNextMediaPageMock = vi.hoisted(() => vi.fn())
vi.mock('../stores/mediaStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/mediaStore')>()
  return { ...actual, loadNextMediaPage: loadNextMediaPageMock }
})

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

function resetUIStore(overrides: Partial<Parameters<typeof useUIStore.setState>[0]> = {}): void {
  useUIStore.setState({
    currentView: 'gallery',
    filterType: 'all',
    searchQuery: '',
    sortBy: 'date',
    sortOrder: 'desc',
    selectedSceneCategories: [],
    selectedSceneTimes: [],
    filterOutfit: '',
    currentCategoryId: null,
    filterDateRange: [null, null],
    filterRating: null,
    showMissingOnly: false,
    groupDimension: 'none',
    selectedGroupKey: 'all',
    showDuplicates: false,
    ...overrides
  })
}

describe('useFilteredMediaFiles', () => {
  beforeEach(() => {
    useMediaStore.setState({ mediaFiles: [] })
    resetUIStore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('初始与基础', () => {
    it('无媒体时返回空数组', () => {
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toEqual([])
    })

    it('无任何过滤时返回全部文件', () => {
      const files = [makeFile({ id: '1' }), makeFile({ id: '2' })]
      useMediaStore.setState({ mediaFiles: files })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(2)
    })
  })

  describe('视图过滤', () => {
    it('favorites 视图仅显示 is_favorite=true', () => {
      const files = [
        makeFile({ id: '1', is_favorite: true }),
        makeFile({ id: '2', is_favorite: false })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ currentView: 'favorites' })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
      expect(result.current[0].id).toBe('1')
    })

    it('screenshots 视图展示全部媒体（与图库同构，不做 is_favorite 过滤）', () => {
      const files = [
        makeFile({ id: '1', is_favorite: true, media_source: 'local_screenshot' }),
        makeFile({ id: '2', is_favorite: false, media_source: 'local_screenshot' }),
        makeFile({ id: '3', media_source: 'game' })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ currentView: 'screenshots' })
      const { result } = renderHook(() => useFilteredMediaFiles())
      // 截图视图仅由 mediaStore 的 mediaSource 过滤驱动；hook 层不二次裁剪（与图库一致）
      expect(result.current).toHaveLength(3)
    })
  })

  describe('丢失文件', () => {
    it('showMissingOnly=true 仅显示 is_missing=true', () => {
      const files = [
        makeFile({ id: '1', is_missing: true }),
        makeFile({ id: '2', is_missing: false }),
        makeFile({ id: '3' })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ showMissingOnly: true })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
      expect(result.current[0].id).toBe('1')
    })

    it('showMissingOnly=false（默认）隐藏 is_missing=true，仅保留未丢失项（含字段缺失）', () => {
      const files = [
        makeFile({ id: '1', is_missing: true }),
        makeFile({ id: '2', is_missing: false }),
        makeFile({ id: '3' }) // is_missing 未定义，视为未丢失
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ showMissingOnly: false })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(2)
      expect(result.current.map((f) => f.id).sort()).toEqual(['2', '3'])
    })

    it('recycle-bin 视图默认同样隐藏已丢失项', () => {
      const files = [
        makeFile({ id: '1', is_missing: true }),
        makeFile({ id: '2', is_deleted: true })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ currentView: 'recycle-bin', showMissingOnly: false })
      const { result } = renderHook(() => useFilteredMediaFiles())
      // 已丢失项被隐藏；recycle-bin 由后端过滤已删除项，此处仅验证缺失过滤生效
      expect(result.current.every((f) => f.is_missing !== true)).toBe(true)
    })
  })

  describe('重复项过滤', () => {
    it('默认隐藏 is_duplicate=true', () => {
      const files = [
        makeFile({ id: '1', is_duplicate: false }),
        makeFile({ id: '2', is_duplicate: true })
      ]
      useMediaStore.setState({ mediaFiles: files })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
      expect(result.current[0].id).toBe('1')
    })

    it('showDuplicates=true 显示全部', () => {
      const files = [
        makeFile({ id: '1', is_duplicate: false }),
        makeFile({ id: '2', is_duplicate: true })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ showDuplicates: true })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(2)
    })

    it('recycle-bin 视图不受 showDuplicates 过滤影响', () => {
      const files = [makeFile({ id: '1', is_duplicate: true })]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ currentView: 'recycle-bin', showDuplicates: false })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
    })
  })

  describe('智能分组', () => {
    it('groupDimension=file_type 且 selectedGroupKey=image 仅返回 image', () => {
      const files = [
        makeFile({ id: '1', file_type: 'image' }),
        makeFile({ id: '2', file_type: 'video' })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ groupDimension: 'file_type', selectedGroupKey: 'image' })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
      expect(result.current[0].file_type).toBe('image')
    })

    it('selectedGroupKey=all 显示该维度全部文件', () => {
      const files = [
        makeFile({ id: '1', file_type: 'image' }),
        makeFile({ id: '2', file_type: 'video' })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ groupDimension: 'file_type', selectedGroupKey: 'all' })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(2)
    })

    it('groupDimension=album_type 时按相册类型筛选', () => {
      const files = [
        makeFile({ id: '1', album_type: 'NikkiPhotos_HighQuality' }),
        makeFile({ id: '2', album_type: 'MagazinePhotos' })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ groupDimension: 'album_type', selectedGroupKey: 'MagazinePhotos' })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
      expect(result.current[0].id).toBe('2')
    })

    it('album_type 缺失时映射为"其他"', () => {
      const files = [
        makeFile({ id: '1' }), // album_type 缺失
        makeFile({ id: '2', album_type: 'NikkiPhotos_HighQuality' })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ groupDimension: 'album_type', selectedGroupKey: 'group.other' })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
      expect(result.current[0].id).toBe('1')
    })
  })

  describe('文件类型筛选', () => {
    it('filterType=video 仅返回 video', () => {
      const files = [
        makeFile({ id: '1', file_type: 'image' }),
        makeFile({ id: '2', file_type: 'video' })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ filterType: 'video' })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
      expect(result.current[0].file_type).toBe('video')
    })
  })

  describe('场景分类筛选', () => {
    it('selectedSceneCategories 非空时仅返回匹配项', () => {
      const files = [
        makeFile({ id: '1', scene_category: 'travel_journal' }),
        makeFile({ id: '2', scene_category: 'collage' })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ selectedSceneCategories: ['travel_journal'] })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
      expect(result.current[0].scene_category).toBe('travel_journal')
    })
  })

  describe('场景时段筛选', () => {
    it('selectedSceneTimes 非空时仅返回匹配项', () => {
      const files = [
        makeFile({ id: '1', scene_time: 'day' }),
        makeFile({ id: '2', scene_time: 'night' }),
        makeFile({ id: '3' })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ selectedSceneTimes: ['night'] })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
      expect(result.current[0].scene_time).toBe('night')
    })
  })

  describe('套装筛选', () => {
    it('filterOutfit 非空时仅返回匹配项', () => {
      const files = [
        makeFile({ id: '1', outfit: 'Blossom' }),
        makeFile({ id: '2', outfit: 'Starlight' })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ filterOutfit: 'Blossom' })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
      expect(result.current[0].outfit).toBe('Blossom')
    })
  })

  describe('分类筛选', () => {
    it('currentCategoryId 非空时仅返回匹配项', () => {
      const files = [makeFile({ id: '1', category_id: 10 }), makeFile({ id: '2', category_id: 20 })]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ currentCategoryId: 20 })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
      expect(result.current[0].category_id).toBe(20)
    })
  })

  describe('日期范围筛选', () => {
    it('startDate 之前文件被过滤', () => {
      const files = [
        makeFile({ id: '1', created_at: '2026-01-01T00:00:00.000Z' }),
        makeFile({ id: '2', created_at: '2026-06-01T00:00:00.000Z' })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({
        filterDateRange: [new Date('2026-03-01T00:00:00.000Z'), null]
      })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
      expect(result.current[0].id).toBe('2')
    })

    it('endDate 之后文件被过滤（取当天结束）', () => {
      const files = [
        makeFile({ id: '1', created_at: '2026-06-01T00:00:00.000Z' }),
        makeFile({ id: '2', created_at: '2026-12-01T00:00:00.000Z' })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({
        filterDateRange: [null, new Date('2026-06-30T00:00:00.000Z')]
      })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
      expect(result.current[0].id).toBe('1')
    })
  })

  describe('评分筛选', () => {
    it('filterRating>0 仅返回 rating>=filterRating', () => {
      const files = [
        makeFile({ id: '1', rating: 2 }),
        makeFile({ id: '2', rating: 5 }),
        makeFile({ id: '3', rating: 0 })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ filterRating: 3 })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
      expect(result.current[0].rating).toBe(5)
    })

    it('filterRating=0 不过滤', () => {
      const files = [makeFile({ id: '1', rating: 0 }), makeFile({ id: '2', rating: 5 })]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ filterRating: 0 })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(2)
    })
  })

  describe('搜索', () => {
    it('searchQuery 匹配 file_name', () => {
      const files = [
        makeFile({ id: '1', file_name: 'sunset.jpg' }),
        makeFile({ id: '2', file_name: 'mountain.png' })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ searchQuery: 'sun' })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
      expect(result.current[0].file_name).toBe('sunset.jpg')
    })

    it('searchQuery 大小写不敏感', () => {
      const files = [makeFile({ id: '1', file_name: 'Sunset.JPG' })]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ searchQuery: 'SUNSET' })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
    })

    it('searchQuery 匹配 tags', () => {
      const files = [
        makeFile({ id: '1', file_name: 'a.jpg', tags: ['travel'] }),
        makeFile({ id: '2', file_name: 'b.jpg', tags: ['food'] })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ searchQuery: 'travel' })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
      expect(result.current[0].id).toBe('1')
    })

    it('searchQuery 匹配 outfit', () => {
      const files = [makeFile({ id: '1', file_name: 'a.jpg', outfit: 'Blossom' })]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ searchQuery: 'blossom' })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
    })

    it('searchQuery 为空时不过滤', () => {
      const files = [makeFile({ id: '1', file_name: 'a.jpg' })]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ searchQuery: '' })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
    })
  })

  describe('排序', () => {
    it('sortBy=date desc（默认）按创建时间倒序', () => {
      const files = [
        makeFile({ id: '1', created_at: '2026-01-01T00:00:00.000Z' }),
        makeFile({ id: '2', created_at: '2026-06-01T00:00:00.000Z' })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ sortBy: 'date', sortOrder: 'desc' })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current[0].id).toBe('2')
      expect(result.current[1].id).toBe('1')
    })

    it('sortBy=name asc 按文件名升序', () => {
      const files = [
        makeFile({ id: '1', file_name: 'banana.jpg' }),
        makeFile({ id: '2', file_name: 'apple.jpg' })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ sortBy: 'name', sortOrder: 'asc' })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current[0].file_name).toBe('apple.jpg')
      expect(result.current[1].file_name).toBe('banana.jpg')
    })

    it('sortBy=size asc 按文件大小升序', () => {
      const files = [makeFile({ id: '1', file_size: 200 }), makeFile({ id: '2', file_size: 100 })]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ sortBy: 'size', sortOrder: 'asc' })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current[0].id).toBe('2')
      expect(result.current[1].id).toBe('1')
    })

    it('sortBy=resolution asc 按分辨率面积升序', () => {
      const files = [
        makeFile({ id: '1', width: 1920, height: 1080 }),
        makeFile({ id: '2', width: 800, height: 600 })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ sortBy: 'resolution', sortOrder: 'asc' })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current[0].id).toBe('2')
    })

    it('sortBy=rating desc 按评分倒序', () => {
      const files = [makeFile({ id: '1', rating: 3 }), makeFile({ id: '2', rating: 5 })]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({ sortBy: 'rating', sortOrder: 'desc' })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current[0].rating).toBe(5)
    })
  })

  describe('组合过滤', () => {
    it('类型 + 评分 + 搜索同时生效', () => {
      const files = [
        makeFile({ id: '1', file_type: 'image', rating: 5, file_name: 'sunset.jpg' }),
        makeFile({ id: '2', file_type: 'image', rating: 1, file_name: 'sunset.png' }),
        makeFile({ id: '3', file_type: 'video', rating: 5, file_name: 'sunset.mp4' })
      ]
      useMediaStore.setState({ mediaFiles: files })
      resetUIStore({
        filterType: 'image',
        filterRating: 3,
        searchQuery: 'sunset'
      })
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(result.current).toHaveLength(1)
      expect(result.current[0].id).toBe('1')
    })
  })

  describe('缓存', () => {
    it('依赖未变化时返回相同引用', () => {
      const files = [makeFile({ id: '1' })]
      useMediaStore.setState({ mediaFiles: files })
      const { result, rerender } = renderHook(() => useFilteredMediaFiles())
      const first = result.current
      rerender()
      expect(result.current).toBe(first)
    })
  })

  // FIX(组20-1): 筛选/搜索只作用于已加载分页子集的问题——筛选激活且还有未加载页时应逐页拉齐全库
  describe('全库加载（组20-1）', () => {
    beforeEach(() => {
      loadNextMediaPageMock.mockClear()
    })

    it('默认无筛选时不触发全库加载', () => {
      useMediaStore.setState({
        mediaFiles: [makeFile({ id: '1' })],
        hasMoreMedia: true
      })
      resetUIStore()
      renderHook(() => useFilteredMediaFiles())
      expect(loadNextMediaPageMock).not.toHaveBeenCalled()
    })

    it('搜索激活且还有未加载页时应触发加载下一页', async () => {
      useMediaStore.setState({
        mediaFiles: [makeFile({ id: '1' })],
        hasMoreMedia: true
      })
      resetUIStore()
      const { result } = renderHook(() => useFilteredMediaFiles())
      expect(loadNextMediaPageMock).not.toHaveBeenCalled()
      await act(async () => {
        useUIStore.setState({ searchQuery: 'img' })
      })
      expect(loadNextMediaPageMock).toHaveBeenCalled()
      expect(result.current).toHaveLength(1)
    })

    it('评分筛选激活同样触发全库加载', async () => {
      useMediaStore.setState({
        mediaFiles: [makeFile({ id: '1', rating: 5 })],
        hasMoreMedia: true
      })
      resetUIStore()
      renderHook(() => useFilteredMediaFiles())
      await act(async () => {
        useUIStore.setState({ filterRating: 3 })
      })
      expect(loadNextMediaPageMock).toHaveBeenCalled()
    })

    it('已加载完毕（hasMoreMedia=false）时即使筛选也不触发', async () => {
      useMediaStore.setState({
        mediaFiles: [makeFile({ id: '1' })],
        hasMoreMedia: false
      })
      resetUIStore()
      renderHook(() => useFilteredMediaFiles())
      await act(async () => {
        useUIStore.setState({ searchQuery: 'img' })
      })
      expect(loadNextMediaPageMock).not.toHaveBeenCalled()
    })

    it('回收站视图不触发（独立数据源）', async () => {
      useMediaStore.setState({
        mediaFiles: [makeFile({ id: '1' })],
        hasMoreMedia: true
      })
      resetUIStore({ currentView: 'recycle-bin', searchQuery: 'img' })
      renderHook(() => useFilteredMediaFiles())
      expect(loadNextMediaPageMock).not.toHaveBeenCalled()
    })
  })

  // 修复「扫描媒体超过 500 个时 UI 仅显示 500 个」：
  // 非网格视图（list/timeline/masonry/event-timeline）无触底加载入口，
  // 无筛选条件时应同样逐页拉齐全库（计划：docs/plans/fix-gallery-non-grid-500-display.md）
  describe('非网格视图全库加载（fix-gallery-non-grid-500-display）', () => {
    beforeEach(() => {
      loadNextMediaPageMock.mockClear()
    })

    it('viewMode=list 无筛选且 hasMoreMedia=true 时触发全库加载', () => {
      useMediaStore.setState({
        mediaFiles: [makeFile({ id: '1' })],
        hasMoreMedia: true
      })
      resetUIStore({ viewMode: 'list' })
      renderHook(() => useFilteredMediaFiles())
      expect(loadNextMediaPageMock).toHaveBeenCalled()
    })

    it('viewMode=timeline 同样触发全库加载', () => {
      useMediaStore.setState({
        mediaFiles: [makeFile({ id: '1' })],
        hasMoreMedia: true
      })
      resetUIStore({ viewMode: 'timeline' })
      renderHook(() => useFilteredMediaFiles())
      expect(loadNextMediaPageMock).toHaveBeenCalled()
    })

    it('viewMode=grid 无筛选时不触发（守护首屏分页行为，防回归）', () => {
      useMediaStore.setState({
        mediaFiles: [makeFile({ id: '1' })],
        hasMoreMedia: true
      })
      resetUIStore({ viewMode: 'grid' })
      renderHook(() => useFilteredMediaFiles())
      expect(loadNextMediaPageMock).not.toHaveBeenCalled()
    })

    it('viewMode=list 但已加载完毕（hasMoreMedia=false）时不触发', () => {
      useMediaStore.setState({
        mediaFiles: [makeFile({ id: '1' })],
        hasMoreMedia: false
      })
      resetUIStore({ viewMode: 'list' })
      renderHook(() => useFilteredMediaFiles())
      expect(loadNextMediaPageMock).not.toHaveBeenCalled()
    })
  })
})
