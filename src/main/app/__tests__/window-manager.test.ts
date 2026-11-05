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
  markBootSuccessMock,
  markAppBootedMock,
  requestSelfHealMock,
  isStartupPhaseMock,
  loggerWarnMock
} = vi.hoisted(() => ({
  showMessageBoxMock: vi.fn(),
  appQuitMock: vi.fn(),
  logFaultMock: vi.fn(),
  logStartupErrorMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  BrowserWindowCtorMock: vi.fn(),
  getFocusedWindowMock: vi.fn(() => null),
  markBootSuccessMock: vi.fn(),
  markAppBootedMock: vi.fn(),
  requestSelfHealMock: vi.fn(() => false),
  isStartupPhaseMock: vi.fn(() => false),
  loggerWarnMock: vi.fn()
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
        onHeadersReceived: vi.fn(),
        onBeforeSendHeaders: vi.fn()
      }
    }
  }
}))

vi.mock('../../utils/logger', () => ({
  logger: { error: loggerErrorMock, warn: loggerWarnMock },
  logFault: logFaultMock
}))

vi.mock('../../utils/startup-diagnostic', () => ({
  logStartupError: logStartupErrorMock,
  diagLog: vi.fn()
}))

vi.mock('../gpu-fallback', () => ({
  markBootSuccess: markBootSuccessMock,
  markAppBooted: markAppBootedMock,
  requestSelfHeal: requestSelfHealMock,
  isStartupPhase: isStartupPhaseMock,
  BOOT_SUCCESS_SETTLE_MS: 8000
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
  markAppBootedMock.mockReset()
  requestSelfHealMock.mockReset()
  isStartupPhaseMock.mockReset()
  loggerWarnMock.mockReset()
  // 默认：非启动期、且自愈不触发（维持既有 dialog 流程）
  isStartupPhaseMock.mockReturnValue(false)
  requestSelfHealMock.mockReturnValue(false)

  // 默认：getFocusedWindow 返回 null
  getFocusedWindowMock.mockReturnValue(null)
  // 默认：logFault 返回 resolved promise（源码用 .catch(() => {})）
  logFaultMock.mockResolvedValue(undefined)
  // 默认：dialog 返回 response=0（重新加载）
  showMessageBoxMock.mockResolvedValue({ response: 0 })

  // BrowserWindow 构造时创建 mock 实例并保存到 lastCreatedWindow
  // vitest 5：生产代码 `new BrowserWindow(...)`，箭头实现不可构造 → 必须用 function 表达式
  BrowserWindowCtorMock.mockImplementation(function createBrowserWindowMock(options: unknown) {
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
    // img-src 必须放行 cdn.gongeo.us（衣橱/搭配码外链图唯一豁免主机），误删会导致图静默全破。
    expect(out.responseHeaders['Content-Security-Policy'][0]).toContain(
      "img-src 'self' media: data: https://cdn.gongeo.us"
    )
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
    // vitest 5：`new BrowserWindow(...)` 要求实现可 new，箭头函数会抛 "is not a constructor"
    BrowserWindowCtorMock.mockImplementation(function createBrowserWindowMock(options: unknown) {
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

  it('15. did-finish-load 立即标记首绘（退出启动期），但失败计数清零延后到存活窗口到点', async () => {
    process.env.NODE_ENV = 'production'
    await createMainWindow(makeAppCtx())

    lastCreatedWindow!.webContents._emit('did-finish-load')

    expect(markAppBootedMock).toHaveBeenCalledTimes(1)
    expect(markBootSuccessMock).not.toHaveBeenCalled()
  })

  it('S1. 首绘后未达存活窗口（7.999s）→ 不清零失败计数（GPU FATAL 多在首绘后数秒杀死进程）', async () => {
    vi.useFakeTimers({ now: 0 })
    try {
      process.env.NODE_ENV = 'production'
      await createMainWindow(makeAppCtx())
      lastCreatedWindow!.webContents._emit('did-finish-load')

      vi.advanceTimersByTime(8000 - 1)
      expect(markBootSuccessMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('S2. 首绘后达存活窗口（8s）→ 清零一次；重复 did-finish-load 不二次确认', async () => {
    vi.useFakeTimers({ now: 0 })
    try {
      process.env.NODE_ENV = 'production'
      await createMainWindow(makeAppCtx())
      const wc = lastCreatedWindow!.webContents
      wc._emit('did-finish-load')
      vi.advanceTimersByTime(8000)
      expect(markBootSuccessMock).toHaveBeenCalledTimes(1)

      // 页面二次导航（reload）再触发：不得重复写盘确认
      wc._emit('did-finish-load')
      vi.advanceTimersByTime(8000)
      expect(markBootSuccessMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('S3. 只有 did-fail-load（白屏）→ 既不标记首绘也不清零失败计数', async () => {
    vi.useFakeTimers({ now: 0 })
    try {
      process.env.NODE_ENV = 'production'
      await createMainWindow(makeAppCtx())
      lastCreatedWindow!.webContents._emit(
        'did-fail-load',
        -2,
        'ERR_FAILED',
        'app://renderer/index.html'
      )

      vi.advanceTimersByTime(60_000)
      expect(markAppBootedMock).not.toHaveBeenCalled()
      expect(markBootSuccessMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('16. 开发模式分支不注册 did-finish-load（markBootSuccess 不被调用）', async () => {
    process.env.NODE_ENV = 'development'
    await createMainWindow(makeAppCtx())

    lastCreatedWindow!.webContents._emit('did-finish-load')

    expect(markBootSuccessMock).not.toHaveBeenCalled()
  })

  it('17. 启动期（首绘前）render-process-gone → 调用 requestSelfHeal 自愈且跳过对话框', async () => {
    await createMainWindow(makeAppCtx())
    isStartupPhaseMock.mockReturnValue(true)
    requestSelfHealMock.mockReturnValue(true) // 已触发自动重启

    lastCreatedWindow!.webContents._emit(
      'render-process-gone',
      {},
      { reason: 'crashed', exitCode: 1 }
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(requestSelfHealMock).toHaveBeenCalledWith('crashed', 1)
    // 自愈重启：跳过用户对话框、不退出应用
    expect(showMessageBoxMock).not.toHaveBeenCalled()
    expect(appQuitMock).not.toHaveBeenCalled()
  })

  it('18. 启动期崩溃但已兼容模式仍崩（requestSelfHeal 返回 false）→ 回退到错误对话框', async () => {
    await createMainWindow(makeAppCtx())
    isStartupPhaseMock.mockReturnValue(true)
    requestSelfHealMock.mockReturnValue(false) // 已兼容模式仍崩，不自愈

    lastCreatedWindow!.webContents._emit(
      'render-process-gone',
      {},
      { reason: 'crashed', exitCode: 1 }
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 自愈失败：仍走既有对话框 UX，避免无限重启
    expect(requestSelfHealMock).toHaveBeenCalledWith('crashed', 1)
    expect(showMessageBoxMock).toHaveBeenCalledTimes(1)
  })
})

// ============ 导航防护：非应用文档不得带走 preload 的 IPC 桥 ============
// preload 是 webContents 级 webPreferences，对该窗口加载的任何文档都会执行。
// will-navigate 覆盖主帧，will-frame-navigate 覆盖子帧（iframe 等同样会跑 preload）。
describe('导航防护（will-navigate / will-frame-navigate）', () => {
  function makeNavEvent(): { preventDefault: ReturnType<typeof vi.fn> } {
    return { preventDefault: vi.fn() }
  }

  function emitNavigate(url: string): { preventDefault: ReturnType<typeof vi.fn> } {
    const event = makeNavEvent()
    lastCreatedWindow!.webContents._emit('will-navigate', event, url)
    return event
  }

  // will-frame-navigate 只回传一个 Event 对象（url / isMainFrame 挂在它上面），
  // 与 will-navigate 的 (event, url) 双参数签名不同，故此处合并为单对象。
  function emitFrameNavigate(
    url: string,
    isMainFrame: boolean
  ): {
    preventDefault: ReturnType<typeof vi.fn>
  } {
    const event = Object.assign(makeNavEvent(), {
      url,
      isMainFrame,
      frameProcessId: 1,
      frameRoutingId: 2
    })
    lastCreatedWindow!.webContents._emit('will-frame-navigate', event)
    return event
  }

  it('1. 生产：file:///…/evil.html 被拦截（preventDefault + navigation-blocked 故障）', async () => {
    process.env.NODE_ENV = 'production'
    await createMainWindow(makeAppCtx())
    const url = 'file:///C:/Users/me/Downloads/evil.html'

    const event = emitNavigate(url)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(logFaultMock).toHaveBeenCalledWith(
      'navigation-blocked',
      expect.any(Error),
      expect.objectContaining({ source: 'will-navigate', url })
    )
  })

  it('2. 生产：任意 localhost 端口的 HTTP 服务被拦截（历史 startsWith 白名单的泄露面）', async () => {
    process.env.NODE_ENV = 'production'
    await createMainWindow(makeAppCtx())

    const event = emitNavigate('http://localhost:8080')

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(logFaultMock).toHaveBeenCalledTimes(1)
  })

  it('3. 生产：外站 http/https 被拦截', async () => {
    process.env.NODE_ENV = 'production'
    await createMainWindow(makeAppCtx())

    expect(emitNavigate('https://example.com').preventDefault).toHaveBeenCalledTimes(1)
  })

  it('4. 生产：app:// 与 media:// 应用自身文档放行（不拦截、不记故障）', async () => {
    process.env.NODE_ENV = 'production'
    await createMainWindow(makeAppCtx())
    logFaultMock.mockClear()

    expect(emitNavigate('app://renderer/index.html').preventDefault).not.toHaveBeenCalled()
    expect(emitNavigate('media://file?path=C%3A%2Fa.jpg').preventDefault).not.toHaveBeenCalled()
    expect(logFaultMock).not.toHaveBeenCalled()
  })

  it('5. dev：vite dev server（localhost:5173）放行', async () => {
    process.env.NODE_ENV = 'development'
    await createMainWindow(makeAppCtx())
    logFaultMock.mockClear()

    expect(emitNavigate('http://localhost:5173').preventDefault).not.toHaveBeenCalled()
    expect(logFaultMock).not.toHaveBeenCalled()
  })

  it('6. dev：file:// 仍被拦截（dev 无 file:// 文档依赖）', async () => {
    process.env.NODE_ENV = 'development'
    await createMainWindow(makeAppCtx())

    expect(emitNavigate('file:///C:/evil.html').preventDefault).toHaveBeenCalledTimes(1)
  })

  it('7. 子帧（isMainFrame=false）导航到 file:// 被拦截并记为 will-frame-navigate', async () => {
    process.env.NODE_ENV = 'production'
    await createMainWindow(makeAppCtx())

    const event = emitFrameNavigate('file:///C:/evil.html', false)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(logFaultMock).toHaveBeenCalledWith(
      'navigation-blocked',
      expect.any(Error),
      expect.objectContaining({ source: 'will-frame-navigate' })
    )
  })

  it('8. 主帧的 will-frame-navigate 短路（交给 will-navigate，避免同一导航记两条故障）', async () => {
    process.env.NODE_ENV = 'production'
    await createMainWindow(makeAppCtx())
    logFaultMock.mockClear()

    const event = emitFrameNavigate('file:///C:/evil.html', true)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(logFaultMock).not.toHaveBeenCalled()
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

// cdn.gongeo.us 固定 User-Agent 标识的契约测试。
// 期望值一律用字面量：红灯阶段实现模块尚不存在，不得 import 被测模块。
type BeforeHeaders = Record<string, string>
type BeforeResponse = { requestHeaders?: BeforeHeaders }
type BeforeSendDetails = { url: string; requestHeaders?: BeforeHeaders }
type BeforeSendListener = (
  details: BeforeSendDetails,
  callback: (response: BeforeResponse) => void
) => void

function webRequestMocks(): {
  onBeforeSendHeaders: ReturnType<typeof vi.fn>
  onHeadersReceived: ReturnType<typeof vi.fn>
} {
  return session.defaultSession.webRequest as unknown as {
    onBeforeSendHeaders: ReturnType<typeof vi.fn>
    onHeadersReceived: ReturnType<typeof vi.fn>
  }
}

/** clearMocks:false：共享 vi.fn 的调用历史跨用例累积，取回调前必须手动清 */
async function getRegisteredListener(nodeEnv: string): Promise<BeforeSendListener> {
  const onBefore = webRequestMocks().onBeforeSendHeaders
  onBefore.mockClear()
  loggerWarnMock.mockClear()
  process.env.NODE_ENV = nodeEnv
  await createMainWindow(makeAppCtx())
  expect(onBefore).toHaveBeenCalledTimes(1)
  return onBefore.mock.calls[0][0] as BeforeSendListener
}

function drive(listener: BeforeSendListener, details: BeforeSendDetails): Promise<BeforeResponse> {
  return new Promise((resolve) => listener(details, resolve))
}

function hasWarn(text: string): boolean {
  return loggerWarnMock.mock.calls.some((call) => String(call[0]).includes(text))
}

describe('createMainWindow / cdn.gongeo.us 固定 User-Agent', () => {
  it('UA-1 目标主机 cdn.gongeo.us 的请求 User-Agent 被设为 MeowStarMap', async () => {
    const listener = await getRegisteredListener('production')
    const original = { Accept: 'image/avif,image/webp,*/*', 'User-Agent': 'Mozilla/5.0 Chrome/131' }
    const out = await drive(listener, {
      url: 'https://cdn.gongeo.us/images/items/icons/1020100001.png',
      requestHeaders: { ...original }
    })

    expect(out.requestHeaders).toBeDefined()
    expect(out.requestHeaders!['User-Agent']).toBe('MeowStarMap')
    expect(
      Object.keys(out.requestHeaders!).filter((k) => k.toLowerCase() === 'user-agent')
    ).toHaveLength(1)
    expect(out.requestHeaders!['Accept']).toBe(original.Accept)
  })

  it('UA-2 非目标主机请求头原样保留（零干预、不 mutate）', async () => {
    const listener = await getRegisteredListener('development')
    for (const url of [
      'http://localhost:5173/@vite/client',
      'app://renderer/index.html',
      'media://file?path=C%3A%2Fa.jpg',
      'https://cdn.gongeo.us.evil.com/x.png',
      'https://evilcdn.gongeo.us/x.png',
      'https://example.com/cdn.gongeo.us/x.png'
    ]) {
      const before = { 'User-Agent': 'Mozilla/5.0 Chrome/131', Accept: '*/*' }
      const snapshot = { ...before }
      const out = await drive(listener, { url, requestHeaders: before })

      expect(out).toEqual({})
      expect(before).toEqual(snapshot)
      expect(before['User-Agent']).toBe('Mozilla/5.0 Chrome/131')
    }
  })

  it('UA-3 既有 User-Agent（任意大小写）被覆盖为唯一 MeowStarMap', async () => {
    const listener = await getRegisteredListener('production')
    for (const key of ['User-Agent', 'user-agent', 'USER-AGENT', 'uSeR-AgEnT']) {
      const out = await drive(listener, {
        url: 'https://cdn.gongeo.us/images/outfits/10001.png',
        requestHeaders: { [key]: 'OldAgent/1.0', Accept: '*/*' }
      })

      expect(
        Object.keys(out.requestHeaders!).filter((k) => k.toLowerCase() === 'user-agent')
      ).toEqual(['User-Agent'])
      expect(out.requestHeaders!['User-Agent']).toBe('MeowStarMap')
      expect(JSON.stringify(out.requestHeaders!)).not.toContain('OldAgent')
    }
  })

  it('UA-4 onBeforeSendHeaders 注册早于 loadURL，且加载瞬间即可改写', async () => {
    const onBefore = webRequestMocks().onBeforeSendHeaders
    onBefore.mockClear()
    let uaAtLoad: string | undefined

    BrowserWindowCtorMock.mockImplementation(function createBrowserWindowMockWithUaProbe(
      options: unknown
    ) {
      const win = createMockWindow(options)
      win.loadURL.mockImplementation(() => {
        const cb = onBefore.mock.calls[0]?.[0] as BeforeSendListener | undefined
        if (cb) {
          cb(
            { url: 'https://cdn.gongeo.us/images/items/icons/1020100001.png', requestHeaders: {} },
            (response) => {
              uaAtLoad = response.requestHeaders?.['User-Agent']
            }
          )
        }
        return Promise.resolve()
      })
      lastCreatedWindow = win
      return win
    })

    process.env.NODE_ENV = 'production'
    await createMainWindow(makeAppCtx())
    expect(onBefore).toHaveBeenCalledTimes(1)

    const regOrder = onBefore.mock.invocationCallOrder[0]
    const loadOrder = lastCreatedWindow!.loadURL.mock.invocationCallOrder[0]
    expect(regOrder).toBeLessThan(loadOrder)

    for (let i = 0; i < 20 && uaAtLoad === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(uaAtLoad).toBe('MeowStarMap')
  })

  it('UA-5 开发模式（NODE_ENV=development）也注册 UA 改写', async () => {
    await getRegisteredListener('development')
    expect(lastCreatedWindow!.loadURL).toHaveBeenCalledWith('http://localhost:5173')
  })

  it('UA-6 URL 解析失败 / requestHeaders 缺失时 fail-open、不阻断、有诊断', async () => {
    const listener = await getRegisteredListener('production')

    const out1 = await drive(listener, {
      url: 'not a valid url',
      requestHeaders: { 'User-Agent': 'Keep/1.0' }
    })
    expect(out1).toEqual({})
    expect(hasWarn('URL parse failed')).toBe(true)

    const out2 = await drive(listener, {
      url: 'https://cdn.gongeo.us/x.png',
      requestHeaders: undefined
    })
    expect(out2).toEqual({})
    expect(hasWarn('requestHeaders')).toBe(true)
  })
})
