/**
 * 共享测试 mock：electron 组合式工厂
 *
 * 覆盖主进程代码最常用的 electron API 面：app / ipcMain / utilityProcess /
 * BrowserWindow / shell / dialog。所有部分默认给出最小桩，options 定向定制。
 *
 * 用法（vi.mock 工厂会被提升，须配合 vi.hoisted）：
 * ```ts
 * const { electronMock } = vi.hoisted(() => ({
 *   electronMock: createElectronMock({ app: { getPath: (n) => `/tmp/${n}` } })
 * }))
 * vi.mock('electron', () => electronMock)
 *
 * // 断言 / 驱动
 * electronMock.utilityProcess.fork.mockReturnValue(myWorker)
 * electronMock.ipcMain.handle('db:execute', handler)
 * await electronMock.ipcMain.invoke('db:execute', payload)
 * ```
 */
import { vi } from 'vitest'
import { EventEmitter } from 'events'
import type { MockFn } from './logger'

/** app 部分的定制选项 */
export interface ElectronAppOptions {
  /** 自定义 getPath 实现；默认返回 `/mock/userdata/<name>` */
  getPath?: (name: string) => string
  /** 默认 false */
  isPackaged?: boolean
}

/** utilityProcess 部分的定制选项 */
export interface ElectronUtilityProcessOptions {
  /** fork 的固定返回值；默认每次 fork 返回一个新的 createMockUtilityProcess() */
  worker?: unknown
}

/** BrowserWindow 部分的定制选项 */
export interface ElectronBrowserWindowOptions {
  /** getAllWindows 的返回值；默认 [] */
  windows?: unknown[]
}

export interface CreateElectronMockOptions {
  app?: ElectronAppOptions
  utilityProcess?: ElectronUtilityProcessOptions
  browserWindow?: ElectronBrowserWindowOptions
}

/** ipcMain mock：handle 注册的 handler 会被收集，可用 invoke 手动驱动 */
export interface ElectronIpcMainMock {
  handle: MockFn
  on: MockFn
  removeHandler: MockFn
  /** channel → handler（handle 注册的） */
  handlers: Map<string, (...args: unknown[]) => unknown>
  /** channel → listener 列表（on 注册的） */
  listeners: Map<string, Array<(...args: unknown[]) => unknown>>
  /** 以给定参数直接调用 handle 注册的 handler（不注入 event） */
  invoke: (channel: string, ...args: unknown[]) => unknown
  /** 以给定参数触发 on 注册的全部 listener（不注入 event） */
  emit: (channel: string, ...args: unknown[]) => void
}

export interface ElectronMock {
  app: {
    getPath: MockFn
    isPackaged: boolean
    getName: MockFn
    getVersion: MockFn
    quit: MockFn
    on: MockFn
    once: MockFn
    whenReady: MockFn
  }
  ipcMain: ElectronIpcMainMock
  utilityProcess: { fork: MockFn }
  BrowserWindow: { getAllWindows: MockFn }
  shell: {
    openPath: MockFn
    openExternal: MockFn
    showItemInFolder: MockFn
  }
  dialog: {
    showMessageBox: MockFn
    showOpenDialog: MockFn
    showSaveDialog: MockFn
    showErrorBox: MockFn
  }
}

/**
 * 创建模拟 utilityProcess worker：EventEmitter + postMessage/kill vi.fn。
 * 测试可对其 emit('message', ...) / emit('exit', ...) 驱动 bridge 逻辑。
 */
export function createMockUtilityProcess(): EventEmitter & {
  postMessage: MockFn
  kill: MockFn
} {
  const worker = new EventEmitter() as EventEmitter & {
    postMessage: MockFn
    kill: MockFn
  }
  worker.postMessage = vi.fn()
  worker.kill = vi.fn()
  return worker
}

function createIpcMainMock(): ElectronIpcMainMock {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler)
  })
  const on = vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
    const list = listeners.get(channel) ?? []
    list.push(listener)
    listeners.set(channel, list)
  })
  const removeHandler = vi.fn((channel: string) => {
    handlers.delete(channel)
  })
  return {
    handle,
    on,
    removeHandler,
    handlers,
    listeners,
    invoke: (channel, ...args) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`ipcMain mock：channel "${channel}" 未注册 handler`)
      return handler(...args)
    },
    emit: (channel, ...args) => {
      for (const listener of listeners.get(channel) ?? []) listener(...args)
    }
  }
}

/**
 * 创建组合式 electron mock。返回对象是普通对象（非模块），
 * 可直接作为 `vi.mock('electron', () => mock)` 的工厂返回值。
 * 未通过 options 定制的部分使用最小默认桩。
 */
export function createElectronMock(options: CreateElectronMockOptions = {}): ElectronMock {
  const appOptions = options.app ?? {}
  const utilityOptions = options.utilityProcess
  const windowOptions = options.browserWindow

  return {
    app: {
      getPath: vi.fn((name: string) =>
        appOptions.getPath ? appOptions.getPath(name) : `/mock/userdata/${name}`
      ),
      isPackaged: appOptions.isPackaged ?? false,
      getName: vi.fn(() => 'meow-star-map-test'),
      getVersion: vi.fn(() => '0.0.0-test'),
      quit: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      whenReady: vi.fn(() => Promise.resolve())
    },
    ipcMain: createIpcMainMock(),
    utilityProcess: {
      fork: vi.fn(() => utilityOptions?.worker ?? createMockUtilityProcess())
    },
    BrowserWindow: {
      getAllWindows: vi.fn(() => windowOptions?.windows ?? [])
    },
    shell: {
      openPath: vi.fn(async () => ''),
      openExternal: vi.fn(async () => undefined),
      showItemInFolder: vi.fn()
    },
    dialog: {
      showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
      showErrorBox: vi.fn()
    }
  }
}
