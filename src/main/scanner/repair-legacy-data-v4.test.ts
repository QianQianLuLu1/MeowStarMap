/**
 * @layer L1
 * @module src/main/scanner/repair-legacy-data-v4
 * @coverage repairLegacyDataV4 迁移幂等早退 / schema_migrations 缺失降级 / launcher 误标重分类 / 标记容错 / 异常返回 false
 * @dependencies better-sqlite3（mock，因 native 模块为 Electron 编译无法在 vitest/node 运行）
 * @remarks 验证"误标记为 launcher 的记录用新规则重分类"的分支行为；分类逻辑直接复用真实的 extractMediaSourceFromPath
 */
import { describe, it, expect, vi } from 'vitest'
import { repairLegacyDataV4 } from './repair-legacy-data-v4'
import { extractMediaSourceFromPath } from './path-classifier'
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

/**
 * 轻量 db 桩，覆盖 repairLegacyDataV4 用到的 SQL 模式：
 * - SELECT 1 FROM schema_migrations WHERE name = ?（可配置抛错模拟表不存在）
 * - SELECT id, file_path FROM media_files WHERE media_source = 'launcher'（可配置抛错）
 * - UPDATE media_files SET media_source = ? WHERE id = ?
 * - INSERT OR IGNORE INTO schema_migrations（可配置抛错模拟标记失败）
 *
 * transaction(fn) 返回可调用函数，调用时同步执行 fn（模拟 better-sqlite3 同步事务语义）。
 */
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

      if (lower.includes("from media_files where media_source = 'launcher'")) {
        return {
          get: vi.fn(),
          all: vi.fn(() => {
            if (queryFailer) queryFailer()
            return mediaFiles.map((f) => ({ id: f.id, file_path: f.file_path }))
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

// 构造路径前先确认真实分类器行为（测试数据依据真实函数语义构造）
// - launcher\cache / \MallPic\ → 'launcher'（应保持不 UPDATE）
// - \CloudPhotos\xxx\ → 'cloud'，其余 → 'game'（应被重分类）

describe('repairLegacyDataV4', () => {
  it('1. 迁移已应用时早退：返回 true，且不查询 media_files', () => {
    const mock = createMockDb()
    mock._migrations.add('repair_legacy_data_v4')
    insertRow(mock, 'C:\\CloudPhotos\\123\\a.jpg')

    const result = repairLegacyDataV4(mock.db, vi.fn())

    expect(result).toBe(true)
    // 早退：media_files 的 SELECT 语句从未 prepare
    const prepared = (mock.db.prepare as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]).toLowerCase()
    )
    expect(prepared.some((sql) => sql.includes('from media_files'))).toBe(false)
    expect(mock._migrations.has('repair_legacy_data_v4')).toBe(true)
  })

  it('2. schema_migrations 查询抛错时降级继续执行主流程', () => {
    const mock = createMockDb({ withMigrationsTable: false })
    // 误标记为 launcher 的云相册记录 → 新规则应判为 cloud
    insertRow(mock, 'C:\\CloudPhotos\\123\\a.jpg')

    const log = vi.fn()
    const result = repairLegacyDataV4(mock.db, log)

    expect(result).toBe(true)
    expect(mock._updateCalls).toHaveLength(1)
    expect(mock._updateCalls[0].source).toBe('cloud')
    // 标记写入失败（表不存在）仅 warn，不影响成功返回
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('标记迁移状态失败'),
      expect.any(String)
    )
  })

  it('3. 无 launcher 记录时不做 UPDATE、不记 info 日志，仍写迁移标记', () => {
    const mock = createMockDb()

    const log = vi.fn()
    const result = repairLegacyDataV4(mock.db, log)

    expect(result).toBe(true)
    expect(mock._updateCalls).toHaveLength(0)
    // 没有重分类时不输出统计日志，且事务根本不需要创建
    expect(log).not.toHaveBeenCalled()
    expect(mock.db.transaction).not.toHaveBeenCalled()
    expect(mock._migrations.has('repair_legacy_data_v4')).toBe(true)
  })

  it('4. 有记录时：新分类 ≠ launcher 才 UPDATE 并计数；= launcher 跳过', () => {
    const mock = createMockDb()
    // 真实分类器下仍为 launcher 的路径（不应被更新）
    const keepLauncher = 'D:\\Launcher\\cache\\bg.jpg'
    const keepMall = 'D:\\X6Game\\Saved\\MallPic\\https=##webstatic\\1.jpg'
    // 真实分类器下不再是 launcher 的路径（应被重分类）
    const cloudPath = 'C:\\CloudPhotos\\123\\a.jpg'
    const gamePath = 'C:\\GamePlayPhotos\\123456789\\NikkiPhotos_1.jpg'
    expect(extractMediaSourceFromPath(keepLauncher)).toBe('launcher')
    expect(extractMediaSourceFromPath(keepMall)).toBe('launcher')
    expect(extractMediaSourceFromPath(cloudPath)).toBe('cloud')
    expect(extractMediaSourceFromPath(gamePath)).toBe('game')

    const idKeep1 = insertRow(mock, keepLauncher)
    const idKeep2 = insertRow(mock, keepMall)
    const idCloud = insertRow(mock, cloudPath)
    const idGame = insertRow(mock, gamePath)

    const log = vi.fn()
    const result = repairLegacyDataV4(mock.db, log)

    expect(result).toBe(true)
    // 仅 2 条被 UPDATE，且新分类正确
    expect(mock._updateCalls).toEqual([
      { id: idCloud, source: 'cloud' },
      { id: idGame, source: 'game' }
    ])
    expect(mock._updateCalls.some((u) => u.id === idKeep1 || u.id === idKeep2)).toBe(false)
    // 统计日志包含重分类条数
    expect(log).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('重新分类 2 条误标记为 launcher 的记录')
    )
    expect(mock._migrations.has('repair_legacy_data_v4')).toBe(true)
  })

  it('5. 标记迁移 INSERT 失败仅 log warn 且仍返回 true', () => {
    const mock = createMockDb()
    insertRow(mock, 'C:\\CloudPhotos\\123\\a.jpg')
    mock._setMarkFailer(() => {
      throw new Error('disk full')
    })

    const log = vi.fn()
    const result = repairLegacyDataV4(mock.db, log)

    expect(result).toBe(true)
    expect(mock._updateCalls).toHaveLength(1)
    expect(mock._migrations.has('repair_legacy_data_v4')).toBe(false)
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('标记迁移状态失败'),
      'disk full'
    )
    // 不应记录 error
    expect(log.mock.calls.some((c) => c[0] === 'error')).toBe(false)
  })

  it('6. 主流程异常时 log error 且返回 false', () => {
    const mock = createMockDb()
    insertRow(mock, 'C:\\CloudPhotos\\123\\a.jpg')
    mock._setQueryFailer(() => {
      throw new Error('database is locked')
    })

    const log = vi.fn()
    const result = repairLegacyDataV4(mock.db, log)

    expect(result).toBe(false)
    expect(mock._updateCalls).toHaveLength(0)
    expect(mock._migrations.has('repair_legacy_data_v4')).toBe(false)
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('repairLegacyDataV4 失败'),
      'database is locked'
    )
  })

  it('7. 主流程异常为非 Error 值时以 String(err) 记录', () => {
    const mock = createMockDb()
    insertRow(mock, 'C:\\CloudPhotos\\123\\a.jpg')
    mock._setQueryFailer(() => {
      throw 'plain-string-failure'
    })

    const log = vi.fn()
    const result = repairLegacyDataV4(mock.db, log)

    expect(result).toBe(false)
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('repairLegacyDataV4 失败'),
      'plain-string-failure'
    )
  })
})
