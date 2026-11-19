// @vitest-environment jsdom
/**
 * T1：控制台骨架套件——五视图切换 / 待批角标 / 子视图持久化 / 返回不丢栈。
 * (q) 的页面级 h2 判据随迁至此（Connect 套件只保留视图内 h3）。
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
  it('(q 随迁) 页面级 h2 钉住「同步服务」；左侧子导航五项齐备，默认停在连接视图', async () => {
    renderLayout()
    expect(await screen.findByRole('heading', { level: 2, name: '同步服务' })).toBeInTheDocument()
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
    expect(screen.getByRole('heading', { level: 3, name: '暖暖相册' })).toBeInTheDocument()
    // 底栏在场（T11）
    expect(screen.getByTestId('sync-status-bar')).toBeInTheDocument()
  })

  it('五视图逐一切换：目标视图 hero 在场，切走的视图卸载（内容不残留）', async () => {
    renderLayout()
    await screen.findByRole('heading', { level: 3, name: '暖暖相册' })

    fireEvent.click(screen.getByTestId('sync-console-nav-settings'))
    expect(await screen.findByRole('heading', { level: 3, name: '同步设置' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 3, name: '暖暖相册' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('sync-console-nav-organizer'))
    expect(await screen.findByRole('heading', { level: 3, name: '最近删除' })).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('sync-console-nav-inspiration'))
    expect(await screen.findByRole('heading', { level: 3, name: '灵感库' })).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('sync-console-nav-about'))
    expect(await screen.findByRole('heading', { level: 3, name: '关于' })).toBeInTheDocument()
    expect(screen.getByTestId('sync-console-nav-about')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('sync-console-nav-connect')).not.toHaveAttribute('aria-current')
  })

  it('子视图持久化：切换落盘 syncConsole.view；重挂载恢复上次停留位', async () => {
    const { unmount } = renderLayout()
    await screen.findByRole('heading', { level: 3, name: '暖暖相册' })
    fireEvent.click(screen.getByTestId('sync-console-nav-about'))
    await screen.findByRole('heading', { level: 3, name: '关于' })
    expect(window.localStorage.getItem('syncConsole.view')).toBe('about')
    unmount()

    renderLayout()
    expect(await screen.findByRole('heading', { level: 3, name: '关于' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 3, name: '暖暖相册' })).not.toBeInTheDocument()
  })

  it('持久化值非法/缺席 ⇒ 回默认连接视图（不臆造视图态）', async () => {
    window.localStorage.setItem('syncConsole.view', 'bogus-view')
    renderLayout()
    expect(await screen.findByRole('heading', { level: 3, name: '暖暖相册' })).toBeInTheDocument()
  })

  it('返回不丢栈：子视图切换不动宿主 viewStack；goBack 弹的是宿主视图栈', async () => {
    useUIStore.setState({ currentView: 'sync-service', viewStack: ['gallery', 'sync-service'] })
    renderLayout()
    await screen.findByRole('heading', { level: 3, name: '暖暖相册' })
    fireEvent.click(screen.getByTestId('sync-console-nav-settings'))
    await screen.findByRole('heading', { level: 3, name: '同步设置' })
    fireEvent.click(screen.getByTestId('sync-console-nav-organizer'))
    await screen.findByRole('heading', { level: 3, name: '最近删除' })
    // 宿主路由栈原封不动（子视图是控制台内部态，不新增 ViewLevel）
    expect(useUIStore.getState().viewStack).toEqual(['gallery', 'sync-service'])
    expect(useUIStore.getState().currentView).toBe('sync-service')
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

      useUIStore.setState({ currentView: 'sync-service' })
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

describe('T11：底栏重启 ⇒ 连接视图重挂载', () => {
  it('重启成功后连接视图即时重读状态（refreshTick 重挂载）', async () => {
    renderLayout()
    await screen.findByRole('heading', { level: 3, name: '暖暖相册' })
    await waitFor(() => expect(serverApi.getServerStatus).toHaveBeenCalled())
    const before = serverApi.getServerStatus.mock.calls.length
    fireEvent.click(screen.getByTestId('sync-status-restart'))
    await waitFor(() => expect(serverApi.restartServer).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(serverApi.getServerStatus.mock.calls.length).toBeGreaterThan(before))
  })
})
