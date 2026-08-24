/**
 * D3 修复回归：全盘目录发现阶段（findMediaDirectories 多盘符签名搜索）的进度盲区。
 *
 * U4：fullScan 进入目录发现之前，必须已发出一条初始 SCAN_PROGRESS
 *     （scanned=0 / found=0 / status='running' / currentPath=发现阶段文案），
 *     且该事件发生在目录发现 resolve 之前（用 pending deferred 卡住发现流程验证时序）。
 * U5：初始进度事件发送异常（postMessage 抛错）不得中断扫描流程。
 *
 * 桩法与 scan-batch-write-failure.test.ts 同源：
 * - parentPort 桩捕获 message 处理器 + postMessage 间谍
 * - better-sqlite3 走 Module._load 拦截（vite-node 注入的原生 require 不经 vi.mock 注册表）
 * - game-directory-discovery 桩替换，findSteamGamePaths 返回可控 deferred
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import Module from 'node:module'

// repairLegacyDataV1/V3/V4 桩掉（startScan 串行调用，与本测试无关）
vi.mock('../repair-legacy-data-v1', () => ({ repairLegacyDataV1: vi.fn() }))
vi.mock('../repair-legacy-data-v3', () => ({ repairLegacyDataV3: vi.fn() }))
vi.mock('../repair-legacy-data-v4', () => ({ repairLegacyDataV4: vi.fn() }))

// 目录发现桩：findSteamGamePaths 返回可控 deferred，卡住 findMediaDirectories 验证事件时序
const discovery = vi.hoisted(() => ({
  findSteamGamePaths: vi.fn(),
  findEpicGamePaths: vi.fn(() => Promise.resolve([])),
  getUserDataPaths: vi.fn(() => Promise.resolve([])),
  getAvailableDrives: vi.fn(() => Promise.resolve([])),
  searchByMediaFolderSignatureShallow: vi.fn(() => Promise.resolve([])),
  searchBySignatureShallow: vi.fn(() => Promise.resolve(null))
}))

vi.mock('../game-directory-discovery', () => discovery)

// better-sqlite3 假实现：构造函数返回共享实例（每用例可替换行为）
const h = vi.hoisted(() => {
  const state: { instance: unknown } = { instance: null }
  const Ctor = function () {
    return state.instance
  }
  return { state, Ctor }
})

// parentPort 桩：捕获 message 处理器 + postMessage 间谍
let messageHandler: ((event: { data: unknown }) => void) | undefined
const postMessageMock = vi.fn()
// worker-entry 模块引用（beforeAll 动态 import 后赋值，供 U-C 直接调用 findMediaDirectories）
let workerEntryModule: typeof import('../worker-entry')

// Module._load 挂钩（beforeAll 安装、afterAll 还原）
type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown
const moduleWithLoad = Module as unknown as { _load: ModuleLoad }
const originalLoad: ModuleLoad = moduleWithLoad._load

function isBetterSqliteRequest(request: string): boolean {
  return (
    request === 'better-sqlite3' ||
    request.replace(/\\/g, '/').endsWith('better-sqlite3/lib/index.js')
  )
}

function createFakeDb(): unknown {
  return {
    pragma: () => undefined,
    close: () => undefined,
    prepare: (_sql: string) => ({
      run: () => ({ changes: 1, lastInsertRowid: 1 }),
      get: () => undefined,
      all: () => []
    }),
    transaction: (fn: (...args: unknown[]) => unknown) => fn
  }
}

function sendScanStart(dbPath: string, options: Record<string, unknown>): void {
  if (!messageHandler) throw new Error('parentPort message handler 未注册')
  messageHandler({ data: { type: 'SCAN_START', payload: { dbPath, options } } })
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, what: string): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error(`${what} 未在超时内到达`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 已发出的指定类型事件列表 */
function sentEvents(type: string): Array<{ type: string; payload: unknown }> {
  return postMessageMock.mock.calls
    .map((c) => c[0] as { type: string; payload: unknown })
    .filter((e) => e?.type === type)
}

beforeAll(async () => {
  // 1. 挂钩 Module._load：better-sqlite3 替换为 mock（其余请求走原实现）
  moduleWithLoad._load = function (request, parent, isMain) {
    if (typeof request === 'string' && isBetterSqliteRequest(request)) {
      return { default: h.Ctor }
    }
    return originalLoad(request, parent, isMain)
  }

  // 2. parentPort 桩（必须在 import worker-entry 之前安装）
  ;(process as { parentPort?: unknown }).parentPort = {
    on: (_type: string, cb: (event: { data: unknown }) => void) => {
      messageHandler = cb
    },
    postMessage: postMessageMock
  }

  // 3. 动态 import（此时全部桩已就绪），保存模块引用供 U-C 直接调用 findMediaDirectories
  workerEntryModule = await import('../worker-entry')
})

afterAll(() => {
  moduleWithLoad._load = originalLoad
  delete (process as { parentPort?: unknown }).parentPort
})

describe('D3：全盘目录发现阶段的初始进度事件', () => {
  it('U4. fullScan 进入目录发现前已发出 SCAN_PROGRESS，且早于目录发现 resolve', async () => {
    postMessageMock.mockClear()
    h.state.instance = createFakeDb()

    // 目录发现挂起：resolve 前发送初始进度事件才算"发现阶段有反馈"
    let resolveDiscovery!: (dirs: string[]) => void
    const discoveryDeferred = new Promise<string[]>((resolve) => {
      resolveDiscovery = resolve
    })
    discovery.findSteamGamePaths.mockReturnValueOnce(discoveryDeferred)

    sendScanStart('fake-initial-progress.db', { fullScan: true })

    // 目录发现仍挂起时，初始 SCAN_PROGRESS 必须已经发出
    await waitFor(
      () => sentEvents('SCAN_PROGRESS').length > 0,
      5000,
      '目录发现挂起期间的初始 SCAN_PROGRESS'
    )
    const initial = sentEvents('SCAN_PROGRESS')[0].payload as {
      scanned: number
      found: number
      currentPath: string
      status: string
    }
    expect(initial.scanned).toBe(0)
    expect(initial.found).toBe(0)
    expect(initial.status).toBe('running')
    expect(initial.currentPath).toContain('搜索游戏目录')

    // 放行目录发现（返回一个空目录集会走 noMediaDirFound 失败分支，同样能收尾）
    resolveDiscovery([])
    await waitFor(() => sentEvents('SCAN_COMPLETE').length > 0, 5000, 'SCAN_COMPLETE')
  })

  it('U5. 初始进度 sendEvent 抛异常：扫描流程不被中断，仍走到目录发现', async () => {
    postMessageMock.mockClear()
    h.state.instance = createFakeDb()

    // postMessage 对 SCAN_PROGRESS 一律抛错（模拟 parentPort 异常）
    postMessageMock.mockImplementation((event: { type: string }) => {
      if (event?.type === 'SCAN_PROGRESS') {
        throw new Error('postMessage broken（模拟初始进度发送异常）')
      }
      return undefined
    })

    discovery.findSteamGamePaths.mockResolvedValueOnce([])

    sendScanStart('fake-progress-throw.db', { fullScan: true })

    // 扫描未被中断：目录发现执行且流程走到 SCAN_COMPLETE
    await waitFor(() => sentEvents('SCAN_COMPLETE').length > 0, 5000, 'SCAN_COMPLETE')
    expect(discovery.findSteamGamePaths).toHaveBeenCalled()
    const complete = sentEvents('SCAN_COMPLETE')[0].payload as { success: boolean }
    expect(complete.success).toBe(false) // 0 目录 → noMediaDirFound，但流程完整收尾

    postMessageMock.mockReset()
    postMessageMock.mockImplementation(() => undefined)
    // postMessage 收集行为恢复（供后续断言用），清空调用记录
    postMessageMock.mock.calls.length = 0
  })
})

describe('T2：目录发现结论日志透传', () => {
  it('U-C. findMediaDirectories 的结论日志以 SCAN_LOG info 事件透传到主进程', async () => {
    postMessageMock.mockClear()
    h.state.instance = createFakeDb()

    // 桩返回空结果即可走完目录发现全流程（结论日志在函数末尾必定发出）
    discovery.findSteamGamePaths.mockResolvedValueOnce([])

    await workerEntryModule.findMediaDirectories()

    // 捕获 SCAN_LOG info 事件（修复前 workerLog 对 info 直接丢弃，无任何事件发出 ← RED 断言）
    const scanLogInfoEvents = postMessageMock.mock.calls
      .map((c) => c[0] as { type: string; payload?: { level?: string; message?: string } })
      .filter((e) => e?.type === 'SCAN_LOG' && e.payload?.level === 'info')

    expect(scanLogInfoEvents.length).toBeGreaterThan(0)
    expect(
      scanLogInfoEvents.some((e) => e.payload?.message?.includes('findMediaDirectories 搜索结果'))
    ).toBe(true)
  })
})
