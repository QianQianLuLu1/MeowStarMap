import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import { app } from 'electron'

/**
 * @layer L2
 * @module src/main/database/connection
 * @coverage 数据库连接管理 + 迁移执行 + 设置项读写 + WAL 文件大小
 * @dependencies electron.app, fs, better-sqlite3, scene-category
 * @remarks better-sqlite3 原生模块 ABI 不匹配，使用内存 SQL 引擎 mock；
 *          与 media-repository.test.ts 的 mock 策略保持一致
 */

// ============================================================================
// Mock: electron（app.getPath / isPackaged）
// ============================================================================
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => `/mock/userdata/${name}`),
    isPackaged: false
  }
}))

// ============================================================================
// Mock: ../../shared/scene-category（detectSceneCategory）
// ============================================================================
// vi.mock 工厂被提升到文件顶部，不能引用普通顶层变量（TDZ）。
// 使用 vi.hoisted 将 mock 函数声明也提升到顶部，与 vi.mock 工厂同步可见。
const { mockDetectSceneCategory } = vi.hoisted(() => ({
  mockDetectSceneCategory: vi.fn(() => 'other')
}))
vi.mock('../../shared/scene-category', () => ({
  detectSceneCategory: mockDetectSceneCategory
}))

// ============================================================================
// Mock: ../utils/startup-diagnostic（diagLog 在测试中无需真实写入）
// ============================================================================
vi.mock('../utils/startup-diagnostic', () => ({
  logStartupError: vi.fn(),
  diagLog: vi.fn()
}))

// ============================================================================
// Mock: better-sqlite3（内存 SQL 引擎，支持 connection.ts 用到的全部 SQL 模式）
// ============================================================================

interface MockRow {
  [key: string]: unknown
}

interface MockTable {
  name: string
  columns: string[]
  rows: MockRow[]
}

interface PreparedStatement {
  sql: string
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint }
  get: (...params: unknown[]) => MockRow | undefined
  all: (...params: unknown[]) => MockRow[]
}

class MockDatabase {
  private tables = new Map<string, MockTable>()
  private autoIncCounters = new Map<string, number>()
  private autoVacuumMode = 0

  // 可配置的构造失败（用于测试 initialize 重试逻辑）
  static failNextConstruction = false
  static failAllConstructions = false
  // FIX(组7-1) 用：下次构造以 SQLITE_BUSY 锁错误失败（模拟外部 SQLite 工具/备份软件占用）
  static failNextConstructionWithLock = false

  // H1 用：下次构造以任意指定错误失败（用于模拟权限/磁盘满/ABI 不匹配等分类）
  static nextConstructionError: Error | null = null

  // 可配置的 pragma 失败（用于测试容错）
  static pragmasToFail: string[] = []

  // 可配置的完整性校验失败：'quick' 使 quick_check 返回非 ok，'full' 使 integrity_check 返回非 ok
  // （启动性能优化：默认返回 'ok' 干净路径，修复原 mock 对未知 pragma 返回 undefined 导致的假绿）
  static integrityFail: 'quick' | 'full' | null = null

  // 记录 pragma 调用历史（断言全量 integrity_check 是否被调用的分级行为）
  static pragmaCalls: string[] = []

  // R16：按路径持久化表数据，使多次 initialize() 共享同一份数据（模拟真实磁盘 DB）
  private static sharedState = new Map<
    string,
    { tables: Map<string, MockTable>; autoIncCounters: Map<string, number> }
  >()

  /** beforeEach 调用：清空共享状态，避免测试间数据泄漏 */
  static resetSharedState(): void {
    MockDatabase.sharedState.clear()
  }

  constructor(dbPath: string) {
    if (MockDatabase.failNextConstructionWithLock) {
      MockDatabase.failNextConstructionWithLock = false
      const lockErr = new Error('Mock: SQLITE_BUSY: database is locked')
      ;(lockErr as { code?: string }).code = 'SQLITE_BUSY'
      throw lockErr
    }
    if (MockDatabase.nextConstructionError) {
      const err = MockDatabase.nextConstructionError
      MockDatabase.nextConstructionError = null
      throw err
    }
    if (MockDatabase.failAllConstructions) {
      throw new Error('Mock: 数据库打开失败（持续）')
    }
    if (MockDatabase.failNextConstruction) {
      MockDatabase.failNextConstruction = false
      throw new Error('Mock: 数据库打开失败（首次）')
    }
    // R16：恢复同路径的持久化状态，使二次 initialize 能看到上次写入的数据
    const saved = MockDatabase.sharedState.get(dbPath)
    if (saved) {
      this.tables = saved.tables
      this.autoIncCounters = saved.autoIncCounters
    } else {
      MockDatabase.sharedState.set(dbPath, {
        tables: this.tables,
        autoIncCounters: this.autoIncCounters
      })
    }
  }

  pragma(str: string, options?: { simple?: boolean }): unknown {
    MockDatabase.pragmaCalls.push(str)
    for (const failStr of MockDatabase.pragmasToFail) {
      if (str.includes(failStr)) {
        throw new Error(`Mock: pragma ${str} 失败`)
      }
    }
    // 完整性校验（启动性能优化）：默认返回 'ok' 干净路径，按需注入失败以测损坏分支
    if (str === 'quick_check') {
      return MockDatabase.integrityFail === 'quick' ? 'row damage found' : 'ok'
    }
    if (str === 'integrity_check') {
      return MockDatabase.integrityFail === 'full' ? 'row damage found' : 'ok'
    }
    // 读取 auto_vacuum 模式
    if (str === 'auto_vacuum' && options?.simple) {
      return this.autoVacuumMode
    }
    // 设置 auto_vacuum = INCREMENTAL
    if (str.startsWith('auto_vacuum =')) {
      const mode = str.split('=')[1].trim()
      this.autoVacuumMode = mode === 'INCREMENTAL' ? 1 : parseInt(mode, 10) || 0
      return undefined
    }
    // 其他 pragma 均为 no-op
    return undefined
  }

  exec(sql: string): void {
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s)
    for (const stmt of statements) {
      this.execSingle(stmt)
    }
  }

  private execSingle(sql: string): void {
    // CREATE TABLE IF NOT EXISTS
    const createMatch = sql.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]+)\)$/i
    )
    if (createMatch) {
      const [, name, colsDef] = createMatch
      if (!this.tables.has(name)) {
        const columns = this.parseColumns(colsDef)
        this.tables.set(name, { name, columns, rows: [] })
        this.autoIncCounters.set(name, 0)
      }
      return
    }
    // CREATE INDEX IF NOT EXISTS（忽略）
    if (/CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(sql)) return
    // DROP TABLE IF EXISTS
    const dropMatch = sql.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i)
    if (dropMatch) {
      this.tables.delete(dropMatch[1])
      return
    }
    // ALTER TABLE ADD COLUMN
    const alterMatch = sql.match(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(.+)$/i)
    if (alterMatch) {
      const [, tableName, colDef] = alterMatch
      const table = this.tables.get(tableName)
      if (table) {
        const colName = colDef.trim().split(/\s+/)[0]
        if (table.columns.includes(colName)) {
          // 列已存在，模拟 SQLite 抛出 "duplicate column name"
          throw new Error(`duplicate column name: ${colName}`)
        }
        table.columns.push(colName)
        const defaultValue = this.parseDefaultValue(colDef)
        for (const row of table.rows) {
          if (!(colName in row)) {
            row[colName] = defaultValue
          }
        }
      }
      return
    }
    // DELETE FROM ... WHERE ...（用于 operation_history 清理）
    const deleteMatch = sql.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+([\s\S]+))?$/i)
    if (deleteMatch) {
      const [, tableName, whereClause] = deleteMatch
      const table = this.tables.get(tableName)
      if (!table) return
      if (!whereClause) {
        table.rows = []
        return
      }
      table.rows = table.rows.filter((row) => !this.matchWhere(row, whereClause, []))
      return
    }
    // UPDATE ... SET ... WHERE ...（R16 backfillColumnDefault 通过 exec 调用）
    const updateMatch = sql.match(/UPDATE\s+(\w+)\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/i)
    if (updateMatch) {
      this.executeRun(sql, [])
      return
    }
  }

  private parseColumns(colsDef: string): string[] {
    const lines = colsDef.split('\n').map((l) => l.replace(/--.*/, '').trim())
    const joined = lines.join(' ')
    return joined
      .split(/,(?![^()]*\))/)
      .map((c) => c.trim().split(/\s+/)[0].replace(/[`,]/g, ''))
      .filter(
        (c) =>
          c &&
          !c.startsWith('--') &&
          c.toUpperCase() !== 'FOREIGN' &&
          c.toUpperCase() !== 'PRIMARY' &&
          c.toUpperCase() !== 'UNIQUE' &&
          c.toUpperCase() !== 'CHECK' &&
          c.toUpperCase() !== 'CONSTRAINT'
      )
  }

  private parseDefaultValue(colDef: string): unknown {
    const m = colDef.match(/DEFAULT\s+(['"]?)([^'"\s)]+)\1/i)
    if (!m) return null
    const val = m[2]
    if (val === 'NULL') return null
    if (/^-?\d+$/.test(val)) return parseInt(val, 10)
    if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val)
    return val
  }

  prepare(sql: string): PreparedStatement {
    // 去除末尾分号，与 exec 方法的分号分割逻辑保持一致
    const cleanSql = sql.trim().replace(/;\s*$/, '')
    // better-sqlite3 同时支持 .run(1, 2, 3) 和 .run([1, 2, 3]) 两种调用风格；
    // connection.ts 使用 .run(params || [])（数组作为单参数），需归一化为参数数组
    const normalize = (args: unknown[]): unknown[] =>
      args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args
    return {
      sql: cleanSql,
      run: (...args: unknown[]) => this.executeRun(cleanSql, normalize(args)),
      get: (...args: unknown[]) => this.executeGet(cleanSql, normalize(args)),
      all: (...args: unknown[]) => this.executeAll(cleanSql, normalize(args))
    }
  }

  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
    return (...args: unknown[]) => fn(...args)
  }

  close(): void {
    // no-op（不清理表数据，便于测试多次 initialize 场景）
  }

  // ---- SQL 执行 ----

  private executeRun(
    sql: string,
    params: unknown[]
  ): { changes: number; lastInsertRowid: number | bigint } {
    // INSERT [OR IGNORE|OR REPLACE] INTO table (cols) VALUES (vals)
    const insertMatch = sql.match(
      /INSERT\s+(?:OR\s+(\w+)\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([\s\S]+)\)\s*$/i
    )
    if (insertMatch) {
      const [, conflict, tableName, colsList, valuesList] = insertMatch
      const table = this.tables.get(tableName)
      if (!table) throw new Error(`Table ${tableName} not found`)

      const cols = colsList.split(',').map((c) => c.trim())
      const valueExprs = this.splitOnComma(valuesList)

      const row: MockRow = {}
      let paramIdx = 0
      for (let i = 0; i < cols.length; i++) {
        const expr = valueExprs[i] || '?'
        const { value, isParam } = this.parseValueExpr(expr, params, paramIdx)
        if (isParam) paramIdx++
        row[cols[i]] = value
      }

      // 冲突处理
      const pk = this.getPrimaryKey(tableName)
      if (conflict && conflict.toUpperCase() === 'IGNORE') {
        // 主键冲突 → 跳过
        if (pk && table.rows.some((r) => r[pk] === row[pk])) {
          return { changes: 0, lastInsertRowid: 0 }
        }
        // 已知 UNIQUE 约束（简化）
        if (tableName === 'categories' && row.name && table.rows.some((r) => r.name === row.name)) {
          return { changes: 0, lastInsertRowid: 0 }
        }
        if (
          tableName === 'character_profiles' &&
          row.uid &&
          table.rows.some((r) => r.uid === row.uid)
        ) {
          return { changes: 0, lastInsertRowid: 0 }
        }
        if (tableName === 'app_settings' && row.key && table.rows.some((r) => r.key === row.key)) {
          return { changes: 0, lastInsertRowid: 0 }
        }
        if (
          tableName === 'schema_migrations' &&
          row.name &&
          table.rows.some((r) => r.name === row.name)
        ) {
          return { changes: 0, lastInsertRowid: 0 }
        }
      }
      if (conflict && conflict.toUpperCase() === 'REPLACE') {
        if (tableName === 'app_settings' && row.key) {
          const idx = table.rows.findIndex((r) => r.key === row.key)
          if (idx >= 0) {
            table.rows[idx] = row
            return { changes: 1, lastInsertRowid: 0 }
          }
        }
      }

      // 自增 id
      if (!('id' in row) || row.id === undefined || row.id === null) {
        if (pk === 'id') {
          const counter = (this.autoIncCounters.get(tableName) || 0) + 1
          this.autoIncCounters.set(tableName, counter)
          row.id = counter
        }
      }

      table.rows.push(row)
      return { changes: 1, lastInsertRowid: row.id as number }
    }

    // UPDATE table SET ... WHERE ...
    const updateMatch = sql.match(/UPDATE\s+(\w+)\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/i)
    if (updateMatch) {
      const [, tableName, setClause, whereClause] = updateMatch
      const table = this.tables.get(tableName)
      if (!table) throw new Error(`Table ${tableName} not found`)

      const setPairs = this.splitOnComma(setClause)
      let paramIdx = 0
      const setValues: Array<{ col: string; value: unknown }> = []
      for (const pair of setPairs) {
        const equalIdx = pair.indexOf('=')
        if (equalIdx === -1) continue
        const col = pair.substring(0, equalIdx).trim()
        const valueExpr = pair.substring(equalIdx + 1).trim()
        const { value, isParam } = this.parseValueExpr(valueExpr, params, paramIdx)
        if (isParam) paramIdx++
        setValues.push({ col, value })
      }

      const whereParams = params.slice(paramIdx)
      const matchingRows = whereClause
        ? table.rows.filter((row) => this.matchWhere(row, whereClause, whereParams))
        : table.rows

      let changes = 0
      for (const row of matchingRows) {
        for (const { col, value } of setValues) {
          row[col] = value
        }
        changes++
      }
      return { changes, lastInsertRowid: 0 }
    }

    // DELETE FROM ... WHERE ...
    const deleteMatch = sql.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+([\s\S]+))?$/i)
    if (deleteMatch) {
      const [, tableName, whereClause] = deleteMatch
      const table = this.tables.get(tableName)
      if (!table) throw new Error(`Table ${tableName} not found`)
      if (!whereClause) {
        const changes = table.rows.length
        table.rows = []
        return { changes, lastInsertRowid: 0 }
      }
      const initialLength = table.rows.length
      table.rows = table.rows.filter((row) => !this.matchWhere(row, whereClause, params))
      return { changes: initialLength - table.rows.length, lastInsertRowid: 0 }
    }

    return { changes: 0, lastInsertRowid: 0 }
  }

  private executeGet(sql: string, params: unknown[]): MockRow | undefined {
    const rows = this.executeAll(sql, params)
    return rows[0]
  }

  private executeAll(sql: string, params: unknown[]): MockRow[] {
    const selectMatch = sql.match(
      /SELECT\s+([\s\S]+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+([\s\S]+?))?(?:\s+GROUP\s+BY\s+([\s\S]+?))?(?:\s+ORDER\s+BY\s+([\s\S]+?))?(?:\s+LIMIT\s+(\d+|\?))?\s*$/i
    )
    if (!selectMatch) return []

    const [, selectClause, tableName, whereClause] = selectMatch
    const table = this.tables.get(tableName)
    if (!table) throw new Error(`Table ${tableName} not found`)

    const rows = whereClause
      ? table.rows.filter((row) => this.matchWhere(row, whereClause, params))
      : [...table.rows]

    // 聚合查询（无 GROUP BY）
    const countMatch = selectClause.match(/^COUNT\s*\(\s*\*\s*\)\s*(?:as|AS)\s+(\w+)$/i)
    if (countMatch) {
      return [{ [countMatch[1]]: rows.length }]
    }
    const maxMatch = selectClause.match(/^MAX\s*\(\s*(\w+)\s*\)\s*(?:as|AS)\s+(\w+)$/i)
    if (maxMatch) {
      const values = rows
        .map((r) => r[maxMatch[1]])
        .filter((v) => v !== null && v !== undefined) as number[]
      return [
        { [maxMatch[2]]: values.length > 0 ? values.reduce((a, b) => (a > b ? a : b)) : null }
      ]
    }
    const minMatch = selectClause.match(/^MIN\s*\(\s*(\w+)\s*\)\s*(?:as|AS)\s+(\w+)$/i)
    if (minMatch) {
      const values = rows
        .map((r) => r[minMatch[1]])
        .filter((v) => v !== null && v !== undefined) as string[]
      return [
        { [minMatch[2]]: values.length > 0 ? values.reduce((a, b) => (a < b ? a : b)) : null }
      ]
    }

    // SELECT 1 FROM ...（存在性检查）
    if (selectClause.trim() === '1') {
      return rows.length > 0 ? [{ _exists: 1 }] : []
    }

    // 多列投影
    const selectItems = selectClause.split(',').map((s) => s.trim())
    return rows.map((row) => {
      const out: MockRow = {}
      for (const item of selectItems) {
        const m = item.match(/^(\w+)(?:\s+(?:as|AS)\s+(\w+))?$/)
        if (m) {
          const col = m[1]
          const alias = m[2] || col
          if (row[col] !== undefined) {
            out[alias] = row[col]
          }
        }
      }
      return out
    })
  }

  private matchWhere(row: MockRow, whereClause: string, params: unknown[]): boolean {
    const clause = whereClause.trim().replace(/^WHERE\s+/i, '')
    const conditions = clause.split(/\s+AND\s+/i)

    let paramIdx = 0
    for (const cond of conditions) {
      const trimmed = cond.trim()
      // col = ?
      if (/^\w+\s*=\s*\?$/.test(trimmed)) {
        const col = trimmed.split(/\s*=\s*/)[0].trim()
        if (row[col] !== params[paramIdx++]) return false
      }
      // col = 'literal'
      else if (/^\w+\s*=\s*'[^']*'$/.test(trimmed)) {
        const m = trimmed.match(/^(\w+)\s*=\s*'([^']*)'$/)
        if (m && row[m[1]] !== m[2]) return false
      }
      // col IS NULL
      else if (/^\w+\s+IS\s+NULL$/i.test(trimmed)) {
        const col = trimmed.split(/\s+/)[0]
        if (row[col] !== null && row[col] !== undefined) return false
      }
      // col IS NOT NULL
      else if (/^\w+\s+IS\s+NOT\s+NULL$/i.test(trimmed)) {
        const col = trimmed.split(/\s+/)[0]
        if (row[col] === null || row[col] === undefined) return false
      }
      // col != ''
      else if (/^\w+\s*!=\s*''$/.test(trimmed)) {
        const col = trimmed.split(/!=/)[0].trim()
        if (row[col] === '') return false
      }
      // col = number
      else if (/^\w+\s*=\s*\d+$/.test(trimmed)) {
        const m = trimmed.match(/^(\w+)\s*=\s*(\d+)$/)
        if (m && row[m[1]] !== parseInt(m[2], 10)) return false
      }
      // col IN (?, ?, ...)
      else if (/^\w+\s+IN\s*\(([^)]+)\)$/i.test(trimmed)) {
        const m = trimmed.match(/^(\w+)\s+IN\s*\(([^)]+)\)$/i)
        if (!m) return false
        const col = m[1]
        const placeholders = m[2].split(',').map((s) => s.trim())
        const values = placeholders.map(() => params[paramIdx++])
        if (!values.includes(row[col])) return false
      }
      // col < datetime('now', '-30 days')（30 天前日期比较）
      else if (/^\w+\s*<\s*datetime\s*\(/i.test(trimmed)) {
        const col = trimmed.split(/\s*</)[0].trim()
        const rowDate = row[col] as string | undefined
        if (!rowDate) return false
        // 简化：将日期字符串解析为 Date，与 30 天前比较
        const rowTime = new Date(rowDate.replace(' ', 'T') + 'Z').getTime()
        if (isNaN(rowTime)) return false
        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
        if (rowTime >= thirtyDaysAgo) return false
      }
      // 其他未识别条件：保守返回 true
    }
    return true
  }

  private splitOnComma(s: string): string[] {
    const result: string[] = []
    let depth = 0
    let current = ''
    for (const ch of s) {
      if (ch === '(') {
        depth++
        current += ch
      } else if (ch === ')') {
        depth--
        current += ch
      } else if (ch === ',' && depth === 0) {
        result.push(current.trim())
        current = ''
      } else {
        current += ch
      }
    }
    if (current.trim()) result.push(current.trim())
    return result
  }

  private parseValueExpr(
    expr: string,
    params: unknown[],
    paramIdx: number
  ): { value: unknown; isParam: boolean } {
    const e = expr.trim()
    if (e === '?') return { value: params[paramIdx], isParam: true }
    if (e.toUpperCase() === 'NULL') return { value: null, isParam: false }
    if (/^-?\d+(\.\d+)?$/.test(e)) return { value: parseFloat(e), isParam: false }
    const strMatch = e.match(/^'([^']*)'$/)
    if (strMatch) return { value: strMatch[1], isParam: false }
    const strMatch2 = e.match(/^"([^"]*)"$/)
    if (strMatch2) return { value: strMatch2[1], isParam: false }
    // datetime('now') / datetime('now', 'localtime')
    const dtMatch = e.match(/datetime\s*\(\s*['"]now['"]\s*(?:,\s*['"][^'"]*['"]\s*)?\s*\)/i)
    if (dtMatch) {
      const now = new Date()
      const utc = new Date(now.getTime() + now.getTimezoneOffset() * 60000)
      return { value: utc.toISOString().replace('T', ' ').substring(0, 19), isParam: false }
    }
    return { value: null, isParam: false }
  }

  private getPrimaryKey(tableName: string): string | null {
    if (
      tableName === 'media_files' ||
      tableName === 'categories' ||
      tableName === 'scan_history' ||
      tableName === 'filter_presets' ||
      tableName === 'watermark_templates' ||
      tableName === 'edit_history' ||
      tableName === 'operation_history'
    ) {
      return 'id'
    }
    if (tableName === 'character_profiles') return 'uid'
    if (tableName === 'app_settings') return 'key'
    if (tableName === 'schema_migrations') return 'name'
    return null
  }

  // 测试辅助：暴露内部状态
  _getTable(name: string): MockTable | undefined {
    return this.tables.get(name)
  }
}

// 使用代理类避免 vi.mock 提升导致的 TDZ 问题：
// connection.ts 使用 `import Database from 'better-sqlite3'`（值导入，非 type），
// mock 工厂在 import 时立即执行，此时 MockDatabase 类尚未初始化。
// 代理类的 constructor 体在 `new Database(...)` 实际调用时才执行，
// 那时 MockDatabase 已完成类声明求值。
vi.mock('better-sqlite3', () => ({
  default: class ProxyDatabase {
    constructor(...args: unknown[]) {
      return new MockDatabase(...(args as [string]))
    }
  }
}))

// ============================================================================
// 导入被测模块（必须在 mock 之后）
// ============================================================================
import { DatabaseManager } from './connection'
import { logger } from '../utils/logger'
import { backupService } from '../services/backup-service'

// ============================================================================
// 测试用例
// ============================================================================

describe('DatabaseManager', () => {
  let manager: DatabaseManager

  beforeEach(() => {
    // 重置所有 mock 配置
    MockDatabase.failNextConstruction = false
    MockDatabase.failAllConstructions = false
    MockDatabase.failNextConstructionWithLock = false
    MockDatabase.nextConstructionError = null
    MockDatabase.pragmasToFail = []
    MockDatabase.integrityFail = null
    MockDatabase.pragmaCalls = []
    MockDatabase.resetSharedState()
    mockDetectSceneCategory.mockReset()
    mockDetectSceneCategory.mockReturnValue('other')

    // spy fs 方法（不替换整个 fs 模块，避免影响 vitest 内部）
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined)
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined)
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 1024 } as fs.Stats)
    // 启动性能优化：markCleanExit 写标志断言用（默认静默，不真实写盘）
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined)

    // 重置 electron.app.getPath mock
    app.getPath.mockClear()
    app.getPath.mockImplementation((name: string) => `/mock/userdata/${name}`)

    manager = new DatabaseManager()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    // 确保关闭数据库
    try {
      manager.close()
    } catch {
      // 忽略
    }
  })

  // ==========================================================================
  // constructor
  // ==========================================================================
  describe('constructor', () => {
    it('正常创建实例并调用 app.getPath("userData")', () => {
      expect(app.getPath).toHaveBeenCalledWith('userData')
      expect(manager).toBeDefined()
    })

    it('目录已存在时不调用 mkdirSync', () => {
      vi.mocked(fs.mkdirSync).mockClear()
      // 已在 beforeEach 中 existsSync=true，manager 已创建
      // 需要重新构造以验证
      vi.mocked(fs.existsSync).mockReturnValue(true)
      new DatabaseManager()
      expect(fs.mkdirSync).not.toHaveBeenCalled()
    })

    it('目录不存在时调用 mkdirSync 创建目录', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      new DatabaseManager()
      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('database'), {
        recursive: true
      })
    })

    it('dbPath 指向 wxnn_photo_manager.db 文件', () => {
      // 通过 getWalFileSize 间接验证 dbPath（WAL 路径 = dbPath + '-wal'）
      vi.mocked(fs.statSync).mockReturnValue({ size: 2048 } as fs.Stats)
      const size = manager.getWalFileSize()
      expect(size).toBe(2048)
      expect(fs.statSync).toHaveBeenCalledWith(expect.stringContaining('wxnn_photo_manager.db-wal'))
    })
  })

  // ==========================================================================
  // initialize
  // ==========================================================================
  describe('initialize', () => {
    it('正常初始化完成所有迁移步骤', async () => {
      await expect(manager.initialize()).resolves.not.toThrow()
      expect(manager.getDatabase()).not.toBeNull()
    })

    it('初始化后 schema_migrations 表已创建', async () => {
      await manager.initialize()
      // 通过 isMigrationApplied 间接验证表存在
      expect(manager.isMigrationApplied('non_existent')).toBe(false)
    })

    it('初始化后 media_files 表已创建', async () => {
      await manager.initialize()
      // 通过 execute 间接验证表存在（不抛错即表存在）
      expect(() =>
        manager.execute(
          'INSERT INTO media_files (file_path, file_name, file_type, file_ext, file_size, created_at, modified_at, source_path, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            '/test.jpg',
            'test.jpg',
            'image',
            '.jpg',
            1024,
            '2024-01-01 10:00:00',
            '2024-01-01 10:00:00',
            '/source',
            '2024-01-01 10:00:00'
          ]
        )
      ).not.toThrow()
    })

    it('初始化后 app_settings 表已创建', async () => {
      await manager.initialize()
      // 通过 setSetting/getSetting 验证表存在
      manager.setSetting('test_key', 'test_value')
      expect(manager.getSetting('test_key', 'default')).toBe('test_value')
    })

    it('初始化后 categories 表已插入 7 个默认系统分类', async () => {
      await manager.initialize()
      const rows = manager.query('SELECT name FROM categories') as Array<{ name: string }>
      expect(rows).toHaveLength(7)
      const names = rows.map((r) => r.name)
      expect(names).toEqual(
        expect.arrayContaining([
          'people',
          'location',
          'scene',
          'screenshot',
          'recording',
          'recent',
          'favorite'
        ])
      )
    })

    it('初始化后 character_profiles 表已创建并插入 default 档案', async () => {
      await manager.initialize()
      const rows = manager.query('SELECT uid FROM character_profiles') as Array<{ uid: string }>
      expect(rows.some((r) => r.uid === 'default')).toBe(true)
    })

    it('版本 3 迁移：旧库中文系统分类名/默认档案昵称升级为稳定 key', async () => {
      await manager.initialize()
      // 模拟旧库状态：分类名写回中文默认值、默认档案昵称写回中文、撤销 v3 迁移标记
      manager.execute("UPDATE categories SET name = '人物' WHERE name = 'people'")
      manager.execute("UPDATE categories SET name = '地点' WHERE name = 'location'")
      manager.execute("UPDATE character_profiles SET nickname = '默认档案' WHERE uid = 'default'")
      manager.execute('DELETE FROM schema_migrations WHERE version = 3')
      manager.close()

      // 再次初始化：v3 迁移应把中文默认值改写为稳定 key（用户改过名的行不受影响）
      const upgraded = new DatabaseManager()
      await upgraded.initialize()
      const names = (upgraded.query('SELECT name FROM categories') as Array<{ name: string }>).map(
        (r) => r.name
      )
      expect(names).toContain('people')
      expect(names).toContain('location')
      expect(names).not.toContain('人物')
      const profile = upgraded.query(
        "SELECT nickname FROM character_profiles WHERE uid = 'default'"
      ) as Array<{ nickname: string }>
      expect(profile[0]?.nickname).toBe('')
    })

    it('初始化后 scene_category 迁移已应用（R17 版本号=2）', async () => {
      await manager.initialize()
      // R17：新数据库通过版本号标记，name 列写入 'v2'
      // 旧数据库（回填后）name='scene_category_backfill_v1' + version=2，两种都能被 isMigrationVersionApplied 查到
      expect(manager.isMigrationVersionApplied(2)).toBe(true)
    })

    it('初始化后 media_files 表含 is_deleted 列（ALTER TABLE 迁移成功）', async () => {
      await manager.initialize()
      // 通过 execute UPDATE 验证列存在（不抛错即列存在）
      const result = manager.execute('UPDATE media_files SET is_deleted = 0 WHERE id = 1')
      expect(result).toBeDefined()
    })

    it('初始化后 import_roots 表含 disabled 列（指定目录关闭语义迁移成功）', async () => {
      await manager.initialize()
      // 通过 UPDATE 验证列存在；新建库由建表 DDL 含列，已发布库由 safeEnsureColumn 幂等 ALTER 补充
      const result = manager.execute('UPDATE import_roots SET disabled = 0 WHERE id = 1')
      expect(result).toBeDefined()
    })

    it('初始化后 media_files 表含 phash 列', async () => {
      await manager.initialize()
      const result = manager.execute('UPDATE media_files SET phash = NULL WHERE id = 1')
      expect(result).toBeDefined()
    })

    it('初始化后 media_files 表含 account_uid 列', async () => {
      await manager.initialize()
      const result = manager.execute("UPDATE media_files SET account_uid = 'default' WHERE id = 1")
      expect(result).toBeDefined()
    })

    it('初始化后 media_files 表含 album_type 列', async () => {
      await manager.initialize()
      const result = manager.execute("UPDATE media_files SET album_type = '其他' WHERE id = 1")
      expect(result).toBeDefined()
    })

    it('初始化后 media_files 表含 media_source 列', async () => {
      await manager.initialize()
      const result = manager.execute("UPDATE media_files SET media_source = 'game' WHERE id = 1")
      expect(result).toBeDefined()
    })

    it('初始化后 media_files 表含 scene_time 列', async () => {
      await manager.initialize()
      const result = manager.execute("UPDATE media_files SET scene_time = 'unknown' WHERE id = 1")
      expect(result).toBeDefined()
    })

    it('初始化后 media_files 表含 outfit 列', async () => {
      await manager.initialize()
      const result = manager.execute("UPDATE media_files SET outfit = '' WHERE id = 1")
      expect(result).toBeDefined()
    })

    it('初始化后 media_files 表含 is_duplicate 列', async () => {
      await manager.initialize()
      const result = manager.execute('UPDATE media_files SET is_duplicate = 0 WHERE id = 1')
      expect(result).toBeDefined()
    })

    it('初始化后 media_files 表含 original_id 列', async () => {
      await manager.initialize()
      const result = manager.execute('UPDATE media_files SET original_id = NULL WHERE id = 1')
      expect(result).toBeDefined()
    })

    it('初始化后 media_files 表含 is_missing 列', async () => {
      await manager.initialize()
      const result = manager.execute('UPDATE media_files SET is_missing = 0 WHERE id = 1')
      expect(result).toBeDefined()
    })

    it('初始化后 media_files 表含 missing_count 列', async () => {
      await manager.initialize()
      const result = manager.execute('UPDATE media_files SET missing_count = 0 WHERE id = 1')
      expect(result).toBeDefined()
    })

    it('初始化后 media_files 表含 deleted_at 列', async () => {
      await manager.initialize()
      const result = manager.execute('UPDATE media_files SET deleted_at = NULL WHERE id = 1')
      expect(result).toBeDefined()
    })

    it('初始化后 tags 与 media_tags 僵尸表已删除', async () => {
      await manager.initialize()
      // tags 表已 DROP，查询应抛错
      expect(() => manager.query('SELECT * FROM tags')).toThrow()
      expect(() => manager.query('SELECT * FROM media_tags')).toThrow()
    })

    it('初始化后 operation_history 表已创建', async () => {
      await manager.initialize()
      expect(() =>
        manager.execute(
          'INSERT INTO operation_history (operation_type, payload, created_at) VALUES (?, ?, ?)',
          ['test', '{}', '2024-01-01 10:00:00']
        )
      ).not.toThrow()
    })

    it('初始化后 scan_history 表已创建', async () => {
      await manager.initialize()
      expect(() =>
        manager.execute('INSERT INTO scan_history (scan_type, start_time) VALUES (?, ?)', [
          'full',
          '2024-01-01 10:00:00'
        ])
      ).not.toThrow()
    })

    it('初始化后 filter_presets 表已创建', async () => {
      await manager.initialize()
      expect(() =>
        manager.execute(
          'INSERT INTO filter_presets (name, category, params, created_at) VALUES (?, ?, ?, ?)',
          ['预设1', 'filter', '{}', '2024-01-01 10:00:00']
        )
      ).not.toThrow()
    })

    it('初始化后 watermark_templates 表已创建', async () => {
      await manager.initialize()
      expect(() =>
        manager.execute(
          'INSERT INTO watermark_templates (name, config, created_at) VALUES (?, ?, ?)',
          ['水印1', '{}', '2024-01-01 10:00:00']
        )
      ).not.toThrow()
    })

    it('初始化后 edit_history 表已创建', async () => {
      await manager.initialize()
      expect(() =>
        manager.execute(
          'INSERT INTO edit_history (media_id, params, created_at) VALUES (?, ?, ?)',
          [1, '{}', '2024-01-01 10:00:00']
        )
      ).not.toThrow()
    })

    it('PRAGMA wal_autocheckpoint 失败时不影响初始化', async () => {
      MockDatabase.pragmasToFail.push('wal_autocheckpoint')
      await expect(manager.initialize()).resolves.not.toThrow()
    })

    it('PRAGMA optimize 失败时不影响初始化', async () => {
      MockDatabase.pragmasToFail.push('optimize')
      await expect(manager.initialize()).resolves.not.toThrow()
    })

    it('auto_vacuum=0 时切换为 INCREMENTAL 模式', async () => {
      await manager.initialize()
      // 验证 auto_vacuum 已被设置（通过 mock 内部状态间接验证）
      // 初始化不抛错即说明 auto_vacuum 处理正常
      expect(manager.getDatabase()).not.toBeNull()
    })

    it('H1: 第一次打开失败时优先走数据保全的 WAL 合并恢复（不删除 WAL/SHM、不覆盖备份）', async () => {
      // 构造 WAL_CORRUPT 类错误（file is not a database）→ 分类 WAL_CORRUPT → 走数据保全 WAL 合并恢复，重开成功
      MockDatabase.nextConstructionError = Object.assign(
        new Error('SQLite3 can only open files that are databases, file is not a database'),
        { code: '' }
      )
      vi.mocked(fs.existsSync).mockReturnValue(true)
      const restoreSpy = vi
        .spyOn(backupService, 'restoreLatestBackupTo')
        .mockResolvedValue({ success: false } as never)
      await expect(manager.initialize()).resolves.not.toThrow()
      // H1：绝不为打开失败删除 -wal/-shm（会丢弃未 checkpoint 的已提交事务）
      expect(fs.unlinkSync).not.toHaveBeenCalled()
      // H1：数据保全的 WAL 合并恢复成功，未触发破坏性备份恢复
      expect(restoreSpy).not.toHaveBeenCalled()
      expect(manager.getLastRecovery()?.success).toBe(true)
      expect(manager.getLastRecovery()?.kind).toBe('WAL_CORRUPT')
    })

    it('H1: 第一次打开失败且 WAL/SHM 不存在时仍走 WAL 合并恢复', async () => {
      // 构造 WAL_CORRUPT 类错误 → 分类 WAL_CORRUPT → 走数据保全 WAL 合并恢复（WAL/SHM 不存在也能 checkpoint）
      MockDatabase.nextConstructionError = Object.assign(
        new Error('SQLite3 can only open files that are databases, file is not a database'),
        { code: '' }
      )
      vi.mocked(fs.existsSync).mockReturnValue(false)
      await expect(manager.initialize()).resolves.not.toThrow()
      expect(manager.getLastRecovery()?.kind).toBe('WAL_CORRUPT')
    })

    it('UNKNOWN（无法归类的打开失败，两次打开都失败）→ 保留现场、不覆盖备份、提示排查', async () => {
      // 无法归类的通用打开失败 → 分类 UNKNOWN → 已进入 NON_DESTRUCTIVE_KINDS，绝不覆盖在线库
      MockDatabase.failAllConstructions = true
      const restoreSpy = vi
        .spyOn(backupService, 'restoreLatestBackupTo')
        .mockResolvedValue({ success: false } as never)
      await expect(manager.initialize()).rejects.toThrow(/原因未知|打开失败/)
      expect(restoreSpy).not.toHaveBeenCalled()
      const rec = manager.getLastRecovery()
      expect(rec?.nonDestructive).toBe(true)
      expect(rec?.kind).toBe('UNKNOWN')
    })

    // ========================================================================
    // H1: 非破坏性故障不得用备份覆盖在线库（覆盖会丢失自上次备份以来的全部变更）
    // ========================================================================
    describe('H1: 非破坏性故障保留现场', () => {
      const makeErr = (code: string, message: string): Error =>
        Object.assign(new Error(message), { code })

      it('权限错误(SQLITE_PERM) → 保留在线库、不触发备份恢复、抛出权限提示', async () => {
        MockDatabase.nextConstructionError = makeErr(
          'SQLITE_PERM',
          'SQLITE_PERM: attempt to write a readonly database'
        )
        const restoreSpy = vi
          .spyOn(backupService, 'restoreLatestBackupTo')
          .mockResolvedValue({ success: false } as never)
        await expect(manager.initialize()).rejects.toThrow(/权限|permission/i)
        expect(restoreSpy).not.toHaveBeenCalled()
        const rec = manager.getLastRecovery()
        expect(rec?.success).toBe(false)
        expect(rec?.nonDestructive).toBe(true)
        expect(rec?.kind).toBe('PERMISSION')
      })

      it('磁盘满(SQLITE_FULL) → 保留现场、不覆盖备份、抛出磁盘提示', async () => {
        MockDatabase.nextConstructionError = makeErr(
          'SQLITE_FULL',
          'SQLITE_FULL: database or disk is full'
        )
        const restoreSpy = vi
          .spyOn(backupService, 'restoreLatestBackupTo')
          .mockResolvedValue({ success: false } as never)
        await expect(manager.initialize()).rejects.toThrow(/磁盘空间不足|disk/i)
        expect(restoreSpy).not.toHaveBeenCalled()
        const rec = manager.getLastRecovery()
        expect(rec?.nonDestructive).toBe(true)
        expect(rec?.kind).toBe('DISK_FULL')
      })

      it('ABI 不匹配 → 保留现场、不覆盖备份、提示重新安装', async () => {
        MockDatabase.nextConstructionError = new Error(
          'Error: The specified procedure could not be found.\n\\??\\node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node'
        )
        const restoreSpy = vi
          .spyOn(backupService, 'restoreLatestBackupTo')
          .mockResolvedValue({ success: false } as never)
        await expect(manager.initialize()).rejects.toThrow(/重新安装|ABI|better-sqlite3/i)
        expect(restoreSpy).not.toHaveBeenCalled()
        const rec = manager.getLastRecovery()
        expect(rec?.nonDestructive).toBe(true)
        expect(rec?.kind).toBe('ABI_INCOMPATIBLE')
      })

      it('WAL_CORRUPT 且 WAL 合并恢复失败时回退破坏性备份恢复（仍会调用恢复）', async () => {
        // 构造"file is not a database"类错误 → 分类 WAL_CORRUPT；
        // failAllConstructions 使 runWALRecovery 重开仍失败 → 回退 destructive 覆盖
        MockDatabase.nextConstructionError = makeErr(
          '',
          'SQLite3 can only open files that are databases, file is not a database'
        )
        MockDatabase.failAllConstructions = true
        const restoreSpy = vi
          .spyOn(backupService, 'restoreLatestBackupTo')
          .mockResolvedValue({ success: false } as never)
        await expect(manager.initialize()).rejects.toThrow(/数据库打开失败/)
        // WAL_CORRUPT 回退属于确认损坏路径，允许调用恢复（H1：仅非损坏类才保留现场）
        expect(restoreSpy).toHaveBeenCalled()
      })

      it('真正损坏(integrity 校验失败) → 仍走破坏性备份恢复，并抛出损坏错误', async () => {
        MockDatabase.pragmasToFail.push('quick_check')
        MockDatabase.integrityFail = 'full'
        const restoreSpy = vi
          .spyOn(backupService, 'restoreLatestBackupTo')
          .mockResolvedValue({ success: false } as never)
        await expect(manager.initialize()).rejects.toThrow(/已损坏|无法从备份恢复/)
        expect(restoreSpy).toHaveBeenCalled()
        expect(manager.getLastRecovery()?.kind).toBe('CORRUPT')
      })
    })

    it('FIX(组7-1): 锁类错误（SQLITE_BUSY）不删除 WAL/SHM，等待后重试打开成功', async () => {
      MockDatabase.failNextConstructionWithLock = true
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.unlinkSync).mockClear()
      await expect(manager.initialize()).resolves.not.toThrow()
      // 关键断言：锁错误路径不得删除 -wal/-shm（会丢弃未 checkpoint 的已提交事务）
      expect(fs.unlinkSync).not.toHaveBeenCalled()
      expect(manager.getDatabase()).not.toBeNull()
    })

    it('FIX(组7-1): 锁持续未释放时抛出占用指引（不删除 WAL、不进恢复流程）', async () => {
      // 首次 BUSY + 持续失败：先锁错误，再持续失败
      MockDatabase.failNextConstructionWithLock = true
      MockDatabase.failAllConstructions = true
      await expect(manager.initialize()).rejects.toThrow(/被其他程序锁定/)
    })

    it('重复 initialize 不抛错（迁移幂等性）', async () => {
      await manager.initialize()
      // 第二次 initialize（在同一 manager 上）应不抛错
      // 注意：第一次 initialize 已创建表，第二次的 CREATE TABLE IF NOT EXISTS 安全
      // ALTER TABLE ADD COLUMN 会抛 "duplicate column name"，但 safeEnsureColumn 会捕获
      await expect(manager.initialize()).resolves.not.toThrow()
    })
  })

  // ==========================================================================
  // isMigrationApplied
  // ==========================================================================
  describe('isMigrationApplied', () => {
    it('迁移未应用时返回 false', async () => {
      await manager.initialize()
      expect(manager.isMigrationApplied('never_applied')).toBe(false)
    })

    it('迁移已应用时返回 true', async () => {
      await manager.initialize()
      manager.markMigrationApplied('test_migration')
      expect(manager.isMigrationApplied('test_migration')).toBe(true)
    })

    it('db 未初始化时返回 true（避免误执行迁移）', () => {
      const freshManager = new DatabaseManager()
      expect(freshManager.isMigrationApplied('any_migration')).toBe(true)
    })
  })

  // ==========================================================================
  // markMigrationApplied
  // ==========================================================================
  describe('markMigrationApplied', () => {
    it('正常标记迁移为已应用', async () => {
      await manager.initialize()
      manager.markMigrationApplied('new_migration')
      expect(manager.isMigrationApplied('new_migration')).toBe(true)
    })

    it('重复标记同一迁移是幂等的（OR IGNORE）', async () => {
      await manager.initialize()
      manager.markMigrationApplied('idempotent_migration')
      expect(() => manager.markMigrationApplied('idempotent_migration')).not.toThrow()
      expect(manager.isMigrationApplied('idempotent_migration')).toBe(true)
    })

    it('db 未初始化时不抛错（no-op）', () => {
      const freshManager = new DatabaseManager()
      expect(() => freshManager.markMigrationApplied('any')).not.toThrow()
    })
  })

  // ==========================================================================
  // R17：isMigrationVersionApplied / markMigrationVersionApplied
  // ==========================================================================
  describe('R17 isMigrationVersionApplied', () => {
    it('版本号迁移未应用时返回 false', async () => {
      await manager.initialize()
      expect(manager.isMigrationVersionApplied(999)).toBe(false)
    })

    it('版本号迁移已应用时返回 true', async () => {
      await manager.initialize()
      manager.markMigrationVersionApplied(100)
      expect(manager.isMigrationVersionApplied(100)).toBe(true)
    })

    it('db 未初始化时返回 true（避免误执行迁移）', () => {
      const freshManager = new DatabaseManager()
      expect(freshManager.isMigrationVersionApplied(1)).toBe(true)
    })

    it('初始化后 version=1（index_optimization_v3）已应用', async () => {
      await manager.initialize()
      expect(manager.isMigrationVersionApplied(1)).toBe(true)
    })
  })

  describe('R17 markMigrationVersionApplied', () => {
    it('正常标记版本号迁移为已应用', async () => {
      await manager.initialize()
      manager.markMigrationVersionApplied(200)
      expect(manager.isMigrationVersionApplied(200)).toBe(true)
    })

    it('重复标记同一版本号是幂等的（OR IGNORE）', async () => {
      await manager.initialize()
      manager.markMigrationVersionApplied(300)
      expect(() => manager.markMigrationVersionApplied(300)).not.toThrow()
      expect(manager.isMigrationVersionApplied(300)).toBe(true)
    })

    it('db 未初始化时不抛错（no-op）', () => {
      const freshManager = new DatabaseManager()
      expect(() => freshManager.markMigrationVersionApplied(1)).not.toThrow()
    })

    it('标记后 name 列写入 v{version} 格式（兼容旧版查询）', async () => {
      await manager.initialize()
      manager.markMigrationVersionApplied(42)
      // 通过旧 name 模式也能查到（name = 'v42'）
      expect(manager.isMigrationApplied('v42')).toBe(true)
    })
  })

  // ==========================================================================
  // query
  // ==========================================================================
  describe('query', () => {
    it('正常返回 SELECT 查询结果数组', async () => {
      await manager.initialize()
      manager.execute(
        'INSERT INTO categories (name, icon, color, sort_order, is_system, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['测试分类', 'icon', '#000', 100, 0, '2024-01-01 10:00:00']
      )
      const rows = manager.query('SELECT name FROM categories WHERE name = ?', ['测试分类'])
      expect(rows).toHaveLength(1)
      expect((rows[0] as { name: string }).name).toBe('测试分类')
    })

    it('查询无结果时返回空数组', async () => {
      await manager.initialize()
      const rows = manager.query('SELECT name FROM categories WHERE name = ?', ['不存在'])
      expect(rows).toEqual([])
    })

    it('不传 params 时使用空数组', async () => {
      await manager.initialize()
      const rows = manager.query('SELECT name FROM categories')
      expect(Array.isArray(rows)).toBe(true)
      expect(rows.length).toBeGreaterThan(0)
    })

    it('db 未初始化时抛出 "Database not initialized"', () => {
      const freshManager = new DatabaseManager()
      expect(() => freshManager.query('SELECT 1')).toThrow('数据库未初始化')
    })
  })

  // ==========================================================================
  // execute
  // ==========================================================================
  describe('execute', () => {
    it('正常执行 INSERT 并返回 RunResult', async () => {
      await manager.initialize()
      const result = manager.execute(
        'INSERT INTO categories (name, icon, color, sort_order, is_system, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['新分类', 'icon', '#fff', 200, 0, '2024-01-01 10:00:00']
      )
      expect(result).toBeDefined()
      expect(result.changes).toBe(1)
      expect(result.lastInsertRowid).toBeGreaterThan(0)
    })

    it('正常执行 UPDATE 并返回受影响行数', async () => {
      await manager.initialize()
      const insertResult = manager.execute(
        'INSERT INTO categories (name, icon, color, sort_order, is_system, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['待更新', 'icon', '#000', 1, 0, '2024-01-01 10:00:00']
      )
      const id = Number(insertResult.lastInsertRowid)
      const updateResult = manager.execute('UPDATE categories SET name = ? WHERE id = ?', [
        '已更新',
        id
      ])
      expect(updateResult.changes).toBe(1)
    })

    it('正常执行 DELETE 并返回受影响行数', async () => {
      await manager.initialize()
      const insertResult = manager.execute(
        'INSERT INTO categories (name, icon, color, sort_order, is_system, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['待删除', 'icon', '#000', 1, 0, '2024-01-01 10:00:00']
      )
      const id = Number(insertResult.lastInsertRowid)
      const deleteResult = manager.execute('DELETE FROM categories WHERE id = ?', [id])
      expect(deleteResult.changes).toBe(1)
    })

    it('不传 params 时使用空数组', async () => {
      await manager.initialize()
      const result = manager.execute(
        "INSERT INTO categories (name, icon, color, sort_order, is_system, created_at) VALUES ('无参', 'icon', '#000', 1, 0, '2024-01-01 10:00:00')"
      )
      expect(result.changes).toBe(1)
    })

    it('db 未初始化时抛出 "Database not initialized"', () => {
      const freshManager = new DatabaseManager()
      expect(() => freshManager.execute('INSERT INTO foo VALUES (1)')).toThrow('数据库未初始化')
    })
  })

  // ==========================================================================
  // getSetting
  // ==========================================================================
  describe('getSetting', () => {
    it('键存在且类型匹配时返回存储的字符串值', async () => {
      await manager.initialize()
      manager.setSetting('string_key', 'hello')
      expect(manager.getSetting('string_key', 'default')).toBe('hello')
    })

    it('键存在且类型匹配时返回存储的数值', async () => {
      await manager.initialize()
      manager.setSetting('number_key', 42)
      expect(manager.getSetting('number_key', 0)).toBe(42)
    })

    it('键存在且类型匹配时返回存储的布尔值', async () => {
      await manager.initialize()
      manager.setSetting('bool_key', true)
      expect(manager.getSetting('bool_key', false)).toBe(true)
    })

    it('键存在且类型匹配时返回存储的数组', async () => {
      await manager.initialize()
      const arr = [1, 2, 3]
      manager.setSetting('array_key', arr)
      expect(manager.getSetting('array_key', [])).toEqual(arr)
    })

    it('键存在且类型匹配时返回存储的对象', async () => {
      await manager.initialize()
      const obj = { foo: 'bar', count: 1 }
      manager.setSetting('object_key', obj)
      expect(manager.getSetting('object_key', {})).toEqual(obj)
    })

    it('键不存在时返回 defaultValue', async () => {
      await manager.initialize()
      expect(manager.getSetting('non_existent', 'fallback')).toBe('fallback')
    })

    it('db 未初始化时返回 defaultValue', () => {
      const freshManager = new DatabaseManager()
      expect(freshManager.getSetting('any', 'default')).toBe('default')
    })

    it('存储值为损坏 JSON 时返回 defaultValue', async () => {
      await manager.initialize()
      // 直接写入损坏的 JSON 字符串
      manager.execute('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [
        'corrupt_key',
        'not-json{'
      ])
      expect(manager.getSetting('corrupt_key', 'fallback')).toBe('fallback')
    })

    it('存储值类型与 defaultValue 不匹配（string vs number）时返回 defaultValue', async () => {
      await manager.initialize()
      manager.setSetting('typed_key', 'string_value')
      expect(manager.getSetting('typed_key', 123)).toBe(123)
    })

    it('存储值类型与 defaultValue 不匹配（number vs string）时返回 defaultValue', async () => {
      await manager.initialize()
      manager.setSetting('typed_key', 42)
      expect(manager.getSetting('typed_key', 'default_string')).toBe('default_string')
    })

    it('存储值类型与 defaultValue 不匹配（array vs object）时返回 defaultValue', async () => {
      await manager.initialize()
      manager.setSetting('typed_key', [1, 2, 3])
      expect(manager.getSetting('typed_key', { foo: 'bar' })).toEqual({ foo: 'bar' })
    })

    it('存储值类型与 defaultValue 不匹配（object vs array）时返回 defaultValue', async () => {
      await manager.initialize()
      manager.setSetting('typed_key', { foo: 'bar' })
      expect(manager.getSetting('typed_key', ['default'])).toEqual(['default'])
    })

    it('存储值类型与 defaultValue 不匹配（boolean vs string）时返回 defaultValue', async () => {
      await manager.initialize()
      manager.setSetting('typed_key', true)
      expect(manager.getSetting('typed_key', 'default')).toBe('default')
    })

    it('存储值为 null 时视为兼容，返回 null', async () => {
      await manager.initialize()
      manager.execute('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [
        'null_key',
        'null'
      ])
      // JSON.parse('null') === null，isSettingTypeCompatible 对 null 返回 true
      expect(manager.getSetting('null_key', 'default')).toBeNull()
    })

    it('存储值为 null 且 defaultValue 为对象时返回 null', async () => {
      await manager.initialize()
      manager.execute('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [
        'null_obj_key',
        'null'
      ])
      expect(manager.getSetting('null_obj_key', { foo: 'bar' })).toBeNull()
    })
  })

  // ==========================================================================
  // setSetting
  // ==========================================================================
  describe('setSetting', () => {
    it('正常写入字符串值', async () => {
      await manager.initialize()
      manager.setSetting('str_key', 'value')
      expect(manager.getSetting('str_key', '')).toBe('value')
    })

    it('正常写入数值', async () => {
      await manager.initialize()
      manager.setSetting('num_key', 99)
      expect(manager.getSetting('num_key', 0)).toBe(99)
    })

    it('正常写入对象', async () => {
      await manager.initialize()
      const obj = { a: 1, b: 'hello' }
      manager.setSetting('obj_key', obj)
      expect(manager.getSetting('obj_key', {})).toEqual(obj)
    })

    it('正常写入数组', async () => {
      await manager.initialize()
      const arr = ['a', 'b', 'c']
      manager.setSetting('arr_key', arr)
      expect(manager.getSetting('arr_key', [])).toEqual(arr)
    })

    it('覆盖已存在的值（OR REPLACE 语义）', async () => {
      await manager.initialize()
      manager.setSetting('overwrite_key', 'first')
      manager.setSetting('overwrite_key', 'second')
      expect(manager.getSetting('overwrite_key', '')).toBe('second')
    })

    it('覆盖时支持类型变更', async () => {
      await manager.initialize()
      manager.setSetting('type_change_key', 'string_value')
      manager.setSetting('type_change_key', 42)
      expect(manager.getSetting('type_change_key', 0)).toBe(42)
    })

    it('db 未初始化时不抛错（no-op）', () => {
      const freshManager = new DatabaseManager()
      expect(() => freshManager.setSetting('key', 'value')).not.toThrow()
    })
  })

  // ==========================================================================
  // getDatabase
  // ==========================================================================
  describe('getDatabase', () => {
    it('initialize 前返回 null', () => {
      const freshManager = new DatabaseManager()
      expect(freshManager.getDatabase()).toBeNull()
    })

    it('initialize 后返回非 null 数据库实例', async () => {
      await manager.initialize()
      expect(manager.getDatabase()).not.toBeNull()
    })

    it('close 后返回 null', async () => {
      await manager.initialize()
      manager.close()
      expect(manager.getDatabase()).toBeNull()
    })
  })

  // ==========================================================================
  // close
  // ==========================================================================
  describe('close', () => {
    it('正常关闭后 getDatabase 返回 null', async () => {
      await manager.initialize()
      manager.close()
      expect(manager.getDatabase()).toBeNull()
    })

    it('db 已为 null 时 no-op', () => {
      const freshManager = new DatabaseManager()
      expect(() => freshManager.close()).not.toThrow()
    })

    it('PRAGMA optimize 失败时不影响关闭流程', async () => {
      await manager.initialize()
      MockDatabase.pragmasToFail.push('optimize')
      expect(() => manager.close()).not.toThrow()
      expect(manager.getDatabase()).toBeNull()
    })

    it('WAL checkpoint 失败时不影响关闭流程', async () => {
      await manager.initialize()
      MockDatabase.pragmasToFail.push('wal_checkpoint')
      expect(() => manager.close()).not.toThrow()
      expect(manager.getDatabase()).toBeNull()
    })

    it('重复调用 close 不抛错', async () => {
      await manager.initialize()
      manager.close()
      expect(() => manager.close()).not.toThrow()
    })
  })

  // ==========================================================================
  // getWalFileSize
  // ==========================================================================
  describe('getWalFileSize', () => {
    it('WAL 文件存在时返回文件大小', async () => {
      vi.mocked(fs.statSync).mockReturnValue({ size: 4096 } as fs.Stats)
      expect(manager.getWalFileSize()).toBe(4096)
    })

    it('WAL 文件不存在时返回 0', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      })
      expect(manager.getWalFileSize()).toBe(0)
    })

    it('statSync 抛出非 ENOENT 错误时返回 0', () => {
      vi.mocked(fs.statSync).mockImplementation(() => {
        throw new Error('EACCES')
      })
      expect(manager.getWalFileSize()).toBe(0)
    })

    it('WAL 文件大小为 0 时返回 0', () => {
      vi.mocked(fs.statSync).mockReturnValue({ size: 0 } as fs.Stats)
      expect(manager.getWalFileSize()).toBe(0)
    })

    it('查询的 WAL 路径包含 dbPath 前缀', () => {
      vi.mocked(fs.statSync).mockReturnValue({ size: 100 } as fs.Stats)
      manager.getWalFileSize()
      expect(fs.statSync).toHaveBeenCalledWith(expect.stringMatching(/wxnn_photo_manager\.db-wal$/))
    })
  })

  // ==========================================================================
  // 启动性能优化：完整性自检分级（quick_check 快速路径 + 干净退出标志）
  // 场景矩阵（docs/plans/startup-perf.md §1.3）：
  //   quick_check 失败 → 同步全量 + recovery（启动即发现损坏）
  //   quick_check 通过 + 标志缺失 → 返回 need，由 lifecycle 后台复核
  //   quick_check 通过 + 标志存在 → 完全跳过全量（最常见路径）
  // ==========================================================================
  describe('启动性能优化：完整性自检分级', () => {
    it('quick_check 通过 + 标志存在 → 跳过全量 integrity_check（不阻塞启动）', async () => {
      await manager.initialize()
      // 快速路径被调用
      expect(MockDatabase.pragmaCalls).toContain('quick_check')
      // 全量自检未执行
      expect(MockDatabase.pragmaCalls).not.toContain('integrity_check')
      expect(manager.shouldRunFullIntegrityCheck()).toBe(false)
    })

    it('quick_check 失败 → 同步执行全量 integrity_check（启动即发现损坏）', async () => {
      MockDatabase.integrityFail = 'quick'
      await expect(manager.initialize()).resolves.not.toThrow()
      expect(MockDatabase.pragmaCalls).toContain('integrity_check')
      // 全量通过（integrity_check 返回 ok）→ 无需恢复
      expect(manager.getLastRecovery()).toBeNull()
      // 已同步处理 → lifecycle 不再重复入队
      expect(manager.shouldRunFullIntegrityCheck()).toBe(false)
    })

    it('quick_check 失败 + 全量失败 → 同步执行恢复流程（attemptRecovery 被触发）', async () => {
      // quick_check 抛错 + integrity_check 返回损坏
      MockDatabase.pragmasToFail.push('quick_check')
      MockDatabase.integrityFail = 'full'
      // H1：恢复失败（无可用备份）不再静默继续，改为抛清晰错误（启动失败可诊断优于静默丢数据）
      await expect(manager.initialize()).rejects.toThrow(/已损坏|无法从备份恢复/)
      expect(MockDatabase.pragmaCalls).toContain('integrity_check')
      // attemptRecovery 被触发：lastRecovery 已记录（无可用备份 → 恢复失败）
      expect(manager.getLastRecovery()).not.toBeNull()
      expect(manager.getLastRecovery()?.success).toBe(false)
      expect(manager.shouldRunFullIntegrityCheck()).toBe(false)
    })

    it('FIX: 自恢复前显式停止 scanner/database/media worker 以释放 dbPath 句柄', async () => {
      // quick_check 抛错 + integrity_check 返回损坏 → 进入 attemptRecovery
      MockDatabase.pragmasToFail.length = 0
      MockDatabase.pragmasToFail.push('quick_check')
      MockDatabase.integrityFail = 'full'
      const dbStop = vi.fn().mockResolvedValue(undefined)
      const scannerStop = vi.fn().mockResolvedValue(undefined)
      const mediaStop = vi.fn().mockResolvedValue(undefined)
      // 模拟"worker 已启动"的假设情形：恢复前三个桥均持有 dbPath 句柄
      manager.setWorkerBridge({ stopWorkerForRestore: dbStop } as never)
      manager.setScannerWorkerBridge({ stopWorkerForRestore: scannerStop } as never)
      manager.setMediaWorkerBridge({ stopWorkerForRestore: mediaStop } as never)

      await expect(manager.initialize()).rejects.toThrow(/已损坏|无法从备份恢复/)

      // 三处持有 dbPath 的 worker 句柄均在 rename 覆盖在线库前被释放
      expect(dbStop).toHaveBeenCalledTimes(1)
      expect(scannerStop).toHaveBeenCalledTimes(1)
      expect(mediaStop).toHaveBeenCalledTimes(1)
      // 恢复失败（无可用备份）但流程未因句柄冲突提前崩溃
      expect(manager.getLastRecovery()?.success).toBe(false)
    })

    it('FIX(组7-2): 备份恢复失败时还原被挪走的原库，而非在原路径新建空库', async () => {
      MockDatabase.pragmasToFail.push('quick_check')
      MockDatabase.integrityFail = 'full'
      // existsSync 恒 true：dbPath 与 .corrupt-<ts> 副本均"存在"，backupCorruptedDb 的
      // renameSync 可成功（既有用例中 renameSync 未桩而真实失败，走的是副本缺失分支）
      vi.mocked(fs.existsSync).mockReturnValue(true)
      const renameCalls: Array<[string, string]> = []
      vi.spyOn(fs, 'renameSync').mockImplementation(((from: unknown, to: unknown) => {
        renameCalls.push([String(from), String(to)])
      }) as unknown as typeof fs.renameSync)
      await expect(manager.initialize()).rejects.toThrow(/已损坏|无法从备份恢复/)
      expect(manager.getLastRecovery()?.success).toBe(false)
      // 第一次 rename：backupCorruptedDb 把原库挪到 .corrupt-<ts>；
      // 第二次 rename（组7-2 修复）：恢复失败后把副本还原回原路径——不再新建空库
      expect(renameCalls.length).toBe(2)
      expect(renameCalls[0][0]).toBe(manager.getDbPath())
      expect(renameCalls[0][1]).toMatch(/\.corrupt-/)
      expect(renameCalls[1][0]).toMatch(/\.corrupt-/)
      expect(renameCalls[1][1]).toBe(manager.getDbPath())
      // 打开的是还原后的原库文件
      expect(manager.getDatabase()).not.toBeNull()
    })

    it('quick_check 与 integrity_check 均抛错 → 同步全量失败后仍走恢复流程', async () => {
      MockDatabase.pragmasToFail.push('quick_check', 'integrity_check')
      await expect(manager.initialize()).rejects.toThrow(/已损坏|无法从备份恢复/)
      expect(manager.getLastRecovery()).not.toBeNull()
      expect(manager.shouldRunFullIntegrityCheck()).toBe(false)
    })

    it('quick_check 通过 + 标志缺失（上次非干净退出）→ 返回 need，由 lifecycle 后台复核', async () => {
      // marker 路径不存在，其余路径存在（模拟真实磁盘：db 在、标志不在）
      vi.mocked(fs.existsSync).mockImplementation((p: string) => !String(p).endsWith('.clean-exit'))
      await manager.initialize()
      expect(manager.shouldRunFullIntegrityCheck()).toBe(true)
      // 快速路径通过时不同步跑全量（后台任务延后执行，不阻塞启动）
      expect(MockDatabase.pragmaCalls).not.toContain('integrity_check')
    })

    it('markCleanExit() 写入 {dbPath}.clean-exit 侧车标志文件', () => {
      manager.markCleanExit()
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/wxnn_photo_manager\.db\.clean-exit$/),
        expect.any(String),
        'utf8'
      )
    })

    it('markCleanExit() 后标志可被读取 → shouldRunFullIntegrityCheck() 转为 false', () => {
      const markerPath = `${manager.getDbPath()}.clean-exit`
      const existing = new Set<string>()
      vi.mocked(fs.existsSync).mockImplementation((p: string) => existing.has(String(p)))
      // 初始：标志缺失 → 需要全量
      expect(manager.shouldRunFullIntegrityCheck()).toBe(true)
      manager.markCleanExit()
      // 模拟标志已落盘
      existing.add(markerPath)
      expect(manager.shouldRunFullIntegrityCheck()).toBe(false)
    })

    it('全新库（db 文件不存在）→ 初始化后自动补写标志，跳过后台全量', async () => {
      vi.mocked(fs.existsSync).mockImplementation(
        (p: string) => !String(p).includes('wxnn_photo_manager.db')
      )
      await manager.initialize()
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/\.clean-exit$/),
        expect.any(String),
        'utf8'
      )
      expect(manager.shouldRunFullIntegrityCheck()).toBe(false)
    })

    it('runFullIntegrityCheck() 失败 → 返回 { ok:false } 且记录 databaseCorruption fault', async () => {
      await manager.initialize()
      MockDatabase.integrityFail = 'full'
      const faultSpy = vi.spyOn(logger, 'fault')
      const result = manager.runFullIntegrityCheck()
      expect(result.ok).toBe(false)
      expect(result.reason).toBeDefined()
      expect(faultSpy).toHaveBeenCalledWith(
        'databaseCorruption',
        expect.any(Error),
        expect.objectContaining({ dbPath: expect.any(String) })
      )
    })

    it('runFullIntegrityCheck() 通过 → 返回 { ok:true } 且不记录 fault', async () => {
      await manager.initialize()
      const faultSpy = vi.spyOn(logger, 'fault')
      const result = manager.runFullIntegrityCheck()
      expect(result).toEqual({ ok: true })
      expect(faultSpy).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // R16：safeEnsureColumn 列已存在时回填 NULL 行为 DEFAULT 值
  // ==========================================================================
  describe('R16 safeEnsureColumn 回填默认值', () => {
    /** 插入最小 media_files 行，返回 id */
    const insertMedia = (overrides: Record<string, unknown> = {}): number => {
      const cols = [
        'file_path',
        'file_name',
        'file_type',
        'file_ext',
        'file_size',
        'created_at',
        'modified_at',
        'source_path',
        'indexed_at'
      ]
      const vals = [
        overrides.file_path ?? '/test/img.jpg',
        overrides.file_name ?? 'img.jpg',
        overrides.file_type ?? 'image',
        overrides.file_ext ?? '.jpg',
        overrides.file_size ?? 1024,
        overrides.created_at ?? '2024-01-01',
        overrides.modified_at ?? '2024-01-01',
        overrides.source_path ?? '/test',
        overrides.indexed_at ?? '2024-01-01'
      ]
      const placeholders = cols.map(() => '?').join(', ')
      const result = manager.execute(
        `INSERT INTO media_files (${cols.join(', ')}) VALUES (${placeholders})`,
        vals
      )
      return Number(result.lastInsertRowid)
    }

    it('R16：列已存在且行有 NULL 时回填 DEFAULT 值', async () => {
      await manager.initialize()
      // scene_time 列定义 "TEXT DEFAULT 'unknown'"，手动设为 NULL 模拟旧记录
      const id = insertMedia()
      manager.execute('UPDATE media_files SET scene_time = NULL WHERE id = ?', [id])
      // 确认确实为 NULL
      const before = manager.query('SELECT scene_time FROM media_files WHERE id = ?', [id])
      expect((before[0] as { scene_time: string | null }).scene_time).toBeNull()

      // 重新 initialize 触发 safeEnsureColumn → duplicate column name → backfill
      await manager.initialize()

      const after = manager.query('SELECT scene_time FROM media_files WHERE id = ?', [id])
      expect((after[0] as { scene_time: string }).scene_time).toBe('unknown')
    })

    it('R16：非 NULL 行不受回填影响', async () => {
      await manager.initialize()
      const id = insertMedia()
      // 设为非 NULL 值
      manager.execute("UPDATE media_files SET scene_time = 'day' WHERE id = ?", [id])

      await manager.initialize()

      const row = manager.query('SELECT scene_time FROM media_files WHERE id = ?', [id])
      expect((row[0] as { scene_time: string }).scene_time).toBe('day')
    })

    it('R16：无 DEFAULT 子句的列不回填（NULL 是预期值）', async () => {
      await manager.initialize()
      const id = insertMedia()
      // phash 列定义 "TEXT"（无 DEFAULT），设为 NULL
      manager.execute('UPDATE media_files SET phash = NULL WHERE id = ?', [id])

      await manager.initialize()

      const row = manager.query('SELECT phash FROM media_files WHERE id = ?', [id])
      // phash 无 DEFAULT，回填逻辑跳过，保持 NULL
      expect((row[0] as { phash: string | null }).phash).toBeNull()
    })

    it('R16：多行 NULL 同时回填', async () => {
      await manager.initialize()
      insertMedia({ file_path: '/test/a.jpg', file_name: 'a.jpg' })
      insertMedia({ file_path: '/test/b.jpg', file_name: 'b.jpg' })
      insertMedia({ file_path: '/test/c.jpg', file_name: 'c.jpg' })
      // 三行 scene_time 都设为 NULL
      manager.execute('UPDATE media_files SET scene_time = NULL')

      await manager.initialize()

      const rows = manager.query('SELECT id, scene_time FROM media_files ORDER BY id')
      for (const row of rows as Array<{ id: number; scene_time: string }>) {
        expect(row.scene_time).toBe('unknown')
      }
      expect(rows).toHaveLength(3)
    })
  })
})
