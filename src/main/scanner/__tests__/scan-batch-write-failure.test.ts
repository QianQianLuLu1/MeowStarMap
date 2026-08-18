/**
 * FIX(组3-1) 回归测试：数据库批量写入失败必须使扫描以失败告终，而非被降级为"跳过目录"静默丢批。
 *
 * 驱动完整 SCAN_START 链路：parentPort 桩接收消息 → startScan → scanDirectory →
 * flushBatch → saveBatchToDatabase（better-sqlite3 mock，media_files INSERT 抛 SQLITE_BUSY 模拟）。
 *
 * better-sqlite3 拦截方式说明：worker-entry 通过惰性 require('better-sqlite3') 加载，
 * vite-node 注入的原生 require 不经过 vi.mock 注册表（且本机 native 模块为 Electron ABI，
 * 在 vitest/Node 下加载即崩溃），故挂钩 CJS 加载器入口 Module._load 定向替换。
 *
 * 运行：npx vitest run src/main/scanner/__tests__/scan-batch-write-failure.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { promises as fsp } from 'fs'
import os from 'os'
import path from 'path'
import Module from 'node:module'

// repairLegacyDataV1/V3/V4 桩掉（startScan 串行调用，与本测试无关，避免依赖 mock db 的复杂行为）
vi.mock('../../repair-legacy-data-v1', () => ({ repairLegacyDataV1: vi.fn() }))
vi.mock('../../repair-legacy-data-v3', () => ({ repairLegacyDataV3: vi.fn() }))
vi.mock('../../repair-legacy-data-v4', () => ({ repairLegacyDataV4: vi.fn() }))

// better-sqlite3 假实现：构造函数返回可替换的共享实例（每个用例注入不同行为）
const h = vi.hoisted(() => {
  const state: { instance: unknown } = { instance: null }
  const Ctor = function () {
    return state.instance
  }
  return { state, Ctor }
})

let fixtureRoot: string
let cleanupRoot: string

// parentPort 桩：捕获 message 处理器 + postMessage 间谍
let messageHandler: ((event: { data: unknown }) => void) | undefined
const postMessageMock = vi.fn()

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

function createFakeDb(failMediaInsert: boolean): unknown {
  return {
    pragma: () => undefined,
    close: () => undefined,
    prepare: (sql: string) => ({
      run: () => {
        if (failMediaInsert && sql.includes('INSERT INTO media_files')) {
          throw new Error('SQLITE_BUSY: database is locked（模拟批量写入失败）')
        }
        return { changes: 1, lastInsertRowid: 1 }
      },
      // schema_migrations 命中即可让 repairLegacyDataV2 等"已应用"检查早退
      get: () => (sql.includes('schema_migrations') ? { 1: 1 } : undefined),
      all: () => []
    }),
    // 直接返回事务体：调用即同步执行内部语句
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
  // 1. 挂钩 Module._load：better-sqlite3 的裸 id 与绝对路径请求都替换为 mock（其余请求走原实现）
  moduleWithLoad._load = function (request, parent, isMain) {
    if (typeof request === 'string' && isBetterSqliteRequest(request)) {
      return { default: h.Ctor }
    }
    return originalLoad(request, parent, isMain)
  }

  // 2. parentPort 桩（必须在 import worker-entry 之前安装：模块加载期注册 message 处理器）
  ;(process as { parentPort?: unknown }).parentPort = {
    on: (_type: string, cb: (event: { data: unknown }) => void) => {
      messageHandler = cb
    },
    postMessage: postMessageMock
  }

  // 3. fixtures：2 张 jpg（单目录扫描模式 applyFilters=false，不过滤小文件）
  cleanupRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'nikki-scan-write-fail-'))
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

  // 4. 动态 import（此时 parentPort 桩与 Module._load 挂钩已就绪）
  await import('../worker-entry')
})

afterAll(async () => {
  // 还原全局桩，避免污染同 fork 内后续测试
  moduleWithLoad._load = originalLoad
  delete (process as { parentPort?: unknown }).parentPort
  await fsp.rm(cleanupRoot, { recursive: true, force: true }).catch(() => {})
})

describe('组3-1：saveBatchToDatabase 抛错的传播链', () => {
  it('media_files INSERT 抛错（SQLITE_BUSY）时，扫描应以失败告终并明确上报批量写入失败', async () => {
    postMessageMock.mockClear()
    h.state.instance = createFakeDb(true)
    // dbPath 唯一：强制 openDatabaseIfNeeded 走"路径变化→重建连接"分支拿到新 mock db
    sendScanStart('fake-busy.db', { path: fixtureRoot })

    const payload = await waitForScanComplete()
    expect(payload.success).toBe(false)
    expect(payload.message).toContain('扫描失败')
    expect(payload.message).toContain('数据库批量写入失败')
    expect(payload.message).toContain('SQLITE_BUSY')
  })

  it('对照组：写库正常时扫描成功完成', async () => {
    postMessageMock.mockClear()
    h.state.instance = createFakeDb(false)
    sendScanStart('fake-ok.db', { path: fixtureRoot })

    const payload = await waitForScanComplete()
    expect(payload.success).toBe(true)
    expect(payload.message).toContain('发现 2 个媒体文件')
  })
})
