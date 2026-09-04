/**
 * @layer L1
 * @module src/main/scanner/worker-entry
 * @coverage 需求五.2：目录遍历超时告警——单次 readdir 超过阈值（生产 3s，单测注入更小值）
 *           无响应时追加 `traverse-timeout` 告警，**只告警不中断**（目录内容仍被完整扫描入库）
 * @dependencies parentPort 桩 + Module._load 拦截 better-sqlite3 + fs/promises readdir 延时桩
 * @remarks 通过延时桩模拟安全软件拦截导致的 readdir 挂起，验证告警埋点与"不丢文件"两条契约。
 *
 * 运行：npx vitest run src/main/scanner/__tests__/scan-traverse-timeout.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { promises as fsp } from 'fs'
import os from 'os'
import path from 'path'
import Module from 'node:module'

// repairLegacyData 桩掉（startScan 串行调用，与本测试无关）
vi.mock('../repair-legacy-data-v1', () => ({ repairLegacyDataV1: vi.fn() }))
vi.mock('../repair-legacy-data-v3', () => ({ repairLegacyDataV3: vi.fn() }))
vi.mock('../repair-legacy-data-v4', () => ({ repairLegacyDataV4: vi.fn() }))

// 延时桩的可变状态（vi.hoisted 保证在 vi.mock 工厂求值前就绪）
const slow = vi.hoisted(() => ({ dirs: new Set<string>(), delayMs: 200 }))

// 仅接管 readdir：目标目录人为延时，其余调用透传原生实现
vi.mock('fs/promises', async (importOriginal) => {
  const orig = (await importOriginal()) as unknown as {
    readdir: (p: unknown, o?: unknown) => unknown
    default: { readdir: (p: unknown, o?: unknown) => unknown }
  }
  const patched = (p: unknown, o?: unknown): unknown => {
    if (slow.dirs.has(String(p))) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          orig.readdir(p, o).then(resolve, reject)
        }, slow.delayMs)
      })
    }
    return orig.readdir(p, o)
  }
  return { ...orig, default: { ...orig.default, readdir: patched }, readdir: patched }
})

// better-sqlite3 假实现：构造函数返回可替换的共享实例
const h = vi.hoisted(() => {
  const state: { instance: unknown } = { instance: null }
  const Ctor = function () {
    return state.instance
  }
  return { state, Ctor }
})

interface InsertRecord {
  sql: string
  params: unknown[]
}

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

function createFakeDb(inserts: InsertRecord[]): unknown {
  return {
    pragma: () => undefined,
    close: () => undefined,
    prepare: (sql: string) => ({
      run: (...params: unknown[]) => {
        if (sql.includes('INSERT INTO media_files')) inserts.push({ sql, params })
        return { changes: 1, lastInsertRowid: 1 }
      },
      get: () => (sql.includes('schema_migrations') ? { 1: 1 } : undefined),
      all: () => []
    }),
    transaction: (fn: (...args: unknown[]) => unknown) => fn
  }
}

interface ScanLogMessage {
  type: string
  payload: { stage?: string; level?: string; message?: string; detail?: unknown }
}

function scanLogMessages(): ScanLogMessage[] {
  return postMessageMock.mock.calls
    .map((c) => c[0] as ScanLogMessage)
    .filter((e) => e?.type === 'SCAN_LOG')
}

async function waitForScanComplete(
  timeoutMs = 8000
): Promise<{ success: boolean; message: string }> {
  const start = Date.now()
  for (;;) {
    const event = postMessageMock.mock.calls
      .map((c) => c[0])
      .find((e) => e?.type === 'SCAN_COMPLETE')
    if (event) return event.payload as { success: boolean; message: string }
    if (Date.now() - start > timeoutMs) throw new Error('SCAN_COMPLETE 未在超时内到达')
    await new Promise((r) => setTimeout(r, 20))
  }
}

let cleanupRoot: string
let slowDir: string
let photoInSlowDir: string
let inserts: InsertRecord[]

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

  // fixtures：官方相册标准布局，HQ 目录为"慢目录"
  cleanupRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'nikki-slow-'))
  const hqDir = path.join(
    cleanupRoot,
    'X6Game',
    'Saved',
    'GamePlayPhotos',
    '123456789',
    'NikkiPhotos_HighQuality'
  )
  await fsp.mkdir(hqDir, { recursive: true })
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  photoInSlowDir = path.join(hqDir, 'slow_photo.jpg')
  await fsp.writeFile(photoInSlowDir, Buffer.concat([jpegHeader, Buffer.alloc(2 * 1024)]))
  slowDir = hqDir
  slow.dirs.add(hqDir)

  const worker = await import('../worker-entry')
  // 注入更小阈值（生产为 3000ms），使用例无需真实等待 3 秒
  worker.__setTraverseSlowMsForTest(30)

  inserts = []
  h.state.instance = createFakeDb(inserts)
  if (!messageHandler) throw new Error('parentPort message handler 未注册')
  messageHandler({
    data: {
      type: 'SCAN_START',
      payload: { dbPath: 'fake-slow-traversal.db', options: { path: cleanupRoot } }
    }
  })
  await waitForScanComplete()
})

afterAll(async () => {
  slow.dirs.clear()
  moduleWithLoad._load = originalLoad
  delete (process as { parentPort?: unknown }).parentPort
  await fsp.rm(cleanupRoot, { recursive: true, force: true }).catch(() => {})
})

describe('需求五.2：目录遍历超时告警（只告警不中断）', () => {
  it('readdir 超过阈值时产出 traverse-timeout 告警，detail 含目录与阈值', () => {
    const entry = scanLogMessages().find((e) => e.payload?.stage === 'traverse-timeout')
    expect(entry).toBeDefined()
    expect(entry!.payload.level).toBe('warn')
    expect(entry!.payload.message).toContain(slowDir)
    expect(entry!.payload.detail).toMatchObject({ path: slowDir, elapsedMs: 30 })
  })

  it('告警不中断扫描：慢目录内的媒体文件仍被完整入库', () => {
    const rec = inserts.find((r) => r.params[0] === photoInSlowDir)
    expect(rec).toBeDefined()
    expect(inserts).toHaveLength(1)
  })

  it('告警后不重复读取目录（仅一条该目录的超时告警）', () => {
    const entries = scanLogMessages().filter((e) => {
      if (e.payload?.stage !== 'traverse-timeout') return false
      const detail = e.payload.detail as { path?: string } | undefined
      return detail?.path === slowDir
    })
    expect(entries).toHaveLength(1)
  })
})
