/**
 * @layer L3
 * @module src/main/ipc/handlers/log
 * @coverage 日志域 IPC handler 注册与执行
 * @dependencies electron / log-service / set-dir-handler / logger
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from '../handler-context'

const {
  handleMock,
  showSaveDialogMock,
  getFocusedWindowMock,
  listFaultsMock,
  getFaultDetailMock,
  openLogDirectoryMock,
  exportLogsAsZipMock,
  clearAllLogsMock,
  getLogStatsMock,
  logFaultMock,
  getLogDirectoryMock,
  loggerInfoMock,
  loggerErrorMock,
  registerSetDirHandlerMock,
  registerResetDirHandlerMock
} = vi.hoisted(() => {
  return {
    handleMock: vi.fn(),
    showSaveDialogMock: vi.fn(),
    getFocusedWindowMock: vi.fn(),
    listFaultsMock: vi.fn(),
    getFaultDetailMock: vi.fn(),
    openLogDirectoryMock: vi.fn(),
    exportLogsAsZipMock: vi.fn(),
    clearAllLogsMock: vi.fn(),
    getLogStatsMock: vi.fn(),
    logFaultMock: vi.fn(),
    getLogDirectoryMock: vi.fn(() => '/mock/logs'),
    loggerInfoMock: vi.fn(),
    loggerErrorMock: vi.fn(),
    registerSetDirHandlerMock: vi.fn(),
    registerResetDirHandlerMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => getFocusedWindowMock() },
  dialog: { showSaveDialog: showSaveDialogMock }
}))

vi.mock('../../services/log-service', () => ({
  listFaults: listFaultsMock,
  getFaultDetail: getFaultDetailMock,
  openLogDirectory: openLogDirectoryMock,
  exportLogsAsZip: exportLogsAsZipMock,
  clearAllLogs: clearAllLogsMock,
  getLogStats: getLogStatsMock
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: loggerInfoMock, warn: vi.fn(), error: loggerErrorMock, debug: vi.fn() },
  logFault: logFaultMock,
  getLogDirectory: getLogDirectoryMock
}))

vi.mock('./set-dir-handler', () => ({
  registerSetDirHandler: registerSetDirHandlerMock,
  registerResetDirHandler: registerResetDirHandlerMock
}))

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

import { registerLogHandlers } from './log'

function makeCtx(): HandlerContext {
  return {
    dbManager: { getSetting: vi.fn(), setSetting: vi.fn() },
    getMainWindow: () => null,
    notifyMediaUpdated: vi.fn(),
    invalidateMediaPathCache: vi.fn(),
    applyUITheme: vi.fn(),
    isThumbnailsGenerating: () => false,
    setThumbnailsGenerating: vi.fn()
  } as unknown as HandlerContext
}

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  for (const call of handleMock.mock.calls) {
    if (call[0] === channel) return call[1]
  }
  throw new Error(`未找到 channel: ${channel}`)
}

describe('registerLogHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    listFaultsMock.mockReset()
    getFaultDetailMock.mockReset()
    openLogDirectoryMock.mockReset()
    exportLogsAsZipMock.mockReset()
    clearAllLogsMock.mockReset()
    getLogStatsMock.mockReset()
    logFaultMock.mockReset()
    showSaveDialogMock.mockReset()
    getFocusedWindowMock.mockReturnValue(null)
    registerSetDirHandlerMock.mockClear()
    registerResetDirHandlerMock.mockClear()
    loggerInfoMock.mockClear()
    loggerErrorMock.mockClear()
  })

  it('应注册 9 个 log channel 并触发 setDir/resetDir 工厂', () => {
    registerLogHandlers(makeCtx())
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toEqual([
      'log:listFaults',
      'log:getFaultDetail',
      'log:openDirectory',
      'log:getDirectoryPath',
      'log:getStats',
      'log:exportZip',
      'log:clear',
      'log:reportRendererError',
      'log:getDir'
    ])
    expect(registerSetDirHandlerMock).toHaveBeenCalledWith(
      expect.anything(),
      'log:setDir',
      'logDir'
    )
    expect(registerResetDirHandlerMock).toHaveBeenCalledWith(
      expect.anything(),
      'log:resetDir',
      'logDir'
    )
  })

  it('log:listFaults 成功时返回 { faults }', async () => {
    listFaultsMock.mockResolvedValue([{ id: 'f1' }])
    registerLogHandlers(makeCtx())
    const result = (await getHandler('log:listFaults')()) as {
      success: true
      data: { faults: unknown[] }
    }
    expect(listFaultsMock).toHaveBeenCalled()
    expect(result.data.faults).toHaveLength(1)
  })

  it('log:listFaults 抛 Error 时返回 INTERNAL_ERROR', async () => {
    listFaultsMock.mockRejectedValue(new Error('读取失败'))
    registerLogHandlers(makeCtx())
    const result = (await getHandler('log:listFaults')()) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
    expect(result.error.message).toContain('获取故障列表失败')
    expect(loggerErrorMock).toHaveBeenCalled()
  })

  it('log:getFaultDetail 成功时返回 { fault }', async () => {
    getFaultDetailMock.mockResolvedValue({ id: 'f1', detail: 'msg' })
    registerLogHandlers(makeCtx())
    const result = (await getHandler('log:getFaultDetail')(['f1'])) as {
      success: true
      data: { fault: { id: string } }
    }
    expect(getFaultDetailMock).toHaveBeenCalledWith('f1')
    expect(result.data.fault.id).toBe('f1')
  })

  it('log:getFaultDetail 抛错时返回 INTERNAL_ERROR', async () => {
    getFaultDetailMock.mockRejectedValue(new Error('not found'))
    registerLogHandlers(makeCtx())
    const result = (await getHandler('log:getFaultDetail')(['f1'])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
  })

  it('log:openDirectory 直接透传 service 结果', async () => {
    openLogDirectoryMock.mockResolvedValue({ success: true })
    registerLogHandlers(makeCtx())
    const result = (await getHandler('log:openDirectory')()) as {
      success: true
      data: { success: boolean }
    }
    expect(openLogDirectoryMock).toHaveBeenCalled()
    expect(result.data.success).toBe(true)
  })

  it('log:getDirectoryPath 返回 { path }', async () => {
    getLogDirectoryMock.mockReturnValue('/mock/logs')
    registerLogHandlers(makeCtx())
    const result = (await getHandler('log:getDirectoryPath')()) as {
      success: true
      data: { path: string }
    }
    expect(result.data.path).toBe('/mock/logs')
  })

  it('log:getStats 成功时返回统计', async () => {
    getLogStatsMock.mockResolvedValue({ totalFiles: 3 })
    registerLogHandlers(makeCtx())
    const result = (await getHandler('log:getStats')()) as {
      success: true
      data: { totalFiles: number }
    }
    expect(result.data.totalFiles).toBe(3)
  })

  it('log:getStats 抛错时返回 INTERNAL_ERROR', async () => {
    getLogStatsMock.mockRejectedValue(new Error('stat 失败'))
    registerLogHandlers(makeCtx())
    const result = (await getHandler('log:getStats')()) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
  })

  it('log:exportZip 取消时抛 canceled', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: '' })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerLogHandlers(makeCtx())
    const result = (await getHandler('log:exportZip')()) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_CANCELED')
    expect(exportLogsAsZipMock).not.toHaveBeenCalled()
  })

  it('log:exportZip 成功时调用 exportLogsAsZip', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/out.zip' })
    exportLogsAsZipMock.mockResolvedValue({ success: true, filePath: '/out.zip' })
    getFocusedWindowMock.mockReturnValue({ webContents: { send: vi.fn() } })
    registerLogHandlers(makeCtx())
    const result = (await getHandler('log:exportZip')()) as {
      success: true
      data: { success: boolean }
    }
    expect(exportLogsAsZipMock).toHaveBeenCalledWith('/out.zip')
    expect(result.data.success).toBe(true)
  })

  it('log:exportZip 主窗口不存在时抛 preconditionFailed', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/out.zip' })
    registerLogHandlers(makeCtx())
    const result = (await getHandler('log:exportZip')()) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_PRECONDITION_FAILED')
  })

  it('log:clear 成功时返回结果并记录日志', async () => {
    clearAllLogsMock.mockResolvedValue({ success: true, cleared: 5 })
    registerLogHandlers(makeCtx())
    const result = (await getHandler('log:clear')()) as {
      success: true
      data: { success: boolean; cleared: number }
    }
    expect(clearAllLogsMock).toHaveBeenCalled()
    expect(loggerInfoMock).toHaveBeenCalledWith(expect.stringContaining('清空了所有日志'))
    expect(result.data.cleared).toBe(5)
  })

  it('log:clear 抛错时返回 INTERNAL_ERROR', async () => {
    clearAllLogsMock.mockRejectedValue(new Error('权限不足'))
    registerLogHandlers(makeCtx())
    const result = (await getHandler('log:clear')()) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
    expect(result.error.message).toContain('清空日志失败')
  })

  it('log:reportRendererError source=ErrorBoundary 时映射到 rendererComponent', async () => {
    registerLogHandlers(makeCtx())
    const payload = {
      message: '组件崩溃',
      stack: 'stack',
      source: 'ErrorBoundary' as const
    }
    const result = (await getHandler('log:reportRendererError')([payload])) as {
      success: true
      data: { reported: boolean }
    }
    expect(logFaultMock).toHaveBeenCalledWith(
      'rendererComponent',
      expect.any(Error),
      expect.objectContaining({ source: 'ErrorBoundary' })
    )
    expect(result.data.reported).toBe(true)
  })

  it('log:reportRendererError source=window.onerror 时映射到 rendererResource 并附带 location', async () => {
    registerLogHandlers(makeCtx())
    const payload = {
      message: '资源加载失败',
      filename: '/app.js',
      lineno: 10,
      colno: 5,
      source: 'window.onerror' as const
    }
    await getHandler('log:reportRendererError')([payload])
    expect(logFaultMock).toHaveBeenCalledWith(
      'rendererResource',
      expect.any(Error),
      expect.objectContaining({ location: '/app.js:10:5', source: 'window.onerror' })
    )
  })

  it('log:reportRendererError source=unhandledrejection 时映射到 rendererPromise', async () => {
    registerLogHandlers(makeCtx())
    await getHandler('log:reportRendererError')([
      { message: 'promise 拒绝', source: 'unhandledrejection' }
    ])
    expect(logFaultMock).toHaveBeenCalledWith(
      'rendererPromise',
      expect.any(Error),
      expect.anything()
    )
  })

  it('log:reportRendererError logFault 抛错时返回 INTERNAL_ERROR', async () => {
    logFaultMock.mockRejectedValue(new Error('写入失败'))
    registerLogHandlers(makeCtx())
    const result = (await getHandler('log:reportRendererError')([
      { message: 'err', source: 'ErrorBoundary' }
    ])) as {
      success: false
      error: { code: string }
    }
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
  })

  it('log:getDir 返回日志目录字符串', async () => {
    getLogDirectoryMock.mockReturnValue('/mock/logs')
    registerLogHandlers(makeCtx())
    const result = (await getHandler('log:getDir')()) as { success: true; data: string }
    expect(result.data).toBe('/mock/logs')
  })
})
