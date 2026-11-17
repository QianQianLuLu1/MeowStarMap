/**
 * @layer L3
 * @module src/main/app/window-manager 重建兜底守卫（审查修复轮 G1-F7）
 * @coverage reload 失败重建路径：旧空白窗必须销毁；旧窗 closed 不得清空新窗引用
 *
 * 缺陷机理：reload 失败兜底 createMainWindow 不销毁旧窗——旧窗及其监听器残留；
 * 旧窗日后关闭时 closed→ctx.setMainWindow(null) 把新窗引用清空 → sendToRenderer 短路。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const instances: FakeWindow[] = []
  class FakeWebContents {
    handlers = new Map<string, Array<(...a: unknown[]) => void>>()
    reloadImpl: () => void = () => {}
    on(ev: string, cb: (...a: unknown[]) => void) {
      const list = this.handlers.get(ev) ?? []
      list.push(cb)
      this.handlers.set(ev, list)
    }
    once(ev: string, cb: (...a: unknown[]) => void) {
      this.on(ev, cb)
    }
    emit(ev: string, ...args: unknown[]) {
      for (const cb of this.handlers.get(ev) ?? []) cb(...args)
    }
    setWindowOpenHandler() {}
    reload() {
      this.reloadImpl()
    }
    openDevTools() {}
  }
  class FakeWindow {
    webContents = new FakeWebContents()
    handlers = new Map<string, Array<(...a: unknown[]) => void>>()
    destroyed = false
    visible = false
    constructor() {
      instances.push(this)
    }
    on(ev: string, cb: (...a: unknown[]) => void) {
      const list = this.handlers.get(ev) ?? []
      list.push(cb)
      this.handlers.set(ev, list)
    }
    once(ev: string, cb: (...a: unknown[]) => void) {
      this.on(ev, cb)
    }
    emit(ev: string, ...args: unknown[]) {
      for (const cb of this.handlers.get(ev) ?? []) cb(...args)
    }
    isDestroyed() {
      return this.destroyed
    }
    isVisible() {
      return this.visible
    }
    show() {
      this.visible = true
    }
    destroy() {
      this.destroyed = true
      this.emit('closed')
    }
    async loadURL() {}
  }
  return {
    instances,
    FakeWindow,
    dialogResponse: { response: 0 },
    requestSingleInstanceLock: vi.fn(() => true)
  }
})

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), quit: vi.fn(), exit: vi.fn() },
  BrowserWindow: h.FakeWindow,
  dialog: { showMessageBox: vi.fn(async () => h.dialogResponse) },
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))
vi.mock('../../utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  logFault: vi.fn(() => Promise.resolve())
}))
vi.mock('../../utils/startup-diagnostic', () => ({
  logStartupError: vi.fn(),
  diagLog: vi.fn()
}))
vi.mock('../navigation-guard', () => ({ guardNavigation: vi.fn() }))
vi.mock('../gpu-status', () => ({ logGpuStatusSummary: vi.fn(() => Promise.resolve()) }))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))
vi.mock('../cdn-user-agent', () => ({ registerCdnUserAgent: vi.fn() }))
vi.mock('../app-icon-path', () => ({ resolveAppIconPath: vi.fn(() => null) }))
vi.mock('../gpu-fallback', () => ({
  markAppBooted: vi.fn(),
  markBootSuccess: vi.fn(),
  requestSelfHeal: vi.fn(() => false),
  isStartupPhase: vi.fn(() => false),
  BOOT_SUCCESS_SETTLE_MS: 8000
}))

import { createMainWindow } from '../window-manager'
import type { AppContext } from '../app-context'

function makeCtx(): { ctx: AppContext; current: () => unknown } {
  let current: unknown = null
  const ctx = {
    setMainWindow: (w: unknown) => {
      current = w
    },
    getMainWindow: () => current,
    taskScheduler: { isPaused: () => false, resume: vi.fn() }
  } as unknown as AppContext
  return { ctx, current: () => current }
}

beforeEach(() => {
  h.instances.length = 0
  h.dialogResponse = { response: 0 }
})

describe('window-manager reload 失败重建兜底（G1-F7）', () => {
  it('w1. 重建后旧窗必须已销毁，且旧窗 closed 不得把新窗引用清空', async () => {
    const { ctx, current } = makeCtx()
    await createMainWindow(ctx)
    const oldWin = h.instances[0]
    expect(current()).toBe(oldWin)

    // 渲染崩溃 → 用户选"重新加载" → reload 抛错 → 重建兜底
    oldWin.webContents.reloadImpl = () => {
      throw new Error('reload failed')
    }
    const gone = oldWin.webContents.handlers.get('render-process-gone')?.[0]
    expect(gone, 'render-process-gone 监听器应已注册').toBeTruthy()
    await gone!({}, { reason: 'crashed', exitCode: 1 })

    expect(h.instances.length, 'reload 失败应重建一个新窗口').toBe(2)
    const newWin = h.instances[1]
    expect(current(), 'ctx 引用应指向新窗口').toBe(newWin)
    expect(oldWin.isDestroyed(), '旧空白窗必须销毁（防监听器残留与 closed 竞态）').toBe(true)

    // 旧窗 closed 晚到（destroy 已发过一次；模拟极端晚到二次 closed）不得清空新窗引用
    oldWin.emit('closed')
    expect(current(), '旧窗 closed 不得清空新窗引用').toBe(newWin)
  })
})
