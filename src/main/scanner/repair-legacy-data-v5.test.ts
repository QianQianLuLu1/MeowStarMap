/**
 * @layer L1
 * @module src/main/scanner/repair-legacy-data-v5
 * @coverage repairLegacyDataV5 迁移幂等早退 / schema_migrations 缺失降级 / X6Game ScreenShot&Video 误标重分类 / 标记容错 / 异常返回 false
 * @dependencies better-sqlite3（mock，因 native 模块为 Electron 编译无法在 vitest/node 运行）
 * @remarks 验证"误标记为 launcher 的 X6Game/ScreenShot、X6Game/Video 记录重分类为 game"的分支行为（独立于 path-classifier 规则）
 */
import { describe, it, expect, vi } from 'vitest'
import { repairLegacyDataV5 } from './repair-legacy-data-v5'
import type DatabaseType from 'better-sqlite3'

interface MediaRow {
  id: number
  file_path: string
}

interface MockDb {
  db: DatabaseType.Database
  _mediaFiles: MediaRow[]
  _migrations: Set<string>
  _updateCalls: Array<{ id: number; source: string }>
  _setMarkFailer: (failer: (() => void) | null) => void
  _setQueryFailer: (failer: (() => void) | null) => void
}

// V5 的命中条件（与 repair-legacy-data-v5.ts 中 SQL LIKE 完全一致，用于 mock 过滤）
function isV5Match(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/').toLowerCase()
  return norm.includes('/x6game/screenshot/') || norm.includes('/x6game/video/')
}

function createMockDb(opts: { withMigrationsTable?: boolean } = {}): MockDb {
  const mediaFiles: MediaRow[] = []
  const migrations = new Set<string>()
  const updateCalls: Array<{ id: number; source: string }> = []
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

      // V5 的查询：media_source = 'launcher' AND (LIKE screenshot OR LIKE video)
      if (lower.includes("media_source = 'launcher'") && lower.includes('from media_files')) {
        return {
          get: vi.fn(),
          all: vi.fn(() => {
            if (queryFailer) queryFailer()
            // mock 端模拟 SQL LIKE 过滤（仅返回路径命中 X6Game/ScreenShot、X6Game/Video 的 launcher 行）
            // 测试中所有插入行均代表 launcher 记录，故仅按 V5 路径命中过滤即可
            return mediaFiles
              .filter((f) => isV5Match(f.file_path))
              .map((f) => ({ id: f.id, file_path: f.file_path }))
          }),
          run: vi.fn()
        }
      }

      if (lower.startsWith('update media_files set media_source = ?')) {
        return {
          get: vi.fn(),
          all: vi.fn(() => []),
          run: vi.fn((source: string, id: number) => {
            updateCalls.push({ id, source })
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

function insertRow(mock: MockDb, filePath: string): number {
  const id = mock._mediaFiles.length + 1
  mock._mediaFiles.push({ id, file_path: filePath })
  return id
}

describe('repairLegacyDataV5', () => {
  it('1. 迁移已应用时早退：返回 true，且不查询 media_files', () => {
    const mock = createMockDb()
    mock._migrations.add('repair_legacy_data_v5')
    insertRow(mock, 'C:\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\ScreenShot\\a.jpg')

    const result = repairLegacyDataV5(mock.db, vi.fn())

    expect(result).toBe(true)
    const prepared = (mock.db.prepare as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]).toLowerCase()
    )
    expect(prepared.some((sql) => sql.includes('from media_files'))).toBe(false)
    expect(mock._migrations.has('repair_legacy_data_v5')).toBe(true)
  })

  it('2. schema_migrations 查询抛错时降级继续执行主流程', () => {
    const mock = createMockDb({ withMigrationsTable: false })
    insertRow(mock, 'C:\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\ScreenShot\\a.jpg')

    const log = vi.fn()
    const result = repairLegacyDataV5(mock.db, log)

    expect(result).toBe(true)
    expect(mock._updateCalls).toHaveLength(1)
    expect(mock._updateCalls[0].source).toBe('game')
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('标记迁移状态失败'),
      expect.any(String)
    )
  })

  it('3. 无命中记录时不做 UPDATE、不记 info 日志，仍写迁移标记', () => {
    const mock = createMockDb()
    // 非 X6Game ScreenShot/Video 的 launcher 记录（不应被重分类）
    insertRow(mock, 'D:\\Launcher\\cache\\bg.jpg')

    const log = vi.fn()
    const result = repairLegacyDataV5(mock.db, log)

    expect(result).toBe(true)
    expect(mock._updateCalls).toHaveLength(0)
    expect(log).not.toHaveBeenCalled()
    expect(mock.db.transaction).not.toHaveBeenCalled()
    expect(mock._migrations.has('repair_legacy_data_v5')).toBe(true)
  })

  it('4. 仅 X6Game/ScreenShot 与 X6Game/Video 命中重分类为 game，其余 launcher 跳过', () => {
    const mock = createMockDb()
    const idShot = insertRow(
      mock,
      'C:\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\ScreenShot\\a.png'
    )
    const idVideo = insertRow(
      mock,
      'C:\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\Video\\b.mp4'
    )
    // 以下不应被重分类
    const idSaved = insertRow(
      mock,
      'C:\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\Saved\\ScreenShot\\c.jpg'
    )
    const idOther = insertRow(mock, 'D:\\Launcher\\cache\\bg.jpg')
    const idGameNonLauncher = insertRow(mock, 'C:\\Games\\OtherGame\\ScreenShot\\d.jpg')

    const log = vi.fn()
    const result = repairLegacyDataV5(mock.db, log)

    expect(result).toBe(true)
    expect(mock._updateCalls).toEqual([
      { id: idShot, source: 'game' },
      { id: idVideo, source: 'game' }
    ])
    expect(
      mock._updateCalls.some(
        (u) => u.id === idSaved || u.id === idOther || u.id === idGameNonLauncher
      )
    ).toBe(false)
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('重新分类 2 条'))
    expect(mock._migrations.has('repair_legacy_data_v5')).toBe(true)
  })

  it('5. 标记迁移 INSERT 失败仅 log warn 且仍返回 true', () => {
    const mock = createMockDb()
    insertRow(mock, 'C:\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\Video\\a.mp4')
    mock._setMarkFailer(() => {
      throw new Error('disk full')
    })

    const log = vi.fn()
    const result = repairLegacyDataV5(mock.db, log)

    expect(result).toBe(true)
    expect(mock._updateCalls).toHaveLength(1)
    expect(mock._migrations.has('repair_legacy_data_v5')).toBe(false)
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('标记迁移状态失败'),
      'disk full'
    )
    expect(log.mock.calls.some((c) => c[0] === 'error')).toBe(false)
  })

  it('6. 主流程异常时 log error 且返回 false', () => {
    const mock = createMockDb()
    insertRow(mock, 'C:\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\ScreenShot\\a.jpg')
    mock._setQueryFailer(() => {
      throw new Error('database is locked')
    })

    const log = vi.fn()
    const result = repairLegacyDataV5(mock.db, log)

    expect(result).toBe(false)
    expect(mock._updateCalls).toHaveLength(0)
    expect(mock._migrations.has('repair_legacy_data_v5')).toBe(false)
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('repairLegacyDataV5 失败'),
      'database is locked'
    )
  })

  it('7. 幂等：重复执行不重复 UPDATE', () => {
    const mock = createMockDb()
    insertRow(mock, 'C:\\InfinityNikki Launcher\\InfinityNikki\\X6Game\\ScreenShot\\a.png')

    const first = repairLegacyDataV5(mock.db, vi.fn())
    const second = repairLegacyDataV5(mock.db, vi.fn())

    expect(first).toBe(true)
    expect(second).toBe(true)
    // 第二次因迁移标记已存在而早退，总 UPDATE 仅 1 次
    expect(mock._updateCalls).toHaveLength(1)
  })
})
