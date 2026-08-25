/**
 * @layer L1
 * @module src/main/scanner/worker-entry
 * @coverage 动态 UID 自动识别与隔离（GamePlayPhotos 下每个纯数字子目录 = 账号 UID，
 *           其下媒体归属对应账号，不同 UID 在数据库索引/前端分类/账号管理中完全隔离）
 * @dependencies parentPort 桩 + Module._load 拦截 better-sqlite3（与 worker-entry.native-thumbnail.test.ts 同源）
 * @remarks 验证：两个不同数字 UID 目录下的照片，入库 account_uid 各自正确、无混同。
 *
 * 运行：npx vitest run src/main/scanner/__tests__/scan-directory.multi-uid.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { promises as fsp } from 'fs'
import os from 'os'
import path from 'path'
import Module from 'node:module'

vi.mock('../repair-legacy-data-v1', () => ({ repairLegacyDataV1: vi.fn() }))
vi.mock('../repair-legacy-data-v3', () => ({ repairLegacyDataV3: vi.fn() }))
vi.mock('../repair-legacy-data-v4', () => ({ repairLegacyDataV4: vi.fn() }))

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
        if (sql.includes('INSERT INTO media_files')) {
          inserts.push({ sql, params })
        }
        return { changes: 1, lastInsertRowid: 1 }
      },
      get: () => (sql.includes('schema_migrations') ? { 1: 1 } : undefined),
      all: () => []
    }),
    transaction: (fn: (...args: unknown[]) => unknown) => fn
  }
}

/** 从 INSERT SQL 解析指定列的占位符参数下标 */
function paramIndex(sql: string, column: string): number {
  const match = sql.match(/INSERT INTO media_files\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i)
  if (!match) throw new Error('未能从 INSERT SQL 解析列列表/VALUES')
  const columns = match[1].split(',').map((c) => c.trim().toLowerCase())
  const values = match[2].split(',').map((v) => v.trim())
  const colIdx = columns.indexOf(column.toLowerCase())
  if (colIdx === -1) throw new Error(`INSERT SQL 列列表缺少 ${column} 列`)
  if (values[colIdx] !== '?') throw new Error(`${column} 列的 VALUES 不是占位符`)
  let paramIdx = 0
  for (let i = 0; i < colIdx; i++) {
    if (values[i] === '?') paramIdx++
  }
  return paramIdx
}

async function waitForScanComplete(
  timeoutMs = 8000
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

let cleanupRoot: string
let pUidA: string // UID=111111111 下的照片
let pUidB: string // UID=222222222 下的照片

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

  cleanupRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'nikki-multi-uid-'))
  const gp = path.join(cleanupRoot, 'X6Game', 'Saved', 'GamePlayPhotos')
  const hqA = path.join(gp, '111111111', 'NikkiPhotos_HighQuality')
  const hqB = path.join(gp, '222222222', 'NikkiPhotos_HighQuality')
  await fsp.mkdir(hqA, { recursive: true })
  await fsp.mkdir(hqB, { recursive: true })

  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  const smallJpeg = Buffer.concat([jpegHeader, Buffer.alloc(2 * 1024)])
  pUidA = path.join(hqA, 'photo_a.jpg')
  pUidB = path.join(hqB, 'photo_b.jpg')
  await fsp.writeFile(pUidA, smallJpeg)
  await fsp.writeFile(pUidB, smallJpeg)

  await import('../worker-entry')
})

afterAll(async () => {
  moduleWithLoad._load = originalLoad
  delete (process as { parentPort?: unknown }).parentPort
  await fsp.rm(cleanupRoot, { recursive: true, force: true }).catch(() => {})
})

describe('动态 UID 自动识别与隔离', () => {
  let inserts: InsertRecord[]

  beforeAll(async () => {
    postMessageMock.mockClear()
    inserts = []
    h.state.instance = createFakeDb(inserts)
    sendScanStart('fake-multi-uid.db', { path: cleanupRoot })

    const payload = await waitForScanComplete()
    expect(payload.success).toBe(true)
    expect(inserts).toHaveLength(2)
  })

  it('UID=111111111 下的照片 account_uid 正确、无混同', () => {
    const rec = inserts.find((r) => r.params[0] === pUidA)
    expect(rec).toBeDefined()
    const uidIdx = paramIndex(rec!.sql, 'account_uid')
    expect(rec!.params[uidIdx]).toBe('111111111')
  })

  it('UID=222222222 下的照片 account_uid 正确、无混同', () => {
    const rec = inserts.find((r) => r.params[0] === pUidB)
    expect(rec).toBeDefined()
    const uidIdx = paramIndex(rec!.sql, 'account_uid')
    expect(rec!.params[uidIdx]).toBe('222222222')
  })

  it('两个 UID 各自独立入库、互不交叉（无重复、无串号）', () => {
    const uidA = inserts.find((r) => r.params[0] === pUidA)!
    const uidB = inserts.find((r) => r.params[0] === pUidB)!
    const idx = paramIndex(uidA.sql, 'account_uid')
    expect(uidA.params[idx]).not.toBe(uidB.params[idx])
    expect(new Set([uidA.params[idx], uidB.params[idx]]).size).toBe(2)
  })
})
