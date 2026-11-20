// @vitest-environment jsdom
/**
 * T11：控制台底栏套件——双版本口径 / 重启（typeof 守卫 + Toast + onRefresh）/
 * 导出诊断包（成功 Toast 带落盘路径）。
 *
 * 运行：npx vitest run src/renderer/pages/sync-gallery/console/SyncStatusBar.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SyncStatusBar } from './SyncStatusBar'
import {
  setupConsoleTest,
  renderView,
  mockShowMessage,
  serverApi,
  logExportZip,
  appGetVersion,
  makeStatus
} from './sync-console-test-utils'
import { NIKKISYNC_ALIGNED_VERSION } from '../../../../shared/nikkisync-version'
import type { NikkiSyncServerStatusInfo } from '../../../../shared/types/electron-api'

const mockRefresh = vi.fn()
const RECOVERY_HINT = '服务恢复入口始终在此，无需切换页面'

function renderBar(serverStatus?: NikkiSyncServerStatusInfo | null) {
  return renderView(<SyncStatusBar onRefresh={mockRefresh} serverStatus={serverStatus} />)
}

beforeEach(() => {
  setupConsoleTest()
  mockRefresh.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('T11：双版本口径', () => {
  it('宿主版本来自 app.getVersion；上游对齐版本来自共享常量（不硬编码）', async () => {
    renderBar()
    await waitFor(() => expect(appGetVersion).toHaveBeenCalledTimes(1))
    const bar = screen.getByTestId('sync-status-bar')
    expect(bar).toHaveTextContent('2.5.7-beta')
    expect(bar).toHaveTextContent(NIKKISYNC_ALIGNED_VERSION)
  })

  it('app.getVersion 缺席 ⇒ 宿主版本占位「—」，不臆造版本号', async () => {
    ;(window.electronAPI as unknown as { app: Record<string, unknown> }).app.getVersion = undefined
    renderBar()
    const bar = screen.getByTestId('sync-status-bar')
    await waitFor(() => expect(bar).toHaveTextContent('—'))
    expect(bar).toHaveTextContent(NIKKISYNC_ALIGNED_VERSION)
  })
})

describe('R2：恢复提示随服务状态门控', () => {
  it('服务运行中 ⇒ 不渲染「已停止/去重启」类恢复提示', () => {
    renderBar(makeStatus({ running: true }) as NikkiSyncServerStatusInfo)
    expect(screen.queryByText(RECOVERY_HINT)).toBeNull()
  })

  it('服务已停止 ⇒ 渲染恢复提示', () => {
    renderBar(makeStatus({ running: false }) as NikkiSyncServerStatusInfo)
    expect(screen.getByText(RECOVERY_HINT)).toBeInTheDocument()
  })

  it('状态未知（null）⇒ 不伪造停机提示', () => {
    renderBar(null)
    expect(screen.queryByText(RECOVERY_HINT)).toBeNull()
  })

  it('桥缺失（available:false）⇒ 不提示去重启服务', () => {
    renderBar(makeStatus({ available: false, running: false }) as NikkiSyncServerStatusInfo)
    expect(screen.queryByText(RECOVERY_HINT)).toBeNull()
  })
})

describe('T11：重启同步服务', () => {
  it('restartServer 成功 ⇒ success Toast + onRefresh 通知', async () => {
    renderBar()
    fireEvent.click(screen.getByTestId('sync-status-restart'))
    await waitFor(() => expect(serverApi.restartServer).toHaveBeenCalledTimes(1))
    expect(mockShowMessage).toHaveBeenCalledWith('同步服务已重启', 'success')
    expect(mockRefresh).toHaveBeenCalledTimes(1)
  })

  it('restartServer 失败 ⇒ error Toast，不通知刷新', async () => {
    serverApi.restartServer.mockRejectedValue(new Error('restart failed'))
    renderBar()
    fireEvent.click(screen.getByTestId('sync-status-restart'))
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('重启同步服务失败', 'error'))
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it('老桥面（restartServer 缺席）⇒ 诚实提示不可用，零调用', async () => {
    ;(
      window.electronAPI as unknown as { nikkisync: Record<string, unknown> }
    ).nikkisync.restartServer = undefined
    renderBar()
    fireEvent.click(screen.getByTestId('sync-status-restart'))
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('当前构建不可用', 'info'))
    expect(mockRefresh).not.toHaveBeenCalled()
  })
})

describe('T11：导出诊断包', () => {
  it('成功 ⇒ success Toast 带落盘路径', async () => {
    renderBar()
    fireEvent.click(screen.getByTestId('sync-status-export'))
    await waitFor(() => expect(logExportZip).toHaveBeenCalledTimes(1))
    expect(mockShowMessage).toHaveBeenCalledWith(
      '诊断包已导出：C:/diagnostics/nikkisync.zip',
      'success'
    )
  })

  it('用户取消 ⇒ info 提示（不报错）', async () => {
    logExportZip.mockResolvedValue({ success: false, canceled: true })
    renderBar()
    fireEvent.click(screen.getByTestId('sync-status-export'))
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('已取消导出', 'info'))
  })

  it('导出失败（success:false）⇒ error 提示', async () => {
    logExportZip.mockResolvedValue({ success: false })
    renderBar()
    fireEvent.click(screen.getByTestId('sync-status-export'))
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('导出诊断包失败', 'error'))
  })

  it('log.exportZip 缺席 ⇒ 诚实提示不可用', async () => {
    ;(window.electronAPI as unknown as { log: Record<string, unknown> }).log.exportZip = undefined
    renderBar()
    fireEvent.click(screen.getByTestId('sync-status-export'))
    await waitFor(() => expect(mockShowMessage).toHaveBeenCalledWith('当前构建不可用', 'info'))
  })
})
