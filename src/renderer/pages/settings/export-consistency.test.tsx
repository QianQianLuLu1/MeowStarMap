/**
 * @vitest-environment jsdom
 *
 * P3 回归：设置页导出与反馈弹窗导出结果等价。
 * 同一 mock 返回（success + filePath）下，两入口必须：
 * ① 调用同一 window.electronAPI.log.exportZip 通道；② 成功展示均含真实落盘路径。
 *
 * 运行：npx vitest run src/renderer/pages/settings/export-consistency.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { DiagnosticsLogsSection } from './diagnostics-sections'
import { FeedbackDialog } from '../../components/common/FeedbackDialog'
import { GlobalToastContext } from './shared'

vi.mock('../../components/common/BaseDialog', () => ({
  BaseDialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null
}))

const mockShowMessage = vi.fn()
const exportZip = vi.fn()

beforeEach(() => {
  mockShowMessage.mockClear()
  exportZip.mockReset()
  exportZip.mockResolvedValue({
    success: true,
    filePath: 'C:/eq.zip',
    message: '诊断包已导出'
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    log: {
      listFaults: vi.fn(() => Promise.resolve({ success: true, faults: [] })),
      getDirectoryPath: vi.fn(() => Promise.resolve({ success: true, path: 'C:/logs' })),
      getStats: vi.fn(() =>
        Promise.resolve({ success: true, faultCount: 0, totalSize: 0, fileCount: 0 })
      ),
      openDirectory: vi.fn(),
      exportZip,
      clear: vi.fn()
    }
  }
})

describe('设置页导出与反馈导出结果等价', () => {
  it('设置页：同一通道 + 成功展示含真实路径', async () => {
    render(
      <GlobalToastContext.Provider value={mockShowMessage}>
        <DiagnosticsLogsSection />
      </GlobalToastContext.Provider>
    )
    fireEvent.click(await screen.findByText('导出日志'))
    await waitFor(() => expect(exportZip).toHaveBeenCalledTimes(1))
    expect(mockShowMessage).toHaveBeenCalledWith(expect.stringContaining('C:/eq.zip'), 'success')
  })

  it('反馈弹窗：同一通道 + 成功展示含真实路径', async () => {
    render(<FeedbackDialog open={true} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText('导出诊断包'))
    await waitFor(() => expect(exportZip).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/C:\/eq\.zip/)).toBeInTheDocument()
  })
})
