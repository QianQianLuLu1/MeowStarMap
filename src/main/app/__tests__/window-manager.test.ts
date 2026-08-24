/**
 * @layer L2
 * @module src/main/app/window-manager
 * @coverage createMainWindow / getMainWindow
 * @dependencies electron (BrowserWindow/dialog/app)、utils/logger (logFault)、utils/startup-diagnostic
 *
 * 难点：
 * 1. BrowserWindow 构造函数 mock + 实例方法 + webContents 事件监听
 * 2. ready-to-show / render-process-gone / console-message 三个事件需通过捕获的 listener 间接触发
 * 3. reload 抛错时递归调用 createMainWindow 的兜底分支
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeAppCtx } from '../../ipc/handlers/_test-helpers'

// 共享 mock
const {
  showMessageBoxMock,
  appQuitMock,
  logFaultMock,
  logStartupErrorMock,
  loggerErrorMock,
  BrowserWindowCtorMock,
  getFocusedWindowMock,
  markBootSuccessMock
} = vi.hoisted(() => ({
  showMessageBoxMock: vi.fn(),
  appQuitMock: vi.fn(),
  logFaultMock: vi.fn(),
  logStartupErrorMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  BrowserWindowCtorMock: vi.fn(),
  getFocusedWindowMock: vi.fn(() => null),
  markBootSuccessMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(BrowserWindowCtorMock, {
    getFocusedWindow: getFocusedWindowMock
  }),
  dialog: {
    showMessageBox: showMessageBoxMock
  },
  app: {
    quit: appQuitMock
  },
  ipcMain: {
    on: vi.fn(),
    removeListener: vi.fn()
  },
  // CSP 下发的响应头经此注册；生产路径 createMainWindow 会调用。
  session: {
    defaultSession: {
      webRequest: {
        onHeadersReceived: vi.fn()
      }
    }
  }
}))

vi.mock('../../utils/logger', () => ({
  logger: { error: loggerErrorMock },
  logFault: logFaultMock
}))

vi.mock('../../utils/startup-diagnostic', () => ({
  logStartupError: logStartupErrorMock,
  diagLog: vi.fn()
}))

vi.mock('../gpu-fallback', () => ({
  markBootSuccess: markBootSuccessMock
}))

import { createMainWindow, getMainWindow } from '../window-manager'
import { session } from 'electron'
import { vi } from 'vitest'

// 构造 BrowserWindow 实例 mock：捕获事件监听器，便于后续 emit
interface MockWindow {
  options: unknown
  webContents: {
    on: ReturnType<typeof vi.fn>
    once: ReturnType<typeof vi.fn>
    openDevTools: ReturnType<typeof vi.fn>
    reload: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
    isDestroyed: ReturnType<typeof vi.fn>
    _emit: (event: string, ...args: unknown[]) => void
  }
  once: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  isVisible: ReturnType<typeof vi.fn>
  _emit: (event: string, ...args: unknown[]) => void
}

function createMockWindow(options: unknown): MockWindow {
  const winListeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const wcListeners: Record<string, Array<(...args: unknown[]) => void>> = {}

  const win: MockWindow = {
    options,
    webContents: {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        ;(wcListeners[event] ??= []).push(cb)
      }),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        ;(wcListeners[event] ??= []).push(cb)
      }),
      openDevTools: vi.fn(),
      reload: vi.fn(),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      isDestroyed: vi.fn(() => false),
      _emit: (event: string, ...args: unknown[]): void => {
        ;(wcListeners[event] ?? []).forEach((cb) => cb(...args))
      }
    },
    once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      ;(winListeners[event] ??= []).push(cb)
    }),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      ;(winListeners[event] ??= []).push(cb)
    }),
    show: vi.fn(),
    loadURL: vi.fn(() => Promise.resolve()),
    loadFile: vi.fn(() => Promise.resolve()),
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => false),
    _emit: (event: string, ...args: unknown[]): void => {
      ;(winListeners[event] ?? []).forEach((cb) => cb(...args))
    }
  }
  return win
}

let lastCreatedWindow: MockWindow | null = null
let originalNodeEnv: string | undefined

beforeEach(() => {
  showMessageBoxMock.mockReset()
  appQuitMock.mockReset()
  logFaultMock.mockReset()
  logStartupErrorMock.mockReset()
  loggerErrorMock.mockReset()
  BrowserWindowCtorMock.mockReset()
  getFocusedWindowMock.mockReset()
  markBootSuccessMock.mockReset()

  // 默认：getFocusedWindow 返回 null
  getFocusedWindowMock.mockReturnValue(null)
  // 默认：logFault 返回 resolved promise（源码用 .catch(() => {})）
  logFaultMock.mockResolvedValue(undefined)
  // 默认：dialog 返回 response=0（重新加载）
  showMessageBoxMock.mockResolvedValue({ response: 0 })

  // BrowserWindow 构造时创建 mock 实例并保存到 lastCreatedWindow
  BrowserWindowCtorMock.mockImplementation((options: unknown) => {
    lastCreatedWindow = createMockWindow(options)
    return lastCreatedWindow
  })

  lastCreatedWindow = null
  originalNodeEnv = process.env.NODE_ENV
})

afterEach(() => {
  // 恢复 NODE_ENV
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV
  } else {
    process.env.NODE_ENV = originalNodeEnv
  }
})

describe('createMainWindow', () => {
  it('1. 构造 BrowserWindow，传入正确 webPreferences', async () => {
    await createMainWindow(makeAppCtx())

    expect(BrowserWindowCtorMock).toHaveBeenCalledTimes(1)
    const options = BrowserWindowCtorMock.mock.calls[0][0] as {
      webPreferences: Record<string, unknown>
    }
    expect(options.webPreferences.contextIsolation).toBe(true)
    expect(options.webPreferences.sandbox).toBe(true)
    expect(options.webPreferences.nodeIntegration).toBe(false)
  })

  it('2. ctx.setMainWindow 被调用，注入新窗口', async () => {
    const ctx = makeAppCtx()
    await createMainWindow(ctx)

    expect(ctx.setMainWindow).toHaveBeenCalledTimes(1)
    expect(ctx.setMainWindow).toHaveBeenCalledWith(lastCreatedWindow)
  })

  it('3. 开发环境加载 http://localhost:5173 并打开 devtools', async () => {
    process.env.NODE_ENV = 'development'
    await createMainWindow(makeAppCtx())

    expect(lastCreatedWindow!.loadURL).toHaveBeenCalledWith('http://localhost:5173')
    expect(lastCreatedWindow!.webContents.openDevTools).toHaveBeenCalledTimes(1)
    expect(lastCreatedWindow!.loadFile).not.toHaveBeenCalled()
  })

  it('4. 生产环境经 app:// 特权协议加载 renderer/index.html', async () => {
    process.env.NODE_ENV = 'production'
    session.defaultSession.webRequest.onHeadersReceived.mockClear()
    await createMainWindow(makeAppCtx())

    expect(lastCreatedWindow!.loadURL).toHaveBeenCalledTimes(1)
    expect(lastCreatedWindow!.loadURL).toHaveBeenCalledWith('app://renderer/index.html')
    expect(lastCreatedWindow!.loadFile).not.toHaveBeenCalled()
    expect(lastCreatedWindow!.webContents.openDevTools).not.toHaveBeenCalled()

    // 生产环境必须通过 onHeadersReceived 下发 CSP 响应头（与 index.html 的 meta 双重防护）。
    expect(session.defaultSession.webRequest.onHeadersReceived).toHaveBeenCalledTimes(1)
    const cb = session.defaultSession.webRequest.onHeadersReceived.mock.calls[0][0]
    const out = await new Promise<{ responseHeaders: Record<string, string[]> }>((resolve) =>
      cb({ responseHeaders: {} }, (r: unknown) =>
        resolve(r as { responseHeaders: Record<string, string[]> })
      )
    )
    expect(out.responseHeaders['Content-Security-Policy'][0]).toContain("script-src 'self'")
  })

  it('5. ready-to-show 事件触发后 mainWindow.show() + taskScheduler.resume()', async () => {
    const ctx = makeAppCtx()
    await createMainWindow(ctx)

    // 触发 ready-to-show 事件
    lastCreatedWindow!._emit('ready-to-show')

    expect(lastCreatedWindow!.show).toHaveBeenCalledTimes(1)
    expect(ctx.taskScheduler.resume).toHaveBeenCalledTimes(1)
  })

  // ============ D1 修复：ready-to-show 注册时序竞态（打包版首装启动扫描不触发的主因） ============

  it('U1. ready-to-show 在 loadURL promise resolve 之前触发（打包版竞态）：仍 show + resume', async () => {
    const ctx = makeAppCtx()
    // 模拟打包版 app:// 本地协议加载极快：ready-to-show 在 loadURL 调用内同步发出，
    // 早于 loadURL 返回的 promise resolve——晚于 loadURL 注册的 once 监听会永久错过该事件
    BrowserWindowCtorMock.mockImplementation((options: unknown) => {
      const win = createMockWindow(options)
      win.loadURL.mockImplementation(() => {
        win._emit('ready-to-show')
        return Promise.resolve()
      })
      lastCreatedWindow = win
      return win
    })

    await createMainWindow(ctx)

    expect(lastCreatedWindow!.show).toHaveBeenCalledTimes(1)
    expect(ctx.taskScheduler.resume).toHaveBeenCalledTimes(1)
  })

  it('U2. 正常时序（loadURL resolve 后 emit ready-to-show）：show + resume 各一次，重复触发不叠加', async () => {
    const ctx = makeAppCtx()
    await createMainWindow(ctx)

    lastCreatedWindow!._emit('ready-to-show')
    expect(lastCreatedWindow!.show).toHaveBeenCalledTimes(1)
    expect(ctx.taskScheduler.resume).toHaveBeenCalledTimes(1)

    // 重复触发（did-finish-load 兜底 + ready-to-show 双路径）不应二次 show/resume
    lastCreatedWindow!._emit('ready-to-show')
    expect(lastCreatedWindow!.show).toHaveBeenCalledTimes(1)
    expect(ctx.taskScheduler.resume).toHaveBeenCalledTimes(1)
  })

  it('U3. ready-to-show 未触发但 did-finish-load 触发：兜底 show + resume 被调用', async () => {
    process.env.NODE_ENV = 'production'
    const ctx = makeAppCtx()
    await createMainWindow(ctx)

    // 不触发 ready-to-show，仅页面加载完成
    lastCreatedWindow!.webContents._emit('did-finish-load')

    expect(lastCreatedWindow!.show).toHaveBeenCalledTimes(1)
    expect(ctx.taskScheduler.resume).toHaveBeenCalledTimes(1)

    // 随后 ready-to-show 再到也不重复执行
    lastCreatedWindow!._emit('ready-to-show')
    expect(lastCreatedWindow!.show).toHaveBeenCalledTimes(1)
    expect(ctx.taskScheduler.resume).toHaveBeenCalledTimes(1)
  })

  it('6. render-process-gone 事件触发时弹出 dialog.showMessageBox（含"重新加载/关闭应用"）', async () => {
    await createMainWindow(makeAppCtx())

    // 触发 render-process-gone 事件
    lastCreatedWindow!.webContents._emit(
      'render-process-gone',
      {},
      { reason: 'crashed', exitCode: 1 }
    )

    // 等待 async handler 完成
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(showMessageBoxMock).toHaveBeenCalledTimes(1)
    const options = showMessageBoxMock.mock.calls[0][1] as { buttons: string[] }
    expect(options.buttons).toEqual(['重新加载', '关闭应用'])
  })

  it('7. 用户选择"重新加载"（response=0）时调用 webContents.reload()', async () => {
    await createMainWindow(makeAppCtx())
    showMessageBoxMock.mockResolvedValue({ response: 0 })

    lastCreatedWindow!.webContents._emit(
      'render-process-gone',
      {},
      { reason: 'crashed', exitCode: 1 }
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(lastCreatedWindow!.webContents.reload).toHaveBeenCalledTimes(1)
    expect(appQuitMock).not.toHaveBeenCalled()
  })

  it('8. 用户选择"关闭应用"（response=1）时调用 app.quit()', async () => {
    await createMainWindow(makeAppCtx())
    showMessageBoxMock.mockResolvedValue({ response: 1 })

    lastCreatedWindow!.webContents._emit(
      'render-process-gone',
      {},
      { reason: 'crashed', exitCode: 1 }
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(appQuitMock).toHaveBeenCalledTimes(1)
    expect(lastCreatedWindow!.webContents.reload).not.toHaveBeenCalled()
  })

  it('9. mainWindow.isDestroyed() 返回 true 时 render-process-gone 短路返回（不弹窗）', async () => {
    await createMainWindow(makeAppCtx())
    // 触发事件后将 isDestroyed 设为 true
    lastCreatedWindow!.isDestroyed.mockReturnValue(true)

    lastCreatedWindow!.webContents._emit(
      'render-process-gone',
      {},
      { reason: 'crashed', exitCode: 1 }
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(showMessageBoxMock).not.toHaveBeenCalled()
  })

  it('10. reload 抛错时调用 createMainWindow 重建', async () => {
    await createMainWindow(makeAppCtx())
    showMessageBoxMock.mockResolvedValue({ response: 0 })
    // reload 抛错
    lastCreatedWindow!.webContents.reload.mockImplementation(() => {
      throw new Error('reload failed')
    })

    // 初始 BrowserWindow 调用 1 次
    expect(BrowserWindowCtorMock).toHaveBeenCalledTimes(1)

    lastCreatedWindow!.webContents._emit(
      'render-process-gone',
      {},
      { reason: 'crashed', exitCode: 1 }
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    // reload 失败后递归调用 createMainWindow → BrowserWindow 构造 2 次
    expect(BrowserWindowCtorMock).toHaveBeenCalledTimes(2)
    expect(logStartupErrorMock).toHaveBeenCalledWith('renderer-reload-failed', expect.any(Error))
  })

  it("11. console-message level='error' 时调用 logFault", async () => {
    await createMainWindow(makeAppCtx())

    // Electron v35+ 单一事件对象签名
    lastCreatedWindow!.webContents._emit('console-message', {
      level: 'error',
      message: 'renderer error',
      lineNumber: 42,
      sourceId: 'app.js'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(logFaultMock).toHaveBeenCalledWith(
      'rendererError',
      expect.any(Error),
      expect.objectContaining({
        source: 'renderer.console.error',
        location: 'app.js:42'
      })
    )
  })

  it("12. console-message level≠'error' 时不调用 logFault", async () => {
    await createMainWindow(makeAppCtx())

    for (const level of ['debug', 'info', 'warning'] as const) {
      logFaultMock.mockClear()
      lastCreatedWindow!.webContents._emit('console-message', {
        level,
        message: 'msg',
        lineNumber: 1,
        sourceId: 'src.js'
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(logFaultMock).not.toHaveBeenCalled()
    }
  })

  it('15. did-finish-load 触发时调用 markBootSuccess（GPU 回退失败计数清零）', async () => {
    process.env.NODE_ENV = 'production'
    await createMainWindow(makeAppCtx())

    lastCreatedWindow!.webContents._emit('did-finish-load')

    expect(markBootSuccessMock).toHaveBeenCalledTimes(1)
  })

  it('16. 开发模式分支不注册 did-finish-load（markBootSuccess 不被调用）', async () => {
    process.env.NODE_ENV = 'development'
    await createMainWindow(makeAppCtx())

    lastCreatedWindow!.webContents._emit('did-finish-load')

    expect(markBootSuccessMock).not.toHaveBeenCalled()
  })
})

describe('getMainWindow', () => {
  it('13. ctx.mainWindow 为 null 且无 focusedWindow 时抛错"主窗口未初始化"', () => {
    const ctx = makeAppCtx({ mainWindow: null })
    getFocusedWindowMock.mockReturnValue(null)

    expect(() => getMainWindow(ctx)).toThrow('主窗口未初始化')
  })

  it('14. 优先返回 ctx.mainWindow（不调用 getFocusedWindow）', () => {
    const mockWin = { id: 999, isDestroyed: () => false }
    const ctx = makeAppCtx({ mainWindow: mockWin })

    const result = getMainWindow(ctx)
    expect(result).toBe(mockWin)
    expect(getFocusedWindowMock).not.toHaveBeenCalled()
  })
})
