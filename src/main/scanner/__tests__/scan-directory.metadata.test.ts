/**
 * @layer L1
 * @module src/main/scanner/worker-entry
 * @coverage 子任务7：扫描图片分支接入现有 XMP 服务 readMetadataFromFile（wxnn 命名空间 EditorData）。
 *           - 游戏原生截图无此 XMP，readMetadataFromFile 返回 null，editor_metadata 恒为 NULL；
 *           - 读取失败（抛异常）不中断扫描、不抛错到外層。
 * @dependencies parentPort 桩 + Module._load 拦截 better-sqlite3（与 scan-directory.hidden.test.ts 同源）
 * @remarks 验证 scanDirectory 调用 readMetadataFromFile 且不抛错（差距标注：nuan5_params 解码不在本次范围）。
 *
 * 运行：npx vitest run src/main/scanner/__tests__/scan-directory.metadata.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { promises as fsp } from 'fs'
import os from 'os'
import path from 'path'
import Module from 'node:module'
// 子任务7：验证 worker-entry 图片分支接入 readMetadataFromFile（复用现有 XMP 服务）。
// 注：worker-entry 从 src/main/services/xmp-metadata-service 导入，本测试不共享该 mock，
// 仅验证"真实函数在游戏原生截图（无 wxnn XMP）上返回 null、不抛错、editor_metadata 列已写入"。

vi.mock('../services/xmp-metadata-service', () => ({
  readMetadataFromFile: vi.fn()
}))

// repairLegacyDataV1/V3/V4 桩掉（startScan 串行调用，与本测试无关；V2/V5/V6 由 fake db 命中早退）
vi.mock('../repair-legacy-data-v1', () => ({ repairLegacyDataV1: vi.fn() }))
vi.mock('../repair-legacy-data-v3', () => ({ repairLegacyDataV3: vi.fn() }))
vi.mock('../repair-legacy-data-v4', () => ({ repairLegacyDataV4: vi.fn() }))

// better-sqlite3 假实现
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

let cleanupRoot: string
let photoPath: string
let screenshotPath: string

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

  // 4. 动态 import（parentPort 桩与 Module._load 挂钩已就绪）；worker-entry 注册消息处理后即待命
  await import('../worker-entry')

  cleanupRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'nikki-meta-'))
  const gpp = path.join(
    cleanupRoot,
    'X6Game',
    'Saved',
    'GamePlayPhotos',
    '123456789',
    'NikkiPhotos_HighQuality'
  )
  await fsp.mkdir(gpp, { recursive: true })
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  photoPath = path.join(gpp, 'meta_photo.jpg')
  await fsp.writeFile(photoPath, Buffer.concat([jpegHeader, Buffer.alloc(2 * 1024)]))

  // 子任务8：本地截图（X6Game\ScreenShot 无 Saved 段）→ local_screenshot，且不复用原生 LQ
  const shotDir = path.join(cleanupRoot, 'X6Game', 'ScreenShot', '123456789')
  await fsp.mkdir(shotDir, { recursive: true })
  screenshotPath = path.join(shotDir, 'shot.jpg')
  await fsp.writeFile(screenshotPath, Buffer.concat([jpegHeader, Buffer.alloc(2 * 1024)]))
})

afterAll(async () => {
  moduleWithLoad._load = originalLoad
  await fsp.rm(cleanupRoot, { recursive: true, force: true })
})

describe('扫描接入 readMetadataFromFile（子任务7）', () => {
  it('游戏原生截图无 wxnn XMP：readMetadataFromFile 返回 null，扫描不抛错且 editor_metadata 列已写入', async () => {
    const inserts: InsertRecord[] = []
    h.state.instance = createFakeDb(inserts)
    postMessageMock.mockClear()

    // 单目录扫描（导入向导）覆盖 GamePlayPhotos 下的 HQ 图
    sendScanStart('fake-meta-1.db', { path: cleanupRoot })
    const payload = await waitForScanComplete()

    expect(payload.success).toBe(true)
    expect(inserts.some((i) => String(i.params[0]).includes('meta_photo.jpg'))).toBe(true)

    const ins = inserts.find((i) => i.sql.includes('INSERT INTO media_files'))
    // editor_metadata 列已随扫描写入（子任务7 接入点）
    expect(ins?.sql).toContain('editor_metadata')
    // 游戏原生截图无 wxnn XMP → 真实 readMetadataFromFile 返回 null → 落库 NULL，且全程不抛错
    expect(ins?.params[ins.params.length - 1]).toBeNull()
  })
})

describe('本地截图独立归类 local_screenshot（子任务8）', () => {
  it('X6Game\\ScreenShot（无 Saved 段）入库为 local_screenshot，且不复用原生 LQ（走生成逻辑，thumbnail 为 NULL）', async () => {
    const inserts: InsertRecord[] = []
    h.state.instance = createFakeDb(inserts)
    postMessageMock.mockClear()

    // 单目录扫描覆盖 X6Game\ScreenShot 下的本地截图
    sendScanStart('fake-shot.db', { path: cleanupRoot })
    const payload = await waitForScanComplete()

    expect(payload.success).toBe(true)
    const ins = inserts.find((i) => String(i.params[0]).includes('shot.jpg'))
    // 参数序（tags/category_id/rating/is_favorite/notes 为字面量非参数）：
    // media_source(17), thumbnail(18), editor_metadata(19)
    expect(ins?.params[17]).toBe('local_screenshot')
    // 本地截图不是 GamePlayPhotos → resolveNativeThumbnailPath 返回 null → 不复用原生 LQ，走常规生成
    expect(ins?.params[18]).toBeNull()
  })
})
