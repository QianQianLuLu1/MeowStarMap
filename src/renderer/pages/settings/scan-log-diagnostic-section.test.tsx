/**
 * @vitest-environment jsdom
 *
 * 扫描诊断区「导出全部日志(zip)」入口回归（P3 三入口统一）：
 * 成功 Toast 带真实 filePath；用户取消（throw IPC_CANCELED）静默不报错。
 *
 * 运行：npx vitest run src/renderer/pages/settings/scan-log-diagnostic-section.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ScanLogDiagnosticSection } from './scan-log-diagnostic-section'
import { GlobalToastContext } from './shared'
import { ERROR_CODES } from '../../../shared/errors/error-codes'

const mockShowMessage = vi.fn()

function installApi(exportZip: ReturnType<typeof vi.fn>) {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    scanner: {
      getScanLog: vi.fn(() => Promise.resolve([])),
      clearScanLog: vi.fn(),
      exportScanLog: vi.fn()
    },
    log: { exportZip }
  }
}

function renderSection() {
  return render(
    <GlobalToastContext.Provider value={mockShowMessage}>
      <ScanLogDiagnosticSection />
    </GlobalToastContext.Provider>
  )
}

beforeEach(() => {
  mockShowMessage.mockClear()
})

describe('ScanLogDiagnosticSection — 导出全部日志', () => {
  it('成功 ⇒ success Toast 带真实路径', async () => {
    const exportZip = vi.fn().mockResolvedValue({ success: true, filePath: 'D:/all.zip' })
    installApi(exportZip)
    renderSection()
    fireEvent.click(await screen.findByText('导出全部日志(zip)'))
    await waitFor(() => expect(exportZip).toHaveBeenCalledTimes(1))
    expect(mockShowMessage).toHaveBeenCalledWith(expect.stringContaining('D:/all.zip'), 'success')
  })

  it('用户取消（throw CANCELED）⇒ 静默不报错', async () => {
    const exportZip = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('canceled'), { code: ERROR_CODES.CANCELED }))
    installApi(exportZip)
    renderSection()
    fireEvent.click(await screen.findByText('导出全部日志(zip)'))
    await waitFor(() => expect(exportZip).toHaveBeenCalledTimes(1))
    expect(mockShowMessage).not.toHaveBeenCalled()
  })

  it('导出失败（success:false）⇒ error 提示', async () => {
    const exportZip = vi.fn().mockResolvedValue({ success: false, message: '磁盘不足' })
    installApi(exportZip)
    renderSection()
    fireEvent.click(await screen.findByText('导出全部日志(zip)'))
    await waitFor(() => expect(exportZip).toHaveBeenCalledTimes(1))
    expect(mockShowMessage).toHaveBeenCalledWith(expect.any(String), 'error')
  })
})
