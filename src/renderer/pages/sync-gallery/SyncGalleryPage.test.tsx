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

const { storeState, uiState, loadFirst, loadMore, openFullscreen, navigateTo, globalShowMessage } =
  vi.hoisted(() => {
    const loadFirst = vi.fn(async () => undefined)
    const loadMore = vi.fn(async () => undefined)
    const openFullscreen = vi.fn()
    const navigateTo = vi.fn()
    // 全局 Toast 的替身：捕获 useGlobalToast 的调用（Toast UI 本体由 ToastProvider.test.tsx 覆盖）
    const globalShowMessage = vi.fn()
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
      openFullscreen,
      navigateTo
    }
    return {
      storeState,
      uiState,
      loadFirst,
      loadMore,
      openFullscreen,
      navigateTo,
      globalShowMessage
    }
  })

// 页面将经全局 Toast 展示扫描失败：mock useGlobalToast 以断言接线（默认 context 是 no-op，
// 不 mock 就什么也断言不到）
vi.mock('../../components/common/ToastProvider', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, useGlobalToast: () => globalShowMessage }
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

function setBridge(
  getRuntimeStatus: ReturnType<typeof vi.fn>,
  startScan: ReturnType<typeof vi.fn> = vi.fn(async () => undefined)
): void {
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    nikkisync: { getRuntimeStatus, startScan, onLibraryChanged: vi.fn(() => undefined) }
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
  navigateTo.mockReset()
  globalShowMessage.mockReset()
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

  it('列表态的工具栏「同步服务」入口压栈到 sync-service 二级页', async () => {
    storeState.files = [asset('a/1')]
    render(<SyncGalleryPage />)
    await waitFor(() => expect(loadFirst).toHaveBeenCalled())
    fireEvent.click(screen.getByTitle('同步服务'))
    expect(navigateTo).toHaveBeenCalledWith('sync-service')
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

  it('运行态 off 空态指向工具栏的「同步服务」入口；degraded 指向游戏目录', async () => {
    statusMock = vi.fn(async () => ({ state: 'idle', dbPath: '', linkReady: true }))
    setBridge(statusMock)
    const { unmount } = render(<SyncGalleryPage />)
    await waitFor(() => expect(screen.queryByTestId('grid')).toBeNull())
    // 同步服务已从设置页剥离，空态必须指向板块内的二级页入口，不能再指向设置页
    expect(screen.getByText(/工具栏的「同步服务」/)).toBeTruthy()
    expect(screen.queryByText(/设置页/)).toBeNull()
    // 空态下工具栏仍在渲染，「同步服务」入口必须可用（这是用户唯一的去处）
    const serviceEntry = screen.getByTitle('同步服务')
    expect((serviceEntry as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(serviceEntry)
    expect(navigateTo).toHaveBeenCalledWith('sync-service')
    // 「关于 NikkiSync」不受可选 prop 门控：空态分支（不传 onOpenDetail）同样必须出现
    expect(screen.getByTitle('关于 NikkiSync')).toBeInTheDocument()
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

  describe('扫描失败可见化（2026-11-04：此前只进 console，用户感知是「点了没反应」）', () => {
    it('异常：startScan 失败时弹本地化「扫描失败」，不把英文原文与安装路径铺进 UI', async () => {
      // 装机实锤形态：这条链上 AppError.preconditionFailed 不带 userMessage，
      // extractUserMessage 会退化到 message，而 message 里拼着装配失败原文与绝对路径
      const startScan = vi.fn(async () => {
        throw new Error(
          "NikkiSync runtime is not ready (Cannot find package 'qrcode' imported from " +
            'D:\\App\\resources\\app.asar.unpacked\\node_modules\\@nikkisync\\pc-companion\\dist\\x.mjs)'
        )
      })
      setBridge(statusMock, startScan)
      render(<SyncGalleryPage />)
      await waitFor(() => expect(loadFirst).toHaveBeenCalled())
      fireEvent.click(screen.getByTitle('扫描游戏相册'))
      await waitFor(() => expect(globalShowMessage).toHaveBeenCalledWith('扫描失败', 'error'))
      // 反向钉：Toast 文本里不得出现未翻译原文或本机路径
      expect(
        globalShowMessage.mock.calls.every(
          (call) => !/not ready|app\.asar|D:\\/i.test(String(call[0]))
        )
      ).toBe(true)
    })

    it('正常：startScan 成功时不弹错误 Toast', async () => {
      const startScan = vi.fn(async () => undefined)
      setBridge(statusMock, startScan)
      render(<SyncGalleryPage />)
      await waitFor(() => expect(loadFirst).toHaveBeenCalled())
      fireEvent.click(screen.getByTitle('扫描游戏相册'))
      await waitFor(() => expect(startScan).toHaveBeenCalledTimes(1))
      expect(globalShowMessage).not.toHaveBeenCalled()
    })
  })
})
