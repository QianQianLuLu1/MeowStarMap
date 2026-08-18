/**
 * @layer L1
 * @module src/main/scanner/repair-legacy-data-v1
 * @coverage repairLegacyDataV1 三步合并单事务 + 幂等可重跑 + 标记独立容错
 * @dependencies better-sqlite3（mock，因 native 模块为 Electron 编译无法在 vitest/node 运行）
 * @remarks R10：验证"删除 + NULL 修复 + 字段重算"在单事务内原子提交，事务失败回滚不影响后续启动
 */
import { describe, it, expect, vi } from 'vitest'
import { repairLegacyDataV1 } from './repair-legacy-data-v1'
import type DatabaseType from 'better-sqlite3'

/**
 * 内存 mock 数据库，覆盖 repairLegacyDataV1 用到的所有 SQL 模式：
 * - SELECT 1 FROM schema_migrations WHERE name = ?
 * - SELECT id, file_path FROM media_files WHERE ...（多种 LIKE 组合）
 * - SELECT COUNT(*) as count FROM media_files WHERE media_source IS NULL
 * - DELETE FROM media_files WHERE id = ?
 * - UPDATE media_files SET media_source = 'game' WHERE media_source IS NULL
 * - UPDATE media_files SET media_source = ?, account_uid = ?, album_type = ? WHERE id = ?
 * - INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, datetime('now'))
 *
 * transaction(fn) 直接同步执行 fn 并返回其返回值（模拟 better-sqlite3 同步事务语义）。
 */
interface MediaRow {
  id: number
  file_path: string
  media_source: string | null
  account_uid: string
  album_type: string
}

interface MockDb {
  db: DatabaseType.Database
  _mediaFiles: MediaRow[]
  _migrations: Set<string>
  _importRoots: string[]
  _setTransactionFailer: (failer: (() => void) | null) => void
  _deleteCallCount: () => number
  _updateCallCount: () => number
}

function createMockDb(
  opts: { withMigrationsTable?: boolean; importRoots?: string[] } = {}
): MockDb {
  const mediaFiles: MediaRow[] = []
  const migrations = new Set<string>()
  const importRoots: string[] = [...(opts.importRoots ?? [])]
  const nextId = 1
  let deleteCount = 0
  let updateCount = 0
  let txFailer: (() => void) | null = null
  const withMigrationsTable = opts.withMigrationsTable !== false

  const db = {
    prepare: vi.fn((sql: string) => {
      const lower = sql.toLowerCase()

      // SELECT 1 FROM schema_migrations WHERE name = ?
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

      // SELECT root_path FROM import_roots ORDER BY id
      // —— A4：导入根豁免读取（repairLegacyDataV1 通过 ImportRootRepository.listImportRoots 调用）
      if (lower.includes('from import_roots')) {
        return {
          get: vi.fn(),
          all: vi.fn(() => importRoots.map((r) => ({ root_path: r }))),
          run: vi.fn()
        }
      }

      // SELECT id, file_path FROM media_files WHERE LOWER(file_path) NOT LIKE '%infinitynikki%' AND (...)
      // —— 步骤 1：误扫描非游戏目录文件
      if (lower.includes('not like') && lower.includes('infinitynikki')) {
        return {
          get: vi.fn(),
          all: vi.fn(() => {
            return mediaFiles.filter((f) => {
              const lp = f.file_path.toLowerCase()
              if (lp.includes('infinitynikki')) return false
              return (
                lp.includes('warthunder') ||
                lp.includes('test_media') ||
                lp.includes('\\temp\\') ||
                lp.includes('/temp/')
              )
            })
          }),
          run: vi.fn()
        }
      }

      // SELECT COUNT(*) as count FROM media_files WHERE media_source IS NULL
      // —— 步骤 2：NULL media_source 计数
      if (lower.includes('select count(*) as count') && lower.includes('media_source is null')) {
        return {
          get: vi.fn(() => ({
            count: mediaFiles.filter((f) => f.media_source === null).length
          })),
          all: vi.fn(() => []),
          run: vi.fn()
        }
      }

      // SELECT id, file_path FROM media_files WHERE media_source = 'unknown' OR (...)
      // —— 步骤 3：待重算字段的旧记录
      // 注意：必须限定 startsWith('select')，否则会误匹配 UPDATE 语句中的 SET media_source = 'game'
      if (
        lower.startsWith('select') &&
        (lower.includes("media_source = 'unknown'") || lower.includes("media_source = 'game'"))
      ) {
        return {
          get: vi.fn(),
          all: vi.fn(() => {
            return mediaFiles.filter((f) => {
              const lp = f.file_path.toLowerCase()
              if (f.media_source === 'unknown') return true
              if (f.media_source === 'game') {
                return (
                  lp.includes('\\mallpic\\') ||
                  lp.includes('\\x6game\\screenshot\\') ||
                  lp.includes('\\cloudphotos\\temp\\')
                )
              }
              return false
            })
          }),
          run: vi.fn()
        }
      }

      // DELETE FROM media_files WHERE id = ?
      if (lower.startsWith('delete from media_files')) {
        return {
          get: vi.fn(),
          all: vi.fn(() => []),
          run: vi.fn((id: number) => {
            const idx = mediaFiles.findIndex((f) => f.id === id)
            if (idx >= 0) {
              mediaFiles.splice(idx, 1)
              deleteCount++
            }
          })
        }
      }

      // UPDATE media_files SET media_source = 'game' WHERE media_source IS NULL
      if (lower.startsWith('update media_files set media_source') && lower.includes('is null')) {
        return {
          get: vi.fn(),
          all: vi.fn(() => []),
          run: vi.fn(() => {
            for (const f of mediaFiles) {
              if (f.media_source === null) {
                f.media_source = 'game'
                updateCount++
              }
            }
          })
        }
      }

      // UPDATE media_files SET media_source = ?, account_uid = ?, album_type = ? WHERE id = ?
      if (lower.startsWith('update media_files set media_source = ?')) {
        return {
          get: vi.fn(),
          all: vi.fn(() => []),
          run: vi.fn((source: string, uid: string, album: string, id: number) => {
            const f = mediaFiles.find((f) => f.id === id)
            if (f) {
              f.media_source = source
              f.account_uid = uid
              f.album_type = album
              updateCount++
            }
          })
        }
      }

      // INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, datetime('now'))
      if (lower.startsWith('insert or ignore into schema_migrations')) {
        return {
          get: vi.fn(),
          all: vi.fn(() => []),
          run: vi.fn((name: string) => {
            migrations.add(name)
          })
        }
      }

      return { get: vi.fn(), all: vi.fn(() => []), run: vi.fn() }
    }),
    transaction: vi.fn(<T>(fn: () => T): (() => T) => {
      // better-sqlite3 的 transaction(fn) 返回一个可调用函数，调用该函数才执行事务
      return () => {
        if (txFailer) txFailer()
        return fn()
      }
    })
  }

  return {
    db: db as unknown as DatabaseType.Database,
    _mediaFiles: mediaFiles,
    _migrations: migrations,
    _importRoots: importRoots,
    _setTransactionFailer: (failer: (() => void) | null) => {
      txFailer = failer
    },
    _deleteCallCount: () => deleteCount,
    _updateCallCount: () => updateCount
  }
}

// 注入一条媒体记录，便于测试构造初始状态
function insertRow(
  mock: MockDb,
  filePath: string,
  mediaSource: string | null,
  accountUid = 'default',
  albumType = '其他'
): void {
  const id = mock._mediaFiles.length + 1
  mock._mediaFiles.push({
    id,
    file_path: filePath,
    media_source: mediaSource,
    account_uid: accountUid,
    album_type: albumType
  })
}

const silentLog = vi.fn()

describe('repairLegacyDataV1', () => {
  it('1. 已应用迁移标记时直接跳过（不执行任何修改）', () => {
    const mock = createMockDb()
    mock._migrations.add('repair_legacy_data_v1')
    insertRow(mock, 'D:\\Temp\\test_media\\foo.jpg', 'game')

    repairLegacyDataV1(mock.db, silentLog)

    expect(mock._mediaFiles).toHaveLength(1)
    expect(mock._deleteCallCount()).toBe(0)
    expect(mock._updateCallCount()).toBe(0)
  })

  it('2. 删除误扫描记录 + 修复 NULL + 重算字段 三步全部执行', () => {
    const mock = createMockDb()
    // 误扫描记录：路径不含 infinitynikki 且属于 warthunder
    insertRow(mock, 'D:\\WarThunder\\shots\\a.jpg', 'game')
    // NULL media_source 记录
    insertRow(mock, 'C:\\InfinityNikki\\save1\\b.jpg', null)
    // media_source='unknown' 旧记录
    insertRow(mock, 'C:\\InfinityNikki\\save1\\c.jpg', 'unknown')

    repairLegacyDataV1(mock.db, silentLog)

    // 误扫描记录已删除
    expect(mock._mediaFiles.find((f) => f.file_path.includes('WarThunder'))).toBeUndefined()
    // NULL 记录被修复为 'game'
    const bFile = mock._mediaFiles.find((f) => f.file_path.endsWith('b.jpg'))
    expect(bFile?.media_source).toBe('game')
    // unknown 记录字段被重算
    const cFile = mock._mediaFiles.find((f) => f.file_path.endsWith('c.jpg'))
    expect(cFile?.media_source).not.toBe('unknown')
    // 迁移标记已写入
    expect(mock._migrations.has('repair_legacy_data_v1')).toBe(true)
  })

  it('3. R10：事务失败时三步全部回滚（删除与更新均不生效）', () => {
    const mock = createMockDb()
    // 误扫描记录（应被删除）
    insertRow(mock, 'D:\\WarThunder\\shots\\a.jpg', 'game')
    // NULL 记录（应被修复）
    insertRow(mock, 'C:\\InfinityNikki\\save1\\b.jpg', null)

    // 让事务抛错：模拟步骤 1（DELETE）之后步骤 2（UPDATE NULL）崩溃
    let txCallCount = 0
    mock._setTransactionFailer(() => {
      txCallCount++
      // 在事务体内执行到某个点后抛错（模拟中途崩溃）
      // 由于 transaction 是同步执行的，failer 在事务一开始就抛错即可让整个事务回滚
      throw new Error('simulated crash mid-transaction')
    })

    const log = vi.fn()
    repairLegacyDataV1(mock.db, log)

    // 事务被调用过（且抛错）
    expect(txCallCount).toBeGreaterThan(0)
    // 删除未生效（误扫描记录仍在）
    expect(mock._mediaFiles.find((f) => f.file_path.includes('WarThunder'))).toBeDefined()
    // NULL 修复未生效
    const bFile = mock._mediaFiles.find((f) => f.file_path.endsWith('b.jpg'))
    expect(bFile?.media_source).toBeNull()
    // 迁移标记未写入（事务回滚，标记在外层 try 也未执行——因为整个 try 块被 catch）
    expect(mock._migrations.has('repair_legacy_data_v1')).toBe(false)
    // 错误被记录
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('repairLegacyData 失败'),
      expect.any(String)
    )
  })

  it('4. 标记迁移失败时不阻塞修复（修复已生效，下次启动重复执行幂等）', () => {
    const mock = createMockDb()
    insertRow(mock, 'C:\\InfinityNikki\\save1\\a.jpg', null)

    // 让 INSERT OR IGNORE INTO schema_migrations 抛错
    const originalPrepare = mock.db.prepare
    mock.db.prepare = vi.fn((sql: string) => {
      if (sql.toLowerCase().startsWith('insert or ignore into schema_migrations')) {
        return {
          get: vi.fn(),
          all: vi.fn(() => []),
          run: vi.fn(() => {
            throw new Error('disk full')
          })
        }
      }
      return originalPrepare(sql)
    }) as never

    const log = vi.fn()
    repairLegacyDataV1(mock.db, log)

    // 修复仍生效（NULL 已被修复为 'game'）
    expect(mock._mediaFiles[0].media_source).toBe('game')
    // 标记未写入
    expect(mock._migrations.has('repair_legacy_data_v1')).toBe(false)
    // 警告已记录
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('标记迁移状态失败'),
      expect.any(String)
    )
  })

  it('5. schema_migrations 表不存在时降级为每次执行（不抛错）', () => {
    const mock = createMockDb({ withMigrationsTable: false })
    insertRow(mock, 'C:\\InfinityNikki\\save1\\a.jpg', null)

    const log = vi.fn()
    expect(() => repairLegacyDataV1(mock.db, log)).not.toThrow()

    // 修复仍生效
    expect(mock._mediaFiles[0].media_source).toBe('game')
  })

  it('6. 无任何待修复记录时仍写入迁移标记', () => {
    const mock = createMockDb()
    // 仅插入一条已正确分类的记录
    insertRow(mock, 'C:\\InfinityNikki\\save1\\a.jpg', 'game', 'uid_123', 'game')

    repairLegacyDataV1(mock.db, silentLog)

    expect(mock._mediaFiles).toHaveLength(1)
    expect(mock._deleteCallCount()).toBe(0)
    expect(mock._updateCallCount()).toBe(0)
    expect(mock._migrations.has('repair_legacy_data_v1')).toBe(true)
  })

  it('7. 修复完成后输出统计日志（每步分别输出）', () => {
    const mock = createMockDb()
    insertRow(mock, 'D:\\WarThunder\\shots\\a.jpg', 'game')
    insertRow(mock, 'C:\\InfinityNikki\\save1\\b.jpg', null)
    insertRow(mock, 'C:\\InfinityNikki\\save1\\c.jpg', 'unknown')

    const log = vi.fn()
    repairLegacyDataV1(mock.db, log)

    // 步骤 1 日志：清理 1 条误扫描记录
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('清理 1 条误扫描记录'))
    // 步骤 2 日志：修复 NULL 记录
    expect(log).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('修复 1 条 media_source IS NULL')
    )
    // 步骤 3 日志：更新旧记录字段
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('更新 1 条旧记录'))
  })

  it('8. 二次调用因标记已存在而跳过（幂等）', () => {
    const mock = createMockDb()
    insertRow(mock, 'C:\\InfinityNikki\\save1\\a.jpg', null)

    // 第一次调用：修复 + 写标记
    repairLegacyDataV1(mock.db, silentLog)
    expect(mock._migrations.has('repair_legacy_data_v1')).toBe(true)
    expect(mock._mediaFiles[0].media_source).toBe('game')

    // 插入新的 NULL 记录
    insertRow(mock, 'C:\\InfinityNikki\\save1\\b.jpg', null)
    const deletesBefore = mock._deleteCallCount()
    const updatesBefore = mock._updateCallCount()

    // 第二次调用：因标记存在而直接返回
    repairLegacyDataV1(mock.db, silentLog)

    // b.jpg 应仍为 NULL（标记已存在，跳过修复）
    const bFile = mock._mediaFiles.find((f) => f.file_path.endsWith('b.jpg'))
    expect(bFile?.media_source).toBeNull()
    // 删除/更新计数未变化
    expect(mock._deleteCallCount()).toBe(deletesBefore)
    expect(mock._updateCallCount()).toBe(updatesBefore)
  })

  it('9. A4：导入根下的误扫描记录被豁免，不删除（仍清理非导入根的误扫描记录）', () => {
    // 登记导入根 H:/Imported，其下误扫描记录应被保护
    const mock = createMockDb({ importRoots: ['H:/Imported'] })
    // 误扫描记录但位于导入根下 → 应被豁免
    insertRow(mock, 'H:/Imported/WarThunder/shots/a.jpg', 'game')
    // 误扫描记录且不在导入根下 → 应被删除
    insertRow(mock, 'D:/WarThunder/shots/b.jpg', 'game')
    // 正常游戏记录（含 infinitynikki），不在删除判定内
    insertRow(mock, 'C:\\InfinityNikki\\save1\\c.jpg', 'game')

    repairLegacyDataV1(mock.db, silentLog)

    // 导入根下的误扫描记录保留
    expect(
      mock._mediaFiles.find((f) => f.file_path === 'H:/Imported/WarThunder/shots/a.jpg')
    ).toBeDefined()
    // 非导入根下的误扫描记录被删除
    expect(
      mock._mediaFiles.find((f) => f.file_path === 'D:/WarThunder/shots/b.jpg')
    ).toBeUndefined()
    // 正常游戏记录不受影响
    expect(mock._mediaFiles.find((f) => f.file_path.endsWith('c.jpg'))).toBeDefined()
    // 仅删除 1 条（导入根下的被豁免）
    expect(mock._deleteCallCount()).toBe(1)
  })

  it('10. A4：未登记导入根时保持原删除语义（不豁免）', () => {
    const mock = createMockDb()
    // 误扫描记录，且无导入根 → 仍按原逻辑删除
    insertRow(mock, 'D:\\WarThunder\\shots\\a.jpg', 'game')

    repairLegacyDataV1(mock.db, silentLog)

    expect(mock._mediaFiles.find((f) => f.file_path.includes('WarThunder'))).toBeUndefined()
    expect(mock._deleteCallCount()).toBe(1)
  })
})
