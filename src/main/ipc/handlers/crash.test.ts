/**
 * @layer L3
 * @module src/main/ipc/handlers/crash
 * @coverage 崩溃报告域 IPC handler 注册与执行
 * @dependencies electron / crash-service / set-dir-handler
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandlerContext } from '../handler-context'

const {
  handleMock,
  listCrashesMock,
  getCrashStatsMock,
  openCrashDirectoryMock,
  clearAllCrashesMock,
  getCrashDirectoryMock,
  registerSetDirHandlerMock,
  registerResetDirHandlerMock
} = vi.hoisted(() => {
  return {
    handleMock: vi.fn(),
    listCrashesMock: vi.fn(),
    getCrashStatsMock: vi.fn(),
    openCrashDirectoryMock: vi.fn(),
    clearAllCrashesMock: vi.fn(),
    getCrashDirectoryMock: vi.fn(),
    registerSetDirHandlerMock: vi.fn(),
    registerResetDirHandlerMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: vi.fn() }
}))

vi.mock('../../services/crash-service', () => ({
  listCrashes: listCrashesMock,
  getCrashStats: getCrashStatsMock,
  openCrashDirectory: openCrashDirectoryMock,
  clearAllCrashes: clearAllCrashesMock,
  getCrashDirectory: getCrashDirectoryMock
}))

vi.mock('./set-dir-handler', () => ({
  registerSetDirHandler: registerSetDirHandlerMock,
  registerResetDirHandler: registerResetDirHandlerMock
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

vi.mock('../validator', async () => await import('../../../../tests/mocks/mock-validator'))

import { registerCrashHandlers } from './crash'

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

describe('registerCrashHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    listCrashesMock.mockReset()
    getCrashStatsMock.mockReset()
    openCrashDirectoryMock.mockReset()
    clearAllCrashesMock.mockReset()
    getCrashDirectoryMock.mockReset()
    registerSetDirHandlerMock.mockClear()
    registerResetDirHandlerMock.mockClear()
  })

  it('应注册 5 个 crash channel 并调用 setDir/resetDir 工厂', () => {
    registerCrashHandlers(makeCtx())
    const channels = handleMock.mock.calls.map((c) => c[0])
    expect(channels).toEqual([
      'crash:list',
      'crash:getStats',
      'crash:openDirectory',
      'crash:clear',
      'crash:getDir'
    ])
    expect(registerSetDirHandlerMock).toHaveBeenCalledWith(
      expect.anything(),
      'crash:setDir',
      'crashDir'
    )
    expect(registerResetDirHandlerMock).toHaveBeenCalledWith(
      expect.anything(),
      'crash:resetDir',
      'crashDir'
    )
  })

  it('crash:list 成功时返回 { crashes }', async () => {
    listCrashesMock.mockResolvedValue([{ id: 'c1', timestamp: '2026-01-01' }])
    registerCrashHandlers(makeCtx())
    const result = (await getHandler('crash:list')()) as {
      success: true
      data: { crashes: unknown[] }
    }
    expect(listCrashesMock).toHaveBeenCalled()
    expect(result.data.crashes).toHaveLength(1)
  })

  it('crash:list 抛 Error 时返回 INTERNAL_ERROR', async () => {
    listCrashesMock.mockRejectedValue(new Error('目录不可读'))
    registerCrashHandlers(makeCtx())
    const result = (await getHandler('crash:list')()) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
    expect(result.error.message).toContain('列出崩溃文件失败')
  })

  it('crash:list 抛非 Error 时也能包装错误', async () => {
    listCrashesMock.mockRejectedValue('未知错误')
    registerCrashHandlers(makeCtx())
    const result = (await getHandler('crash:list')()) as {
      success: false
      error: { message: string }
    }
    expect(result.error.message).toContain('未知错误')
  })

  it('crash:getStats 成功时返回统计', async () => {
    getCrashStatsMock.mockResolvedValue({ total: 5, totalSize: 10240 })
    registerCrashHandlers(makeCtx())
    const result = (await getHandler('crash:getStats')()) as {
      success: true
      data: { total: number }
    }
    expect(result.data.total).toBe(5)
  })

  it('crash:getStats 抛错时返回 INTERNAL_ERROR', async () => {
    getCrashStatsMock.mockRejectedValue(new Error('stat 失败'))
    registerCrashHandlers(makeCtx())
    const result = (await getHandler('crash:getStats')()) as {
      success: false
      error: { code: string }
    }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
  })

  it('crash:openDirectory 直接透传 service 结果', async () => {
    openCrashDirectoryMock.mockResolvedValue({ success: true, message: '已打开' })
    registerCrashHandlers(makeCtx())
    const result = (await getHandler('crash:openDirectory')()) as {
      success: true
      data: { success: boolean }
    }
    expect(openCrashDirectoryMock).toHaveBeenCalled()
    expect(result.data.success).toBe(true)
  })

  it('crash:clear 成功时返回结果并记录日志', async () => {
    clearAllCrashesMock.mockResolvedValue({ success: true, cleared: 3 })
    registerCrashHandlers(makeCtx())
    const result = (await getHandler('crash:clear')()) as {
      success: true
      data: { success: boolean; cleared: number }
    }
    expect(clearAllCrashesMock).toHaveBeenCalled()
    expect(result.data.cleared).toBe(3)
  })

  it('crash:clear 抛错时返回 INTERNAL_ERROR', async () => {
    clearAllCrashesMock.mockRejectedValue(new Error('删除失败'))
    registerCrashHandlers(makeCtx())
    const result = (await getHandler('crash:clear')()) as {
      success: false
      error: { code: string; message: string }
    }
    expect(result.success).toBe(false)
    expect(result.error.code).toBe('IPC_INTERNAL_ERROR')
    expect(result.error.message).toContain('清空崩溃文件失败')
  })

  it('crash:getDir 返回崩溃目录路径', async () => {
    getCrashDirectoryMock.mockReturnValue('/mock/crash/dir')
    registerCrashHandlers(makeCtx())
    const result = (await getHandler('crash:getDir')()) as { success: true; data: string }
    expect(getCrashDirectoryMock).toHaveBeenCalled()
    expect(result.data).toBe('/mock/crash/dir')
  })
})
