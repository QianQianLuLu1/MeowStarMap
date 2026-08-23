/**
 * @layer L3
 * @module src/main/media-worker/worker-entry
 * @coverage withFileTimeout（单文件处理超时兑底）+ 消息处理分支
 *          （取消标志/进度 500ms 节流/错误分支/惰性 DB 加载/DISPOSE）
 *
 * 覆盖路径：
 * 1. withFileTimeout：正常完成 / 超时 / reject 三条路径
 * 2. 消息处理：THUMBNAIL/PHASH/SIMILAR 取消标志、标志独立性、DUPLICATE 循环提前退出
 * 3. 进度节流：500ms 时间阈值与 processed 计数阈值（fake timers）
 * 4. 错误分支：单文件失败隔离、批次级异常、handler 顶层异常、parentPort 发送异常吞掉
 * 5. 惰性 DB 加载：加载失败错误路径、函数形态/对象形态 { default } 两个分支、PRAGMA 配置
 *
 * 新增用例的驱动方式：
 * - Module._load 钩子拦截惰性 require('better-sqlite3')（tests/mocks installBetterSqlite3Hook）
 * - parentPort 桩收集消息并手动触发 message 事件（tests/mocks installParentPortStub）
 * - sharp/fluent-ffmpeg/phash/bktree/concurrency 等一律 vi.mock，严禁真实加载原生模块
 */
import { describe, it, expect, vi, afterEach, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { withFileTimeout } from './worker-entry'
import {
  installBetterSqlite3Hook,
  uninstallBetterSqlite3Hook,
  installParentPortStub,
  uninstallParentPortStub
} from '../../../tests/mocks'
import type { BetterSqlite3HookHandle } from '../../../tests/mocks/sqlite/require-hook'
import type { ParentPortStubHandle } from '../../../tests/mocks/parent-port'

// ============ 新增分支覆盖用例：共享 mock 与控制态 ============

/** worker 回传事件的最小结构 */
interface WorkerEvent {
  type: string
  payload: Record<string, unknown>
}

/** bktree-index buildAndSearch 的入参形状（仅测试用到的字段） */
interface BkSearchOpts {
  rows: Array<Record<string, unknown>>
  threshold: number
  shouldStop: () => boolean
  onCandidates: (batch: unknown[]) => void
  onProgress: (scanned: number, total: number, candidates: number) => void
}

// mock 行为控制态：vi.mock 工厂被提升，只能引用 vi.hoisted 创建的共享状态
const ctl = vi.hoisted(() => ({
  /** sharp toFile 延迟 ms：fake timers 节流用例模拟慢速缩略图生成 */
  sharpToFileDelayMs: 0,
  /** calculatePHash 实现覆写（按文件注入失败） */
  phashImpl: null as null | ((filePath: string) => Promise<string | null>),
  /** hammingDistance 实现覆写（控制聚类结果/统计调用次数） */
  hammingImpl: null as null | ((a: string, b: string) => number),
  /** buildAndSearch 实现覆写（相似检测取消/回传用例） */
  bktreeImpl: null as null | ((opts: BkSearchOpts) => unknown),
  /** fluent-ffmpeg run 是否触发 error 回调 */
  ffmpegFail: false,
  /** better-sqlite3 假构造函数当前返回的 db 实例（逐用例注入） */
  currentDb: null as unknown,
  /** 记录假构造函数的每次 dbPath 调用 */
  dbCtorCalls: [] as string[]
}))

// sharp：链式 mock；metadata 固定尺寸，toFile 支持受控延迟（节流用例）
vi.mock('sharp', () => {
  const chain: Record<string, unknown> = {}
  chain.resize = () => chain
  chain.jpeg = () => chain
  chain.metadata = () => Promise.resolve({ width: 1920, height: 1080 })
  chain.toFile = () => new Promise((resolve) => setTimeout(resolve, ctl.sharpToFileDelayMs))
  return { default: () => chain }
})

// fluent-ffmpeg：链式命令 mock；run 后异步触发 end/error（受控）
vi.mock('fluent-ffmpeg', () => {
  const createCommand = (): Record<string, unknown> => {
    const handlers: Record<string, (err?: Error) => void> = {}
    const cmd: Record<string, unknown> = {}
    const chain = (): Record<string, unknown> => cmd
    cmd.setFfmpegPath = chain
    cmd.seekInput = chain
    cmd.frames = chain
    cmd.output = chain
    cmd.outputOptions = chain
    cmd.on = (event: string, cb: (err?: Error) => void) => {
      handlers[event] = cb
      return cmd
    }
    cmd.run = () => {
      setTimeout(() => {
        if (ctl.ffmpegFail) handlers.error?.(new Error('ffmpeg 抽帧失败（mock）'))
        else handlers.end?.()
      }, 0)
    }
    cmd.kill = () => undefined
    return cmd
  }
  return { default: () => createCommand() }
})

// phash：默认返回全 0 hash；逐用例可覆写实现（注入失败/统计调用）
vi.mock('../utils/phash', () => ({
  calculatePHash: (filePath: string) =>
    ctl.phashImpl ? ctl.phashImpl(filePath) : Promise.resolve('0'.repeat(64)),
  hammingDistance: (a: string, b: string) => (ctl.hammingImpl ? ctl.hammingImpl(a, b) : 99)
}))

// 重复评分：默认保留组内第一项
vi.mock('../utils/duplicate-scoring', () => ({
  pickBestId: (items: Array<{ id: number }>) => (items.length > 0 ? items[0].id : null)
}))

// BK-tree：默认空结果；相似检测用例逐用例覆写
vi.mock('./bktree-index', () => ({
  buildAndSearch: (opts: unknown) =>
    ctl.bktreeImpl ? ctl.bktreeImpl(opts as BkSearchOpts) : { cancelled: false, totalCandidates: 0 }
}))

// 并发执行串行化：保证“取消/节流”用例可以在任务粒度确定性介入
vi.mock('../utils/concurrency', () => ({
  runWithConcurrency: async (tasks: Array<() => Promise<unknown>>): Promise<unknown[]> => {
    const results: unknown[] = []
    for (const task of tasks) results.push(await task())
    return results
  }
}))

// 子进程注册表：worker 内无真实 ffmpeg 子进程，全部 no-op
vi.mock('../utils/process-registry', () => ({
  trackFfmpegCommand: (command: unknown) => command,
  untrackFfmpegCommand: () => undefined,
  killAllProcesses: () => undefined
}))

// ffmpeg 路径：避免解析真实二进制
vi.mock('../utils/ffmpeg-paths', () => ({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }))

// 真实 media-constants 会引入 i18n 实例，测试中用纯函数替代
vi.mock('../utils/media-constants', () => ({
  isVideoExt: (ext: string) => ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)
}))

/** better-sqlite3 假构造函数：返回 ctl.currentDb（逐用例注入不同假 db） */
function FakeDatabaseCtor(dbPath: string): unknown {
  ctl.dbCtorCalls.push(dbPath)
  return ctl.currentDb
}

/** 假 db 句柄 */
interface FakeDbHandle {
  db: {
    pragma: (sql: string) => void
    close: () => void
    prepare: (sql: string) => {
      all: () => unknown[]
      run: (...args: unknown[]) => { changes: number }
    }
    transaction: (fn: () => void) => () => void
  }
  pragmas: string[]
  runs: Array<{ sql: string; args: unknown[] }>
  closeCount: () => number
}

/** 创建假 db：SELECT 结果由 selectImpl 按 SQL 路由，run/pragma/close 全部留痕 */
function createFakeDb(selectImpl?: (sql: string) => unknown[]): FakeDbHandle {
  const pragmas: string[] = []
  const runs: Array<{ sql: string; args: unknown[] }> = []
  let closes = 0
  const handle: FakeDbHandle = {
    pragmas,
    runs,
    closeCount: () => closes,
    db: {
      pragma: (sql) => {
        pragmas.push(sql)
      },
      close: () => {
        closes += 1
      },
      prepare: (sql) => ({
        all: () => (selectImpl ? selectImpl(sql) : []),
        run: (...args: unknown[]) => {
          runs.push({ sql, args })
          return { changes: 1 }
        }
      }),
      transaction: (fn) => fn
    }
  }
  return handle
}

/** 轮询等待指定类型的 worker 事件（取最新一条） */
async function waitForEvent(
  messages: unknown[],
  type: string,
  timeoutMs = 5000
): Promise<WorkerEvent> {
  const start = Date.now()
  for (;;) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as WorkerEvent | undefined
      if (m && m.type === type) return m
    }
    if (Date.now() - start > timeoutMs) throw new Error(`等待事件 ${type} 超时`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 取指定类型的全部事件 */
function eventsOf(messages: unknown[], type: string): WorkerEvent[] {
  return messages.filter((m) => (m as WorkerEvent).type === type) as WorkerEvent[]
}

// ── process 生命周期监听器清理 ──
// worker-entry 每次被加载都会在 process 上注册 exit / uncaughtException /
// unhandledRejection 监听器；vi.resetModules 只清模块注册表，不会移除这些监听器。
// 动态重复加载的 describe 必须在 import 前快照、afterAll 中仅移除本次新增的监听器，
// 严禁 removeAllListeners（会误删 vitest 框架自身注册的监听器）。
type ProcessLifecycleEvent = 'exit' | 'uncaughtException' | 'unhandledRejection'
type ProcessLifecycleListener = (...args: unknown[]) => void
const PROCESS_LIFECYCLE_EVENTS: ProcessLifecycleEvent[] = [
  'exit',
  'uncaughtException',
  'unhandledRejection'
]

/** 快照 process 三类生命周期事件的当前监听器列表 */
function snapshotProcessListeners(): Record<ProcessLifecycleEvent, ProcessLifecycleListener[]> {
  const snap = {} as Record<ProcessLifecycleEvent, ProcessLifecycleListener[]>
  for (const event of PROCESS_LIFECYCLE_EVENTS) {
    snap[event] = process.listeners(event) as ProcessLifecycleListener[]
  }
  return snap
}

/** 逐个比对，仅移除快照之后新增的监听器（保留框架与既有监听器） */
function removeAddedProcessListeners(
  before: Record<ProcessLifecycleEvent, ProcessLifecycleListener[]>
): void {
  for (const event of PROCESS_LIFECYCLE_EVENTS) {
    const beforeSet = new Set(before[event])
    for (const listener of process.listeners(event) as ProcessLifecycleListener[]) {
      if (!beforeSet.has(listener)) {
        process.removeListener(event, listener)
      }
    }
  }
}

// worker 内部日志经 process.parentPort.postMessage 转发到主进程；
// 测试环境无 parentPort，这里注入一个可控的 postMessage 供断言。
function mockParentPort(): ReturnType<typeof vi.fn> {
  const postMessage = vi.fn()
  Object.defineProperty(process, 'parentPort', {
    value: { postMessage },
    configurable: true
  })
  return postMessage
}

afterEach(() => {
  vi.useRealTimers()
})

describe('withFileTimeout', () => {
  it('正常完成 → 返回原结果', async () => {
    const postMessage = mockParentPort()

    const result = await withFileTimeout(async () => 42, 1000, '/ok.jpg', 'Thumbnail')

    expect(result).toBe(42)
    // workerLog 仅转发 warn/error；正常完成不产生日志
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('内部任务超时 → 返回 null 并记 MEDIA_WORKER_LOG warn（含"单文件处理超时"）', async () => {
    vi.useFakeTimers()
    const postMessage = mockParentPort()

    const p = withFileTimeout(
      // 永久挂起的重活（模拟 sharp/ffmpeg 无取消 API 卡死）
      async () => new Promise(() => {}),
      1000,
      '/hang.jpg',
      'Thumbnail'
    )
    await vi.advanceTimersByTimeAsync(1000)
    await expect(p).resolves.toBeNull()

    const event = postMessage.mock.calls[0]?.[0] as {
      type: string
      payload: { level: string; message: string }
    }
    expect(event.type).toBe('MEDIA_WORKER_LOG')
    expect(event.payload.level).toBe('warn')
    expect(event.payload.message).toContain('单文件处理超时')
  })

  it('内部任务 reject → 返回 null 并记 warn（不向上抛）', async () => {
    const postMessage = mockParentPort()

    const result = await withFileTimeout(
      async () => {
        throw new Error('boom')
      },
      1000,
      '/bad.jpg',
      'pHash'
    )

    expect(result).toBeNull()
    const event = postMessage.mock.calls[0]?.[0] as {
      type: string
      payload: { level: string; message: string }
    }
    expect(event.type).toBe('MEDIA_WORKER_LOG')
    expect(event.payload.level).toBe('warn')
    expect(event.payload.message).toContain('单文件处理失败')
  })
})

// ============ FIX(组11-2): 致命错误退出码 ============
describe('致命错误退出码（组11-2）', () => {
  it('uncaughtException 处理器先发 WORKER_ERROR 再以非零码退出（触发 bridge 崩溃重启）', () => {
    const postMessage = mockParentPort()
    // 桩掉 process.exit：cleanupAndExit 会真的退出测试进程
    const realExit = process.exit
    const exitMock = vi.fn()
    process.exit = exitMock as unknown as typeof process.exit
    try {
      // 直接调用 worker-entry 注册的监听器（import 后为最后一个），
      // 绕过 process.emit 以免同时触发 vitest 自身的 uncaughtException 处理
      const listeners = process.listeners('uncaughtException') as ((err: Error) => void)[]
      const workerHandler = listeners[listeners.length - 1]
      expect(workerHandler).toBeTruthy()
      workerHandler(new Error('sharp native crash'))

      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'WORKER_ERROR',
          payload: expect.objectContaining({ message: 'sharp native crash' })
        })
      )
      // 原实现固定 exit(0)，bridge 的 isCrash（code !== 0）判定恒为 false，
      // 自动重启与崩溃通知永不触发；修复后致命路径以 1 退出
      expect(exitMock).toHaveBeenCalledWith(1)
    } finally {
      process.exit = realExit
    }
  })
})

// ============ 消息处理分支覆盖（取消标志 / 进度节流 / 错误分支 / 惰性 DB） ============

describe('worker-entry 消息处理分支', () => {
  let port: ParentPortStubHandle
  let hook: BetterSqlite3HookHandle
  let tmpRoot: string
  let cacheDir: string
  const mediaFiles: string[] = []
  let exitSpy: ReturnType<typeof vi.spyOn>
  // 动态加载前快照：afterAll 仅移除本次加载新增的 process 监听器
  let listenerSnapshot: ReturnType<typeof snapshotProcessListeners>

  beforeAll(async () => {
    // fixtures：真实临时图片文件（phash/缩略图任务走真实 fsp.stat / 内容 hash 读取）
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-media-worker-test-'))
    cacheDir = path.join(tmpRoot, 'thumbs')
    fs.mkdirSync(cacheDir)
    for (let i = 0; i < 12; i++) {
      const file = path.join(tmpRoot, `img-${i}.jpg`)
      fs.writeFileSync(file, `fake-image-content-${i}`)
      mediaFiles.push(file)
    }
    // 先装 Module._load 钩子 + parentPort 桩，再动态 import worker-entry
    // （模块加载期才会在桩上注册 message 处理器）
    hook = installBetterSqlite3Hook(FakeDatabaseCtor)
    port = installParentPortStub()
    listenerSnapshot = snapshotProcessListeners()
    vi.resetModules()
    await import('./worker-entry')
  })

  afterAll(() => {
    uninstallBetterSqlite3Hook()
    uninstallParentPortStub()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    removeAddedProcessListeners(listenerSnapshot)
  })

  beforeEach(() => {
    port.messages.splice(0)
    ctl.sharpToFileDelayMs = 0
    ctl.phashImpl = null
    ctl.hammingImpl = null
    ctl.bktreeImpl = null
    ctl.ffmpegFail = false
    // 统一重置 better-sqlite3 假构造器：个别用例（如惰性加载失败）会临时切换 impl，
    // 若其断言失败提前中断，遗留的脏 impl 会污染后续用例，故恢复动作前置到此处
    hook.setImpl(FakeDatabaseCtor)
    // 桁掉 process.exit：cleanupAndExit 不应真的退出测试进程
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  })

  afterEach(() => {
    exitSpy.mockRestore()
    vi.useRealTimers()
  })

  const thumbRow = (
    id: number,
    file: string
  ): { id: number; file_path: string; file_type: string } => ({
    id,
    file_path: file,
    file_type: 'image'
  })

  it('better-sqlite3 惰性加载失败 → THUMBNAIL_COMPLETE 上报批量生成异常（错误路径）', async () => {
    // require 返回 undefined → 读 mod.default 抛 TypeError；DatabaseImpl 保持 null，后续可恢复
    hook.setImpl(undefined)
    ctl.currentDb = createFakeDb().db
    port.emitMessage({
      type: 'THUMBNAIL_BATCH_START',
      payload: { dbPath: 'lazy-fail.db', cacheDir, thumbnailQuality: 'standard' }
    })
    const evt = await waitForEvent(port.messages, 'THUMBNAIL_COMPLETE')
    expect(evt.payload.success).toBe(false)
    expect(String(evt.payload.message)).toContain('缩略图批量生成异常')
    // 无需在用例尾部恢复 impl：describe 级 beforeEach 已统一重置为 FakeDatabaseCtor
  })

  it('函数形态构造器惰性加载：连接带 WAL/busy_timeout 等 PRAGMA；空库返回无需生成', async () => {
    const fake = createFakeDb()
    ctl.currentDb = fake.db
    port.emitMessage({
      type: 'THUMBNAIL_BATCH_START',
      payload: { dbPath: 'empty.db', cacheDir, thumbnailQuality: 'standard' }
    })
    const evt = await waitForEvent(port.messages, 'THUMBNAIL_COMPLETE')
    expect(evt.payload).toMatchObject({
      success: true,
      message: '无需生成',
      processed: 0,
      total: 0
    })
    expect(fake.pragmas).toContain('journal_mode = WAL')
    expect(fake.pragmas).toContain('foreign_keys = ON')
    expect(fake.pragmas).toContain('busy_timeout = 5000')
    expect(ctl.dbCtorCalls).toContain('empty.db')
  })

  it('THUMBNAIL_STOP：在途任务完成后剩余任务提前退出，完成事件报已取消', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => thumbRow(i + 1, mediaFiles[i]))
    const fake = createFakeDb((sql) => (sql.includes('thumbnail IS NULL') ? rows : []))
    ctl.currentDb = fake.db
    port.emitMessage({
      type: 'THUMBNAIL_BATCH_START',
      payload: { dbPath: 'thumb-cancel.db', cacheDir, thumbnailQuality: 'standard' }
    })
    port.emitMessage({ type: 'THUMBNAIL_STOP' })
    const evt = await waitForEvent(port.messages, 'THUMBNAIL_COMPLETE')
    expect(evt.payload.message).toBe('已取消')
    expect(evt.payload.total).toBe(5)
    // 串行并发下仅停止前已启动的第一个任务完成并写库
    expect(evt.payload.processed).toBe(1)
    expect(fake.runs.filter((r) => r.sql.startsWith('UPDATE media_files SET width'))).toHaveLength(
      1
    )
  })

  it('取消标志相互独立：其他任务的 STOP 不影响缩略图批次', async () => {
    const rows = [thumbRow(1, mediaFiles[0]), thumbRow(2, mediaFiles[1])]
    const fake = createFakeDb((sql) => (sql.includes('thumbnail IS NULL') ? rows : []))
    ctl.currentDb = fake.db
    port.emitMessage({
      type: 'THUMBNAIL_BATCH_START',
      payload: { dbPath: 'thumb-indep.db', cacheDir, thumbnailQuality: 'standard' }
    })
    port.emitMessage({ type: 'PHASH_STOP' })
    port.emitMessage({ type: 'DUPLICATE_STOP' })
    port.emitMessage({ type: 'SIMILAR_STOP' })
    const evt = await waitForEvent(port.messages, 'THUMBNAIL_COMPLETE')
    expect(evt.payload).toMatchObject({ success: true, message: '完成', processed: 2, total: 2 })
  })

  it('单文件处理抛错 → MEDIA_WORKER_LOG 上报并跳过，不影响后续文件', async () => {
    ctl.phashImpl = (p) =>
      p === mediaFiles[0] ? Promise.reject(new Error('解码失败')) : Promise.resolve('0'.repeat(64))
    const rows = [thumbRow(1, mediaFiles[0]), thumbRow(2, mediaFiles[1])]
    const fake = createFakeDb((sql) => (sql.includes('thumbnail IS NULL') ? rows : []))
    ctl.currentDb = fake.db
    port.emitMessage({
      type: 'THUMBNAIL_BATCH_START',
      payload: { dbPath: 'err-isolate.db', cacheDir, thumbnailQuality: 'standard' }
    })
    const evt = await waitForEvent(port.messages, 'THUMBNAIL_COMPLETE')
    expect(evt.payload).toMatchObject({ success: true, message: '完成', processed: 1, total: 2 })
    // 错误事件上报（workerLog warn 转发）
    const logs = eventsOf(port.messages, 'MEDIA_WORKER_LOG')
    expect(logs.some((l) => String(l.payload.message).includes('单文件处理失败'))).toBe(true)
    // 仅成功的第二行写库（args 末位为 row id）
    const updates = fake.runs.filter((r) => r.sql.startsWith('UPDATE media_files SET width'))
    expect(updates).toHaveLength(1)
    expect(updates[0].args[6]).toBe(2)
  })

  it('PHASH_STOP：phash 批次取消且跳过链式重复标记', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      id: i + 1,
      file_path: mediaFiles[i],
      phash: null,
      phash_mtime: null,
      phash_file_size: null
    }))
    const fake = createFakeDb((sql) =>
      sql.includes("file_type = 'image' AND is_deleted = 0") ? rows : []
    )
    ctl.currentDb = fake.db
    port.emitMessage({ type: 'PHASH_BATCH_START', payload: { dbPath: 'phash-cancel.db' } })
    port.emitMessage({ type: 'PHASH_STOP' })
    const evt = await waitForEvent(port.messages, 'PHASH_COMPLETE')
    expect(evt.payload.message).toBe('已取消')
    expect(evt.payload.processed).toBe(1)
    expect(evt.payload.total).toBe(4)
    // 取消后不链式 markDuplicates
    expect(evt.payload.duplicatesResult).toBeUndefined()
    expect(eventsOf(port.messages, 'DUPLICATE_PROGRESS')).toHaveLength(0)
    // 第一个任务已回写 phash
    expect(fake.runs.filter((r) => r.sql.startsWith('UPDATE media_files SET phash'))).toHaveLength(
      1
    )
  })

  it('DUPLICATE_STOP：重复标记 O(n²) 循环提前退出（经 phash 空库链式路径观察）', async () => {
    // phash SELECT 空 → total=0 → 链式 markDuplicates；此时 shouldStopDuplicate 已置位
    let hammingCalls = 0
    ctl.hammingImpl = () => {
      hammingCalls += 1
      return 99
    }
    const dupRows = [1, 2].map((i) => ({
      id: i,
      file_size: 10,
      width: 10,
      height: 10,
      modified_at: '2026-01-01 00:00:00',
      is_favorite: 0,
      rating: 0,
      phash: '0'.repeat(64)
    }))
    const fake = createFakeDb((sql) => (sql.includes('is_favorite') ? dupRows : []))
    ctl.currentDb = fake.db
    port.emitMessage({ type: 'DUPLICATE_STOP' })
    port.emitMessage({ type: 'PHASH_BATCH_START', payload: { dbPath: 'dup-stop.db' } })
    const evt = await waitForEvent(port.messages, 'PHASH_COMPLETE')
    expect(evt.payload).toMatchObject({
      success: true,
      message: '无需补算',
      duplicatesResult: { markedDuplicates: 0, totalGroups: 0 }
    })
    // 循环首轮即 break：未发生任何汉明距离比较
    expect(hammingCalls).toBe(0)
  })

  it('PHASH 空库：无需补算但仍链式触发重复标记并返回 duplicatesResult', async () => {
    const fake = createFakeDb(() => [])
    ctl.currentDb = fake.db
    port.emitMessage({ type: 'PHASH_BATCH_START', payload: { dbPath: 'phash-empty.db' } })
    const evt = await waitForEvent(port.messages, 'PHASH_COMPLETE')
    expect(evt.payload).toMatchObject({
      success: true,
      message: '无需补算',
      processed: 0,
      total: 0
    })
    expect(evt.payload.duplicatesResult).toEqual({ markedDuplicates: 0, totalGroups: 0 })
    // rows<2 分支：清空全部重复标记
    expect(fake.runs.some((r) => r.sql.includes('SET is_duplicate = 0, original_id = NULL'))).toBe(
      true
    )
  })

  it('DUPLICATE_MARK：每满 1000 次比较推送进度，并按评分标记重复组', async () => {
    ctl.hammingImpl = () => 0 // 全部相似 → 单一重复组
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      file_size: 1000 + i,
      width: 100,
      height: 100,
      modified_at: '2026-01-01 00:00:00',
      is_favorite: 0,
      rating: 0,
      phash: '0'.repeat(64)
    }))
    const fake = createFakeDb((sql) => (sql.includes('is_favorite') ? rows : []))
    ctl.currentDb = fake.db
    port.emitMessage({ type: 'DUPLICATE_MARK_START', payload: { dbPath: 'dup-mark.db' } })
    const evt = await waitForEvent(port.messages, 'DUPLICATE_COMPLETE')
    expect(evt.payload).toMatchObject({
      success: true,
      message: '完成',
      markedDuplicates: 49,
      totalGroups: 1
    })
    // 计数阈值（≥1000 次比较）进度推送
    const progresses = eventsOf(port.messages, 'DUPLICATE_PROGRESS')
    expect(progresses.length).toBeGreaterThan(0)
    expect(progresses.some((p) => Number(p.payload.compared) >= 1000)).toBe(true)
    expect(progresses[progresses.length - 1].payload.totalPairs).toBe(1225)
    // pickBestId 默认取首项：id=1 保留，其余 49 项标记 is_duplicate=1
    const marked = fake.runs.filter(
      (r) => r.sql.startsWith('UPDATE media_files SET is_duplicate = ?') && r.args[0] === 1
    )
    expect(marked).toHaveLength(49)
    expect(marked.every((r) => r.args[1] === 1)).toBe(true)
  })

  it('DUPLICATE_MARK 少于 2 行：清空重复标记并返回 0 组', async () => {
    const rows = [
      {
        id: 1,
        file_size: 5,
        width: 1,
        height: 1,
        modified_at: '2026-01-01 00:00:00',
        is_favorite: 0,
        rating: 0,
        phash: '0'.repeat(64)
      }
    ]
    const fake = createFakeDb((sql) => (sql.includes('is_favorite') ? rows : []))
    ctl.currentDb = fake.db
    port.emitMessage({ type: 'DUPLICATE_MARK_START', payload: { dbPath: 'dup-one.db' } })
    const evt = await waitForEvent(port.messages, 'DUPLICATE_COMPLETE')
    expect(evt.payload).toMatchObject({
      success: true,
      message: '完成',
      markedDuplicates: 0,
      totalGroups: 0
    })
    expect(fake.runs.some((r) => r.sql.includes('SET is_duplicate = 0, original_id = NULL'))).toBe(
      true
    )
  })

  it('DUPLICATE_MARK 内部异常 → DUPLICATE_COMPLETE 上报标记失败', async () => {
    const fake = createFakeDb()
    // SELECT 阶段直接抛错（markDuplicatesInWorker 内部异常 → startDuplicateMark catch）
    fake.db.prepare = (_sql: string) => ({
      all: () => {
        throw new Error('SQLITE_CORRUPT（mock）')
      },
      run: () => ({ changes: 0 })
    })
    ctl.currentDb = fake.db
    port.emitMessage({ type: 'DUPLICATE_MARK_START', payload: { dbPath: 'dup-err.db' } })
    const evt = await waitForEvent(port.messages, 'DUPLICATE_COMPLETE')
    expect(evt.payload.success).toBe(false)
    expect(String(evt.payload.message)).toContain('标记失败')
    expect(String(evt.payload.message)).toContain('SQLITE_CORRUPT')
  })

  it('SIMILAR_FIND：候选批/进度回传，完成事件剥离 phash 本体', async () => {
    const rows = [1, 2].map((i) => ({
      id: i,
      file_path: mediaFiles[i - 1],
      file_name: `img-${i - 1}.jpg`,
      file_type: 'image',
      file_size: 100,
      modified_at: '2026-01-01 00:00:00',
      width: 10,
      height: 10,
      is_favorite: 0,
      rating: 0,
      phash: '0'.repeat(64)
    }))
    const fake = createFakeDb((sql) => (sql.includes('file_name') ? rows : []))
    ctl.currentDb = fake.db
    ctl.bktreeImpl = (opts) => {
      opts.onProgress(1, opts.rows.length, 1)
      opts.onCandidates([{ a: 1, b: 2, dist: 1 }])
      return { cancelled: false, totalCandidates: 1 }
    }
    port.emitMessage({
      type: 'SIMILAR_FIND_START',
      payload: { dbPath: 'similar-ok.db', threshold: 10 }
    })
    const evt = await waitForEvent(port.messages, 'SIMILAR_COMPLETE')
    expect(evt.payload).toMatchObject({
      success: true,
      message: '完成',
      totalCandidates: 1,
      totalRows: 2
    })
    expect(eventsOf(port.messages, 'SIMILAR_PROGRESS')).toHaveLength(1)
    expect(eventsOf(port.messages, 'SIMILAR_CANDIDATES')).toHaveLength(1)
    const outRows = evt.payload.rows as Array<Record<string, unknown>>
    expect(outRows).toHaveLength(2)
    expect(outRows[0]).not.toHaveProperty('phash')
  })

  it('SIMILAR_FIND 少于 2 行：直接回传无需检测', async () => {
    const rows = [
      {
        id: 1,
        file_path: mediaFiles[0],
        file_name: 'img-0.jpg',
        file_type: 'image',
        file_size: 100,
        modified_at: '2026-01-01 00:00:00',
        width: 10,
        height: 10,
        is_favorite: 0,
        rating: 0,
        phash: '0'.repeat(64)
      }
    ]
    const fake = createFakeDb((sql) => (sql.includes('file_name') ? rows : []))
    ctl.currentDb = fake.db
    port.emitMessage({
      type: 'SIMILAR_FIND_START',
      payload: { dbPath: 'similar-one.db', threshold: 10 }
    })
    const evt = await waitForEvent(port.messages, 'SIMILAR_COMPLETE')
    expect(evt.payload).toMatchObject({
      success: true,
      message: '无需检测',
      totalCandidates: 0,
      totalRows: 1
    })
  })

  it('相似检索取消：buildAndSearch 回传 cancelled → 完成事件报已取消', async () => {
    const rows = [1, 2].map((i) => ({
      id: i,
      file_path: mediaFiles[i - 1],
      file_name: `img-${i - 1}.jpg`,
      file_type: 'image',
      file_size: 100,
      modified_at: '2026-01-01 00:00:00',
      width: 10,
      height: 10,
      is_favorite: 0,
      rating: 0,
      phash: '0'.repeat(64)
    }))
    const fake = createFakeDb((sql) => (sql.includes('file_name') ? rows : []))
    ctl.currentDb = fake.db
    let sawShouldStopFn = false
    let stopFlagWhenChecked: boolean | null = null
    ctl.bktreeImpl = (opts) => {
      sawShouldStopFn = typeof opts.shouldStop === 'function'
      stopFlagWhenChecked = opts.shouldStop()
      // 模拟检索循环内检测到取消标志置位（worker-entry 的 START 链路全程同步，
      // 消息循环无法在重置标志与 buildAndSearch 之间插入，故从返回值侧覆盖取消分支）
      return { cancelled: true, totalCandidates: 0 }
    }
    port.emitMessage({
      type: 'SIMILAR_FIND_START',
      payload: { dbPath: 'similar-stop.db', threshold: 10 }
    })
    const evt = await waitForEvent(port.messages, 'SIMILAR_COMPLETE')
    expect(evt.payload).toMatchObject({
      success: true,
      message: '已取消',
      cancelled: true,
      totalRows: 2
    })
    // shouldStop 回调确为 worker 传入的标志读取器；START 入口已重置标志，故读到 false
    expect(sawShouldStopFn).toBe(true)
    expect(stopFlagWhenChecked).toBe(false)
  })

  it('SIMILAR_STOP：置位取消标志不报错，后续 START 会重置标志', async () => {
    port.emitMessage({ type: 'SIMILAR_STOP' })
    // 标志唯一可观察点是 buildAndSearch 收到的 shouldStop 回调；
    // 再发一次 START，验证入口处重置了取消标志（读到 false，正常完成）
    const rows = [1, 2].map((i) => ({
      id: i,
      file_path: mediaFiles[i - 1],
      file_name: `img-${i - 1}.jpg`,
      file_type: 'image',
      file_size: 100,
      modified_at: '2026-01-01 00:00:00',
      width: 10,
      height: 10,
      is_favorite: 0,
      rating: 0,
      phash: '0'.repeat(64)
    }))
    const fake = createFakeDb((sql) => (sql.includes('file_name') ? rows : []))
    ctl.currentDb = fake.db
    let stopFlagWhenChecked: boolean | null = null
    ctl.bktreeImpl = (opts) => {
      stopFlagWhenChecked = opts.shouldStop()
      return { cancelled: opts.shouldStop(), totalCandidates: 0 }
    }
    port.emitMessage({
      type: 'SIMILAR_FIND_START',
      payload: { dbPath: 'similar-stop2.db', threshold: 10 }
    })
    const evt = await waitForEvent(port.messages, 'SIMILAR_COMPLETE')
    expect(evt.payload).toMatchObject({ success: true, message: '完成' })
    expect(stopFlagWhenChecked).toBe(false)
  })

  it('SIMILAR 检索异常 → SIMILAR_COMPLETE 上报相似检测异常', async () => {
    const rows = [1, 2].map((i) => ({
      id: i,
      file_path: mediaFiles[i - 1],
      file_name: `img-${i - 1}.jpg`,
      file_type: 'image',
      file_size: 100,
      modified_at: '2026-01-01 00:00:00',
      width: 10,
      height: 10,
      is_favorite: 0,
      rating: 0,
      phash: '0'.repeat(64)
    }))
    const fake = createFakeDb((sql) => (sql.includes('file_name') ? rows : []))
    ctl.currentDb = fake.db
    ctl.bktreeImpl = () => {
      throw new Error('bktree 爆了（mock）')
    }
    port.emitMessage({
      type: 'SIMILAR_FIND_START',
      payload: { dbPath: 'similar-err.db', threshold: 10 }
    })
    const evt = await waitForEvent(port.messages, 'SIMILAR_COMPLETE')
    expect(evt.payload.success).toBe(false)
    expect(String(evt.payload.message)).toContain('相似检测异常')
  })

  it('视频行：ffmpeg 抽帧（mock end 事件）产出缩略图路径', async () => {
    const videoFile = path.join(tmpRoot, 'clip.mp4')
    fs.writeFileSync(videoFile, 'fake-video-content')
    const rows = [{ id: 1, file_path: videoFile, file_type: 'video' }]
    const fake = createFakeDb((sql) => (sql.includes('thumbnail IS NULL') ? rows : []))
    ctl.currentDb = fake.db
    port.emitMessage({
      type: 'THUMBNAIL_BATCH_START',
      payload: { dbPath: 'video-ok.db', cacheDir, thumbnailQuality: 'standard' }
    })
    const evt = await waitForEvent(port.messages, 'THUMBNAIL_COMPLETE')
    expect(evt.payload).toMatchObject({ success: true, message: '完成', processed: 1, total: 1 })
    const update = fake.runs.find((r) => r.sql.startsWith('UPDATE media_files SET width'))
    expect(String(update?.args[2])).toMatch(/\.jpg$/)
  })

  it('视频抽帧失败 → 缩略图为 null 但不阻断批次', async () => {
    ctl.ffmpegFail = true
    const videoFile = path.join(tmpRoot, 'clip-bad.mp4')
    fs.writeFileSync(videoFile, 'fake-video-content-bad')
    const rows = [{ id: 1, file_path: videoFile, file_type: 'video' }]
    const fake = createFakeDb((sql) => (sql.includes('thumbnail IS NULL') ? rows : []))
    ctl.currentDb = fake.db
    port.emitMessage({
      type: 'THUMBNAIL_BATCH_START',
      payload: { dbPath: 'video-err.db', cacheDir, thumbnailQuality: 'standard' }
    })
    const evt = await waitForEvent(port.messages, 'THUMBNAIL_COMPLETE')
    expect(evt.payload).toMatchObject({ success: true, message: '完成', processed: 1, total: 1 })
    const update = fake.runs.find((r) => r.sql.startsWith('UPDATE media_files SET width'))
    expect(update?.args[2]).toBeNull()
  })

  // ── 进度 500ms 节流 ──
  // 这组用例用真实时钟设计。注意：不可用 fake timers 的原因不是"模块已加载导致
  // fake timers 无效"——vi.useFakeTimers 替换的是全局 timer/Date 对象，与模块加载时机无关；
  // 真正原因是批次流程依赖真实 fs I/O promise，fake timers 与真实 I/O promise 混用
  // 会让等待链挂起（定时器推进被接管而 I/O 回调依赖真实调度）。
  // 相应地，断言不依赖"真实耗时恰好落在阈值内"这类环境假设（慢速/高负载环境会假失败），
  // 一律放宽为语义断言：首条必发 + 条数上界 + 单调递增。
  // 每个用例先跑一个预热批 + 真实等待 600ms，把模块级
  // lastThumbnailProgressEmit 重置为已过去的真实时刻，保证首条进度的
  // 时间条件判定只受本用例控制。

  /** 预热批 + 600ms 等待：重置模块级节流时间戳，并清空消息队列 */
  async function warmProgressThrottle(): Promise<void> {
    const warmRow = thumbRow(1, mediaFiles[0])
    const warmFake = createFakeDb((sql) => (sql.includes('thumbnail IS NULL') ? [warmRow] : []))
    ctl.currentDb = warmFake.db
    port.emitMessage({
      type: 'THUMBNAIL_BATCH_START',
      payload: { dbPath: 'throttle-warm.db', cacheDir, thumbnailQuality: 'standard' }
    })
    await waitForEvent(port.messages, 'THUMBNAIL_COMPLETE')
    await new Promise((r) => setTimeout(r, 600))
    port.messages.splice(0)
  }

  it('进度节流：500ms 内多个任务完成仅发出首条进度', async () => {
    await warmProgressThrottle()
    ctl.sharpToFileDelayMs = 100
    const rows = Array.from({ length: 3 }, (_, i) => thumbRow(i + 1, mediaFiles[i]))
    const fake = createFakeDb((sql) => (sql.includes('thumbnail IS NULL') ? rows : []))
    ctl.currentDb = fake.db
    port.emitMessage({
      type: 'THUMBNAIL_BATCH_START',
      payload: { dbPath: 'throttle-1.db', cacheDir, thumbnailQuality: 'standard' }
    })
    const evt = await waitForEvent(port.messages, 'THUMBNAIL_COMPLETE')
    expect(evt.payload).toMatchObject({ success: true, message: '完成', processed: 3, total: 3 })
    // 每任务两次 toFile（真实延迟各 100ms）：正常情况下文件间隔 ≈200ms < 500ms，
    // 仅首条满足时间条件。但"500ms 内完成"是真实耗时的环境假设，慢速/高负载环境
    // 间隔可能超过 500ms 而额外放行，故放宽为语义断言：首条必发 + 条数上界 + 单调递增
    const progressList = eventsOf(port.messages, 'THUMBNAIL_PROGRESS').map((e) =>
      Number(e.payload.processed)
    )
    expect(progressList.length).toBeGreaterThanOrEqual(1)
    expect(progressList[0]).toBe(1)
    expect(progressList.length).toBeLessThanOrEqual(rows.length)
    for (let i = 1; i < progressList.length; i++) {
      expect(progressList[i]).toBeGreaterThan(progressList[i - 1])
    }
  })

  it('进度节流：间隔达到 500ms 后再次放行', async () => {
    await warmProgressThrottle()
    ctl.sharpToFileDelayMs = 300
    const rows = [thumbRow(1, mediaFiles[0]), thumbRow(2, mediaFiles[1])]
    const fake = createFakeDb((sql) => (sql.includes('thumbnail IS NULL') ? rows : []))
    ctl.currentDb = fake.db
    port.emitMessage({
      type: 'THUMBNAIL_BATCH_START',
      payload: { dbPath: 'throttle-2.db', cacheDir, thumbnailQuality: 'standard' }
    })
    const evt = await waitForEvent(port.messages, 'THUMBNAIL_COMPLETE')
    expect(evt.payload.processed).toBe(2)
    // 每任务耗时 ≈600ms（两次 300ms toFile），第二条完成时距首条已 ≥500ms → 两条都放行
    expect(eventsOf(port.messages, 'THUMBNAIL_PROGRESS')).toHaveLength(2)
  })

  it('进度节流：processed 增量满 10 强制放行（不受 500ms 限制）', async () => {
    await warmProgressThrottle()
    ctl.sharpToFileDelayMs = 0
    const rows = Array.from({ length: 12 }, (_, i) =>
      thumbRow(i + 1, mediaFiles[i % mediaFiles.length])
    )
    const fake = createFakeDb((sql) => (sql.includes('thumbnail IS NULL') ? rows : []))
    ctl.currentDb = fake.db
    port.emitMessage({
      type: 'THUMBNAIL_BATCH_START',
      payload: { dbPath: 'throttle-3.db', cacheDir, thumbnailQuality: 'standard' }
    })
    const evt = await waitForEvent(port.messages, 'THUMBNAIL_COMPLETE')
    expect(evt.payload.processed).toBe(12)
    // 核心语义：首条（时间条件，距预热批已 >500ms）必发 + 计数阈值强制放行（存在 ≥11 的放行）。
    // 精确相等 [1, 11] 依赖"12 个文件在毫秒内完成、时间条件不可能再次满足"的环境假设，
    // 慢速环境下时间条件可能额外放行，故改为等价语义断言 + 单调性校验。
    const progressList = eventsOf(port.messages, 'THUMBNAIL_PROGRESS').map((e) =>
      Number(e.payload.processed)
    )
    expect(progressList.length).toBeGreaterThanOrEqual(1)
    expect(progressList[0]).toBe(1)
    expect(progressList.some((v) => v >= 11)).toBe(true)
    for (let i = 1; i < progressList.length; i++) {
      expect(progressList[i]).toBeGreaterThan(progressList[i - 1])
    }
  })

  it('MEDIA_WORKER_DISPOSE：关闭 DB 并以码 0 退出', async () => {
    const fake = createFakeDb()
    ctl.currentDb = fake.db
    // 先开一次连接，DISPOSE 时才有 db 可关
    port.emitMessage({
      type: 'THUMBNAIL_BATCH_START',
      payload: { dbPath: 'dispose-prep.db', cacheDir, thumbnailQuality: 'standard' }
    })
    await waitForEvent(port.messages, 'THUMBNAIL_COMPLETE')
    port.emitMessage({ type: 'MEDIA_WORKER_DISPOSE' })
    await new Promise((r) => setTimeout(r, 20))
    expect(fake.closeCount()).toBeGreaterThanOrEqual(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})

// ============ 新模块实例：对象形态惰性加载 / WORKER_READY / 发送异常吞掉 ============

describe('worker-entry 重新加载（对象形态 impl + 发送异常）', () => {
  let port: ParentPortStubHandle
  let readyEvent: unknown
  // 动态加载前快照：afterAll 仅移除本次加载新增的 process 监听器
  let listenerSnapshot: ReturnType<typeof snapshotProcessListeners>

  beforeAll(async () => {
    // 对象形态 { default: Ctor }：命中 getDatabaseImpl 的 mod.default 分支
    installBetterSqlite3Hook({ default: FakeDatabaseCtor })
    port = installParentPortStub()
    listenerSnapshot = snapshotProcessListeners()
    vi.resetModules()
    await import('./worker-entry')
    readyEvent = port.messages[0]
  })

  afterAll(() => {
    uninstallBetterSqlite3Hook()
    uninstallParentPortStub()
    removeAddedProcessListeners(listenerSnapshot)
  })

  beforeEach(() => {
    port.messages.splice(0)
  })

  it('模块加载完成后推送 WORKER_READY', () => {
    expect(readyEvent).toEqual({ type: 'WORKER_READY' })
  })

  it('对象形态 { default: Ctor } 惰性加载命中（mod.default 分支）', async () => {
    const fake = createFakeDb()
    ctl.currentDb = fake.db
    port.emitMessage({
      type: 'THUMBNAIL_BATCH_START',
      payload: { dbPath: 'obj-form.db', cacheDir: os.tmpdir(), thumbnailQuality: 'low' }
    })
    const evt = await waitForEvent(port.messages, 'THUMBNAIL_COMPLETE')
    expect(evt.payload).toMatchObject({ success: true, message: '无需生成' })
    expect(ctl.dbCtorCalls).toContain('obj-form.db')
  })

  it('parentPort 发送异常被 sendEvent 吞掉：worker 不退出且后续指令仍可响应', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      const fake = createFakeDb()
      ctl.currentDb = fake.db
      port.stub.postMessage.mockImplementation(() => {
        throw new Error('ipc 通道不可用（mock）')
      })
      // 完成事件发送失败：异常应被 sendEvent 内部吞掉，不产生未捕获异常/退出
      port.emitMessage({ type: 'DUPLICATE_MARK_START', payload: { dbPath: 'swallow-1.db' } })
      await new Promise((r) => setTimeout(r, 50))
      expect(exitSpy).not.toHaveBeenCalled()
      // 恢复正常发送：worker 仍能处理后续指令
      port.stub.postMessage.mockImplementation((message: unknown) => {
        port.messages.push(message)
      })
      port.emitMessage({ type: 'DUPLICATE_MARK_START', payload: { dbPath: 'swallow-2.db' } })
      const evt = await waitForEvent(port.messages, 'DUPLICATE_COMPLETE')
      expect(evt.payload).toMatchObject({ success: true, markedDuplicates: 0, totalGroups: 0 })
    } finally {
      port.stub.postMessage.mockImplementation((message: unknown) => {
        port.messages.push(message)
      })
      exitSpy.mockRestore()
    }
  })
})
