/**
 * @layer L1
 * @module src/main/scanner/worker-entry
 * @coverage 隐藏目录强制遍历（GamePlayPhotos 默认带 Windows 隐藏属性，扫描器须忽略
 *           FILE_ATTRIBUTE_HIDDEN / FILE_ATTRIBUTE_SYSTEM 过滤，强制递归、不得跳过）
 * @dependencies parentPort 桩 + Module._load 拦截 better-sqlite3（与 worker-entry.native-thumbnail.test.ts 同源）
 * @remarks 验证：隐藏属性标记的 GamePlayPhotos 目录及其子目录仍被完整递归扫描，
 *          内部媒体文件全部入库（不依赖隐藏属性过滤、不跳过）。
 *
 * 运行：npx vitest run src/main/scanner/__tests__/scan-directory.hidden.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { promises as fsp } from 'fs'
import os from 'os'
import path from 'path'
import Module from 'node:module'
import { execFileSync } from 'child_process'

// repairLegacyDataV1/V3/V4 桩掉（startScan 串行调用，与本测试无关；V2/V5 由 fake db 命中早退）
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

// fixtures 根目录与游戏目录树路径
let cleanupRoot: string
let gamePlayPhotosDir: string
let hqDir: string
let photoInHidden: string // 隐藏 GamePlayPhotos 目录内部的媒体文件

beforeAll(async () => {
  // 1. 挂钩 Module._load：better-sqlite3 替换为 mock
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

  // 3. fixtures：构建游戏目录树，并把 GamePlayPhotos 标记为 Windows 隐藏属性
  cleanupRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'nikki-hidden-'))
  gamePlayPhotosDir = path.join(cleanupRoot, 'X6Game', 'Saved', 'GamePlayPhotos')
  const uidDir = path.join(gamePlayPhotosDir, '123456789')
  hqDir = path.join(uidDir, 'NikkiPhotos_HighQuality')
  await fsp.mkdir(hqDir, { recursive: true })

  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  const smallJpeg = Buffer.concat([jpegHeader, Buffer.alloc(2 * 1024)])
  photoInHidden = path.join(hqDir, 'hidden_photo.jpg')
  await fsp.writeFile(photoInHidden, smallJpeg)

  // Windows：为 GamePlayPhotos 目录设置隐藏属性（FILE_ATTRIBUTE_HIDDEN）。
  // 若设置失败（无 attrib 或非 Windows）则跳过——Node readdir 本就不按属性过滤，普通目录同样会递归。
  if (process.platform === 'win32') {
    try {
      execFileSync('attrib', ['+h', gamePlayPhotosDir], { windowsHide: true })
    } catch {
      // 忽略：继续以普通目录运行，仍应被遍历
    }
  }

  // 4. 动态 import（parentPort 桩与 Module._load 挂钩已就绪）
  await import('../worker-entry')
})

afterAll(async () => {
  moduleWithLoad._load = originalLoad
  delete (process as { parentPort?: unknown }).parentPort
  await fsp.rm(cleanupRoot, { recursive: true, force: true }).catch(() => {})
})

describe('隐藏目录强制遍历（GamePlayPhotos 隐藏属性豁免）', () => {
  let inserts: InsertRecord[]

  beforeAll(async () => {
    postMessageMock.mockClear()
    inserts = []
    h.state.instance = createFakeDb(inserts)
    sendScanStart('fake-hidden-traversal.db', { path: cleanupRoot })

    const payload = await waitForScanComplete()
    expect(payload.success).toBe(true)
  })

  it('隐藏的 GamePlayPhotos 目录内部媒体文件仍被扫描入库（不跳过）', () => {
    const rec = inserts.find((r) => r.params[0] === photoInHidden)
    expect(rec).toBeDefined()
    expect(rec!.params[0]).toBe(photoInHidden)
  })

  it('隐藏目录的子目录树被完整递归（NikkiPhotos_HighQuality 下文件计入总数）', () => {
    // 仅 HQ 目录一个文件，且无 LQ 目录，故应有 1 条媒体入库记录
    expect(inserts).toHaveLength(1)
  })
})
