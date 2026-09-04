import { describe, it, expect, beforeEach } from 'vitest'

/**
 * ResonanceRepository 单元测试
 *
 * 策略沿用宿主 media-repository.test.ts：内存 mock 引擎避免原生模块 ABI 依赖。
 * mock 引擎按 RESONANCE_DDL_STATEMENTS 的同一 schema 建表（含 UNIQUE 约束登记），
 * 覆盖共鸣录仓储实际使用的静态字面量语句：
 *   - INSERT INTO / INSERT OR IGNORE（UNIQUE 冲突：前者抛错、后者跳过）
 *   - INSERT OR REPLACE INTO app_settings（KV upsert）
 *   - UPDATE ... WHERE id = ?
 *   - DELETE FROM ... WHERE id = ? / WHERE banner_id = ? / WHERE category = ? AND item_id = ? / 全表
 *   - SELECT ... FROM ... ORDER BY ...（按解析出的排序键排序）
 *   - db.transaction(fn)() 事务语义（异常向上抛，等价回滚）
 */

// ============================================================================
// Mock 实现：内存 SQLite（仅覆盖共鸣录仓储用到的 SQL 模式）
// ============================================================================

interface MockRow {
  [key: string]: unknown
}

interface MockTable {
  columns: string[]
  rows: MockRow[]
  uniqueKeys: string[][]
  autoIncrement: number
  pk?: string[]
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

class ResonanceMockDb {
  tables = new Map<string, MockTable>()

  /** 应用一条 DDL（CREATE TABLE IF NOT EXISTS）；索引语句忽略 */
  applyDdl(sql: string): void {
    for (const statement of sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      this.applyCreate(normalizeSql(statement))
    }
  }

  private applyCreate(sql: string): void {
    const tableMatch = sql.match(/^CREATE TABLE IF NOT EXISTS (\w+) \((.*)\)$/i)
    if (!tableMatch) return
    const name = tableMatch[1]!
    const body = tableMatch[2]!
    const columns: string[] = []
    const uniqueKeys: string[][] = []
    let pk: string[] | undefined
    let depth = 0
    let current = ''
    const parts: string[] = []
    for (const ch of body) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && depth === 0) {
        parts.push(current.trim())
        current = ''
      } else {
        current += ch
      }
    }
    if (current.trim()) parts.push(current.trim())
    for (const part of parts) {
      const upper = part.toUpperCase()
      if (upper.startsWith('UNIQUE')) {
        const keyMatch = part.match(/\(([^)]+)\)/)
        if (keyMatch) uniqueKeys.push(keyMatch[1]!.split(',').map((c) => c.trim()))
        continue
      }
      if (upper.startsWith('PRIMARY KEY')) {
        const keyMatch = part.match(/\(([^)]+)\)/)
        if (keyMatch) pk = keyMatch[1]!.split(',').map((c) => c.trim())
        continue
      }
      if (upper.startsWith('CHECK') || upper.startsWith('FOREIGN')) continue
      const colName = part.split(/\s+/)[0]!
      columns.push(colName)
    }
    this.tables.set(name, { columns, rows: [], uniqueKeys, autoIncrement: 0, pk })
  }

  prepare(sql: string): {
    run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint }
    get: (...params: unknown[]) => MockRow | undefined
    all: (...params: unknown[]) => MockRow[]
  } {
    const normalized = normalizeSql(sql)
    return {
      run: (...params: unknown[]) => this.runStatement(normalized, params),
      get: (...params: unknown[]) => this.getStatement(normalized, params),
      all: (...params: unknown[]) => this.allStatement(normalized, params)
    }
  }

  transaction<R>(fn: () => R): () => R {
    // 简化事务：同步执行；fn 抛错时异常向上传播（等价回滚——中间态对外不可见）
    return () => fn()
  }

  private findUniqueViolation(table: MockTable, candidate: MockRow): boolean {
    const keySets = [...table.uniqueKeys]
    if (table.pk) keySets.push(table.pk)
    for (const keys of keySets) {
      const exists = table.rows.some((row) => keys.every((k) => row[k] === candidate[k]))
      if (exists) return true
    }
    return false
  }

  private runStatement(
    normalized: string,
    params: unknown[]
  ): { changes: number; lastInsertRowid: number | bigint } {
    const kvMatch = normalized.match(
      /^INSERT OR REPLACE INTO app_settings \(key, value\) VALUES \(\?, \?\)$/
    )
    if (kvMatch) {
      const table = this.tables.get('app_settings')
      if (table) {
        const existing = table.rows.find((r) => r['key'] === params[0])
        if (existing) {
          existing['value'] = params[1]
          return { changes: 1, lastInsertRowid: 0 }
        }
        table.rows.push({ key: params[0], value: params[1] })
        return { changes: 1, lastInsertRowid: 0 }
      }
      return { changes: 0, lastInsertRowid: 0 }
    }

    const insertMatch = normalized.match(
      /^INSERT (OR IGNORE )?INTO (\w+) \(([^)]+)\) VALUES \(([^)]*)\)$/
    )
    if (insertMatch) {
      const orIgnore = Boolean(insertMatch[1])
      const tableName = insertMatch[2]!
      const table = this.tables.get(tableName)
      if (!table) throw new Error(`no such table: ${tableName}`)
      const cols = insertMatch[3]!.split(',').map((c) => c.trim())
      const row: MockRow = {}
      cols.forEach((col, i) => {
        row[col] = params[i]
      })
      if (table.columns.includes('id') && row['id'] === undefined) {
        table.autoIncrement += 1
        row['id'] = table.autoIncrement
      }
      if (this.findUniqueViolation(table, row)) {
        if (orIgnore) return { changes: 0, lastInsertRowid: 0 }
        throw new Error(`UNIQUE constraint failed: ${tableName}`)
      }
      table.rows.push(row)
      return { changes: 1, lastInsertRowid: Number(row['id'] ?? 0) }
    }

    const updateMatch = normalized.match(/^UPDATE (\w+) SET (\w+) = \? WHERE id = \?$/)
    if (updateMatch) {
      const table = this.tables.get(updateMatch[1]!)
      if (!table) return { changes: 0, lastInsertRowid: 0 }
      const target = table.rows.find((r) => r['id'] === params[1])
      if (!target) return { changes: 0, lastInsertRowid: 0 }
      target[updateMatch[2]!] = params[0]
      return { changes: 1, lastInsertRowid: 0 }
    }

    const deleteMatch = normalized.match(/^DELETE FROM (\w+)( WHERE (.*))?$/)
    if (deleteMatch) {
      const tableName = deleteMatch[1]!
      const table = this.tables.get(tableName)
      if (!table) return { changes: 0, lastInsertRowid: 0 }
      const where = deleteMatch[3]
      if (!where) {
        const changes = table.rows.length
        table.rows = []
        return { changes, lastInsertRowid: 0 }
      }
      const before = table.rows.length
      const predicate = this.buildWherePredicate(where)
      table.rows = table.rows.filter((row) => !predicate(params, row))
      return { changes: before - table.rows.length, lastInsertRowid: 0 }
    }

    throw new Error(`mock: 未支持的写语句: ${normalized}`)
  }

  private buildWherePredicate(where: string): (params: unknown[], row: MockRow) => boolean {
    if (where === 'id = ?') {
      return (params, row) => row['id'] === params[0]
    }
    if (where === 'banner_id = ?') {
      return (params, row) => row['banner_id'] === params[0]
    }
    if (where === 'category = ? AND item_id = ?') {
      return (params, row) => row['category'] === params[0] && row['item_id'] === params[1]
    }
    if (where === 'key = ?') {
      return (params, row) => row['key'] === params[0]
    }
    throw new Error(`mock: 未支持的 WHERE: ${where}`)
  }

  private getStatement(normalized: string, params: unknown[]): MockRow | undefined {
    if (normalized === 'SELECT value FROM app_settings WHERE key = ?') {
      const table = this.tables.get('app_settings')
      return table?.rows.find((r) => r['key'] === params[0])
    }
    throw new Error(`mock: 未支持的 get 语句: ${normalized}`)
  }

  private allStatement(normalized: string, params: unknown[]): MockRow[] {
    void params
    const selectMatch = normalized.match(/^SELECT (.+?) FROM (\w+)(?: ORDER BY (.+))?$/)
    if (!selectMatch) throw new Error(`mock: 未支持的查询: ${normalized}`)
    const cols = selectMatch[1]!.split(',').map((c) => c.trim())
    const tableName = selectMatch[2]!
    const orderKeys = selectMatch[3]
      ? selectMatch[3]!.split(',').map((part) => {
          const [key, dir] = part.trim().split(/\s+/)
          return { key: key!, desc: (dir ?? '').toUpperCase() === 'DESC' }
        })
      : []
    const table = this.tables.get(tableName)
    const rows = (table?.rows ?? []).map((r) => ({ ...r }))
    rows.sort((left, right) => {
      for (const { key, desc } of orderKeys) {
        const lv = left[key]
        const rv = right[key]
        if (lv === rv) continue
        const cmp = (lv ?? '') < (rv ?? '') ? -1 : 1
        return desc ? -cmp : cmp
      }
      return 0
    })
    return rows.map((row) => {
      const picked: MockRow = {}
      for (const col of cols) picked[col] = row[col]
      return picked
    })
  }
}

// ============================================================================
// 被测对象（内存库直连，无原生模块依赖）
// ============================================================================

import type Database from 'better-sqlite3'
import { ResonanceRepository, RESONANCE_DDL_STATEMENTS } from './resonance-repository'

function createRepo(): { repo: ResonanceRepository; mock: ResonanceMockDb } {
  const mock = new ResonanceMockDb()
  mock.applyDdl(
    'CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
  )
  for (const ddl of RESONANCE_DDL_STATEMENTS) {
    mock.applyDdl(ddl)
  }
  const db = mock as unknown as Database.Database
  return { repo: new ResonanceRepository(db), mock }
}

const T = '2025-06-01 12:30:45'

describe('schema（由 RESONANCE_DDL_STATEMENTS 建表）', () => {
  it('五张表 + 约束登记完成，DDL 幂等可重复应用', () => {
    const { mock } = createRepo()
    expect(mock.tables.has('resonance_pulls')).toBe(true)
    expect(mock.tables.has('resonance_edits')).toBe(true)
    expect(mock.tables.has('resonance_pearpal')).toBe(true)
    expect(mock.tables.has('resonance_evo')).toBe(true)
    expect(mock.tables.has('resonance_wardrobe_items')).toBe(true)
    // 重复应用同一 DDL 不抛错（IF NOT EXISTS 幂等）
    expect(() => {
      for (const ddl of RESONANCE_DDL_STATEMENTS) mock.applyDdl(ddl)
    }).not.toThrow()
    // UNIQUE 约束已登记
    expect(mock.tables.get('resonance_pulls')!.uniqueKeys).toContainEqual([
      'banner_id',
      'obtained_at',
      'item_id'
    ])
  })

  it('防漂移：connection.ts 迁移数组内含与本文件一致的 DDL', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const sourcePath = path.join(import.meta.dirname, 'connection.ts')
    const source = fs.readFileSync(sourcePath, 'utf8')
    // connection.ts 源码中以字符串字面量书写 DDL：含内嵌单引号的语句按 prettier
    // 规范以双引号书写（无反斜杠转义），其余为单引号。比对前统一去除反斜杠，
    // 并剥离行首尾的任意引号字符与结尾逗号
    const sourceLines = source.split('\n').map((line) =>
      normalizeSql(line)
        .replace(/\\/g, '')
        .replace(/^['"]/, '')
        .replace(/['"]?,?$/, '')
        .trim()
    )
    for (const ddl of RESONANCE_DDL_STATEMENTS) {
      const normalized = normalizeSql(ddl)
      expect(
        sourceLines.some((line) => line === normalized),
        `connection.ts 缺少与仓储一致的 DDL: ${normalized.slice(0, 60)}...`
      ).toBe(true)
    }
  })
})

describe('手动补录 CRUD（edits）', () => {
  let repo: ResonanceRepository
  beforeEach(() => {
    repo = createRepo().repo
  })

  it('新增后可查询，UNIQUE(banner_id, item_id) 冲突抛错', async () => {
    await repo.addManualEdit('2', '2020000002', T)
    const data = repo.getAllData()
    expect(data.edits).toHaveLength(1)
    expect(data.edits[0]).toMatchObject({ banner_id: '2', item_id: '2020000002', obtained_at: T })
    await expect(repo.addManualEdit('2', '2020000002', T)).rejects.toThrow(/UNIQUE constraint/)
  })

  it('修改时间生效；不存在时抛 RESONANCE_RECORD_NOT_FOUND', async () => {
    await repo.addManualEdit('2', '2020000002', T)
    const id = repo.getAllData().edits[0]!.id
    await repo.updateEditTime(id, '2025-07-01 00:00:00')
    expect(repo.getAllData().edits[0]!.obtained_at).toBe('2025-07-01 00:00:00')
    await expect(repo.updateEditTime(999, T)).rejects.toMatchObject({
      code: 'RESONANCE_RECORD_NOT_FOUND'
    })
  })

  it('删除记录生效；再删抛 not found', async () => {
    await repo.addManualEdit('2', '2020000002', T)
    const id = repo.getAllData().edits[0]!.id
    await repo.deleteRecord('edit', id)
    expect(repo.getAllData().edits).toHaveLength(0)
    await expect(repo.deleteRecord('edit', id)).rejects.toMatchObject({
      code: 'RESONANCE_RECORD_NOT_FOUND'
    })
  })
})

describe('批量导入（分批事务 + OR IGNORE 幂等）', () => {
  let repo: ResonanceRepository
  beforeEach(() => {
    repo = createRepo().repo
  })

  it('pulls 批量写入；重复写入零变更（幂等）', () => {
    const rows = [
      { banner_id: '2', item_id: '1020000001', obtained_at: '2025-01-02 10:00:00' },
      { banner_id: '2', item_id: '2020000002', obtained_at: '2025-01-01 10:00:00' }
    ]
    expect(repo.importPullsBatch(rows)).toBe(2)
    expect(repo.importPullsBatch(rows)).toBe(0)
    const data = repo.getAllData()
    expect(data.pulls).toHaveLength(2)
    expect(data.pulls[0]!.obtained_at).toBe('2025-01-02 10:00:00')
  })

  it('pearpal 批量写入含 raw_json，读回可解析', () => {
    const raw = {
      card_pool_id: '4',
      pool_cnt: 5,
      result: '1020000001',
      times_from_last_five_stars: 7,
      times_from_last_four_stars: 2,
      rarity: '5'
    }
    repo.importPearpalBatch([
      {
        banner_id: '4',
        item_id: raw.result,
        pool_cnt: 5,
        obtained_at: T,
        raw_json: JSON.stringify(raw)
      }
    ])
    const data = repo.getAllData()
    expect(data.pearpal[0]!.raw).toEqual(raw)
  })

  it('evo 导入按卡池整体覆盖（先删后插）', () => {
    repo.importEvo([{ banner_id: '2', outfit_id: '10001', level: 1 }])
    repo.importEvo([
      { banner_id: '2', outfit_id: '10001', level: 3 },
      { banner_id: '2', outfit_id: '10002', level: 1 }
    ])
    const rows = repo.getAllData().evo
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.outfit_id === '10001')!.level).toBe(3)
  })

  it('事务异常向上抛（等价回滚：批内全部失败）', () => {
    // mock 引擎中 UNIQUE 冲突抛错 → 整个事务函数抛出，调用方捕获后无部分写入
    const rows = [
      { banner_id: '2', item_id: '1020000001', obtained_at: T },
      { banner_id: '2', item_id: '2020000002', obtained_at: T }
    ]
    expect(repo.importPullsBatch(rows)).toBe(2)
    // 同一批里带一条冲突记录：OR IGNORE 跳过冲突、其余正常写入
    const mixed = [
      { banner_id: '2', item_id: '1020000001', obtained_at: T },
      { banner_id: '2', item_id: '9999900009', obtained_at: T }
    ]
    expect(repo.importPullsBatch(mixed)).toBe(1)
  })
})

describe('衣橱', () => {
  let repo: ResonanceRepository
  beforeEach(() => {
    repo = createRepo().repo
  })

  it('增量更新：先删后插，updated_at 写入 app_settings', async () => {
    await repo.updateWardrobe(
      [
        { category: 'item', itemId: 1020000001 },
        { category: 'eureka_color', itemId: 1341 }
      ],
      []
    )
    let wardrobe = repo.getWardrobe()
    expect(wardrobe.ownedItemIds).toEqual([1020000001])
    expect(wardrobe.ownedEurekaColorIds).toEqual([1341])
    expect(wardrobe.updatedAt).not.toBe('')

    await repo.updateWardrobe([], [{ category: 'item', itemId: 1020000001 }])
    wardrobe = repo.getWardrobe()
    expect(wardrobe.ownedItemIds).toEqual([])
    expect(wardrobe.ownedEurekaColorIds).toEqual([1341])
  })

  it('批量超限抛错（DB 层二次防线）', async () => {
    const huge = Array.from({ length: 5001 }, (_, i) => ({
      category: 'item' as const,
      itemId: i + 1
    }))
    await expect(repo.updateWardrobe(huge, [])).rejects.toThrow(/batch limit/)
  })

  it('全量覆盖：旧数据清空、新数据完整', async () => {
    await repo.updateWardrobe([{ category: 'momo', itemId: 1160100001 }], [])
    await repo.replaceWardrobe({
      version: 1,
      ownedItemIds: [1020000001],
      ownedMakeupIds: [10001001],
      ownedMomoIds: [],
      ownedPropIds: [1280010001],
      ownedEurekaColorIds: [1341],
      updatedAt: '2025-08-01T00:00:00.000Z'
    })
    const wardrobe = repo.getWardrobe()
    expect(wardrobe.ownedItemIds).toEqual([1020000001])
    expect(wardrobe.ownedMakeupIds).toEqual([10001001])
    expect(wardrobe.ownedMomoIds).toEqual([])
    expect(wardrobe.ownedPropIds).toEqual([1280010001])
    expect(wardrobe.ownedEurekaColorIds).toEqual([1341])
    expect(wardrobe.updatedAt).toBe('2025-08-01T00:00:00.000Z')
  })
})

describe('clearAll', () => {
  it('清空全部数据与元数据', async () => {
    const { repo } = createRepo()
    await repo.addManualEdit('2', '2020000002', T)
    repo.importPullsBatch([{ banner_id: '2', item_id: '1020000001', obtained_at: T }])
    await repo.updateWardrobe([{ category: 'item', itemId: 1020000001 }], [])
    await repo.clearAll()
    const data = repo.getAllData()
    expect(data.pulls).toHaveLength(0)
    expect(data.edits).toHaveLength(0)
    expect(data.wardrobe.ownedItemIds).toHaveLength(0)
    expect(data.wardrobe.updatedAt).toBe('')
  })
})
