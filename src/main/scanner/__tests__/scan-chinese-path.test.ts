/**
 * @layer L1
 * @module src/main/scanner/worker-entry
 * @coverage 需求四 + 需求五.2：中文 / 空格 / 特殊字符（#）路径端到端扫描
 *           —— 目录名与文件名均含中文、空格与 `#`，验证官方相册通道能正确定位、
 *              UID 与相册分类正确、原生 LQ 缩略图被复用（不触发生成）
 * @dependencies parentPort 桩 + Module._load 拦截 better-sqlite3 + game-directory-discovery 桩
 * @remarks 三渠道定位被桩为空，仅走用户自定义路径，保证用例不依赖真实注册表/盘符。
 *
 * 运行：npx vitest run src/main/scanner/__tests__/scan-chinese-path.test.ts
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
// 三渠道定位桩为空：仅验证自定义（中文）路径链路，避免真实注册表/盘符 IO。
// importOriginal 展开真实模块：findMediaDirectories 依赖的 normalizeCustomGameRoot
// （自定义路径归一化纯函数，走真实 fs）保持真实实现，仅覆写三渠道发现函数。
vi.mock('../game-directory-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../game-directory-discovery')>()),
  findGameInstallRootsByPriority: () => Promise.resolve([]),
  getLastProbeTrail: () => []
}))

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

/**
 * 把 INSERT 记录解析为「列名 → 值」。
 * VALUES 中含字面量（'[]' / NULL / 0 / ''），故按 `?` 出现顺序对齐列，不按位置硬编码。
 */
function toRow(rec: InsertRecord): Record<string, unknown> {
  const colsRaw = rec.sql.slice(rec.sql.indexOf('(') + 1, rec.sql.indexOf(')'))
  const columns = colsRaw.split(',').map((c) => c.trim())
  const valuesRaw = rec.sql.slice(rec.sql.indexOf('VALUES (') + 8)
  const values = valuesRaw
    .slice(0, valuesRaw.indexOf(')'))
    .split(',')
    .map((v) => v.trim())
  const row: Record<string, unknown> = {}
  let paramIdx = 0
  for (let i = 0; i < values.length && i < columns.length; i++) {
    if (values[i] === '?') {
      row[columns[i]] = rec.params[paramIdx]
      paramIdx++
    }
  }
  return row
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
let hqPhoto: string
let lqPhoto: string
let checkinPhoto: string
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

  // 中文 + 空格 + # 的临时根目录（需求四：中文/特殊字符路径兼容）
  cleanupRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'nikki-中文 相册 #2024-'))
  const uidDir = path.join(cleanupRoot, 'X6Game', 'Saved', 'GamePlayPhotos', '100200300')
  const hqDir = path.join(uidDir, 'NikkiPhotos_HighQuality')
  const lqDir = path.join(uidDir, 'NikkiPhotos_LowQuality')
  // 未被 ALBUM_TYPE_MAP 收录的相册子目录（需求四.2：按原目录名分类）
  const checkinDir = path.join(uidDir, '打卡 相册')
  await fsp.mkdir(hqDir, { recursive: true })
  await fsp.mkdir(lqDir, { recursive: true })
  await fsp.mkdir(checkinDir, { recursive: true })

  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2 * 1024)])
  hqPhoto = path.join(hqDir, '照片 001.jpg')
  lqPhoto = path.join(lqDir, '照片 001.jpg')
  checkinPhoto = path.join(checkinDir, '照片 002.jpg')
  await fsp.writeFile(hqPhoto, jpeg)
  await fsp.writeFile(lqPhoto, jpeg)
  await fsp.writeFile(checkinPhoto, jpeg)

  await import('../worker-entry')

  inserts = []
  h.state.instance = createFakeDb(inserts)
  if (!messageHandler) throw new Error('parentPort message handler 未注册')
  messageHandler({
    data: {
      type: 'SCAN_START',
      payload: {
        dbPath: 'fake-chinese-path.db',
        options: { fullScan: true, customKnownPaths: [cleanupRoot] }
      }
    }
  })
})

afterAll(async () => {
  moduleWithLoad._load = originalLoad
  delete (process as { parentPort?: unknown }).parentPort
  await fsp.rm(cleanupRoot, { recursive: true, force: true }).catch(() => {})
})

describe('中文 / 空格 / # 路径端到端扫描（需求四）', () => {
  it('扫描成功且三个媒体文件全部入库（路径含中文、空格与 #）', async () => {
    const payload = await waitForScanComplete()
    expect(payload.success).toBe(true)
    const paths = inserts.map((r) => String(r.params[0]))
    expect(paths).toHaveLength(3)
    expect(paths).toContain(hqPhoto)
    expect(paths).toContain(lqPhoto)
    expect(paths).toContain(checkinPhoto)
  })

  it('UID 自动识别为纯数字子目录名，三张图归属同一账号', () => {
    const rows = inserts.map(toRow)
    expect(rows.every((r) => r.account_uid === '100200300')).toBe(true)
  })

  it('相册分类：HQ / LQ 命中已知映射，未知目录保留原目录名', () => {
    const rows = inserts.map(toRow)
    const hqRow = rows.find((r) => r.file_path === hqPhoto)
    const lqRow = rows.find((r) => r.file_path === lqPhoto)
    const checkinRow = rows.find((r) => r.file_path === checkinPhoto)
    expect(hqRow?.album_type).toBe('高质量照片')
    expect(lqRow?.album_type).toBe('低质量照片')
    // 需求四.2：未收录子目录按原目录名分类（含空格的中文目录名）
    expect(checkinRow?.album_type).toBe('打卡 相册')
  })

  it('HQ 图片复用同名原生 LQ 缩略图（需求七：不触发生成）', () => {
    const hqRow = inserts.map(toRow).find((r) => r.file_path === hqPhoto)
    expect(hqRow?.thumbnail).toBe(lqPhoto)
  })
})
