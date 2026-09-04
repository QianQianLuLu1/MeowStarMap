/**
 * @layer L1
 * @module src/main/scanner/repair-legacy-data-v3
 * @coverage repairLegacyDataV3 迁移幂等早退 / schema_migrations 缺失降级 / NULL 修复条件执行 / 标记容错 / 异常返回 false
 * @dependencies better-sqlite3（mock，因 native 模块为 Electron 编译无法在 vitest/node 运行）
 * @remarks 验证"强制修复 NULL media_source 为 'game'"的分支行为与幂等性
 */
import { describe, it, expect, vi } from 'vitest'
import { repairLegacyDataV3 } from './repair-legacy-data-v3'
import type DatabaseType from 'better-sqlite3'

interface MockDb {
  db: DatabaseType.Database
  _migrations: Set<string>
  _nullCount: () => number
  _updateRunCount: () => number
  _setNullCount: (n: number) => void
  _setMarkFailer: (failer: (() => void) | null) => void
  _setCountFailer: (failer: (() => void) | null) => void
}

/**
 * 轻量 db 桩，覆盖 repairLegacyDataV3 用到的 SQL 模式：
 * - SELECT 1 FROM schema_migrations WHERE name = ?（可配置抛错模拟表不存在）
 * - SELECT COUNT(*) as count FROM media_files WHERE media_source IS NULL（可配置抛错）
 * - UPDATE media_files SET media_source = 'game' WHERE media_source IS NULL
 * - INSERT OR IGNORE INTO schema_migrations（可配置抛错模拟标记失败）
 */
function createMockDb(opts: { withMigrationsTable?: boolean } = {}): MockDb {
  const migrations = new Set<string>()
  let nullCount = 0
  let updateRuns = 0
  let markFailer: (() => void) | null = null
  let countFailer: (() => void) | null = null
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

      if (lower.includes('select count(*) as count') && lower.includes('media_source is null')) {
        return {
          get: vi.fn(() => {
            if (countFailer) countFailer()
            return { count: nullCount }
          }),
          all: vi.fn(() => []),
          run: vi.fn()
        }
      }

      if (
        lower.startsWith("update media_files set media_source = 'game'") &&
        lower.includes('is null')
      ) {
        return {
          get: vi.fn(),
          all: vi.fn(() => []),
          run: vi.fn(() => {
            updateRuns++
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
    })
  }

  return {
    db: db as unknown as DatabaseType.Database,
    _migrations: migrations,
    _nullCount: () => nullCount,
    _updateRunCount: () => updateRuns,
    _setNullCount: (n) => {
      nullCount = n
    },
    _setMarkFailer: (failer) => {
      markFailer = failer
    },
    _setCountFailer: (failer) => {
      countFailer = failer
    }
  }
}

describe('repairLegacyDataV3', () => {
  it('1. 迁移已应用时早退：返回 true，不查询 NULL 计数', () => {
    const mock = createMockDb()
    mock._migrations.add('repair_legacy_data_v3')
    mock._setNullCount(5)

    const result = repairLegacyDataV3(mock.db, vi.fn())

    expect(result).toBe(true)
    expect(mock._updateRunCount()).toBe(0)
    // 早退：COUNT 语句从未 prepare
    const prepared = (mock.db.prepare as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]).toLowerCase()
    )
    expect(prepared.some((sql) => sql.includes('count(*)'))).toBe(false)
  })

  it('2. schema_migrations 查询抛错时降级继续执行主流程', () => {
    const mock = createMockDb({ withMigrationsTable: false })
    mock._setNullCount(2)

    const log = vi.fn()
    const result = repairLegacyDataV3(mock.db, log)

    expect(result).toBe(true)
    expect(mock._updateRunCount()).toBe(1)
    // 标记写入失败（表不存在）仅 warn，不影响成功返回
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('标记迁移状态失败'),
      expect.any(String)
    )
    expect(log.mock.calls.some((c) => c[0] === 'error')).toBe(false)
  })

  it('3. 无 NULL 记录时不执行 UPDATE、不记日志，仍写迁移标记', () => {
    const mock = createMockDb()
    mock._setNullCount(0)

    const log = vi.fn()
    const result = repairLegacyDataV3(mock.db, log)

    expect(result).toBe(true)
    expect(mock._updateRunCount()).toBe(0)
    expect(log).not.toHaveBeenCalled()
    expect(mock._migrations.has('repair_legacy_data_v3')).toBe(true)
  })

  it('4. 有 NULL 记录时执行 UPDATE 并输出 warn 统计日志（含条数）', () => {
    const mock = createMockDb()
    mock._setNullCount(3)

    const log = vi.fn()
    const result = repairLegacyDataV3(mock.db, log)

    expect(result).toBe(true)
    expect(mock._updateRunCount()).toBe(1)
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('强制修复 3 条 media_source IS NULL 记录')
    )
    expect(mock._migrations.has('repair_legacy_data_v3')).toBe(true)
  })

  it('5. 标记迁移 INSERT 失败仅 log warn 且仍返回 true', () => {
    const mock = createMockDb()
    mock._setNullCount(1)
    mock._setMarkFailer(() => {
      throw new Error('disk full')
    })

    const log = vi.fn()
    const result = repairLegacyDataV3(mock.db, log)

    expect(result).toBe(true)
    expect(mock._updateRunCount()).toBe(1)
    expect(mock._migrations.has('repair_legacy_data_v3')).toBe(false)
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('标记迁移状态失败'),
      'disk full'
    )
    expect(log.mock.calls.some((c) => c[0] === 'error')).toBe(false)
  })

  it('6. 主流程异常时 log error 且返回 false', () => {
    const mock = createMockDb()
    mock._setCountFailer(() => {
      throw new Error('database is locked')
    })

    const log = vi.fn()
    const result = repairLegacyDataV3(mock.db, log)

    expect(result).toBe(false)
    expect(mock._updateRunCount()).toBe(0)
    expect(mock._migrations.has('repair_legacy_data_v3')).toBe(false)
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('repairLegacyDataV3 失败'),
      'database is locked'
    )
  })

  it('7. 主流程异常为非 Error 值时以 String(err) 记录', () => {
    const mock = createMockDb()
    mock._setCountFailer(() => {
      throw 'plain-string-failure'
    })

    const log = vi.fn()
    const result = repairLegacyDataV3(mock.db, log)

    expect(result).toBe(false)
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('repairLegacyDataV3 失败'),
      'plain-string-failure'
    )
  })
})
