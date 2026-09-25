/**
 * @layer L2
 * @module src/main/app/error-handlers
 * @coverage registerGlobalErrorHandlers（uncaughtException + unhandledRejection 两条路径）
 * @dependencies electron (app/dialog)、utils/logger、utils/startup-diagnostic
 *
 * 难点：模块顶层闭包变量 hasShownRuntimeErrorDialog / isExiting 跨用例共享。
 * 应对：每个用例前 vi.resetModules() + 重新动态 import，确保闭包状态重置。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// 共享 mock：所有用例共用同一组 vi.fn，通过 mockReset 在 beforeEach 重置调用记录与返回值
const {
  appExitMock,
  showErrorBoxMock,
  releaseLockMock,
  shellShowItemInFolderMock,
  logFaultMock,
  logFaultSyncMock,
  getLogDirectoryMock,
  logStartupErrorMock,
  diagLogMock,
  getLogDirectorySafeMock
} = vi.hoisted(() => ({
  appExitMock: vi.fn(),
  showErrorBoxMock: vi.fn(),
  releaseLockMock: vi.fn(),
  shellShowItemInFolderMock: vi.fn(),
  logFaultMock: vi.fn(),
  logFaultSyncMock: vi.fn(),
  getLogDirectoryMock: vi.fn(() => '/mock/logs'),
  logStartupErrorMock: vi.fn(),
  diagLogMock: vi.fn(),
  getLogDirectorySafeMock: vi.fn(() => '/mock/logs')
}))

vi.mock('electron', () => ({
  app: {
    exit: appExitMock,
    releaseSingleInstanceLock: releaseLockMock
  },
  dialog: {
    showErrorBox: showErrorBoxMock
  },
  shell: {
    showItemInFolder: shellShowItemInFolderMock
  }
}))

vi.mock('../../utils/logger', () => ({
  logFault: logFaultMock,
  logFaultSync: logFaultSyncMock,
  getLogDirectory: getLogDirectoryMock
}))

vi.mock('../../utils/startup-diagnostic', () => ({
  logStartupError: logStartupErrorMock,
  diagLog: diagLogMock,
  getLogDirectorySafe: getLogDirectorySafeMock,
  // early-crash-guard 弹窗展示路径与写盘路径同源，需提供该 getter
  getStartupLogPathValue: vi.fn(() => '/mock/NikkiGallery/Diagnostics/startup-errors.log')
}))

// 捕获 process.on 注册的监听器：用 mockImplementation 拦截，避免污染真实 process 事件
let uncaughtExceptionListener: ((err: Error) => void) | null = null
let unhandledRejectionListener: ((reason: unknown) => void) | null = null

beforeEach(async () => {
  // 重置模块缓存 → 重新 import 时闭包变量（hasShownRuntimeErrorDialog / isExiting）回到初值
  vi.resetModules()

  // 重置所有 mock：调用记录 + 返回值
  appExitMock.mockReset()
  showErrorBoxMock.mockReset()
  releaseLockMock.mockReset()
  shellShowItemInFolderMock.mockReset()
  logFaultMock.mockReset()
  logFaultSyncMock.mockReset()
  getLogDirectoryMock.mockReset()
  logStartupErrorMock.mockReset()
  diagLogMock.mockReset()
  getLogDirectorySafeMock.mockReset()

  // 默认返回值
  getLogDirectoryMock.mockReturnValue('/mock/logs')
  getLogDirectorySafeMock.mockReturnValue('/mock/logs')
  logFaultMock.mockResolvedValue(undefined)
  logFaultSyncMock.mockReturnValue('mock-fault-id')

  // 捕获监听器
  uncaughtExceptionListener = null
  unhandledRejectionListener = null
  const onSpy = vi.spyOn(process, 'on')
  onSpy.mockImplementation((event, listener) => {
    if (event === 'uncaughtException') {
      uncaughtExceptionListener = listener as (err: Error) => void
    } else if (event === 'unhandledRejection') {
      unhandledRejectionListener = listener as (reason: unknown) => void
    }
    return process
  })

  // 动态 import：在 vi.resetModules + vi.mock 之后，确保使用最新闭包状态
  const mod = await import('../error-handlers')
  mod.registerGlobalErrorHandlers()

  onSpy.mockRestore()
})

describe('registerGlobalErrorHandlers', () => {
  it('1. 注册 uncaughtException 与 unhandledRejection 两个监听器', () => {
    // beforeEach 已调用 registerGlobalErrorHandlers，监听器被捕获
    expect(uncaughtExceptionListener).not.toBeNull()
    expect(unhandledRejectionListener).not.toBeNull()
    expect(typeof uncaughtExceptionListener).toBe('function')
    expect(typeof unhandledRejectionListener).toBe('function')
  })

  it('2. 触发 uncaughtException 时调用 logStartupError("uncaughtException", err)', () => {
    const err = new Error('test uncaught')
    uncaughtExceptionListener!(err)
    expect(logStartupErrorMock).toHaveBeenCalledWith('uncaughtException', err)
  })

  it('3. 首次 uncaughtException 弹出不依赖 i18n 的错误框，消息含 err.message 与用户友好日志路径', () => {
    const err = new Error('boom-first')
    uncaughtExceptionListener!(err)
    expect(showErrorBoxMock).toHaveBeenCalledTimes(1)
    const message = showErrorBoxMock.mock.calls[0][1] as string
    expect(message).toContain('boom-first')
    // 用户友好目录（文档/NikkiGallery/Diagnostics），不再指向隐藏 AppData
    expect(message).toContain('NikkiGallery')
    expect(message).toContain('启动失败')
    // 崩溃后高亮日志文件（资源管理器定位）
    expect(shellShowItemInFolderMock).toHaveBeenCalledWith(
      expect.stringContaining('startup-errors.log')
    )
  })

  it('4. 第二次 uncaughtException 不再弹窗（hasShownRuntimeErrorDialog 闭包状态）', () => {
    uncaughtExceptionListener!(new Error('first'))
    uncaughtExceptionListener!(new Error('second'))
    expect(showErrorBoxMock).toHaveBeenCalledTimes(1)
  })

  it('5. uncaughtException 后调用 app.releaseSingleInstanceLock 与 app.exit(1)', () => {
    uncaughtExceptionListener!(new Error('exit-test'))
    expect(releaseLockMock).toHaveBeenCalledTimes(1)
    expect(appExitMock).toHaveBeenCalledTimes(1)
    expect(appExitMock).toHaveBeenCalledWith(1)
  })

  it('6. isExiting 状态下再次触发 uncaughtException 短路返回，不重复 app.exit', () => {
    uncaughtExceptionListener!(new Error('first'))
    uncaughtExceptionListener!(new Error('second'))
    // 第二次因 isExiting=true 短路，app.exit 仍只被调用 1 次
    expect(appExitMock).toHaveBeenCalledTimes(1)
    expect(releaseLockMock).toHaveBeenCalledTimes(1)
  })

  it('7. unhandledRejection 触发时 reason 为非 Error 对象包装为 Error', () => {
    unhandledRejectionListener!('string reason')
    expect(logStartupErrorMock).toHaveBeenCalledWith('unhandledRejection', expect.any(Error))
    const wrappedErr = logStartupErrorMock.mock.calls[0][1] as Error
    expect(wrappedErr.message).toContain('string reason')
  })

  it('8. unhandledRejection 与 uncaughtException 共享 isExiting 状态（第二次不调 app.exit）', () => {
    unhandledRejectionListener!(new Error('rejection'))
    uncaughtExceptionListener!(new Error('exception'))
    // 两次事件共享 isExiting，仅第一次触发 app.exit
    expect(appExitMock).toHaveBeenCalledTimes(1)
  })

  it('9. logFaultSync 抛错时不影响主流程（app.exit(1) 仍被调用）', () => {
    logFaultSyncMock.mockImplementation(() => {
      throw new Error('logFaultSync sync throw')
    })
    uncaughtExceptionListener!(new Error('trigger'))
    // 关键：logFaultSync 抛错被 try/catch 吞掉，主流程继续到 app.exit
    expect(appExitMock).toHaveBeenCalledWith(1)
  })

  it('10. getLogDirectory 抛错时仍弹出友好错误框（不再依赖 t()/getLogDirectory）', () => {
    getLogDirectoryMock.mockImplementation(() => {
      throw new Error('log dir not initialized')
    })
    uncaughtExceptionListener!(new Error('trigger'))
    expect(showErrorBoxMock).toHaveBeenCalledTimes(1)
    const message = showErrorBoxMock.mock.calls[0][1] as string
    expect(message).toContain('NikkiGallery')
  })
})
