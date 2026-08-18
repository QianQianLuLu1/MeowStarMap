/**
 * FIX(组3-2/3-3/3-4) 回归测试：worker-entry 缺失计数归零 / 致命异常补发终态 / 修复链失败中止。
 *
 * 驱动方式与 scan-batch-write-failure.test.ts 相同：parentPort 桩 + Module._load 定向替换
 * better-sqlite3（vite-node 注入的原生 require 不经 vi.mock 注册表，且本机 native 模块为
 * Electron ABI 在 Node 下无法加载）。
 *
 * 组3-4 的断言策略：走真实 repairLegacyDataV1-V4（vi.mock 无法拦截 worker-entry 内部
 * import 的依赖），通过 fake db 的可控行为驱动——
 * - 迁移标记查询 get() 返回 undefined（未应用）→ 各步骤真实执行；
 * - .all() 可选抛错 → 让 V1 的清理查询失败（内部 catch → 返回 false）；
 * - run() 捕获 schema_migrations 标记写入的参数 → 观测 V3/V4 是否执行。
 *
 * 运行：npx vitest run src/main/scanner/__tests__/scan-worker-recovery.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { promises as fsp } from 'fs'
import os from 'os'
import path from 'path'
import Module from 'node:module'

// better-sqlite3 假实现：构造函数返回可替换的共享实例
const dbh = vi.hoisted(() => {
  const state: { instance: unknown } = { instance: null }
  const Ctor = function () {
    return state.instance
  }
  return { state, Ctor }
})

let fixtureRoot: string
let cleanupRoot: string

// 捕获 media_files INSERT 语句文本（组3-2 断言 ON CONFLICT 更新列表）
const capturedSql: string[] = []
// 捕获 schema_migrations 标记写入（组3-4 观测 V1-V4 执行情况）
const markerInserts: string[] = []

let messageHandler: ((event: { data: unknown }) => void) | undefined
const postMessageMock = vi.fn()

type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown
const moduleWithLoad = Module as unknown as { _load: ModuleLoad }
const originalLoad: ModuleLoad = moduleWithLoad._load

function isBetterSqliteRequest(request: string): boolean {
  return (
    request === 'better-sqlite3' ||
    request.replace(/\\/g, '/').endsWith('better-sqlite3/lib/index.js')
  )
}

/**
 * 可控行为的 fake db。
 * @param opts.allThrows 所有 .all() 抛错（让 V1 的清理查询失败 → V1 返回 false）
 */
function createFakeDb(opts: { allThrows?: boolean } = {}): unknown {
  return {
    pragma: () => undefined,
    close: () => undefined,
    prepare: (sql: string) => {
      capturedSql.push(sql)
      return {
        run: (...args: unknown[]) => {
          if (sql.includes('INSERT OR IGNORE INTO schema_migrations')) {
            markerInserts.push(String(args[0]))
          }
          return { changes: 1, lastInsertRowid: 1 }
        },
        // 迁移标记一律"未应用"；COUNT 聚合返回 0，其余查询返回 undefined
        get: (...args: unknown[]) => {
          if (sql.includes('COUNT(*)')) return { count: 0 }
          if (sql.includes('schema_migrations') && args[0]) return undefined
          return undefined
        },
        all: () => {
          if (opts.allThrows)
            throw new Error('SQLITE_BUSY: database is locked（模拟 V1 清理查询失败）')
          return []
        }
      }
    },
    transaction: (fn: (...args: unknown[]) => unknown) => fn
  }
}

async function waitForScanComplete(
  timeoutMs = 5000
): Promise<{ success: boolean; message: string }> {
  const start = Date.now()
  for (;;) {
    const event = postMessageMock.mock.calls
      .map((c) => c[0])
      .find((e) => e?.type === 'SCAN_COMPLETE')
    if (event) return event.payload
    if (Date.now() - start > timeoutMs) throw new Error('SCAN_COMPLETE 未在超时内到达')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function sendScanStart(dbPath: string, options: { path: string }): void {
  if (!messageHandler) throw new Error('parentPort message handler 未注册')
  messageHandler({ data: { type: 'SCAN_START', payload: { dbPath, options } } })
}

beforeAll(async () => {
  moduleWithLoad._load = function (request, parent, isMain) {
    if (typeof request === 'string' && isBetterSqliteRequest(request)) {
      return { default: dbh.Ctor }
    }
    return originalLoad(request, parent, isMain)
  }

  ;(process as { parentPort?: unknown }).parentPort = {
    on: (_type: string, cb: (event: { data: unknown }) => void) => {
      messageHandler = cb
    },
    postMessage: postMessageMock
  }

  cleanupRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'nikki-scan-recovery-'))
  fixtureRoot = path.join(cleanupRoot, 'album')
  await fsp.mkdir(fixtureRoot, { recursive: true })
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  await fsp.writeFile(
    path.join(fixtureRoot, 'photo1.jpg'),
    Buffer.concat([jpegHeader, Buffer.alloc(8 * 1024)])
  )
  await fsp.writeFile(
    path.join(fixtureRoot, 'photo2.jpg'),
    Buffer.concat([jpegHeader, Buffer.alloc(6 * 1024)])
  )

  await import('../worker-entry')
})

afterAll(async () => {
  moduleWithLoad._load = originalLoad
  delete (process as { parentPort?: unknown }).parentPort
  await fsp.rm(cleanupRoot, { recursive: true, force: true }).catch(() => {})
})

describe('组3-2：ON CONFLICT 归零缺失计数', () => {
  it('media_files 的 INSERT ON CONFLICT 更新列表应包含 missing_count = 0 与 is_missing = 0', async () => {
    postMessageMock.mockClear()
    capturedSql.length = 0
    dbh.state.instance = createFakeDb()
    sendScanStart('fake-conflict-reset.db', { path: fixtureRoot })

    const payload = await waitForScanComplete()
    expect(payload.success).toBe(true)
    const insertSql = capturedSql.find((s) => s.includes('INSERT INTO media_files'))
    expect(insertSql).toBeTruthy()
    expect(insertSql).toMatch(/missing_count = 0/)
    expect(insertSql).toMatch(/is_missing = 0/)
  })
})

describe('组3-3：致命异常补发失败终态', () => {
  it('扫描中 uncaughtException 应先发 SCAN_COMPLETE(失败) 再退出，且携带真实错误消息', async () => {
    postMessageMock.mockClear()
    dbh.state.instance = createFakeDb()
    // 桩掉 process.exit：cleanupAndExit 会真的退出测试进程
    const realExit = process.exit
    const exitMock = vi.fn()
    process.exit = exitMock as unknown as typeof process.exit
    try {
      sendScanStart('fake-crash.db', { path: fixtureRoot })
      // startScan 同步首段已置 progress.status='running'，可直接触发异常处理器。
      // 直接调用 worker-entry 注册的监听器（import 后为最后一个），绕过 process.emit
      // 以免同时触发 vitest worker 自身的 uncaughtException 处理。
      const listeners = process.listeners('uncaughtException') as ((err: Error) => void)[]
      const workerHandler = listeners[listeners.length - 1]
      expect(workerHandler).toBeTruthy()
      workerHandler(new Error('native boom'))

      await new Promise((r) => setTimeout(r, 50))
      const events = postMessageMock.mock.calls.map((c) => c[0])
      const crashComplete = events.find(
        (e) =>
          e?.type === 'SCAN_COMPLETE' &&
          String(e.payload?.message ?? '').includes('扫描进程异常退出')
      )
      expect(crashComplete).toBeTruthy()
      expect(crashComplete.payload.success).toBe(false)
      expect(crashComplete.payload.message).toContain('native boom')
      expect(events.some((e) => e?.type === 'WORKER_ERROR')).toBe(true)
      expect(exitMock).toHaveBeenCalledWith(0)
    } finally {
      process.exit = realExit
      // drain：exit 被桩掉后扫描会继续跑完（真实场景进程已退出），等待其结束避免跨用例泄漏
      await new Promise((r) => setTimeout(r, 100))
    }
  })
})

describe('组3-4：修复链失败中止', () => {
  it('V1 清理查询失败时，V2/V3/V4 不应执行（无后续迁移标记写入）', async () => {
    postMessageMock.mockClear()
    markerInserts.length = 0
    dbh.state.instance = createFakeDb({ allThrows: true })
    sendScanStart('fake-repair-abort.db', { path: fixtureRoot })

    const payload = await waitForScanComplete()
    expect(payload.success).toBe(true) // 修复失败不阻塞扫描本身
    // V1 失败路径不写迁移标记；V2/V3/V4 被中止，也不写标记
    expect(markerInserts).not.toContain('repair_legacy_data_v2')
    expect(markerInserts).not.toContain('repair_legacy_data_v3')
    expect(markerInserts).not.toContain('repair_legacy_data_v4')
  })

  it('对照组：V1 成功时 V2/V3/V4 正常执行（迁移标记全部写入）', async () => {
    postMessageMock.mockClear()
    markerInserts.length = 0
    dbh.state.instance = createFakeDb()
    sendScanStart('fake-repair-ok.db', { path: fixtureRoot })

    const payload = await waitForScanComplete()
    expect(payload.success).toBe(true)
    expect(markerInserts).toContain('repair_legacy_data_v1')
    expect(markerInserts).toContain('repair_legacy_data_v2')
    expect(markerInserts).toContain('repair_legacy_data_v3')
    expect(markerInserts).toContain('repair_legacy_data_v4')
  })
})
