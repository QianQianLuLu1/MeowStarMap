/**
 * @layer L1
 * @module src/main/scanner/repair-legacy-data-v3
 * @coverage repairLegacyDataV3 NULL media_source 强制修复
 * @dependencies better-sqlite3（mock，因 native 模块为 Electron 编译无法在 vitest/node 运行）
 * @remarks 纯逻辑测试，验证 NULL 修复幂等性、迁移标记、降级路径
 */
import { describe, it, expect, vi } from 'vitest'
import { repairLegacyDataV3 } from './repair-legacy-data-v3'
import type DatabaseType from 'better-sqlite3'

/**
 * 轻量 SQLite mock，仅实现 repairLegacyDataV3 用到的接口（prepare/get/run/exec）
 * 用内存 Map 模拟表数据，避免依赖 better-sqlite3 native 模块
 */
function createMockDb(withMigrationsTable = true): DatabaseType.Database & {
  _insertMediaFile: (filePath: string, mediaSource: string | null) => void
  _getMediaFiles: () => Array<{ file_path: string; media_source: string | null }>
  _hasMigration: (name: string) => boolean
} {
  const mediaFiles: Array<{ id: number; file_path: string; media_source: string | null }> = []
  const migrations = new Set<string>()
  let nextId = 1

  const db = {
    exec: vi.fn((sql: string) => {
      // CREATE TABLE IF NOT EXISTS - 仅记录表存在，数据通过 _insertMediaFile 注入
      void sql
    }),
    prepare: vi.fn((sql: string) => {
      const lowerSql = sql.toLowerCase()

      return {
        get: vi.fn((...params: unknown[]) => {
          // SELECT 1 FROM schema_migrations WHERE name = ?
          if (lowerSql.startsWith('select 1 from schema_migrations')) {
            const name = params[0] as string
            return migrations.has(name) ? { '1': 1 } : undefined
          }
          // SELECT COUNT(*) as count FROM media_files WHERE media_source IS NULL
          if (
            lowerSql.includes('select count(*) as count from media_files') &&
            lowerSql.includes('media_source is null')
          ) {
            return { count: mediaFiles.filter((f) => f.media_source === null).length }
          }
          return undefined
        }),
        run: vi.fn((...params: unknown[]) => {
          // UPDATE media_files SET media_source = 'game' WHERE media_source IS NULL
          if (lowerSql.startsWith('update media_files set media_source')) {
            for (const f of mediaFiles) {
              if (f.media_source === null) {
                f.media_source = 'game'
              }
            }
            return
          }
          // INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, datetime('now'))
          if (lowerSql.startsWith('insert or ignore into schema_migrations')) {
            const name = params[0] as string
            migrations.add(name)
            return
          }
        })
      }
    }),
    _insertMediaFile: (filePath: string, mediaSource: string | null) => {
      mediaFiles.push({ id: nextId++, file_path: filePath, media_source: mediaSource })
    },
    _getMediaFiles: () =>
      mediaFiles.map((f) => ({ file_path: f.file_path, media_source: f.media_source })),
    _hasMigration: (name: string) => migrations.has(name)
  }

  // 模拟 schema_migrations 表不存在：prepare 抛异常
  if (!withMigrationsTable) {
    const originalPrepare = db.prepare
    db.prepare = vi.fn((sql: string) => {
      if (sql.toLowerCase().includes('schema_migrations')) {
        throw new Error('no such table: schema_migrations')
      }
      return originalPrepare(sql)
    }) as never
  }

  return db as unknown as DatabaseType.Database & {
    _insertMediaFile: (filePath: string, mediaSource: string | null) => void
    _getMediaFiles: () => Array<{ file_path: string; media_source: string | null }>
    _hasMigration: (name: string) => boolean
  }
}

const silentLog = vi.fn()

describe('repairLegacyDataV3', () => {
  it('应修复所有 media_source IS NULL 的记录为 game', () => {
    const db = createMockDb()
    db._insertMediaFile('a.jpg', null)
    db._insertMediaFile('b.jpg', null)
    db._insertMediaFile('c.jpg', 'game')

    repairLegacyDataV3(db, silentLog)

    const files = db._getMediaFiles()
    expect(files.every((f) => f.media_source === 'game')).toBe(true)
    expect(files.filter((f) => f.media_source === 'game')).toHaveLength(3)
  })

  it('应写入 schema_migrations 标记，二次调用不重复执行 UPDATE', () => {
    const db = createMockDb()
    db._insertMediaFile('a.jpg', null)

    // 第一次调用：修复 + 写标记
    repairLegacyDataV3(db, silentLog)
    expect(db._hasMigration('repair_legacy_data_v3')).toBe(true)
    expect(db._getMediaFiles()[0].media_source).toBe('game')

    // 插入新的 NULL 记录，验证二次调用因标记存在而跳过
    db._insertMediaFile('b.jpg', null)
    repairLegacyDataV3(db, silentLog)

    // b.jpg 应仍为 NULL（标记已存在，跳过修复）
    const bFile = db._getMediaFiles().find((f) => f.file_path === 'b.jpg')
    expect(bFile?.media_source).toBeNull()
  })

  it('无 NULL 记录时不应报错，仍应写入迁移标记', () => {
    const db = createMockDb()
    db._insertMediaFile('a.jpg', 'game')

    repairLegacyDataV3(db, silentLog)

    expect(db._getMediaFiles()).toHaveLength(1)
    expect(db._getMediaFiles()[0].media_source).toBe('game')
    // 即使无 NULL 记录，标记也应写入（表示迁移已执行）
    expect(db._hasMigration('repair_legacy_data_v3')).toBe(true)
  })

  it('修复 NULL 记录时应记录 warn 日志', () => {
    const db = createMockDb()
    const log = vi.fn()
    db._insertMediaFile('a.jpg', null)

    repairLegacyDataV3(db, log)

    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining("强制修复 1 条 media_source IS NULL 记录为 'game'")
    )
  })

  it('schema_migrations 表不存在时应降级执行修复（不抛出）', () => {
    const db = createMockDb(false)
    db._insertMediaFile('a.jpg', null)

    // 标记检查会抛异常，但应被 catch 降级，继续执行修复
    expect(() => repairLegacyDataV3(db, silentLog)).not.toThrow()

    // 修复应已执行
    const files = db._getMediaFiles()
    expect(files[0].media_source).toBe('game')
  })
})
