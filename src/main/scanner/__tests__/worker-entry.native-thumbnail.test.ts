/**
 * @layer L1
 * @module src/main/scanner/worker-entry
 * @coverage 扫描入库关联游戏原生缩略图（HQ → 同名 LQ 低清文件直连，不触发缩略图生成）
 * @dependencies parentPort 桩 + Module._load 拦截 better-sqlite3（与 scan-batch-write-failure.test.ts 同源）
 * @remarks 验证：① HQ 图片 + 存在同名 LQ 文件 → 入库行 thumbnail = LQ 路径；
 *          ② LQ 缺失 → thumbnail 为 NULL 且仅记 warn 日志、不中断扫描；
 *          ③ 非游戏路径 → thumbnail 为 NULL（回归）。
 *
 * 运行：npx vitest run src/main/scanner/__tests__/worker-entry.native-thumbnail.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { promises as fsp } from 'fs'
import os from 'os'
import path from 'path'
import Module from 'node:module'

// repairLegacyDataV1/V3/V4 桩掉（startScan 串行调用，与本测试无关；V2/V5 由 fake db 的
// schema_migrations 命中早退，无需桩）
vi.mock('../repair-legacy-data-v1', () => ({ repairLegacyDataV1: vi.fn() }))
vi.mock('../repair-legacy-data-v3', () => ({ repairLegacyDataV3: vi.fn() }))
vi.mock('../repair-legacy-data-v4', () => ({ repairLegacyDataV4: vi.fn() }))

// better-sqlite3 假实现：构造函数返回可替换的共享实例（每个用例注入不同行为）
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
      // schema_migrations 命中即可让 repairLegacyDataV2/V5 等"已应用"检查早退
      get: () => (sql.includes('schema_migrations') ? { 1: 1 } : undefined),
      all: () => []
    }),
    // 直接返回事务体：调用即同步执行内部语句
    transaction: (fn: (...args: unknown[]) => unknown) => fn
  }
}

/** 从捕获的 INSERT SQL 解析 thumbnail 列对应的占位符参数下标（VALUES 含字面量，列下标≠参数下标） */
function thumbnailParamIndex(sql: string): number {
  const match = sql.match(/INSERT INTO media_files\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i)
  if (!match) throw new Error('未能从 INSERT SQL 解析列列表/VALUES')
  const columns = match[1].split(',').map((c) => c.trim().toLowerCase())
  const values = match[2].split(',').map((v) => v.trim())
  const colIdx = columns.indexOf('thumbnail')
  if (colIdx === -1) throw new Error('INSERT SQL 列列表缺少 thumbnail 列')
  if (values[colIdx] !== '?') throw new Error('thumbnail 列的 VALUES 不是占位符')
  // 统计 thumbnail 之前的 ? 占位符个数即其参数下标
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

/** 已发出的 SCAN_LOG 事件 */
function scanLogEvents(level: string): Array<{ level: string; message: string }> {
  return postMessageMock.mock.calls
    .map((c) => c[0])
    .filter((e) => e?.type === 'SCAN_LOG' && e.payload?.level === level)
    .map((e) => e.payload as { level: string; message: string })
}

// fixtures 根目录与游戏目录树路径
let cleanupRoot: string
let fixtureRoot: string
let hqDir: string
let lqDir: string

// 预期路径（path.join 与扫描时 fullPath 构建方式一致）
let hqWithLq: string // HQ 图片（存在同名 LQ）
let hqNoLq: string // HQ 图片（LQ 缺失）
let lqOfWithLq: string // 同名 LQ 文件（预期写入 thumbnail 的值）
let plainFile: string // 非游戏路径图片

beforeAll(async () => {
  // 1. 挂钩 Module._load：better-sqlite3 替换为 mock
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

  // 3. fixtures：构建最小游戏目录树
  //    GamePlayPhotos\123456789\NikkiPhotos_HighQuality（photo_with_lq.jpg 有同名 LQ，photo_no_lq.jpg 无）
  //    GamePlayPhotos\123456789\NikkiPhotos_LowQuality
  //    OtherAlbum（非游戏路径回归）
  cleanupRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'nikki-native-thumb-'))
  fixtureRoot = path.join(cleanupRoot, 'X6Game', 'Saved', 'GamePlayPhotos', '123456789')
  hqDir = path.join(fixtureRoot, 'NikkiPhotos_HighQuality')
  lqDir = path.join(fixtureRoot, 'NikkiPhotos_LowQuality')
  const otherDir = path.join(cleanupRoot, 'OtherAlbum')
  await fsp.mkdir(hqDir, { recursive: true })
  await fsp.mkdir(lqDir, { recursive: true })
  await fsp.mkdir(otherDir, { recursive: true })

  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  const smallJpeg = Buffer.concat([jpegHeader, Buffer.alloc(2 * 1024)])
  hqWithLq = path.join(hqDir, 'photo_with_lq.jpg')
  hqNoLq = path.join(hqDir, 'photo_no_lq.jpg')
  lqOfWithLq = path.join(lqDir, 'photo_with_lq.jpg')
  plainFile = path.join(otherDir, 'plain.jpg')
  await fsp.writeFile(hqWithLq, smallJpeg)
  await fsp.writeFile(hqNoLq, smallJpeg)
  await fsp.writeFile(lqOfWithLq, smallJpeg)
  await fsp.writeFile(plainFile, smallJpeg)

  // 4. 动态 import（此时 parentPort 桩与 Module._load 挂钩已就绪）
  await import('../worker-entry')
})

afterAll(async () => {
  moduleWithLoad._load = originalLoad
  delete (process as { parentPort?: unknown }).parentPort
  await fsp.rm(cleanupRoot, { recursive: true, force: true }).catch(() => {})
})

describe('扫描入库关联游戏原生缩略图（thumbnail 列）', () => {
  let inserts: InsertRecord[]

  beforeAll(async () => {
    postMessageMock.mockClear()
    inserts = []
    h.state.instance = createFakeDb(inserts)
    // dbPath 唯一：强制 openDatabaseIfNeeded 重建连接拿到本用例 mock db
    sendScanStart('fake-native-thumbnail.db', { path: cleanupRoot })

    const payload = await waitForScanComplete()
    expect(payload.success).toBe(true)
    // 4 个文件：2 HQ + 1 LQ（LQ 目录本身也会被扫入）+ 1 非游戏路径
    expect(payload.message).toContain('发现 4 个媒体文件')
    expect(inserts).toHaveLength(4)
  })

  function insertOf(filePath: string): InsertRecord {
    const rec = inserts.find((r) => r.params[0] === filePath)
    if (!rec) throw new Error(`未找到 ${filePath} 的 INSERT 记录`)
    return rec
  }

  it('① HQ 图片 + 存在同名 LQ 文件 → 入库行 thumbnail = LQ 路径', () => {
    const rec = insertOf(hqWithLq)
    const thumbIdx = thumbnailParamIndex(rec.sql)
    expect(rec.params[thumbIdx]).toBe(lqOfWithLq)
  })

  it('② LQ 缺失 → thumbnail 为 NULL，仅记 warn 日志、不中断扫描', () => {
    const rec = insertOf(hqNoLq)
    const thumbIdx = thumbnailParamIndex(rec.sql)
    expect(rec.params[thumbIdx]).toBeNull()

    // 缺失的 LQ 路径触发了 warn 日志（不中断：扫描仍成功，见 beforeAll 断言）
    const expectedMissingLq = path.join(lqDir, 'photo_no_lq.jpg')
    const warns = scanLogEvents('warn')
    expect(
      warns.some(
        (w) => w.message.includes('原生低清缩略图不可访问') && w.message.includes(expectedMissingLq)
      )
    ).toBe(true)
  })

  it('③ 非游戏路径 → thumbnail 为 NULL（回归）', () => {
    const rec = insertOf(plainFile)
    const thumbIdx = thumbnailParamIndex(rec.sql)
    expect(rec.params[thumbIdx]).toBeNull()
  })

  it('④ LQ 目录自身的文件不推导缩略图（避免自指）', () => {
    const rec = insertOf(lqOfWithLq)
    const thumbIdx = thumbnailParamIndex(rec.sql)
    expect(rec.params[thumbIdx]).toBeNull()
  })

  it('⑤ INSERT SQL 结构：列列表与 VALUES 含 thumbnail（防回归）', () => {
    const rec = inserts[0]
    expect(rec.sql).toContain('thumbnail')
    expect(rec.sql).toContain('COALESCE(excluded.thumbnail, media_files.thumbnail)')
  })
})
