/**
 * @layer L3
 * @module src/renderer/hooks/useFilteredMediaFiles
 * @coverage 端到端计数验收：五个视图（含 grid）下 600/1200 个文件全量加载；
 *           拉齐链在「瞬时取数失败 / 并发闸门阻塞 / 被整刷顶掉」三类中断后自动恢复；
 *           持续失败时有界重试而非无限重试
 * @dependencies react, stores/uiStore, stores/mediaStore
 * @remarks jsdom 环境；不 mock mediaStore 模块，走真实 fillRemainingMediaPages →
 *          loadNextMediaPage → loadMoreMedia → window.electronAPI.media.list（keyset 游标分页 mock），
 *          验收标准：mediaFiles 与 hook 返回值长度均等于注入总数（计划：
 *          docs/plans/2026-11-19-图库仅显示500张-拉齐链断死修复-实施计划.md）
 *
 * 本文件原有一条「续页取数失败时停在已加载条数，不再无限重试」用例，断言的是
 * 「失败后永久停在 500 且只请求一次」——正是本轮修复的故障形态（左下角显示 1200、
 * 图库仅 500），已删除，改由下方 E1/E2/E3/E2b 覆盖，并保留其「不得无限重试」原意（E2）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

import { useFilteredMediaFiles } from './useFilteredMediaFiles'
import { useGallerySummaryCounts } from './useGallerySummaryCounts'
import { useMediaStore, type MediaFile } from '../stores/mediaStore'
import { useUIStore } from '../stores/uiStore'

const PAGE_SIZE = 500

type Cursor = { sortValue: string | number | null; id: number }
type ListArgs = { cursor?: Cursor | null }

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

function makeFiles(total: number): MediaFile[] {
  return Array.from({ length: total }, (_, i) => makeFile(i + 1))
}

/** id 降序（与 media-repository 的 DESC keyset 分支同构） */
function sortDesc(files: MediaFile[]): MediaFile[] {
  return [...files].sort((a, b) => Number(b.id) - Number(a.id))
}

/** 按 keyset 游标切一页：语义对齐 listMedia 的 DESC 分支（pageSize+1 探针此处简化为精确分片） */
function sliceAfter(sorted: MediaFile[], afterId: number | null, size = PAGE_SIZE) {
  const startIdx = afterId === null ? 0 : sorted.findIndex((f) => Number(f.id) < afterId)
  const page = startIdx === -1 ? [] : sorted.slice(startIdx, startIdx + size)
  const last = page[page.length - 1]
  const hasMore = startIdx !== -1 && startIdx + size < sorted.length
  return {
    files: page,
    hasMore,
    nextCursor: hasMore && last ? { sortValue: last.created_at, id: Number(last.id) } : null
  }
}

function installListMock(listMock: ReturnType<typeof vi.fn>): void {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    media: { list: listMock }
  }
}

/** 正常分页 mock */
function setupListMock(all: MediaFile[]): ReturnType<typeof vi.fn> {
  const sorted = sortDesc(all)
  const listMock = vi.fn(async (args?: ListArgs) => sliceAfter(sorted, args?.cursor?.id ?? null))
  installListMock(listMock)
  return listMock
}

/** 向 store 注入首屏（第一页 500 条 + keyset 游标 + hasMore），模拟 fetchMediaFromDatabase 首屏结果 */
function seedFirstPage(all: MediaFile[]): void {
  const sorted = sortDesc(all)
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

/** 模拟「一轮整刷结束」信号：mediaRefreshEpoch 递增会重启拉齐链 */
function bumpRefreshEpoch(): void {
  act(() => {
    useMediaStore.setState({ mediaRefreshEpoch: useMediaStore.getState().mediaRefreshEpoch + 1 })
  })
}

describe('全视图端到端计数验收（含 grid 自动拉齐）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    act(() => {
      useMediaStore.setState({
        mediaFiles: [],
        mediaCursor: null,
        hasMoreMedia: false,
        loadingMore: false,
        mediaTotalCount: null,
        mediaImageCount: null,
        mediaVideoCount: null
      })
    })
  })

  afterEach(() => {
    // 让可能残留的拉齐链在下一轮循环顶部自然退出，避免跨用例串扰
    act(() => {
      useMediaStore.setState({ hasMoreMedia: false, loadingMore: false })
    })
  })

  it('注入 600 个文件（list 视图）→ UI 显示 600 个而非 500', async () => {
    const total = 600
    const all = makeFiles(total)
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
    const all = makeFiles(total)
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
    const all = makeFiles(total)
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

  it('边界：总数 501（恰好一页 + 1 条）→ 补齐到 501 而非停在 500', async () => {
    const total = PAGE_SIZE + 1
    const all = makeFiles(total)
    setupListMock(all)
    seedFirstPage(all)
    resetUIStore('grid')

    const { result } = renderHook(() => useFilteredMediaFiles())
    await waitFor(() => {
      expect(result.current).toHaveLength(total)
    })
    expect(useMediaStore.getState().hasMoreMedia).toBe(false)
  })

  it('边界：恰好 500 条且 hasMore=false → 不发起任何续页请求', async () => {
    const total = PAGE_SIZE
    const all = makeFiles(total)
    const listMock = setupListMock(all)
    seedFirstPage(all)
    resetUIStore('grid')

    const { result } = renderHook(() => useFilteredMediaFiles())
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(result.current).toHaveLength(total)
    expect(listMock).not.toHaveBeenCalled()
  })

  it('边界：已拉齐 1200 条后收到刷新信号 → 不重复追加、id 无重复', async () => {
    const total = 1200
    const all = makeFiles(total)
    setupListMock(all)
    useMediaStore.setState({
      mediaFiles: sortDesc(all),
      mediaCursor: null,
      hasMoreMedia: false,
      loadingMore: false
    })
    resetUIStore('list')

    const { result } = renderHook(() => useFilteredMediaFiles())
    bumpRefreshEpoch()
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(result.current).toHaveLength(total)
    const ids = result.current.map((f) => f.id)
    expect(new Set(ids).size).toBe(total)
  })

  it('异常：首轮续页瞬时失败 → 自动重试并补齐 600（不再永久停在 500）', async () => {
    const total = 600
    const all = makeFiles(total)
    const sorted = sortDesc(all)
    let attempts = 0
    const listMock = vi.fn(async (args?: ListArgs) => {
      attempts += 1
      // 首次续页模拟主进程 IPC/DB 瞬时失败，其后恢复
      if (attempts === 1) throw new Error('media:list failed')
      return sliceAfter(sorted, args?.cursor?.id ?? null)
    })
    installListMock(listMock)
    seedFirstPage(all)
    resetUIStore('grid')

    const { result } = renderHook(() => useFilteredMediaFiles())
    await waitFor(
      () => {
        expect(useMediaStore.getState().mediaFiles).toHaveLength(total)
        expect(result.current).toHaveLength(total)
      },
      { timeout: 5000 }
    )
    expect(listMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(useMediaStore.getState().hasMoreMedia).toBe(false)
    expect(useMediaStore.getState().loadingMore).toBe(false)
  })

  it('异常：并发闸门（loadingMore 预占）阻塞后解除 → 自动补齐 600', async () => {
    const total = 600
    const all = makeFiles(total)
    setupListMock(all)
    seedFirstPage(all)
    // 模拟「另一次续页在途」：首次尝试必被闸门挡下且不改任何 state
    useMediaStore.setState({ loadingMore: true })
    resetUIStore('grid')

    const { result } = renderHook(() => useFilteredMediaFiles())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
      useMediaStore.setState({ loadingMore: false })
    })

    await waitFor(
      () => {
        expect(result.current).toHaveLength(total)
      },
      { timeout: 5000 }
    )
    expect(useMediaStore.getState().hasMoreMedia).toBe(false)
  })

  it('异常：续页持续失败 → 有界重试后停止，且刷新信号可重启拉齐链', async () => {
    const total = 600
    const all = makeFiles(total)
    const sorted = sortDesc(all)
    let failContinuation = true
    const listMock = vi.fn(async (args?: ListArgs) => {
      if (args?.cursor && failContinuation) throw new Error('media:list failed')
      return sliceAfter(sorted, args?.cursor?.id ?? null)
    })
    installListMock(listMock)
    seedFirstPage(all)
    resetUIStore('grid')

    const { result } = renderHook(() => useFilteredMediaFiles())

    // 退避阶梯合计约 4.6s；留足余量后断言「有界、已停」
    await waitFor(
      () => {
        expect(listMock.mock.calls.length).toBeGreaterThanOrEqual(2)
      },
      { timeout: 5000 }
    )
    await new Promise((resolve) => setTimeout(resolve, 5200))
    const attemptsAfterGiveUp = listMock.mock.calls.length
    expect(attemptsAfterGiveUp).toBeLessThanOrEqual(7)
    expect(result.current).toHaveLength(PAGE_SIZE)
    expect(useMediaStore.getState().hasMoreMedia).toBe(true)
    expect(useMediaStore.getState().loadingMore).toBe(false)

    // 放弃后不再自行重试（无无限重试）
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(listMock.mock.calls.length).toBe(attemptsAfterGiveUp)

    // 一轮整刷结束（mediaRefreshEpoch 递增）→ 拉齐链重启并补齐
    failContinuation = false
    bumpRefreshEpoch()
    await waitFor(
      () => {
        expect(result.current).toHaveLength(total)
      },
      { timeout: 5000 }
    )
    expect(useMediaStore.getState().hasMoreMedia).toBe(false)
  })

  // 用户可见的故障形态复刻：左下角显示服务端真值 1200，图库板块却只到 500。
  // 前置条件与线上一致——首屏落库后恰好撞上「另一次续页在途」的并发闸门。
  it('计数一致性：并发闸门阻塞解除后，左下角数值 === 图库实际条数', async () => {
    const total = 1200
    const all = makeFiles(total)
    setupListMock(all)
    seedFirstPage(all)
    // 主进程真值（R-1）：未拉齐时计数取服务端值
    useMediaStore.setState({ mediaTotalCount: total, mediaImageCount: total, mediaVideoCount: 0 })
    useMediaStore.setState({ loadingMore: true })
    resetUIStore('grid')

    const { result } = renderHook(() => {
      const files = useFilteredMediaFiles()
      const counts = useGallerySummaryCounts(files)
      return { files, counts }
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
      useMediaStore.setState({ loadingMore: false })
    })

    await waitFor(
      () => {
        expect(result.current.files).toHaveLength(total)
      },
      { timeout: 5000 }
    )
    // 修复前：counts.total=1200（服务端真值）而 files.length=500 —— 用户看到的「数值对、图库只有 500」
    expect(result.current.counts.total).toBe(result.current.files.length)
    expect(result.current.counts.images).toBe(total)
    expect(useMediaStore.getState().hasMoreMedia).toBe(false)
  })
})
