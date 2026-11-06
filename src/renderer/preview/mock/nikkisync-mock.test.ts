// N6：预览版 nikkisync 命名空间 Mock 的 TDD 契约（红灯先行）。
// 本目录 *.test.ts 走 vitest node project：环境无 window，tests/setup.ts 只在
// globalThis 注入 electronAPI 占位 Proxy；installPreviewMock() 首行又要求 window 存在。
// 故每个用例显式重建一个干净的 window（无 electronAPI），让安装真正执行。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { installPreviewMock } from './install'
import { PREVIEW_UNSUPPORTED } from './ipc-error'

type AnyFn = (...args: unknown[]) => unknown
type ApiShape = Record<string, Record<string, AnyFn>>

function installedApi(): ApiShape {
  return (globalThis as unknown as { window: { electronAPI: ApiShape } }).window.electronAPI
}

// 覆盖 SyncGalleryPage / SyncServicePage / SyncInsightPanel / SyncAssetDrawer /
// syncGalleryStore / mediaStore / 配对弹窗会调用的方法（以 preload/api/nikkisync.ts
// 的真实方法名为准）。桩只需覆盖这些；本列表即「已实现方法」契约。
const IMPLEMENTED_METHODS = [
  'getRuntimeStatus',
  'getAssets',
  'getResourceRecords',
  'getAssetDetail',
  'getServerStatus',
  'getPairedDevices',
  'getPairingCode',
  'searchSuits',
  'searchClothing',
  'profileStats',
  'getSyncAccounts',
  'getExtraDirectories',
  'getOrganizerQueue',
  'startScan',
  'startServer',
  'stopServer',
  'onLibraryChanged'
]

beforeEach(() => {
  // 参考 install.test.ts 的写法：stub 一个干净 window；再按契约把 electronAPI 显式
  // 重置为 undefined，规避 tests/setup.ts 预置的占位 Proxy（否则安装会走 skip 分支）。
  const freshWindow: Record<string, unknown> = {}
  vi.stubGlobal('window', freshWindow)
  Object.defineProperty(freshWindow, 'electronAPI', {
    value: undefined,
    configurable: true,
    writable: true
  })
  installPreviewMock()
})

describe('installPreviewMock 注入的 nikkisync 命名空间', () => {
  it('正常：getRuntimeStatus 是函数，await 返回对象（不抛错、非 undefined）', async () => {
    const ns = installedApi().nikkisync
    expect(typeof ns.getRuntimeStatus).toBe('function')
    const status = await ns.getRuntimeStatus()
    expect(status).toBeDefined()
    expect(status).not.toBeNull()
    expect(typeof status).toBe('object')
  })

  it('正常：getAssets 返回含 items: [] 的对象', async () => {
    const ns = installedApi().nikkisync
    const page = await ns.getAssets({ limit: 20 })
    expect(page).toBeDefined()
    expect(typeof page).toBe('object')
    const items = (page as { items: unknown[] }).items
    expect(Array.isArray(items)).toBe(true)
    expect(items).toHaveLength(0)
  })

  it('正常：onLibraryChanged 返回可调用的解订阅函数', async () => {
    const ns = installedApi().nikkisync
    // await 兼容「兜底态返回 rejected Promise」的红灯情形，避免未处理的 rejection。
    const unsubscribe = await ns.onLibraryChanged(() => {})
    expect(typeof unsubscribe).toBe('function')
    expect(() => (unsubscribe as () => void)()).not.toThrow()
  })

  it('异常：已实现的 nikkisync 方法不抛 PREVIEW_UNSUPPORTED', async () => {
    const ns = installedApi().nikkisync
    for (const name of IMPLEMENTED_METHODS) {
      const fn = ns[name]
      expect(typeof fn).toBe('function')
      try {
        await fn()
      } catch (error) {
        expect((error as { code?: string }).code).not.toBe(PREVIEW_UNSUPPORTED)
      }
    }
  })

  it('边界：未实现命名空间的方法仍落到 Proxy 兜底并抛 PREVIEW_UNSUPPORTED', async () => {
    const api = installedApi()
    const errors: unknown[] = []
    // 逐一创建并 await，避免先批量造出 rejected promise 触发 unhandled rejection。
    const calls: Array<() => unknown> = [
      () => api.thisNamespaceIsNotImplemented.someMethod(),
      () => api.anotherMissingNamespace.anotherMethod()
    ]
    for (const makeCall of calls) {
      try {
        await makeCall()
      } catch (error) {
        errors.push(error)
      }
    }
    expect(errors).toHaveLength(2)
    for (const error of errors) {
      expect((error as { code?: string }).code).toBe(PREVIEW_UNSUPPORTED)
    }
  })
})
