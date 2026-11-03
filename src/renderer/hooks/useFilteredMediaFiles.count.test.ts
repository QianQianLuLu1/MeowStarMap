/**
 * @layer L3
 * @module src/renderer/hooks/useFilteredMediaFiles
 * @coverage 端到端计数验收：五个视图（含 grid）下 600/1200 个文件全量加载，
 *           以及续页取数失败时不无限重试（修复「扫描 >500 个时 UI 仅显示 500 个」R-3）
 * @dependencies react, stores/uiStore, stores/mediaStore
 * @remarks jsdom 环境；不 mock mediaStore 模块，走真实 loadNextMediaPage → loadMoreMedia →
 *          window.electronAPI.media.list（keyset 游标分页 mock），验收标准：mediaFiles 与
 *          hook 返回值长度均等于注入总数（计划：docs/plans/2026-11-03-fix-media-recognized-count-500-limit-实施计划.md
 *          Node 3。上一轮 d654b9b 的同名判据只覆盖四个非网格视图、并刻意把 grid 排除在外，本轮按用户决定翻转该判据）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

import { useFilteredMediaFiles } from './useFilteredMediaFiles'
import { useMediaStore, type MediaFile } from '../stores/mediaStore'
import { useUIStore } from '../stores/uiStore'

const PAGE_SIZE = 500

function makeFile(i: number): MediaFile {
  return {
    id: String(i),
    file_path: `/test/img-${i}.jpg`,
    file_name: `img-${i}.jpg`,
    file_type: 'image',
    file_ext: '.jpg',
    file_size: 1024,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    modified_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    tags: [],
    rating: 0,
    is_favorite: false,
    notes: '',
    scene_category: 'other'
  }
}

/**
 * mock window.electronAPI.media.list：按 keyset 游标（id 降序）分页返回全部文件，
 * 语义与 media-repository.listMedia 的 DESC keyset 分支一致（pageSize+1 探针此处简化为精确分片）。
 */
function setupListMock(all: MediaFile[]): void {
  const sorted = [...all].sort((a, b) => Number(b.id) - Number(a.id))
  const listMock = vi.fn(
    async (args?: { cursor?: { sortValue: string | number | null; id: number } | null }) => {
      const afterId = args?.cursor?.id ?? null
      const startIdx = afterId === null ? 0 : sorted.findIndex((f) => Number(f.id) < afterId)
      const page = startIdx === -1 ? [] : sorted.slice(startIdx, startIdx + PAGE_SIZE)
      const hasMore = startIdx !== -1 && startIdx + PAGE_SIZE < sorted.length
      const last = page[page.length - 1]
      return {
        files: page,
        hasMore,
        nextCursor: hasMore && last ? { sortValue: last.created_at, id: Number(last.id) } : null
      }
    }
  )
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    media: { list: listMock }
  }
}

/** 向 store 注入首屏（第一页 500 条 + keyset 游标 + hasMore），模拟 fetchMediaFromDatabase 首屏结果 */
function seedFirstPage(all: MediaFile[]): void {
  const sorted = [...all].sort((a, b) => Number(b.id) - Number(a.id))
  const firstPage = sorted.slice(0, PAGE_SIZE)
  const last = firstPage[firstPage.length - 1]
  useMediaStore.setState({
    mediaFiles: firstPage,
    mediaCursor: { sortValue: last.created_at, id: Number(last.id) },
    hasMoreMedia: sorted.length > PAGE_SIZE,
    loadingMore: false
  })
}

function resetUIStore(viewMode: 'grid' | 'list'): void {
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
    viewMode
  })
}

describe('全视图端到端计数验收（含 grid 自动拉齐）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('注入 600 个文件（list 视图）→ UI 显示 600 个而非 500', async () => {
    const total = 600
    const all = Array.from({ length: total }, (_, i) => makeFile(i + 1))
    setupListMock(all)
    seedFirstPage(all)
    resetUIStore('list')

    const { result } = renderHook(() => useFilteredMediaFiles())
    await waitFor(() => {
      expect(useMediaStore.getState().mediaFiles).toHaveLength(total)
      expect(result.current).toHaveLength(total)
    })
    expect(useMediaStore.getState().hasMoreMedia).toBe(false)
  })

  it('注入 1200 个文件（list 视图，3 页循环推进）→ UI 显示 1200 个', async () => {
    const total = 1200
    const all = Array.from({ length: total }, (_, i) => makeFile(i + 1))
    setupListMock(all)
    seedFirstPage(all)
    resetUIStore('list')

    const { result } = renderHook(() => useFilteredMediaFiles())
    await waitFor(() => {
      expect(useMediaStore.getState().mediaFiles).toHaveLength(total)
      expect(result.current).toHaveLength(total)
    })
    expect(useMediaStore.getState().hasMoreMedia).toBe(false)
  })

  it('grid 视图同样自动拉齐：600 个全部加载（本轮翻转 d654b9b 的旧判据）', async () => {
    const total = 600
    const all = Array.from({ length: total }, (_, i) => makeFile(i + 1))
    setupListMock(all)
    seedFirstPage(all)
    resetUIStore('grid')

    const { result } = renderHook(() => useFilteredMediaFiles())
    await waitFor(() => {
      expect(useMediaStore.getState().mediaFiles).toHaveLength(total)
      expect(result.current).toHaveLength(total)
    })
    expect(useMediaStore.getState().hasMoreMedia).toBe(false)
  })

  it('续页取数失败时停在已加载条数，不再无限重试', async () => {
    const total = 600
    const all = Array.from({ length: total }, (_, i) => makeFile(i + 1))
    const sorted = [...all].sort((a, b) => Number(b.id) - Number(a.id))
    const firstPage = sorted.slice(0, PAGE_SIZE)
    const listMock = vi.fn(async (args?: { cursor?: unknown }) => {
      // 首页（cursor 为 null）给足，续页一律抛错：模拟主进程 IPC/DB 瞬时失败
      if (args?.cursor) throw new Error('media:list failed')
      return {
        files: firstPage,
        hasMore: true,
        nextCursor: {
          sortValue: firstPage[firstPage.length - 1].created_at,
          id: Number(firstPage[firstPage.length - 1].id)
        }
      }
    })
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      media: { list: listMock }
    }
    useMediaStore.setState({
      mediaFiles: firstPage,
      mediaCursor: {
        sortValue: firstPage[firstPage.length - 1].created_at,
        id: Number(firstPage[firstPage.length - 1].id)
      },
      hasMoreMedia: true,
      loadingMore: false
    })
    resetUIStore('grid')

    renderHook(() => useFilteredMediaFiles())
    // 失败路径：loadNextMediaPage 保持游标与 hasMoreMedia 不变即不再触发 effect，
    // 列表停在首屏，且只发起一次续页请求（不是每帧重试）
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(useMediaStore.getState().mediaFiles).toHaveLength(PAGE_SIZE)
    expect(useMediaStore.getState().hasMoreMedia).toBe(true)
    expect(listMock).toHaveBeenCalledTimes(1)
    expect(useMediaStore.getState().loadingMore).toBe(false)
  })
})
