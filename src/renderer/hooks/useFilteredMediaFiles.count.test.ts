/**
 * @layer L3
 * @module src/renderer/hooks/useFilteredMediaFiles
 * @coverage 端到端计数验收：非网格视图下 600/1200 个文件全量加载（修复「扫描 >500 个时 UI 仅显示 500 个」）
 * @dependencies react, stores/uiStore, stores/mediaStore
 * @remarks jsdom 环境；不 mock mediaStore 模块，走真实 loadNextMediaPage → loadMoreMedia →
 *          window.electronAPI.media.list（keyset 游标分页 mock），验收标准：mediaFiles 与
 *          hook 返回值长度均等于注入总数（计划：docs/archive/plans/fix-gallery-non-grid-500-display.md（已归档，不入仓） §4.1 测试 B）
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

describe('非网格视图端到端计数验收（fix-gallery-non-grid-500-display）', () => {
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

  it('grid 视图不自动拉齐（守护首屏分页行为）：600 个保持首屏 500', async () => {
    const total = 600
    const all = Array.from({ length: total }, (_, i) => makeFile(i + 1))
    setupListMock(all)
    seedFirstPage(all)
    resetUIStore('grid')

    renderHook(() => useFilteredMediaFiles())
    // effect 不应触发加载；短暂等待后首屏数量不变（grid 由 VirtualImageGrid 触底驱动）
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(useMediaStore.getState().mediaFiles).toHaveLength(PAGE_SIZE)
  })
})
