/**
 * FIX(组3-5)/FIX(组3-6) 回归测试（worker-entry.ts）。
 *
 * 组3-5：增量扫描的 existingFiles 查询必须按扫描根路径前缀过滤（LIKE + ESCAPE），
 * 不再无 WHERE 全表加载——单目录导入时不得把整个库拉入内存。
 *
 * 组3-6：cleanupAndExit 重入保护——SCAN_DISPOSE 与心跳超时兜底先后触发时，
 * db.close 等清理动作只执行一次。
 *
 * 驱动方式与 scan-batch-write-failure.test.ts 相同：parentPort 桩 +
 * Module._load 挂钩替换 better-sqlite3（vite-node 原生 require 不经 vi.mock 注册表）。
 *
 * 运行：npx vitest run src/main/scanner/__tests__/scan-incremental-prefix.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { promises as fsp } from 'fs'
import os from 'os'
import path from 'path'
import Module from 'node:module'
import { normalizeRootPrefixForLike } from '../integrity-root-filter'

// repairLegacyDataV1/V3/V4 桩掉（与本测试无关，避免依赖 mock db 的复杂行为）
vi.mock('../../repair-legacy-data-v1', () => ({ repairLegacyDataV1: vi.fn() }))
vi.mock('../../repair-legacy-data-v3', () => ({ repairLegacyDataV3: vi.fn() }))
vi.mock('../../repair-legacy-data-v4', () => ({ repairLegacyDataV4: vi.fn() }))

const h = vi.hoisted(() => {
  const state: { instance: unknown } = { instance: null }
  const Ctor = function () {
    return state.instance
  }
  return { state, Ctor }
})

let fixtureRoot: string
let cleanupRoot: string

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

// 记录型 fake db：捕获全部 prepare 语句与 SELECT 参数；close 计数供组3-6 断言
const captured = {
  statements: [] as Array<{ sql: string; params: unknown[] }>,
  closeCount: 0
}

function createRecordingDb(): unknown {
  return {
    pragma: () => undefined,
    close: () => {
      captured.closeCount++
    },
    prepare: (sql: string) => ({
      run: () => ({ changes: 1, lastInsertRowid: 1 }),
      get: () => (sql.includes('schema_migrations') ? { 1: 1 } : undefined),
      all: (...args: unknown[]) => {
        captured.statements.push({ sql, params: args })
        return []
      }
    }),
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

function sendMessage(data: unknown): void {
  if (!messageHandler) throw new Error('parentPort message handler 未注册')
  messageHandler({ data })
}

beforeAll(async () => {
  moduleWithLoad._load = function (request, parent, isMain) {
    if (typeof request === 'string' && isBetterSqliteRequest(request)) {
      return { default: h.Ctor }
    }
    return originalLoad(request, parent, isMain)
  }

  ;(process as { parentPort?: unknown }).parentPort = {
    on: (_type: string, cb: (event: { data: unknown }) => void) => {
      messageHandler = cb
    },
    postMessage: postMessageMock
  }

  cleanupRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'nikki-scan-incr-'))
  fixtureRoot = path.join(cleanupRoot, 'album')
  await fsp.mkdir(fixtureRoot, { recursive: true })
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  await fsp.writeFile(
    path.join(fixtureRoot, 'photo1.jpg'),
    Buffer.concat([jpegHeader, Buffer.alloc(8 * 1024)])
  )

  await import('../worker-entry')
})

afterAll(async () => {
  moduleWithLoad._load = originalLoad
  delete (process as { parentPort?: unknown }).parentPort
  await fsp.rm(cleanupRoot, { recursive: true, force: true }).catch(() => {})
})

describe('组3-5：增量扫描 existingFiles 按扫描根前缀过滤', () => {
  it('existingFiles 查询应为 LIKE 前缀（根路径 + 分隔符 + %，含 ESCAPE），不再全表加载', async () => {
    postMessageMock.mockClear()
    captured.statements = []
    h.state.instance = createRecordingDb()

    sendMessage({
      type: 'SCAN_START',
      payload: { dbPath: 'fake-incr.db', options: { path: fixtureRoot, incremental: true } }
    })

    const payload = await waitForScanComplete()
    expect(payload.success).toBe(true)

    // 无 WHERE 的旧全表 SELECT 不应再出现
    const bareFullTable = captured.statements.find(
      (s) => s.sql.replace(/\s+/g, ' ').trim() === 'SELECT file_path, modified_at FROM media_files'
    )
    expect(bareFullTable).toBeUndefined()

    // 新查询：LIKE + ESCAPE，参数为 根路径 + 分隔符 + %
    const likeQuery = captured.statements.find(
      (s) => s.sql.includes('file_path, modified_at FROM media_files') && s.sql.includes('LIKE')
    )
    expect(likeQuery).toBeDefined()
    // 大小写不敏感范式：LOWER(REPLACE(file_path,'\','/')) LIKE LOWER(?)，与 buildIntegrityRootFilter 同口径
    expect(likeQuery!.sql).toContain("LOWER(REPLACE(file_path, '\\', '/'))")
    expect(likeQuery!.sql).toContain('LIKE LOWER(?)')
    expect(likeQuery!.sql).toContain("ESCAPE '\\'")
    // 参数 = 根路径归一为小写正斜杠前缀，复用与实现一致的共享函数（保证两侧范式完全对称）
    const expectedPrefix = normalizeRootPrefixForLike(fixtureRoot, path.sep)
    expect(likeQuery!.params[0]).toBe(expectedPrefix)
  })
})

describe('组3-6：cleanupAndExit 重入保护', () => {
  it('SCAN_DISPOSE 二次触发时 db.close 只执行一次（置为最后一个用例：模块级 isExiting 不可复位）', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      postMessageMock.mockClear()
      captured.closeCount = 0
      h.state.instance = createRecordingDb()
      // 强制重建连接拿到新 mock db（dbPath 与前用例不同）
      sendMessage({
        type: 'SCAN_START',
        payload: { dbPath: 'fake-dispose.db', options: { path: fixtureRoot } }
      })
      await waitForScanComplete()
      // 基线：扫描完成时 close 只来自换库重连（旧库关闭），以差值断言 dispose 行为
      const baseline = captured.closeCount

      // 两次 SCAN_DISPOSE（模拟 dispose 与心跳兜底竞态先后到达）
      sendMessage({ type: 'SCAN_DISPOSE' })
      sendMessage({ type: 'SCAN_DISPOSE' })

      // cleanupAndExit 回发确认后 setImmediate(() => process.exit(0))：等待宏任务落定，
      // 使延迟的 process.exit 在 exitSpy 仍生效时触发（避免 finally 恢复后真实 exit 抛异常）
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setTimeout(r, 0))

      expect(captured.closeCount - baseline).toBe(1)
      expect(exitSpy).toHaveBeenCalledTimes(1)
    } finally {
      exitSpy.mockRestore()
    }
  })
})
