// @vitest-environment jsdom
/**
 * T1：控制台骨架套件——五视图切换 / 待批角标 / 子视图持久化 / 返回不丢栈。
 * (q) 的页面级 h1 判据随迁至此（Connect 套件只保留视图内折叠区块）。
 *
 * 运行：npx vitest run src/renderer/pages/sync-gallery/console/SyncConsoleLayout.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SyncConsoleLayout } from './SyncConsoleLayout'
import {
  setupConsoleTest,
  renderView,
  installElectronApi,
  makeOrganizerItem,
  makeOrganizerView,
  makeStatus,
  serverApi
} from './sync-console-test-utils'
import { useUIStore } from '../../../stores/uiStore'

const BADGE_POLL_MS = 5000

function renderLayout() {
  return renderView(<SyncConsoleLayout />)
}

beforeEach(() => {
  setupConsoleTest()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('T1：五视图骨架与切换', () => {
  it('(q 随迁) 页面级 h2 随视图切换；左侧子导航五项齐备，默认停在连接视图', async () => {
    renderLayout()
    expect(await screen.findByRole('heading', { level: 1, name: '暖暖相册' })).toBeInTheDocument()
    for (const [id, label] of [
      ['connect', '手机连接'],
      ['settings', '同步设置'],
      ['organizer', '最近删除'],
      ['inspiration', '灵感库'],
      ['about', '关于']
    ] as const) {
      expect(screen.getByTestId(`sync-console-nav-${id}`)).toHaveTextContent(label)
    }
    expect(screen.getByTestId('sync-console-nav-connect')).toHaveAttribute('aria-current', 'page')
    // 全宽底栏已按上游移除：能力迁回关于 hero / Android 卡
    expect(screen.queryByTestId('sync-status-bar')).not.toBeInTheDocument()
  })

  it('五视图逐一切换：目标视图 hero 在场，切走的视图卸载（内容不残留）', async () => {
    renderLayout()
    await screen.findByRole('heading', { level: 1, name: '暖暖相册' })

    fireEvent.click(screen.getByTestId('sync-console-nav-settings'))
    expect(await screen.findByRole('heading', { level: 1, name: '同步设置' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1, name: '暖暖相册' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('sync-console-nav-organizer'))
    expect(await screen.findByRole('heading', { level: 1, name: '最近删除' })).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('sync-console-nav-inspiration'))
    expect(await screen.findByRole('heading', { level: 1, name: '灵感库' })).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('sync-console-nav-about'))
    expect(await screen.findByRole('heading', { level: 1, name: '关于' })).toBeInTheDocument()
    expect(screen.getByTestId('sync-console-nav-about')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('sync-console-nav-connect')).not.toHaveAttribute('aria-current')
  })

  it('页头 chip 三态：运行中/已停止/未就绪，文案与 data-state 同源', async () => {
    const first = renderLayout()
    const chip = await screen.findByTestId('sync-console-status-chip')
    await waitFor(() => expect(chip).toHaveAttribute('data-state', 'ready'))
    expect(chip).toHaveTextContent('同步服务运行中')
    first.unmount()

    installElectronApi({ status: makeStatus({ running: false }) })
    const stopped = renderLayout()
    const stoppedChip = await screen.findByTestId('sync-console-status-chip')
    await waitFor(() => expect(stoppedChip).toHaveAttribute('data-state', 'offline'))
    expect(stoppedChip).toHaveTextContent('同步服务已停止')
    stopped.unmount()

    installElectronApi({ status: { available: false, running: false } })
    renderLayout()
    const unavailableChip = await screen.findByTestId('sync-console-status-chip')
    await waitFor(() => expect(unavailableChip).toHaveAttribute('data-state', 'unavailable'))
    expect(unavailableChip).toHaveTextContent('同步组件未就绪')
  })

  it('状态通道缺席 / 返回 null ⇒ chip 未就绪，不臆造运行中', async () => {
    installElectronApi({ omitMethods: ['getServerStatus'] })
    const missing = renderLayout()
    const missingChip = await screen.findByTestId('sync-console-status-chip')
    await waitFor(() => expect(missingChip).toHaveAttribute('data-state', 'unavailable'))
    expect(missingChip).toHaveTextContent('同步组件未就绪')
    missing.unmount()

    installElectronApi()
    serverApi.getServerStatus.mockResolvedValue(null)
    renderLayout()
    const nullChip = await screen.findByTestId('sync-console-status-chip')
    await waitFor(() => expect(nullChip).toHaveAttribute('data-state', 'unavailable'))
  })

  it('页头副标题逐视图对齐上游文案（DesktopPageScript.ts:28）', async () => {
    renderLayout()
    await screen.findByRole('heading', { level: 1, name: '暖暖相册' })
    expect(screen.getByText('电脑里的风景与穿搭，在手机上慢慢欣赏。')).toBeInTheDocument()

    const expected: Array<[string, string, string]> = [
      ['settings', '同步设置', '管理这台电脑的连接与启动偏好。'],
      ['organizer', '最近删除', '核对手机整理的照片，确认后移入电脑回收站。'],
      ['inspiration', '灵感库', '收藏喜欢的染色码、搭配码和穿搭参考图。'],
      ['about', '关于', '版本、更新与项目仓库。']
    ]
    for (const [id, title, subtitle] of expected) {
      fireEvent.click(screen.getByTestId(`sync-console-nav-${id}`))
      expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument()
      expect(screen.getByText(subtitle)).toBeInTheDocument()
    }
  })

  it('品牌图加载失败 ⇒ 回退内置相机图标，不留破图', async () => {
    renderLayout()
    const image = await screen.findByTestId('sync-console-brand-image')
    fireEvent.error(image)
    expect(screen.queryByTestId('sync-console-brand-image')).toBeNull()
    expect(document.querySelector('.sc-brand-fallback svg')).not.toBeNull()
  })

  it('品牌图与五项导航图标挂载（图片/图标缺失不阻塞导航）', async () => {
    renderLayout()
    expect(await screen.findByTestId('sync-console-status-chip')).toBeInTheDocument()
    expect(screen.getByTestId('sync-console-brand-image')).toBeInTheDocument()
    for (const id of ['connect', 'settings', 'organizer', 'inspiration', 'about']) {
      expect(screen.getByTestId(`sync-console-nav-${id}`).querySelector('svg')).not.toBeNull()
    }
  })

  it('子视图持久化：切换落盘 syncConsole.view；重挂载恢复上次停留位', async () => {
    const { unmount } = renderLayout()
    await screen.findByRole('heading', { level: 1, name: '暖暖相册' })
    fireEvent.click(screen.getByTestId('sync-console-nav-about'))
    await screen.findByRole('heading', { level: 1, name: '关于' })
    expect(window.localStorage.getItem('syncConsole.view')).toBe('about')
    unmount()

    renderLayout()
    expect(await screen.findByRole('heading', { level: 1, name: '关于' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1, name: '暖暖相册' })).not.toBeInTheDocument()
  })

  it('持久化值非法/缺席 ⇒ 回默认连接视图（不臆造视图态）', async () => {
    window.localStorage.setItem('syncConsole.view', 'bogus-view')
    renderLayout()
    expect(await screen.findByRole('heading', { level: 1, name: '暖暖相册' })).toBeInTheDocument()
  })

  it('返回不丢栈：子视图切换不动宿主 viewStack；goBack 弹的是宿主视图栈', async () => {
    useUIStore.setState({ currentView: 'sync-gallery', viewStack: ['gallery', 'sync-gallery'] })
    renderLayout()
    await screen.findByRole('heading', { level: 1, name: '暖暖相册' })
    fireEvent.click(screen.getByTestId('sync-console-nav-settings'))
    await screen.findByRole('heading', { level: 1, name: '同步设置' })
    fireEvent.click(screen.getByTestId('sync-console-nav-organizer'))
    await screen.findByRole('heading', { level: 1, name: '最近删除' })
    // 宿主路由栈原封不动（子视图是控制台内部态，不新增 ViewLevel）
    expect(useUIStore.getState().viewStack).toEqual(['gallery', 'sync-gallery'])
    expect(useUIStore.getState().currentView).toBe('sync-gallery')
    // 宿主返回键语义不变：弹栈回 gallery
    act(() => {
      useUIStore.getState().goBack()
    })
    expect(useUIStore.getState().currentView).toBe('gallery')
    expect(useUIStore.getState().viewStack).toEqual(['gallery'])
  })
})

describe('T10：待批角标（Layout 自持 5s 轮询）', () => {
  it('开关开 + 队列 3 条待批 ⇒ 角标 3；全部批准后下一轮归零消失', async () => {
    vi.useFakeTimers()
    try {
      installElectronApi({
        persisted: { 'nikkisync.organizerEnabled': true },
        organizerQueue: makeOrganizerView([
          makeOrganizerItem({ id: 'del-1aaaaaaaaaaaaaaa' }),
          makeOrganizerItem({ id: 'del-2aaaaaaaaaaaaaaa' }),
          makeOrganizerItem({ id: 'del-3aaaaaaaaaaaaaaa' })
        ])
      })
      renderLayout()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByTestId('sync-console-organizer-badge')).toHaveTextContent('3')

      // 切到 Organizer 视图执行批量批准
      fireEvent.click(screen.getByTestId('sync-console-nav-organizer'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      serverApi.approveOrganizerItems.mockResolvedValue({ items: [], approved: 3, skipped: 0 })
      fireEvent.click(screen.getByRole('button', { name: '全部批准' }))
      // fake timers 下 findByRole 的 waitFor 重试定时器被冻结：显式 flush 后同步查询
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      fireEvent.click(screen.getByRole('button', { name: '确认移入回收站' }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(serverApi.approveOrganizerItems).toHaveBeenCalledWith({
        ids: ['del-1aaaaaaaaaaaaaaa', 'del-2aaaaaaaaaaaaaaa', 'del-3aaaaaaaaaaaaaaa']
      })
      // 队列清空后，下一轮角标轮询归零
      serverApi.getOrganizerQueue.mockResolvedValue(makeOrganizerView([]))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BADGE_POLL_MS)
      })
      expect(screen.queryByTestId('sync-console-organizer-badge')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('开关关 ⇒ 不轮询、无角标（即使队列有待批项）', async () => {
    vi.useFakeTimers()
    try {
      installElectronApi({
        persisted: { 'nikkisync.organizerEnabled': false },
        organizerQueue: makeOrganizerView()
      })
      renderLayout()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BADGE_POLL_MS * 2)
      })
      expect(serverApi.getOrganizerQueue).not.toHaveBeenCalled()
      expect(screen.queryByTestId('sync-console-organizer-badge')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keep-alive 门控：currentView 离开 sync-service ⇒ 角标轮询停表；回前台恢复', async () => {
    vi.useFakeTimers()
    try {
      installElectronApi({ persisted: { 'nikkisync.organizerEnabled': true } })
      useUIStore.setState({ currentView: 'gallery' })
      renderLayout()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BADGE_POLL_MS * 2)
      })
      expect(serverApi.getOrganizerQueue).not.toHaveBeenCalled()

      useUIStore.setState({ currentView: 'sync-gallery' })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(serverApi.getOrganizerQueue).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('卸载后定时器清零（角标轮询 + 连接视图轮询一并收口）', async () => {
    vi.useFakeTimers()
    try {
      installElectronApi({ persisted: { 'nikkisync.organizerEnabled': true } })
      const { unmount } = renderLayout()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      unmount()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('子视图切走即卸载：连接视图 2s 轮询在切到关于后停表', async () => {
    vi.useFakeTimers()
    try {
      renderLayout()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      const before = serverApi.getServerStatus.mock.calls.length
      expect(before).toBeGreaterThanOrEqual(1)
      fireEvent.click(screen.getByTestId('sync-console-nav-about'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000)
      })
      expect(serverApi.getServerStatus.mock.calls.length).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('T11：重启入口（已迁至 Connect 的 Android 卡）', () => {
  it('Android 卡内重启成功后连接视图即时重读状态', async () => {
    renderLayout()
    await screen.findByRole('heading', { level: 1, name: '暖暖相册' })
    await waitFor(() => expect(serverApi.getServerStatus).toHaveBeenCalled())
    const before = serverApi.getServerStatus.mock.calls.length
    fireEvent.click(screen.getByTestId('sync-status-restart'))
    await waitFor(() => expect(serverApi.restartServer).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(serverApi.getServerStatus.mock.calls.length).toBeGreaterThan(before))
  })
})
