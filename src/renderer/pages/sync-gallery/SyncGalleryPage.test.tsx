// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { toRuntimeGroup } from './SyncGalleryToolbar'
import type { AssetMediaFile } from '../../utils/assetViewModel'

/**
 * 阶段 5 · A3：同步图库页面接线测试。
 *
 * store 与网格都被替身接管——取数与游标行为由 `stores/syncGalleryStore.test.ts` 覆盖，
 * 本文件只锁**页面接线**：进页即取数、空态必须给可执行指令、点卡片必须把**本页列表**
 * 显式交给全屏组件（全屏默认读的是图库那份 `mediaFiles`，不带 files 就会串源）。
 */

const fakeEvent = {} as unknown as React.MouseEvent

function asset(id: string): AssetMediaFile {
  return {
    id,
    file_path: `D:/Game/${id}.png`,
    file_name: `${id}.png`,
    file_type: 'image',
    file_ext: '.png',
    file_size: 10,
    created_at: '2026-10-01',
    modified_at: '2026-10-01',
    tags: [],
    rating: 0,
    is_favorite: false,
    notes: '',
    nikkisync: {
      assetId: id,
      assetType: 'photo',
      state: 'ready',
      revision: 1,
      hasMotion: false,
      hasMetadata: false
    }
  } as unknown as AssetMediaFile
}

const { storeState, uiState, loadFirst, loadMore, openFullscreen } = vi.hoisted(() => {
  const loadFirst = vi.fn(async () => undefined)
  const loadMore = vi.fn(async () => undefined)
  const openFullscreen = vi.fn()
  const storeState = {
    files: [] as unknown[],
    cursor: null as string | null,
    libraryRevision: null as number | null,
    hasMore: false,
    loading: false,
    loadingMore: false,
    error: null as string | null,
    // 页面的 selector 是从 store 上取 action 的（`s.loadFirst`），所以动作必须挂在同一对象上
    loadFirst,
    loadMore,
    reset: vi.fn()
  }
  const uiState = {
    currentView: 'sync-gallery',
    openFullscreen
  }
  return { storeState, uiState, loadFirst, loadMore, openFullscreen }
})

vi.mock('../../stores/syncGalleryStore', () => ({
  useSyncGalleryStore: (selector: (s: typeof storeState) => unknown) => selector(storeState)
}))

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (s: typeof uiState) => unknown) => selector(uiState)
}))

vi.mock('../../components/gallery/VirtualImageGrid', () => ({
  VirtualImageGrid: (props: {
    items: { id: string }[]
    onSelect: (id: string, index: number, event: React.MouseEvent) => void
    onEndReached?: () => void
  }) => (
    <div data-testid="grid">
      <span data-testid="grid-count">{props.items.length}</span>
      {props.items.map((file, index) => (
        <button
          key={file.id}
          type="button"
          data-testid={`card-${file.id}`}
          onClick={() => props.onSelect(file.id, index, fakeEvent)}
        >
          {file.id}
        </button>
      ))}
      <button type="button" data-testid="end-reached" onClick={() => props.onEndReached?.()}>
        end
      </button>
    </div>
  )
}))

import { SyncGalleryPage } from './SyncGalleryPage'

function setBridge(getRuntimeStatus: ReturnType<typeof vi.fn>): void {
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    nikkisync: { getRuntimeStatus, startScan: vi.fn(), onLibraryChanged: vi.fn(() => undefined) }
  }
}

function clearBridge(): void {
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = undefined
}

let statusMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  statusMock = vi.fn(async () => ({ state: 'running', dbPath: '', linkReady: true }))
  setBridge(statusMock)
  loadFirst.mockReset()
  loadMore.mockReset()
  openFullscreen.mockReset()
  Object.assign(storeState, {
    files: [],
    cursor: null,
    libraryRevision: null,
    hasMore: false,
    loading: false,
    loadingMore: false,
    error: null
  })
})

afterEach(() => {
  clearBridge()
})

describe('toRuntimeGroup（8 个状态机取值 → 3 档展示分组）', () => {
  it('running/scanning/starting 归为 ready', () => {
    expect(toRuntimeGroup('running')).toBe('ready')
    expect(toRuntimeGroup('scanning')).toBe('ready')
    expect(toRuntimeGroup('starting')).toBe('ready')
  })

  it('degraded/error 归为 degraded', () => {
    expect(toRuntimeGroup('degraded')).toBe('degraded')
    expect(toRuntimeGroup('error')).toBe('degraded')
  })

  it('unavailable/idle/stopping/null 归为 off', () => {
    expect(toRuntimeGroup('unavailable')).toBe('off')
    expect(toRuntimeGroup('idle')).toBe('off')
    expect(toRuntimeGroup('stopping')).toBe('off')
    expect(toRuntimeGroup(null)).toBe('off')
  })
})

describe('SyncGalleryPage 接线', () => {
  it('进入本页即取数一次，并把 store 的 10 条渲染进网格', async () => {
    storeState.files = Array.from({ length: 10 }, (_, i) => asset(`a/${i}`))
    render(<SyncGalleryPage />)
    await waitFor(() => expect(loadFirst).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('grid-count').textContent).toBe('10')
    expect(statusMock).toHaveBeenCalled()
  })

  it('点卡片调用 openFullscreen，并显式带上本页列表（不带就会读到图库那份）', async () => {
    const files = [asset('a/1'), asset('a/2')]
    storeState.files = files
    render(<SyncGalleryPage />)
    await waitFor(() => expect(loadFirst).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('card-a/2'))
    expect(openFullscreen).toHaveBeenCalledWith(1, files)
  })

  it('网格触底把 loadMore 透传给 store', async () => {
    storeState.files = [asset('a/1')]
    storeState.hasMore = true
    render(<SyncGalleryPage />)
    await waitFor(() => expect(loadFirst).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('end-reached'))
    expect(loadMore).toHaveBeenCalledTimes(1)
  })

  it('桥缺失空态给出可执行指令（含 npm run link:nikkisync），而不是空白网格', async () => {
    storeState.error = 'syncGallery.error.bridgeMissing'
    statusMock = vi.fn(async () => ({ state: 'unavailable', dbPath: '', linkReady: false }))
    setBridge(statusMock)
    render(<SyncGalleryPage />)
    await waitFor(() => expect(screen.queryByTestId('grid')).toBeNull())
    // 标题与副标题都含该命令（各语言译文措辞不同，不做逐字锁死），故用 getAllByText
    expect(screen.getAllByText(/npm run link:nikkisync/).length).toBeGreaterThan(0)
  })

  it('运行态 off 空态指向设置页开关；degraded 指向游戏目录', async () => {
    statusMock = vi.fn(async () => ({ state: 'idle', dbPath: '', linkReady: true }))
    setBridge(statusMock)
    const { unmount } = render(<SyncGalleryPage />)
    await waitFor(() => expect(screen.queryByTestId('grid')).toBeNull())
    expect(screen.getByText(/设置页开启 NikkiSync 运行时/)).toBeTruthy()
    unmount()

    statusMock = vi.fn(async () => ({ state: 'degraded', dbPath: '', linkReady: true }))
    setBridge(statusMock)
    render(<SyncGalleryPage />)
    await waitFor(() => expect(screen.queryByTestId('grid')).toBeNull())
    expect(screen.getByText(/无限暖暖.*安装目录/)).toBeTruthy()
  })

  it('加载中显示 loading 态，不渲染网格', async () => {
    storeState.loading = true
    render(<SyncGalleryPage />)
    // 状态徽标是异步取回的：等它落地再断言，否则 React 会报 act() 警告
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId('grid')).toBeNull()
  })
})
