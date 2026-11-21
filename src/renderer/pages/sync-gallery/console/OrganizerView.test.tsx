// @vitest-environment jsdom
/**
 * T1/T10：Organizer 视图套件——SyncServicePage.test.tsx 的 (aa)-(ah) 逐节随迁
 * （判据不重写，渲染锚点改为 Organizer 视图直渲染）；T10 新增回收站入口/
 * 批量结果聚合提示/批量失败行内提示/卸载清表判据。
 *
 * 运行：npx vitest run src/renderer/pages/sync-gallery/console/OrganizerView.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { OrganizerView } from './OrganizerView'
import {
  setupConsoleTest,
  renderView,
  installElectronApi,
  makeOrganizerItem,
  makeOrganizerView,
  mockShowMessage,
  serverApi,
  settingsSet,
  STATUS_POLL_MS
} from './sync-console-test-utils'
import { useUIStore } from '../../../stores/uiStore'

const mockEnabledChange = vi.fn()

function renderOrganizer() {
  return renderView(<OrganizerView onEnabledChange={mockEnabledChange} />)
}

beforeEach(() => {
  setupConsoleTest()
  mockEnabledChange.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('OrganizerView K8（(aa)-(ah) 自 SyncServicePage 随迁）', () => {
  it('(aa) K8：开关挂载读取 organizerEnabled；拨动写回设置项（默认关 ⇒ 队列区隐藏）', async () => {
    installElectronApi({ persisted: { 'nikkisync.organizerEnabled': false } })
    renderOrganizer()
    const toggle = await screen.findByRole('switch', { name: '整理队列（批量删除）' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByText('全部批准')).not.toBeInTheDocument()
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith('nikkisync.organizerEnabled', true)
    )
  })

  it('(ab) K8：开关开 ⇒ 队列列表渲染（11 态映射/文件数/online 指示/操作钮）', async () => {
    installElectronApi({
      persisted: { 'nikkisync.organizerEnabled': true },
      organizerQueue: makeOrganizerView([
        makeOrganizerItem({ state: 'pending' }),
        makeOrganizerItem({
          id: 'del-2aaaaaaaaaaaaaaa',
          state: 'recycled',
          online: false,
          count: 1,
          files: [{ name: 'c.jpg', size: 7, folder: 'photos' }]
        })
      ])
    })
    renderOrganizer()
    expect(await screen.findByText('等待电脑确认')).toBeInTheDocument()
    expect(screen.getByText('已移入回收站')).toBeInTheDocument()
    // 行描述是合并文本节点（"N 个文件 · 手机在线"），按子串正则断言
    expect(screen.getByText(/2 个文件/)).toBeInTheDocument()
    expect(screen.getByText(/手机在线/)).toBeInTheDocument()
    expect(screen.getByText(/手机离线/)).toBeInTheDocument()
    // 非终态行有批准/拒绝；终态行（recycled）没有
    expect(screen.getByRole('button', { name: '批准' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '全部批准' })).toBeInTheDocument()
  })

  it('(ac) K8：未知队列状态回退原样英文串（不谎报，K1 同款口径）', async () => {
    installElectronApi({
      persisted: { 'nikkisync.organizerEnabled': true },
      organizerQueue: makeOrganizerView([makeOrganizerItem({ state: 'brand-new-state' })])
    })
    renderOrganizer()
    expect(await screen.findByText('brand-new-state')).toBeInTheDocument()
  })

  it('(ad) K8：确认弹窗拦截——批准先弹确认（列明文件数与回收站去向），取消不调用', async () => {
    installElectronApi({
      persisted: { 'nikkisync.organizerEnabled': true },
      organizerQueue: makeOrganizerView()
    })
    renderOrganizer()
    fireEvent.click(await screen.findByRole('button', { name: '批准' }))
    // 标题与确认按钮同名（确认移入回收站），按 role 断言弹窗出现；文案用弹窗专属长句
    expect(await screen.findByRole('button', { name: '确认移入回收站' })).toBeInTheDocument()
    expect(screen.getByText(/将把 2 个文件移入 Windows 系统回收站/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByText('确认移入回收站')).not.toBeInTheDocument())
    expect(serverApi.decideOrganizerItem).not.toHaveBeenCalled()
    expect(serverApi.approveOrganizerItems).not.toHaveBeenCalled()
  })

  it('(ae) K8：单条批准确认后调用 decideOrganizerItem(id,true)；拒绝路径无弹窗直接调用', async () => {
    installElectronApi({
      persisted: { 'nikkisync.organizerEnabled': true },
      organizerQueue: makeOrganizerView()
    })
    renderOrganizer()
    // 拒绝：直接调用（非破坏性）
    fireEvent.click(await screen.findByRole('button', { name: '拒绝' }))
    await waitFor(() =>
      expect(serverApi.decideOrganizerItem).toHaveBeenCalledWith({
        id: 'del-1aaaaaaaaaaaaaaa',
        approve: false
      })
    )
    // 批准：弹确认 → 确认后调用
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认移入回收站' }))
    await waitFor(() =>
      expect(serverApi.decideOrganizerItem).toHaveBeenCalledWith({
        id: 'del-1aaaaaaaaaaaaaaa',
        approve: true
      })
    )
  })

  it('(af) K8：批量批准确认后调用 approveOrganizerItems（仅 actionable 且在线的 id）', async () => {
    installElectronApi({
      persisted: { 'nikkisync.organizerEnabled': true },
      organizerQueue: makeOrganizerView([
        makeOrganizerItem({ id: 'del-1aaaaaaaaaaaaaaa', state: 'pending', online: true }),
        makeOrganizerItem({
          id: 'del-2aaaaaaaaaaaaaaa',
          state: 'pending',
          online: false
        }),
        makeOrganizerItem({ id: 'del-3aaaaaaaaaaaaaaa', state: 'recycled', online: false })
      ])
    })
    renderOrganizer()
    fireEvent.click(await screen.findByRole('button', { name: '全部批准' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认移入回收站' }))
    await waitFor(() =>
      expect(serverApi.approveOrganizerItems).toHaveBeenCalledWith({
        ids: ['del-1aaaaaaaaaaaaaaa']
      })
    )
  })

  it('(ag) K8：开关开但队列为空 ⇒ 空态文案，无操作按钮', async () => {
    installElectronApi({
      persisted: { 'nikkisync.organizerEnabled': true },
      organizerQueue: makeOrganizerView([])
    })
    renderOrganizer()
    expect(await screen.findByText('暂无待整理删除项')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '全部批准' })).not.toBeInTheDocument()
  })

  it('(ah) K8：队列通道失败（会话未装配）⇒ 队列区显示不可用提示而非报错弹窗', async () => {
    installElectronApi({
      persisted: { 'nikkisync.organizerEnabled': true },
      organizerQueueReject: true
    })
    renderOrganizer()
    expect(await screen.findByText('整理队列不可用')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '全部批准' })).not.toBeInTheDocument()
  })
})

describe('T10：回收站入口 / 批量聚合提示 / 轮询纪律', () => {
  it('「打开最近删除」⇒ navigateTo(recycle-bin)（宿主回收站深链）', async () => {
    renderOrganizer()
    fireEvent.click(await screen.findByRole('button', { name: '打开最近删除' }))
    expect(useUIStore.getState().currentView).toBe('recycle-bin')
  })

  it('批量批准有跳过项 ⇒ 聚合计数提示（approved/skipped）', async () => {
    installElectronApi({
      persisted: { 'nikkisync.organizerEnabled': true },
      organizerQueue: makeOrganizerView()
    })
    serverApi.approveOrganizerItems.mockResolvedValue({ items: [], approved: 2, skipped: 1 })
    renderOrganizer()
    fireEvent.click(await screen.findByRole('button', { name: '全部批准' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认移入回收站' }))
    await waitFor(() =>
      expect(mockShowMessage).toHaveBeenCalledWith('已批准 2 项，跳过 1 项', 'info')
    )
  })

  it('批量批准失败 ⇒ 错误 Toast + 行内聚合提示常驻；下次成功后清除', async () => {
    installElectronApi({
      persisted: { 'nikkisync.organizerEnabled': true },
      organizerQueue: makeOrganizerView()
    })
    serverApi.approveOrganizerItems.mockRejectedValueOnce(new Error('queue is busy'))
    renderOrganizer()
    fireEvent.click(await screen.findByRole('button', { name: '全部批准' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认移入回收站' }))
    expect(await screen.findByTestId('sync-organizer-batch-failed')).toBeInTheDocument()
    // 重试成功 ⇒ 行内提示清除
    fireEvent.click(screen.getByRole('button', { name: '全部批准' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认移入回收站' }))
    await waitFor(() =>
      expect(screen.queryByTestId('sync-organizer-batch-failed')).not.toBeInTheDocument()
    )
  })

  it('开关变化上报 onEnabledChange（Layout 角标门控随之启停）', async () => {
    renderOrganizer()
    const toggle = await screen.findByRole('switch', { name: '整理队列（批量删除）' })
    await waitFor(() => expect(mockEnabledChange).toHaveBeenCalledWith(false))
    fireEvent.click(toggle)
    await waitFor(() => expect(mockEnabledChange).toHaveBeenCalledWith(true))
  })

  it('2s 队列轮询按 currentView 门控；卸载后定时器清零', async () => {
    vi.useFakeTimers()
    try {
      installElectronApi({ persisted: { 'nikkisync.organizerEnabled': true } })
      useUIStore.setState({ currentView: 'gallery' })
      const { unmount } = renderOrganizer()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(serverApi.getOrganizerQueue).not.toHaveBeenCalled()

      useUIStore.setState({ currentView: 'sync-gallery' })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(serverApi.getOrganizerQueue).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 2)
      })
      expect(serverApi.getOrganizerQueue.mock.calls.length).toBeGreaterThanOrEqual(3)

      unmount()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('OrganizerView 队列响应契约破坏的兜底', () => {
  it('getOrganizerQueue 返回缺 items ⇒ 走空态，不得渲染期抛错', async () => {
    installElectronApi({
      persisted: { 'nikkisync.organizerEnabled': true },
      // 通道契约破坏（items 缺失）：同仓 SyncConsoleLayout 用 `?? []` 兜底，本视图必须同口径
      organizerQueue: { activity: { catalogPasses: 0 } }
    })
    renderOrganizer()
    expect(await screen.findByText('暂无待整理删除项')).toBeInTheDocument()
  })
})
