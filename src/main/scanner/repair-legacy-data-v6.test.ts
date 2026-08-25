/**
 * @layer L1
 * @module src/main/scanner/repair-legacy-data-v6
 * @coverage 迁移幂等早退 / 候选条件（thumbnail NULL 或 %thumbnails%）/ LQ 存在才回填 /
 *           LQ 缺失不回填 / 非游戏行不受影响 / 标记容错 / 异常返回 false
 * @dependencies better-sqlite3（mock，与 repair-legacy-data-v5.test.ts 同源；native 模块为
 *               Electron 编译无法在 vitest/node 运行）+ 真实临时文件（fs.existsSync 走真实磁盘）
 * @remarks 验证"存量 HQ 记录回填游戏原生低清缩略图（同名 LQ 文件路径）"的分支行为
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { repairLegacyDataV6 } from './repair-legacy-data-v6'
import type DatabaseType from 'better-sqlite3'

interface MediaRow {
  id: number
  file_path: string
  thumbnail: string | null
}

interface MockDb {
  db: DatabaseType.Database
  _mediaFiles: MediaRow[]
  _migrations: Set<string>
  _updateCalls: Array<{ id: number; thumbnail: string }>
  _setMarkFailer: (failer: (() => void) | null) => void
  _setQueryFailer: (failer: (() => void) | null) => void
}

// V6 的候选条件（与 repair-legacy-data-v6.ts 中 SQL 完全一致，用于 mock 过滤）
function isV6Candidate(row: MediaRow): boolean {
  const thumbnailOk = row.thumbnail === null || row.thumbnail.includes('thumbnails')
  if (!thumbnailOk) return false
  const norm = row.file_path.replace(/\\/g, '/').toLowerCase()
  return /\/x6game\/saved\/gameplayphotos\/.*\/nikkiphotos_highquality\//.test(norm)
}

function createMockDb(opts: { withMigrationsTable?: boolean } = {}): MockDb {
  const mediaFiles: MediaRow[] = []
  const migrations = new Set<string>()
  const updateCalls: Array<{ id: number; thumbnail: string }> = []
  let markFailer: (() => void) | null = null
  let queryFailer: (() => void) | null = null
  const withMigrationsTable = opts.withMigrationsTable !== false

  const db = {
    prepare: vi.fn((sql: string) => {
      const lower = sql.toLowerCase()

      if (lower.startsWith('select 1 from schema_migrations')) {
        return {
          get: vi.fn((name: string) => {
            if (!withMigrationsTable) {
              throw new Error('no such table: schema_migrations')
            }
            return migrations.has(name) ? { '1': 1 } : undefined
          }),
          all: vi.fn(() => []),
          run: vi.fn()
        }
      }

      // V6 的候选查询：(thumbnail IS NULL OR thumbnail LIKE '%thumbnails%') 且 HQ 路径命中
      if (lower.includes('thumbnail is null') && lower.includes('from media_files')) {
        return {
          get: vi.fn(),
          all: vi.fn(() => {
            if (queryFailer) queryFailer()
            return mediaFiles
              .filter(isV6Candidate)
              .map((f) => ({ id: f.id, file_path: f.file_path }))
          }),
          run: vi.fn()
        }
      }

      if (lower.startsWith('update media_files set thumbnail = ?')) {
        return {
          get: vi.fn(),
          all: vi.fn(() => []),
          run: vi.fn((thumbnail: string, id: number) => {
            updateCalls.push({ id, thumbnail })
            const row = mediaFiles.find((f) => f.id === id)
            if (row) row.thumbnail = thumbnail
          })
        }
      }

      if (lower.startsWith('insert or ignore into schema_migrations')) {
        return {
          get: vi.fn(),
          all: vi.fn(() => []),
          run: vi.fn((name: string) => {
            if (!withMigrationsTable) {
              throw new Error('no such table: schema_migrations')
            }
            if (markFailer) markFailer()
            migrations.add(name)
          })
        }
      }

      return { get: vi.fn(), all: vi.fn(() => []), run: vi.fn() }
    }),
    transaction: vi.fn(<T, A>(fn: (arg: A) => T): ((arg: A) => T) => {
      return (arg: A) => fn(arg)
    })
  }

  return {
    db: db as unknown as DatabaseType.Database,
    _mediaFiles: mediaFiles,
    _migrations: migrations,
    _updateCalls: updateCalls,
    _setMarkFailer: (failer) => {
      markFailer = failer
    },
    _setQueryFailer: (failer) => {
      queryFailer = failer
    }
  }
}

function insertRow(mock: MockDb, filePath: string, thumbnail: string | null): number {
  const id = mock._mediaFiles.length + 1
  mock._mediaFiles.push({ id, file_path: filePath, thumbnail })
  return id
}

// ============ 真实临时文件（fs.existsSync 走真实磁盘） ============

let tmpRoot: string
// HQ 图片 a：存在同名 LQ → 应回填
let hqWithLq: string
let lqOfA: string
// HQ 图片 b：LQ 缺失 → 不回填
let hqNoLq: string
// 非游戏路径图片（仅路径用于行数据，文件不必真实存在）
const NON_GAME_PATH = 'D:\\photos\\vacation\\c.jpg'
// 评审收紧：含 gameplayphotos 但无完整游戏目录特征的同名用户目录（不应命中候选条件）
const SAME_NAME_USER_PATH = 'C:\\backup\\GamePlayPhotos\\123456789\\NikkiPhotos_HighQuality\\a.jpg'

beforeAll(async () => {
  tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nikki-repair-v6-'))
  const uidDir = path.join(tmpRoot, 'X6Game', 'Saved', 'GamePlayPhotos', '123456789')
  const hqDir = path.join(uidDir, 'NikkiPhotos_HighQuality')
  const lqDir = path.join(uidDir, 'NikkiPhotos_LowQuality')
  await fs.promises.mkdir(hqDir, { recursive: true })
  await fs.promises.mkdir(lqDir, { recursive: true })
  hqWithLq = path.join(hqDir, 'a.jpg')
  lqOfA = path.join(lqDir, 'a.jpg')
  hqNoLq = path.join(hqDir, 'b.jpg')
  await fs.promises.writeFile(hqWithLq, 'hq-a')
  await fs.promises.writeFile(lqOfA, 'lq-a')
  await fs.promises.writeFile(hqNoLq, 'hq-b')
})

afterAll(async () => {
  await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
})

describe('repairLegacyDataV6', () => {
  it('1. 存量 HQ 行 + 同名 LQ 存在 → 回填为 LQ 路径', () => {
    const mock = createMockDb()
    const id = insertRow(mock, hqWithLq, null)

    const log = vi.fn()
    const result = repairLegacyDataV6(mock.db, log)

    expect(result).toBe(true)
    expect(mock._updateCalls).toEqual([{ id, thumbnail: lqOfA }])
    expect(mock._mediaFiles.find((f) => f.id === id)?.thumbnail).toBe(lqOfA)
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('回填游戏原生低清缩略图'))
    expect(mock._migrations.has('repair_legacy_data_v6')).toBe(true)
  })

  it('2. LQ 缺失 → 不回填（仍写迁移标记，返回 true）', () => {
    const mock = createMockDb()
    insertRow(mock, hqNoLq, null)

    const log = vi.fn()
    const result = repairLegacyDataV6(mock.db, log)

    expect(result).toBe(true)
    expect(mock._updateCalls).toHaveLength(0)
    expect(mock._migrations.has('repair_legacy_data_v6')).toBe(true)
    expect(log).not.toHaveBeenCalled()
  })

  it('3. 幂等：重复执行第二次直接跳过（迁移标记早退）', () => {
    const mock = createMockDb()
    insertRow(mock, hqWithLq, null)

    const first = repairLegacyDataV6(mock.db, vi.fn())
    const second = repairLegacyDataV6(mock.db, vi.fn())

    expect(first).toBe(true)
    expect(second).toBe(true)
    // 第二次因迁移标记已存在而早退，总 UPDATE 仅 1 次
    expect(mock._updateCalls).toHaveLength(1)
  })

  it('4. 非游戏路径行不受影响（无 UPDATE）', () => {
    const mock = createMockDb()
    insertRow(mock, NON_GAME_PATH, null)
    // 评审收紧：同名但无 \X6Game\Saved\ 前缀的用户目录同样不命中候选条件（即使 LQ 存在）
    insertRow(mock, SAME_NAME_USER_PATH, null)
    // 已关联原生缩略图的 HQ 行也不应再被选中（不命中候选条件）
    const lqLinked = hqWithLq.replace('a.jpg', 'linked.jpg')
    insertRow(mock, hqWithLq, lqLinked)

    const log = vi.fn()
    const result = repairLegacyDataV6(mock.db, log)

    expect(result).toBe(true)
    expect(mock._updateCalls).toHaveLength(0)
    expect(log).not.toHaveBeenCalled()
  })

  it('5. thumbnail 指向生成缩略图目录（%thumbnails%）的 HQ 行同样回填', () => {
    const mock = createMockDb()
    const id = insertRow(mock, hqWithLq, 'C:\\userdata\\thumbnails\\abc.jpg')

    const result = repairLegacyDataV6(mock.db, vi.fn())

    expect(result).toBe(true)
    expect(mock._updateCalls).toEqual([{ id, thumbnail: lqOfA }])
  })

  it('6. schema_migrations 缺失降级：主流程仍执行，标记失败仅 warn', () => {
    const mock = createMockDb({ withMigrationsTable: false })
    insertRow(mock, hqWithLq, null)

    const log = vi.fn()
    const result = repairLegacyDataV6(mock.db, log)

    expect(result).toBe(true)
    expect(mock._updateCalls).toHaveLength(1)
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('标记迁移状态失败'),
      expect.any(String)
    )
  })

  it('7. 主流程异常时 log error 且返回 false', () => {
    const mock = createMockDb()
    insertRow(mock, hqWithLq, null)
    mock._setQueryFailer(() => {
      throw new Error('database is locked')
    })

    const log = vi.fn()
    const result = repairLegacyDataV6(mock.db, log)

    expect(result).toBe(false)
    expect(mock._updateCalls).toHaveLength(0)
    expect(mock._migrations.has('repair_legacy_data_v6')).toBe(false)
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('repairLegacyDataV6 失败'),
      'database is locked'
    )
  })

  it('8. 标记迁移 INSERT 失败仅 log warn 且仍返回 true', () => {
    const mock = createMockDb()
    insertRow(mock, hqWithLq, null)
    mock._setMarkFailer(() => {
      throw new Error('disk full')
    })

    const log = vi.fn()
    const result = repairLegacyDataV6(mock.db, log)

    expect(result).toBe(true)
    expect(mock._updateCalls).toHaveLength(1)
    expect(mock._migrations.has('repair_legacy_data_v6')).toBe(false)
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('标记迁移状态失败'),
      'disk full'
    )
  })
})
