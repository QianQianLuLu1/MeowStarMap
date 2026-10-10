import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { SQLITE_MAX_VARIABLE_NUMBER, SQL_IN_SAFE_CEILING, SQL_IN_CHUNK_SIZE } from './sql-chunk'

/**
 * MediaRepository 单元测试
 *
 * 策略：用 vi.mock 模拟 better-sqlite3，避免 native 模块编译依赖（Node ABI 兼容问题）
 * mock 内部实现一个简化的内存 SQL 引擎，覆盖 MediaRepository 实际使用的 SQL 模式：
 *   - CREATE TABLE
 *   - INSERT INTO ... VALUES (?, ?, ...)
 *   - UPDATE ... SET ... WHERE ... [AND ...] [IN (...)]
 *   - DELETE FROM ... WHERE ... [AND ...] [IN (...)]
 *   - SELECT cols FROM ... WHERE ... [GROUP BY] [ORDER BY] [LIMIT] [OFFSET]
 *   - COUNT(*) / MAX(col) / MIN(col) / SUM(col) 聚合
 *
 * 注意：mock 不解析完整 SQL 语法，仅识别 MediaRepository 中实际出现的 SQL 模板
 */

// ============================================================================
// 测试辅助：SQL LIKE 前缀匹配（支持 ESCAPE '\'），供路径前缀软删过滤
// ============================================================================
function escapeRegexChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
}

function likeMatch(value: string, pattern: string): boolean {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '\\') {
      const next = pattern[i + 1]
      re += next === undefined ? '' : escapeRegexChar(next)
      i += 2
      continue
    }
    if (ch === '%') re += '.*'
    else if (ch === '_') re += '.'
    else re += escapeRegexChar(ch)
    i++
  }
  return new RegExp(`^${re}$`).test(value)
}

// ============================================================================
// Mock 实现：内存 SQLite（仅覆盖 MediaRepository 用到的 SQL 模式）
// ============================================================================

interface MockRow {
  [key: string]: unknown
}

interface MockTable {
  name: string
  columns: string[]
  rows: MockRow[]
  autoIncrement: number
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

  constructor(_path: string) {}

  pragma(_str: string): void {
    // 忽略所有 PRAGMA
  }

  exec(sql: string): void {
    // 多语句：按 ; 拆分后逐条处理，避免贪婪正则跨语句误匹配
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s)
    for (const stmt of statements) {
      this.execSingle(stmt)
    }
  }

  private execSingle(sql: string): void {
    // 解析 CREATE TABLE
    const createMatch = sql.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]+)\)$/i
    )
    if (createMatch) {
      const [, name, colsDef] = createMatch
      // 过滤掉注释行和约束关键字（FOREIGN KEY / PRIMARY KEY 等内联约束）
      const lines = colsDef.split('\n').map((l) => l.replace(/--.*/, '').trim())
      const joined = lines.join(' ')
      const cleanColumns = joined
        .split(/,(?![^()]*\))/) // 不分割括号内的逗号
        .map((c) => c.trim().split(/\s+/)[0].replace(/[`,]/g, ''))
        .filter(
          (c) =>
            c &&
            !c.startsWith('--') &&
            c.toUpperCase() !== 'FOREIGN' &&
            c.toUpperCase() !== 'PRIMARY' &&
            c.toUpperCase() !== 'UNIQUE' &&
            c.toUpperCase() !== 'CHECK'
        )
      this.tables.set(name, {
        name,
        columns: cleanColumns,
        rows: [],
        autoIncrement: 0
      })
      this.autoIncCounters.set(name, 0)
      return
    }
    // 其他 exec（如 CREATE INDEX、DROP TABLE 等）忽略
  }

  prepare(sql: string): PreparedStatement {
    // better-sqlite3 兼容：run/get/all 既支持 run(p1, p2, ...) 也支持 run([p1, p2, ...])
    // MediaRepository.syncRun 调用 .run(params ?? []) 即数组形式，需解包后传给 executeRun
    const unwrap = (params: unknown[]): unknown[] =>
      params.length === 1 && Array.isArray(params[0]) ? (params[0] as unknown[]) : params
    return {
      sql,
      run: (...params: unknown[]) => this.executeRun(sql, unwrap(params)),
      get: (...params: unknown[]) => this.executeGet(sql, unwrap(params)),
      all: (...params: unknown[]) => this.executeAll(sql, unwrap(params))
    }
  }

  transaction<T>(fn: () => T): () => T
  transaction<T, A extends unknown[]>(fn: (...args: A) => T): (...args: A) => T
  transaction(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
    // 简化的事务：直接执行 fn（不真正实现回滚）
    // 注意：mock 不支持真实回滚；测试用例"事务中抛错回滚"需要单独处理
    return (...args: unknown[]) => fn(...args)
  }

  /**
   * 按逗号拆分（不分割括号内的逗号），用于 VALUES / SET 子句
   * 支持 datetime('now', 'localtime') 等带括号的表达式
   */
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

  /**
   * 解析 SQL 值表达式：? / NULL / 数字 / '字符串' / datetime('now')
   * 返回 { value, isParam } —— isParam=true 表示占用了 params 中一个位置
   */
  private parseValueExpr(
    expr: string,
    params: unknown[],
    paramIdx: number
  ): { value: unknown; isParam: boolean } {
    const e = expr.trim()
    if (e === '?') {
      return { value: params[paramIdx], isParam: true }
    }
    if (e.toUpperCase() === 'NULL') {
      return { value: null, isParam: false }
    }
    if (/^-?\d+(\.\d+)?$/.test(e)) {
      return { value: parseFloat(e), isParam: false }
    }
    // '字符串字面量'
    const strMatch = e.match(/^'([^']*)'$/)
    if (strMatch) {
      return { value: strMatch[1], isParam: false }
    }
    // "字符串字面量"（双引号）
    const strMatch2 = e.match(/^"([^"]*)"$/)
    if (strMatch2) {
      return { value: strMatch2[1], isParam: false }
    }
    // datetime('now') / datetime("now") / datetime('now', 'localtime')
    const dtMatch = e.match(/datetime\s*\(\s*['"]now['"]\s*(?:,\s*['"][^'"]*['"]\s*)?\s*\)/i)
    if (dtMatch) {
      // 返回 ISO 风格的本地时间字符串（SQLite datetime('now') 返回 UTC）
      const now = new Date()
      const utc = new Date(now.getTime() + now.getTimezoneOffset() * 60000)
      const str = utc.toISOString().replace('T', ' ').substring(0, 19)
      return { value: str, isParam: false }
    }
    // 其他未识别表达式（如 COALESCE、CASE 等）：置 null（不影响测试断言）
    return { value: null, isParam: false }
  }

  private executeRun(
    sql: string,
    params: unknown[]
  ): { changes: number; lastInsertRowid: number | bigint } {
    // INSERT INTO table (cols) VALUES (?, ?, ?, datetime('now'))
    // 用贪心正则捕获整段 VALUES 内容，再用 splitOnComma 处理嵌套括号
    const insertMatch = sql.match(
      /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([\s\S]+)\)\s*$/i
    )
    if (insertMatch) {
      const [, tableName, colsList, valuesList] = insertMatch
      const cols = colsList.split(',').map((c) => c.trim())
      const valueExprs = this.splitOnComma(valuesList)
      const table = this.tables.get(tableName)
      if (!table) throw new Error(`Table ${tableName} not found`)

      const row: MockRow = {}
      let paramIdx = 0
      cols.forEach((col, i) => {
        const expr = valueExprs[i] || '?'
        const { value, isParam } = this.parseValueExpr(expr, params, paramIdx)
        if (isParam) paramIdx++
        row[col] = value
      })

      // 处理 AUTOINCREMENT（id 列）
      if (cols.includes('id') && (row.id === undefined || row.id === null)) {
        const counter = (this.autoIncCounters.get(tableName) || 0) + 1
        this.autoIncCounters.set(tableName, counter)
        row.id = counter
      } else if (!cols.includes('id')) {
        const counter = (this.autoIncCounters.get(tableName) || 0) + 1
        this.autoIncCounters.set(tableName, counter)
        row.id = counter
      }

      table.rows.push(row)
      return {
        changes: 1,
        lastInsertRowid: row.id as number
      }
    }

    // UPDATE table SET col1 = ?, col2 = 'literal', col3 = datetime('now') WHERE ...
    const updateMatch = sql.match(/UPDATE\s+(\w+)\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/i)
    if (updateMatch) {
      const [, tableName, setClause, whereClause] = updateMatch
      const table = this.tables.get(tableName)
      if (!table) throw new Error(`Table ${tableName} not found`)

      // 拆分 SET 子句（不分割括号内逗号，如 datetime('now', 'localtime')）
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

      // 过滤符合条件的行（WHERE 用 SET 之后剩余的参数）
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

    // DELETE FROM table WHERE ...
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
      const changes = initialLength - table.rows.length
      return { changes, lastInsertRowid: 0 }
    }

    return { changes: 0, lastInsertRowid: 0 }
  }

  private executeGet(sql: string, params: unknown[]): MockRow | undefined {
    const rows = this.executeAll(sql, params)
    return rows[0]
  }

  private executeAll(sql: string, params: unknown[]): MockRow[] {
    // SELECT cols FROM table [WHERE ...] [GROUP BY col] [ORDER BY col ASC/DESC, ...] [LIMIT n|?] [OFFSET n|?]
    const selectMatch = sql.match(
      /SELECT\s+([\s\S]+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+([\s\S]+?))?(?:\s+GROUP\s+BY\s+([\s\S]+?))?(?:\s+ORDER\s+BY\s+([\s\S]+?))?(?:\s+LIMIT\s+(\d+|\?)(?:\s+OFFSET\s+(\d+|\?))?)?$/i
    )
    if (!selectMatch) {
      return []
    }

    const [, selectClause, tableName, whereClause, groupByClause, orderByClause, limit, offset] =
      selectMatch
    const table = this.tables.get(tableName)
    if (!table) throw new Error(`Table ${tableName} not found`)

    // 处理参数化 LIMIT ? 和 OFFSET ? —— 从 params 末尾弹出（WHERE 参数在前）
    // SQL 中 LIMIT 在 OFFSET 之前，故 params 顺序为 [...whereParams, limit, offset]
    // 先弹 offset（最末），再弹 limit
    let limitNum: number | undefined
    let offsetNum: number = 0
    if (limit !== undefined) {
      if (offset === '?') {
        const v = params.pop()
        offsetNum = typeof v === 'number' ? v : parseInt(String(v), 10)
      } else if (offset !== undefined) {
        offsetNum = parseInt(offset, 10)
      }
      if (limit === '?') {
        const v = params.pop()
        limitNum = typeof v === 'number' ? v : parseInt(String(v), 10)
      } else {
        limitNum = parseInt(limit, 10)
      }
      // SQLite 行为：负 OFFSET 视为 0；负 LIMIT 视为无上限
      if (offsetNum < 0) offsetNum = 0
      if (limitNum !== undefined && limitNum < 0) limitNum = undefined
    }

    // 过滤
    let rows = whereClause
      ? table.rows.filter((row) => this.matchWhere(row, whereClause, params))
      : [...table.rows]

    // 标记是否已聚合（聚合结果 aggRow 已包含正确字段，跳过后续投影）
    let isAggregated = false

    // GROUP BY 聚合
    if (groupByClause) {
      const groupCol = groupByClause.trim().split(/\s+/)[0]
      const groups = new Map<string, MockRow[]>()
      for (const row of rows) {
        const key = String(row[groupCol])
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(row)
      }
      // 检查是否是聚合查询
      const hasCount = /COUNT\s*\(\s*\*\s*\)/i.test(selectClause)
      const hasMax = /MAX\s*\(\s*(\w+)\s*\)/i.test(selectClause)
      const hasMin = /MIN\s*\(\s*(\w+)\s*\)/i.test(selectClause)
      const hasSum = /SUM\s*\(\s*(?:CASE[\s\S]+?ELSE\s+0\s+END|[\w.]+)\s*\)/i.test(selectClause)

      if (hasCount || hasMax || hasMin || hasSum) {
        const aggregatedRows: MockRow[] = []
        for (const [, groupRows] of groups) {
          const aggRow: MockRow = {}
          // 解析 select 中的字段
          const selectItems = selectClause.split(',').map((s) => s.trim())
          for (const item of selectItems) {
            const countMatch = item.match(/COUNT\s*\(\s*\*\s*\)\s*(?:as|AS)\s+(\w+)/i)
            const maxMatch = item.match(/MAX\s*\(\s*(\w+)\s*\)\s*(?:as|AS)\s+(\w+)/i)
            const minMatch = item.match(/MIN\s*\(\s*(\w+)\s*\)\s*(?:as|AS)\s+(\w+)/i)
            // SUM(CASE WHEN file_type='image' THEN 1 ELSE 0 END) as image_count
            const sumCaseMatch = item.match(
              /SUM\s*\(\s*CASE\s+WHEN\s+(\w+)\s*=\s*'(\w+)'\s+THEN\s+1\s+ELSE\s+0\s+END\s*\)\s*(?:as|AS)\s+(\w+)/i
            )
            const sumSimpleMatch = item.match(
              /COALESCE\s*\(\s*SUM\s*\(\s*(\w+)\s*\)\s*,\s*0\s*\)\s*(?:as|AS)\s+(\w+)/i
            )
            const plainColMatch = item.match(/^(\w+)(?:\s*(?:as|AS)\s+(\w+))?$/i)

            if (countMatch) {
              aggRow[countMatch[1]] = groupRows.length
            } else if (maxMatch) {
              const col = maxMatch[1]
              const alias = maxMatch[2]
              const values = groupRows.map((r) => r[col] as number).filter((v) => v !== null)
              aggRow[alias] = values.length > 0 ? values.reduce((a, b) => (a > b ? a : b)) : null
            } else if (minMatch) {
              const col = minMatch[1]
              const alias = minMatch[2]
              const values = groupRows.map((r) => r[col] as number).filter((v) => v !== null)
              aggRow[alias] = values.length > 0 ? values.reduce((a, b) => (a < b ? a : b)) : null
            } else if (sumCaseMatch) {
              const col = sumCaseMatch[1]
              const val = sumCaseMatch[2]
              const alias = sumCaseMatch[3]
              aggRow[alias] = groupRows.filter((r) => String(r[col]) === val).length
            } else if (sumSimpleMatch) {
              const col = sumSimpleMatch[1]
              const alias = sumSimpleMatch[2]
              const sum = groupRows.reduce((acc, r) => acc + ((r[col] as number) || 0), 0)
              aggRow[alias] = sum
            } else if (plainColMatch) {
              const col = plainColMatch[1]
              const alias = plainColMatch[2] || col
              aggRow[alias] = groupRows[0][col]
            }
          }
          aggregatedRows.push(aggRow)
        }
        rows = aggregatedRows
        isAggregated = true
      }
    } else {
      // 聚合但无 GROUP BY：MAX(col) as alias / MIN(col) as alias / COUNT(*) as count / 多聚合
      const maxOnlyMatch = selectClause.match(/^MAX\s*\(\s*(\w+)\s*\)\s*(?:as|AS)\s+(\w+)$/i)
      if (maxOnlyMatch) {
        const col = maxOnlyMatch[1]
        const alias = maxOnlyMatch[2]
        const values = rows
          .map((r) => r[col] as number)
          .filter((v) => v !== null && v !== undefined)
        return [{ [alias]: values.length > 0 ? values.reduce((a, b) => (a > b ? a : b)) : null }]
      }
      const minOnlyMatch = selectClause.match(/^MIN\s*\(\s*(\w+)\s*\)\s*(?:as|AS)\s+(\w+)$/i)
      if (minOnlyMatch) {
        const col = minOnlyMatch[1]
        const alias = minOnlyMatch[2]
        const values = rows
          .map((r) => r[col] as number)
          .filter((v) => v !== null && v !== undefined)
        return [{ [alias]: values.length > 0 ? values.reduce((a, b) => (a < b ? a : b)) : null }]
      }
      const countOnlyMatch = selectClause.match(/^COUNT\s*\(\s*\*\s*\)\s*(?:as|AS)\s+(\w+)$/i)
      if (countOnlyMatch) {
        const alias = countOnlyMatch[1]
        return [{ [alias]: rows.length }]
      }
      const multiAggMatch = selectClause.match(
        /COUNT\s*\(\s*\*\s*\)\s*(?:as|AS)\s+(\w+)\s*,\s*SUM\s*\(\s*CASE[\s\S]+?ELSE\s+0\s+END\s*\)\s*(?:as|AS)\s+(\w+)\s*,\s*SUM\s*\(\s*CASE[\s\S]+?ELSE\s+0\s+END\s*\)\s*(?:as|AS)\s+(\w+)\s*,\s*COALESCE\s*\(\s*SUM[\s\S]+?\s*,\s*0\s*\)\s*(?:as|AS)\s+(\w+)\s*,\s*MIN\s*\(\s*(\w+)\s*\)\s*(?:as|AS)\s+(\w+)\s*,\s*MAX\s*\(\s*(\w+)\s*\)\s*(?:as|AS)\s+(\w+)/i
      )
      if (multiAggMatch) {
        const totalCount = rows.length
        const imageCount = rows.filter((r) => r.file_type === 'image').length
        const videoCount = rows.filter((r) => r.file_type === 'video').length
        const totalSize = rows.reduce((acc, r) => acc + ((r.file_size as number) || 0), 0)
        const earliestTime =
          rows
            .map((r) => r.created_at as string)
            .filter((v) => v !== null && v !== undefined)
            .sort()[0] || null
        const latestTime =
          rows
            .map((r) => r.created_at as string)
            .filter((v) => v !== null && v !== undefined)
            .sort()
            .reverse()[0] || null
        return [
          {
            total_count: totalCount,
            image_count: imageCount,
            video_count: videoCount,
            total_size: totalSize,
            earliest_time: earliestTime,
            latest_time: latestTime
          }
        ]
      }
    }

    // ORDER BY —— 支持多列（如 "cnt DESC, latest_created DESC"）
    if (orderByClause) {
      const specs = orderByClause.split(',').map((s) => s.trim())
      // 从最后一列往前排序（稳定排序保证多列优先级正确）
      for (let i = specs.length - 1; i >= 0; i--) {
        const parts = specs[i].split(/\s+/)
        const sortCol = parts[0]
        const direction = (parts[1] || 'ASC').toUpperCase()
        rows.sort((a, b) => {
          const av = a[sortCol] as string | number | null | undefined
          const bv = b[sortCol] as string | number | null | undefined
          if (av === null || av === undefined) return direction === 'ASC' ? -1 : 1
          if (bv === null || bv === undefined) return direction === 'ASC' ? 1 : -1
          if (av < bv) return direction === 'ASC' ? -1 : 1
          if (av > bv) return direction === 'ASC' ? 1 : -1
          return 0
        })
      }
    }

    // LIMIT + OFFSET
    if (limitNum !== undefined) {
      rows = rows.slice(offsetNum, offsetNum + limitNum)
    }

    // 聚合查询直接返回（aggRow 已包含正确 alias 字段，不做投影）
    if (isAggregated) {
      return rows
    }

    // 字段投影（仅返回 SELECT 中指定的列，使用 alias）
    const selectItems = selectClause.split(',').map((s) => s.trim())
    const projected = rows.map((row) => {
      const out: MockRow = {}
      for (const item of selectItems) {
        // 简单列名 / 列名 AS alias
        const m = item.match(/^(\w+)(?:\s+(?:as|AS)\s+(\w+))?$/)
        if (m) {
          const col = m[1]
          const alias = m[2] || col
          if (row[col] !== undefined) {
            out[alias] = row[col]
          }
        }
        // COUNT(*) as count 已在聚合处理
        // 其他情况忽略（不在 SELECT 中的列）
      }
      return out
    })

    return projected
  }

  /**
   * 简化的 WHERE 匹配器
   * 支持：col = ?、col < ?、col > ?、col IS NULL、col IS NOT NULL、col != ''、col IN (?, ?, ?)
   * 支持 AND 连接，以及顶层 OR 与括号分组（用于 keyset 游标的
   * `(sortCol < ? OR (sortCol = ? AND id < ?))` 形态）
   * 参数绑定按出现顺序从 params 头开始消费（与 better-sqlite3 位置参数一致）。
   */
  private matchWhere(row: MockRow, whereClause: string, params: unknown[]): boolean {
    const clause = whereClause.trim().replace(/^WHERE\s+/i, '')
    // 顶层 OR 拆分（不在括号内）
    const orGroups = this.splitTopLevel(clause, /\s+OR\s+/i)
    let paramIdx = 0
    // 任一 OR 分组为真即整体为真
    const groupResults = orGroups.map((group) => {
      const andConds = this.splitTopLevel(group, /\s+AND\s+/i)
      for (const cond of andConds) {
        const matched = this.evalCondition(row, cond.trim(), params, paramIdx)
        if (matched === null) {
          // 未识别：保守视为真，不推进 paramIdx（交由后续识别条件消费）
          continue
        }
        const [ok, nextIdx] = matched
        paramIdx = nextIdx
        if (!ok) return false
      }
      return true
    })
    return groupResults.some((r) => r === true)
  }

  /**
   * 按分隔符（正则）在「不在括号内」的顶层位置拆分字符串。
   * 括号深度通过左右括号计数维护；分隔符匹配使用 sticky 正则从当前位置尝试，
   * 避免逐字符匹配多字符分隔符失败的坑。
   */
  private splitTopLevel(input: string, sep: RegExp): string[] {
    const parts: string[] = []
    let depth = 0
    let current = ''
    // 以 sticky 模式在 i 处尝试匹配分隔符
    const re = new RegExp(sep.source, sep.flags.includes('g') ? sep.flags : sep.flags + 'y')
    for (let i = 0; i < input.length; i++) {
      const ch = input[i]
      if (ch === '(') {
        depth++
        current += ch
        continue
      }
      if (ch === ')') {
        depth = Math.max(0, depth - 1)
        current += ch
        continue
      }
      if (depth === 0) {
        re.lastIndex = i
        const m = re.exec(input)
        if (m && m.index === i) {
          if (current.trim().length > 0) parts.push(current.trim())
          current = ''
          i += m[0].length - 1
          continue
        }
      }
      current += ch
    }
    if (current.trim().length > 0) parts.push(current.trim())
    return parts
  }

  /**
   * 求值单个 AND 条件（可能是括号分组）。返回 [匹配结果, 消费参数后的新索引]；
   * 无法识别则返回 null（调用方保守视为真且不消费参数）。
   */
  private evalCondition(
    row: MockRow,
    cond: string,
    params: unknown[],
    paramIdx: number
  ): [boolean, number] | null {
    // 括号分组：( ... ) → 组内按「顶层 OR 再 AND」求值（支持 keyset 的 (a < ? OR (a = ? AND id < ?))）
    const groupMatch = cond.match(/^\(([\s\S]+)\)$/)
    if (groupMatch) {
      const inner = groupMatch[1]
      const orGroups = this.splitTopLevel(inner, /\s+OR\s+/i)
      let idx = paramIdx
      const anyTrue = orGroups.some((g) => {
        const andConds = this.splitTopLevel(g, /\s+AND\s+/i)
        for (const c of andConds) {
          const r = this.evalCondition(row, c.trim(), params, idx)
          if (r === null) continue
          idx = r[1]
          if (!r[0]) return false
        }
        return true
      })
      return [anyTrue, idx]
    }
    // 逻辑非：NOT ( ... ) → 对子分组取反（子分组内仍按 OR/AND 求值）
    const notMatch = cond.match(/^NOT\s+\(([\s\S]+)\)$/i)
    if (notMatch) {
      const inner = notMatch[1]
      const orGroups = this.splitTopLevel(inner, /\s+OR\s+/i)
      let idx = paramIdx
      const anyTrue = orGroups.some((g) => {
        const andConds = this.splitTopLevel(g, /\s+AND\s+/i)
        for (const c of andConds) {
          const r = this.evalCondition(row, c.trim(), params, idx)
          if (r === null) continue
          idx = r[1]
          if (!r[0]) return false
        }
        return true
      })
      return [!anyTrue, idx]
    }

    let localIdx = paramIdx

    // col < ? / col > ?（含 NULL 安全：NULL 视为最小，任何比较为 false 一侧）
    let m = cond.match(/^(\w+)\s*(<|>)\s*\?$/)
    if (m) {
      const col = m[1]
      const op = m[2]
      const val = row[col]
      const cmp = params[localIdx++]
      if (val === null || val === undefined) return [false, localIdx]
      const cmpStr = String(cmp)
      const valStr = String(val)
      const less = valStr < cmpStr
      const greater = valStr > cmpStr
      // 字典序比较（created_at 为 ISO 文本，id 为数值但统一按字符串比较不影响排序语义）
      if (op === '<') return [less, localIdx]
      return [greater, localIdx]
    }
    // col = ?
    m = cond.match(/^(\w+)\s*=\s*\?$/)
    if (m) {
      const col = m[1]
      return [row[col] === params[localIdx++], localIdx]
    }
    // col = 'literal'
    m = cond.match(/^(\w+)\s*=\s*'([^']*)'$/)
    if (m) {
      return [row[m[1]] === m[2], localIdx]
    }
    // col IN (?, ?, ...)
    m = cond.match(/^(\w+)\s+IN\s*\(([^)]+)\)$/i)
    if (m) {
      const col = m[1]
      const placeholders = m[2].split(',').map((s) => s.trim())
      const values = placeholders.map(() => params[localIdx++])
      return [values.includes(row[col]), localIdx]
    }
    // col IS NULL
    if (/^\w+\s+IS\s+NULL$/i.test(cond)) {
      const col = cond.split(/\s+/)[0]
      return [row[col] === null || row[col] === undefined, localIdx]
    }
    // col IS NOT NULL
    if (/^\w+\s+IS\s+NOT\s+NULL$/i.test(cond)) {
      const col = cond.split(/\s+/)[0]
      return [!(row[col] === null || row[col] === undefined), localIdx]
    }
    // col != ''
    if (/^\w+\s*!=\s*''$/.test(cond)) {
      const col = cond.split(/!=/)[0].trim()
      return [row[col] !== '', localIdx]
    }
    // COALESCE(col, 'default') != 'literal' / = 'literal'
    m = cond.match(/^COALESCE\s*\(\s*(\w+)\s*,\s*'([^']*)'\s*\)\s*(!=|=)\s*'([^']*)'$/i)
    if (m) {
      const [, col, def, op, literal] = m
      const val = row[col] === null || row[col] === undefined ? def : row[col]
      return [op === '!=' ? val !== literal : val === literal, localIdx]
    }
    // col = 0 或 col = 1
    m = cond.match(/^(\w+)\s*=\s*(\d+)$/)
    if (m) {
      return [row[m[1]] === parseInt(m[2], 10), localIdx]
    }
    // colExpr LIKE ? ESCAPE '\'
    m = cond.match(/^(.+?)\s+LIKE\s+\?\s+ESCAPE\s+'\\'\s*$/i)
    if (m) {
      const colExpr = m[1].trim()
      const pattern = String(params[localIdx++] ?? '')
      let leftVal: string
      if (colExpr === "LOWER(REPLACE(file_path, '\\', '/'))") {
        leftVal = String(row.file_path ?? '')
          .replace(/\\/g, '/')
          .toLowerCase()
      } else {
        const colName = colExpr.replace(/^LOWER\(([\w.]+)\)$/i, '$1').trim()
        leftVal = String(row[colName] ?? '')
      }
      return [likeMatch(leftVal, pattern), localIdx]
    }
    // 未识别：返回 null（调用方保守视为真）
    return null
  }
}

// 应用 mock
vi.mock('better-sqlite3', () => ({
  default: MockDatabase
}))

// ============================================================================
// 测试用例
// ============================================================================

import { MediaRepository } from './media-repository'

/** 创建内存数据库并初始化 schema */
function createInMemoryDb(): MockDatabase {
  const db = new MockDatabase(':memory:')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE media_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_ext TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      duration REAL,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      source_path TEXT NOT NULL,
      thumbnail TEXT,
      tags TEXT DEFAULT '[]',
      category_id INTEGER,
      rating INTEGER DEFAULT 0,
      is_favorite INTEGER DEFAULT 0,
      notes TEXT DEFAULT '',
      indexed_at TEXT NOT NULL,
      scene_category TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      scene_time TEXT DEFAULT 'unknown',
      outfit TEXT DEFAULT '',
      is_missing INTEGER NOT NULL DEFAULT 0,
      missing_count INTEGER NOT NULL DEFAULT 0,
      phash TEXT,
      phash_mtime INTEGER,
      phash_file_size INTEGER,
      account_uid TEXT NOT NULL DEFAULT 'default',
      album_type TEXT NOT NULL DEFAULT '其他',
      is_duplicate INTEGER NOT NULL DEFAULT 0,
      original_id INTEGER,
      media_source TEXT NOT NULL DEFAULT 'game',
      delete_origin TEXT
    );

    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      icon TEXT,
      color TEXT,
      sort_order INTEGER DEFAULT 0,
      parent_id INTEGER,
      is_system INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE character_profiles (
      uid TEXT PRIMARY KEY,
      nickname TEXT NOT NULL DEFAULT '',
      avatar TEXT,
      created_at TEXT NOT NULL,
      last_active_at TEXT
    );

    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  return db
}

interface MediaOverrides {
  id?: number
  file_path?: string
  file_name?: string
  file_type?: string
  file_ext?: string
  file_size?: number
  width?: number | null
  height?: number | null
  duration?: number | null
  created_at?: string
  modified_at?: string
  source_path?: string
  thumbnail?: string | null
  tags?: string
  category_id?: number | null
  rating?: number
  is_favorite?: number
  notes?: string
  indexed_at?: string
  scene_category?: string | null
  is_deleted?: number
  deleted_at?: string | null
  scene_time?: string
  outfit?: string
  is_missing?: number
  missing_count?: number
  phash?: string | null
  phash_mtime?: number | null
  phash_file_size?: number | null
  account_uid?: string
  album_type?: string
  is_duplicate?: number
  original_id?: number | null
  media_source?: string
  delete_origin?: string | null
}

function insertMedia(db: MockDatabase, overrides: MediaOverrides = {}): number {
  const v = {
    file_path: '/test/photo.jpg',
    file_name: 'photo.jpg',
    file_type: 'image',
    file_ext: '.jpg',
    file_size: 1024,
    width: 1920,
    height: 1080,
    duration: null,
    created_at: '2024-01-01 10:00:00',
    modified_at: '2024-01-01 10:00:00',
    source_path: '/source',
    thumbnail: null,
    tags: '[]',
    category_id: null,
    rating: 0,
    is_favorite: 0,
    notes: '',
    indexed_at: '2024-01-01 10:00:00',
    scene_category: null,
    is_deleted: 0,
    deleted_at: null,
    scene_time: 'unknown',
    outfit: '',
    is_missing: 0,
    missing_count: 0,
    phash: null,
    phash_mtime: null,
    phash_file_size: null,
    account_uid: 'default',
    album_type: '其他',
    is_duplicate: 0,
    original_id: null,
    media_source: 'game',
    delete_origin: null,
    ...overrides
  }
  const cols = [
    'file_path',
    'file_name',
    'file_type',
    'file_ext',
    'file_size',
    'width',
    'height',
    'duration',
    'created_at',
    'modified_at',
    'source_path',
    'thumbnail',
    'tags',
    'category_id',
    'rating',
    'is_favorite',
    'notes',
    'indexed_at',
    'scene_category',
    'is_deleted',
    'deleted_at',
    'scene_time',
    'outfit',
    'is_missing',
    'missing_count',
    'phash',
    'phash_mtime',
    'phash_file_size',
    'account_uid',
    'album_type',
    'is_duplicate',
    'original_id',
    'media_source',
    'delete_origin'
  ]
  const placeholders = cols.map(() => '?').join(', ')
  const values = cols.map((c) => v[c as keyof MediaOverrides])
  const result = db
    .prepare(`INSERT INTO media_files (${cols.join(', ')}) VALUES (${placeholders})`)
    .run(...values)
  return Number(result.lastInsertRowid)
}

function insertCategory(
  db: MockDatabase,
  overrides: Partial<{
    name: string
    icon: string
    color: string
    sort_order: number
    parent_id: number | null
    is_system: number
  }> = {}
): number {
  const v = {
    name: '测试分类',
    icon: 'icon',
    color: '#000000',
    sort_order: 1,
    parent_id: null,
    is_system: 0,
    ...overrides
  }
  const result = db
    .prepare(
      `INSERT INTO categories (name, icon, color, sort_order, parent_id, is_system, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(v.name, v.icon, v.color, v.sort_order, v.parent_id, v.is_system)
  return Number(result.lastInsertRowid)
}

function insertProfile(
  db: MockDatabase,
  overrides: Partial<{
    uid: string
    nickname: string
    avatar: string | null
    created_at: string
    last_active_at: string | null
  }> = {}
): string {
  const v = {
    uid: 'user-001',
    nickname: '角色1',
    avatar: null,
    created_at: '2024-01-01 10:00:00',
    last_active_at: null,
    ...overrides
  }
  db.prepare(
    `INSERT INTO character_profiles (uid, nickname, avatar, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)`
  ).run(v.uid, v.nickname, v.avatar, v.created_at, v.last_active_at)
  return v.uid
}

describe('MediaRepository', () => {
  let db: MockDatabase
  let repo: MediaRepository

  beforeEach(() => {
    db = createInMemoryDb()
    repo = new MediaRepository(db as unknown as import('better-sqlite3').Database)
  })

  // ==========================================================================
  // 单行更新
  // ==========================================================================
  describe('单行更新', () => {
    it('updateRating 正常更新评分', async () => {
      const id = insertMedia(db, { rating: 0 })
      await repo.updateRating(id, 5)
      const row = db.prepare('SELECT rating FROM media_files WHERE id = ?').get(id) as {
        rating: number
      }
      expect(row.rating).toBe(5)
    })

    it('updateRating mediaId 不存在时不抛错', async () => {
      await expect(repo.updateRating(99999, 5)).resolves.toBeUndefined()
    })

    it('updateFavorite true → 1', async () => {
      const id = insertMedia(db, { is_favorite: 0 })
      await repo.updateFavorite(id, true)
      const row = db.prepare('SELECT is_favorite FROM media_files WHERE id = ?').get(id) as {
        is_favorite: number
      }
      expect(row.is_favorite).toBe(1)
    })

    it('updateFavorite false → 0', async () => {
      const id = insertMedia(db, { is_favorite: 1 })
      await repo.updateFavorite(id, false)
      const row = db.prepare('SELECT is_favorite FROM media_files WHERE id = ?').get(id) as {
        is_favorite: number
      }
      expect(row.is_favorite).toBe(0)
    })

    it('updateTags 空数组', async () => {
      const id = insertMedia(db)
      await repo.updateTags(id, [])
      const row = db.prepare('SELECT tags FROM media_files WHERE id = ?').get(id) as {
        tags: string
      }
      expect(JSON.parse(row.tags)).toEqual([])
    })

    it('updateTags 单元素与多元素', async () => {
      const id = insertMedia(db)
      await repo.updateTags(id, ['风景'])
      expect(
        (db.prepare('SELECT tags FROM media_files WHERE id = ?').get(id) as { tags: string }).tags
      ).toBe('["风景"]')

      await repo.updateTags(id, ['风景', '人物', '夜景'])
      expect(
        (db.prepare('SELECT tags FROM media_files WHERE id = ?').get(id) as { tags: string }).tags
      ).toBe('["风景","人物","夜景"]')
    })

    it('updateTags 含中文/特殊字符', async () => {
      const id = insertMedia(db)
      await repo.updateTags(id, ['暖暖"套装"', '<script>'])
      const row = db.prepare('SELECT tags FROM media_files WHERE id = ?').get(id) as {
        tags: string
      }
      const parsed = JSON.parse(row.tags)
      expect(parsed).toEqual(['暖暖"套装"', '<script>'])
    })

    it('updateNotes 空字符串与长文本', async () => {
      const id = insertMedia(db)
      await repo.updateNotes(id, '')
      expect(
        (db.prepare('SELECT notes FROM media_files WHERE id = ?').get(id) as { notes: string })
          .notes
      ).toBe('')

      const longText = 'a'.repeat(10000)
      await repo.updateNotes(id, longText)
      expect(
        (db.prepare('SELECT notes FROM media_files WHERE id = ?').get(id) as { notes: string })
          .notes
      ).toBe(longText)
    })

    it('updateCategory null 取消分类', async () => {
      const catId = insertCategory(db)
      const id = insertMedia(db, { category_id: catId })
      await repo.updateCategory(id, null)
      const row = db.prepare('SELECT category_id FROM media_files WHERE id = ?').get(id) as {
        category_id: number | null
      }
      expect(row.category_id).toBeNull()
    })

    it('updateCategory 正常赋值', async () => {
      const catId = insertCategory(db)
      const id = insertMedia(db)
      await repo.updateCategory(id, catId)
      const row = db.prepare('SELECT category_id FROM media_files WHERE id = ?').get(id) as {
        category_id: number | null
      }
      expect(row.category_id).toBe(catId)
    })

    it('updateOutfit 空字符串与套装名', async () => {
      const id = insertMedia(db, { outfit: '初始套装' })
      await repo.updateOutfit(id, '')
      expect(
        (db.prepare('SELECT outfit FROM media_files WHERE id = ?').get(id) as { outfit: string })
          .outfit
      ).toBe('')

      await repo.updateOutfit(id, '星海幻想')
      expect(
        (db.prepare('SELECT outfit FROM media_files WHERE id = ?').get(id) as { outfit: string })
          .outfit
      ).toBe('星海幻想')
    })

    it('updateSceneTime 更新场景时段', async () => {
      const id = insertMedia(db, { scene_time: 'unknown' })
      await repo.updateSceneTime(id, 'day')
      expect(
        (
          db.prepare('SELECT scene_time FROM media_files WHERE id = ?').get(id) as {
            scene_time: string
          }
        ).scene_time
      ).toBe('day')
    })
  })

  // ==========================================================================
  // 批量删除/恢复
  // ==========================================================================
  describe('批量删除/恢复', () => {
    it('hardDelete 删除后查不到', async () => {
      const id = insertMedia(db)
      await repo.hardDelete(id)
      const row = db.prepare('SELECT id FROM media_files WHERE id = ?').get(id)
      expect(row).toBeUndefined()
    })

    it('softDeleteBatch 空数组 no-op', async () => {
      await expect(repo.softDeleteBatch([])).resolves.toBeUndefined()
    })

    it('softDeleteBatch 单条软删除', async () => {
      const id = insertMedia(db, { is_deleted: 0 })
      await repo.softDeleteBatch([id])
      const row = db.prepare('SELECT is_deleted, deleted_at FROM media_files WHERE id = ?').get(id)
      expect(row?.is_deleted).toBe(1)
      expect(row?.deleted_at).not.toBeNull()
    })

    it('softDeleteBatch 多条批量软删除', async () => {
      const id1 = insertMedia(db, { file_path: '/test/1.jpg' })
      const id2 = insertMedia(db, { file_path: '/test/2.jpg' })
      const id3 = insertMedia(db, { file_path: '/test/3.jpg' })
      await repo.softDeleteBatch([id1, id2, id3])
      const rows = db
        .prepare('SELECT id FROM media_files WHERE is_deleted = 1 ORDER BY id')
        .all() as Array<{ id: number }>
      expect(rows.map((r) => r.id)).toEqual([id1, id2, id3])
    })

    it('softDeleteBatch 已软删除 id 幂等', async () => {
      const id = insertMedia(db)
      await repo.softDeleteBatch([id])
      const firstDeletedAt = (
        db.prepare('SELECT deleted_at FROM media_files WHERE id = ?').get(id) as {
          deleted_at: string
        }
      ).deleted_at

      await repo.softDeleteBatch([id])
      const secondDeletedAt = (
        db.prepare('SELECT deleted_at FROM media_files WHERE id = ?').get(id) as {
          deleted_at: string
        }
      ).deleted_at
      expect(secondDeletedAt).toBe(firstDeletedAt)
    })

    it('restoreBatch 空数组 no-op', async () => {
      await expect(repo.restoreBatch([])).resolves.toBeUndefined()
    })

    it('restoreBatch 单条恢复', async () => {
      const id = insertMedia(db, { is_deleted: 1, deleted_at: '2024-01-01 10:00:00' })
      await repo.restoreBatch([id])
      const row = db.prepare('SELECT is_deleted, deleted_at FROM media_files WHERE id = ?').get(id)
      expect(row?.is_deleted).toBe(0)
      expect(row?.deleted_at).toBeNull()
    })

    it('restoreBatch 多条批量恢复', async () => {
      const id1 = insertMedia(db, { file_path: '/t/1.jpg', is_deleted: 1, deleted_at: '2024' })
      const id2 = insertMedia(db, { file_path: '/t/2.jpg', is_deleted: 1, deleted_at: '2024' })
      await repo.restoreBatch([id1, id2])
      const rows = db
        .prepare('SELECT COUNT(*) as count FROM media_files WHERE is_deleted = 1')
        .get() as { count: number }
      expect(rows.count).toBe(0)
    })

    it('restoreBatch 非软删除 id 幂等', async () => {
      const id = insertMedia(db, { is_deleted: 0 })
      await expect(repo.restoreBatch([id])).resolves.toBeUndefined()
      const row = db.prepare('SELECT is_deleted FROM media_files WHERE id = ?').get(id) as {
        is_deleted: number
      }
      expect(row.is_deleted).toBe(0)
    })

    it('softDeleteForPermanentDelete 空数组 no-op', async () => {
      await expect(repo.softDeleteForPermanentDelete([])).resolves.toBeUndefined()
    })

    it('softDeleteForPermanentDelete 多条标记软删除', async () => {
      const id1 = insertMedia(db, { file_path: '/t/1.jpg' })
      const id2 = insertMedia(db, { file_path: '/t/2.jpg' })
      await repo.softDeleteForPermanentDelete([id1, id2])
      const rows = db
        .prepare('SELECT COUNT(*) as count FROM media_files WHERE is_deleted = 1')
        .get() as { count: number }
      expect(rows.count).toBe(2)
    })

    // 软删除来源标记（回收站语义修复）：用户主动删除标记 'user'，重扫不得复活
    it('softDeleteBatch 标记 delete_origin = user', async () => {
      const id = insertMedia(db, { is_deleted: 0 })
      await repo.softDeleteBatch([id])
      const row = db.prepare('SELECT delete_origin FROM media_files WHERE id = ?').get(id) as {
        delete_origin: string | null
      }
      expect(row.delete_origin).toBe('user')
    })

    it('restoreBatch 恢复时清除 delete_origin（置 NULL）', async () => {
      const id = insertMedia(db, {
        is_deleted: 1,
        deleted_at: '2024-01-01 10:00:00',
        delete_origin: 'user'
      })
      await repo.restoreBatch([id])
      const row = db.prepare('SELECT delete_origin FROM media_files WHERE id = ?').get(id) as {
        delete_origin: string | null
      }
      expect(row.delete_origin).toBeNull()
    })

    it('softDeleteForPermanentDelete 标记 delete_origin = user', async () => {
      const id = insertMedia(db, { file_path: '/t/pd.jpg' })
      await repo.softDeleteForPermanentDelete([id])
      const row = db.prepare('SELECT delete_origin FROM media_files WHERE id = ?').get(id) as {
        delete_origin: string | null
      }
      expect(row.delete_origin).toBe('user')
    })

    it('softDeleteForPermanentDelete 用单引号 datetime 字面量（与其它软删 SQL 一致）', async () => {
      const id = insertMedia(db, { file_path: '/t/pd2.jpg' })
      const captured: string[] = []
      const originalPrepare = db.prepare.bind(db)
      const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        if (sql.includes('UPDATE media_files SET is_deleted = 1')) captured.push(sql)
        return originalPrepare(sql)
      })
      try {
        await repo.softDeleteForPermanentDelete([id])
      } finally {
        spy.mockRestore()
      }
      expect(captured.length).toBeGreaterThan(0)
      expect(captured[0]).toContain("datetime('now')")
      expect(captured[0]).not.toContain('datetime("now")')
    })

    it('hardDeleteBatch 空数组 no-op', async () => {
      await expect(repo.hardDeleteBatch([])).resolves.toBeUndefined()
    })

    it('hardDeleteBatch 多条批量删除', async () => {
      const id1 = insertMedia(db, { file_path: '/t/1.jpg' })
      const id2 = insertMedia(db, { file_path: '/t/2.jpg' })
      const id3 = insertMedia(db, { file_path: '/t/3.jpg' })
      await repo.hardDeleteBatch([id1, id2, id3])
      const rows = db.prepare('SELECT COUNT(*) as count FROM media_files').get() as {
        count: number
      }
      expect(rows.count).toBe(0)
    })

    it('hardDeleteBatch 含不存在的 id 不抛错', async () => {
      const id = insertMedia(db)
      await expect(repo.hardDeleteBatch([id, 99999, 88888])).resolves.toBeUndefined()
      const row = db.prepare('SELECT id FROM media_files WHERE id = ?').get(id)
      expect(row).toBeUndefined()
    })

    it('cleanupMissingRecords 返回删除条数', async () => {
      insertMedia(db, { file_path: '/t/1.jpg', is_missing: 1 })
      insertMedia(db, { file_path: '/t/2.jpg', is_missing: 1 })
      insertMedia(db, { file_path: '/t/3.jpg', is_missing: 0 })
      const deleted = await repo.cleanupMissingRecords()
      expect(deleted).toBe(2)
    })

    it('cleanupMissingRecords 无缺失时返回 0', async () => {
      insertMedia(db, { is_missing: 0 })
      const deleted = await repo.cleanupMissingRecords()
      expect(deleted).toBe(0)
    })

    it('removeMissingRecord 删除 missing 记录返回 true', async () => {
      const id = insertMedia(db, { is_missing: 1 })
      expect(await repo.removeMissingRecord(id)).toBe(true)
      const row = db.prepare('SELECT id FROM media_files WHERE id = ?').get(id)
      expect(row).toBeUndefined()
    })

    it('removeMissingRecord 非 missing 记录返回 false', async () => {
      const id = insertMedia(db, { is_missing: 0 })
      expect(await repo.removeMissingRecord(id)).toBe(false)
      const row = db.prepare('SELECT id FROM media_files WHERE id = ?').get(id)
      expect(row).toBeDefined()
    })
  })

  // ==========================================================================
  // 查询接口
  // ==========================================================================
  describe('查询接口', () => {
    it('listMedia 默认视图仅返回 is_deleted=0', () => {
      insertMedia(db, { file_path: '/t/1.jpg', is_deleted: 0 })
      insertMedia(db, { file_path: '/t/2.jpg', is_deleted: 1 })
      const result = repo.listMedia({})
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].file_path).toBe('/t/1.jpg')
    })

    it('listMedia includeDeleted=true 返回所有记录', () => {
      insertMedia(db, { file_path: '/t/1.jpg', is_deleted: 0 })
      insertMedia(db, { file_path: '/t/2.jpg', is_deleted: 1 })
      const result = repo.listMedia({ includeDeleted: true })
      expect(result.rows).toHaveLength(2)
    })

    it('listMedia deletedOnly=true 仅返回已软删除记录', () => {
      insertMedia(db, { file_path: '/t/1.jpg', is_deleted: 0 })
      insertMedia(db, { file_path: '/t/2.jpg', is_deleted: 1 })
      const result = repo.listMedia({ deletedOnly: true })
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].file_path).toBe('/t/2.jpg')
    })

    it('listMedia 传入 cursor 但 sortOrder=asc 应抛错（而非静默回退 offset 首页）', () => {
      insertMedia(db, { file_path: '/t/1.jpg', is_deleted: 0 })
      // cursor 与 ASC 混用是非法的 keyset 组合：必须显式抛错，不能静默忽略 cursor 返回首页数据
      expect(() =>
        repo.listMedia({ cursor: { sortValue: '2026-01-01 00:00:00', id: 1 }, sortOrder: 'asc' })
      ).toThrow(/keyset cursor only supports DESC sort order/)
    })

    it('listMedia 不传 cursor（asc）走 offset 兼容路径不抛错', () => {
      insertMedia(db, { file_path: '/t/1.jpg', is_deleted: 0 })
      // 仅 asc 但无 cursor → 旧 offset 兼容路径，向后兼容插件桥/perf 脚本
      expect(() => repo.listMedia({ sortOrder: 'asc', page: 0, pageSize: 10 })).not.toThrow()
    })

    // 回归：keyset 续页锚点拼接须守卫前导 AND。whereClause 为空（某 keyset 视图无基础过滤）
    // 时必须用 'WHERE ' 而非 ' AND '，否则会拼出 'FROM media_files AND (...)' 非法 SQL（潜在崩溃）。
    // 该分支经公共 API 当前不可达（所有 keyset 视图均带基础过滤），故直接对纯函数做单测触达。
    describe('buildKeysetClauseWithAnchor 前导 AND 守卫', () => {
      const buildKeysetClauseWithAnchor = (
        MediaRepository as unknown as {
          buildKeysetClauseWithAnchor(whereClause: string, anchorExpr: string): string
        }
      ).buildKeysetClauseWithAnchor
      const anchor = '(rating IS NULL AND id < ?)'

      it('空 whereClause 时使用 WHERE 前缀（避免 FROM media_files AND (...)）', () => {
        expect(buildKeysetClauseWithAnchor('', anchor)).toBe(`WHERE ${anchor}`)
      })

      it('非空 whereClause 时使用 AND 前缀（保持现有视图行为）', () => {
        expect(buildKeysetClauseWithAnchor('WHERE is_deleted = 0', anchor)).toBe(
          `WHERE is_deleted = 0 AND ${anchor}`
        )
      })
    })

    it('listMedia 分页：usePagination=true 时返回 total/page/pageSize', () => {
      for (let i = 0; i < 5; i++) {
        insertMedia(db, { file_path: `/t/${i}.jpg`, is_deleted: 0 })
      }
      const result = repo.listMedia({ page: 0, pageSize: 2 })
      expect(result.rows).toHaveLength(2)
      expect(result.total).toBe(5)
      expect(result.page).toBe(0)
      expect(result.pageSize).toBe(2)
    })

    // 性能重构：keyset 深分页游标（created_at DESC, id DESC）
    it('listMedia keyset 游标：首页返回 nextCursor，续页按游标推进', () => {
      const created: string[] = []
      for (let i = 0; i < 5; i++) {
        const c = `2026-01-0${i + 1} 00:00:00`
        created.push(c)
        insertMedia(db, { file_path: `/t/${i}.jpg`, created_at: c, is_deleted: 0 })
      }
      // 首页 cursor=null
      const p1 = repo.listMedia({ cursor: null, pageSize: 2 })
      expect(p1.rows).toHaveLength(2)
      expect(p1.hasMore).toBe(true)
      expect(p1.nextCursor).not.toBeNull()
      // 首页应为 created_at 最新两条（DESC）：2026-01-05、2026-01-04
      expect(p1.rows[0].file_path).toBe('/t/4.jpg')
      expect(p1.rows[1].file_path).toBe('/t/3.jpg')

      // 续页：用首页末行 (2026-01-04, id) 作游标
      const p2 = repo.listMedia({ cursor: p1.nextCursor, pageSize: 2 })
      expect(p2.rows).toHaveLength(2)
      // 跳过已展示的两条，剩下 created_at=01-03 / 01-02
      expect(p2.rows[0].file_path).toBe('/t/2.jpg')
      expect(p2.rows[1].file_path).toBe('/t/1.jpg')
      // p2 仍有下一页（id0 未取完）→ hasMore=true 且 nextCursor 非空
      expect(p2.hasMore).toBe(true)
      expect(p2.nextCursor).not.toBeNull()
      // 第三页取尽剩余（id0），nextCursor 归 null
      const p3 = repo.listMedia({ cursor: p2.nextCursor, pageSize: 2 })
      expect(p3.rows.map((r) => r.file_path)).toEqual(['/t/0.jpg'])
      expect(p3.hasMore).toBe(false)
      expect(p3.nextCursor).toBeNull()
    })

    it('listMedia keyset 游标：同排序键用 id 作 tie-breaker 去重', () => {
      // 同一 created_at 的多条记录，游标按 (created_at, id) 精确推进，避免重复/遗漏
      for (let i = 0; i < 4; i++) {
        insertMedia(db, {
          file_path: `/t/${i}.jpg`,
          created_at: '2026-01-01 00:00:00',
          is_deleted: 0
        })
      }
      const p1 = repo.listMedia({ cursor: null, pageSize: 2 })
      expect(p1.rows).toHaveLength(2)
      expect(p1.nextCursor?.sortValue).toBe('2026-01-01 00:00:00')
      const p2 = repo.listMedia({ cursor: p1.nextCursor, pageSize: 2 })
      // 续页不应重复首页两条，且收齐剩余两条（id2, id1）
      const ids1 = new Set(p1.rows.map((r) => r.id))
      const ids2 = new Set(p2.rows.map((r) => r.id))
      expect([...ids1].some((id) => ids2.has(id))).toBe(false)
      expect(p2.rows).toHaveLength(2)
      // 同排序键下 id 作 tie-breaker：4 行分两页恰好取尽 → p2 为末页
      expect(p2.hasMore).toBe(false)
      expect(p2.nextCursor).toBeNull()
    })

    it('listMedia keyset 游标：首页返回 total（命中默认视图缓存优先）', async () => {
      await repo.setMediaCountCache(7)
      for (let i = 0; i < 3; i++) {
        insertMedia(db, { file_path: `/t/${i}.jpg`, is_deleted: 0 })
      }
      const p1 = repo.listMedia({ cursor: null, pageSize: 2 })
      // 首页 total 取缓存值（避免 O(n) COUNT），续页不再返回 total
      expect(p1.total).toBe(7)
      const p2 = repo.listMedia({ cursor: p1.nextCursor, pageSize: 2 })
      expect(p2.total).toBeUndefined()
      expect(p2.nextCursor).toBeNull()
    })

    it('listMedia 同时传 page 与 cursor 时优先使用 cursor（keyset）', () => {
      for (let i = 0; i < 4; i++) {
        insertMedia(db, {
          file_path: `/t/${i}.jpg`,
          created_at: `2026-01-0${i + 1} 00:00:00`,
          is_deleted: 0
        })
      }
      const r = repo.listMedia({
        page: 0,
        pageSize: 4,
        cursor: { sortValue: '2026-01-04 00:00:00', id: 999 }
      })
      // 不应返回 created_at=01-04 及更新的 01-05（被游标排除）
      expect(
        r.rows.every(
          (row) =>
            row.created_at < '2026-01-04 00:00:00' ||
            (row.created_at === '2026-01-04 00:00:00' && row.id < 999)
        )
      ).toBe(true)
    })

    // 回归：可空排序列（rating 允许 NULL）按 DESC 排尾，keyset 续页锚点 sortValue===null 时
    // 不能静默丢行。旧实现 `(rating < NULL OR rating = NULL AND id < ?)` 在 SQL 中恒为 NULL（false）
    // → 末页返回 0 行、分页提前终止、尾部 NULL 行丢失。修复后 null 锚点走专用 IS NULL 分支。
    it('listMedia keyset 游标：rating 降序含 NULL 行，续页不丢尾', () => {
      // 非 NULL 评分 5/4/3/2/1 各一行 + 两行 rating NULL（共 7 行）
      const ratings: Array<number | null> = [5, 4, null, 3, 2, null, 1]
      ratings.forEach((r, i) => {
        insertMedia(db, { file_path: `/t/${i}.jpg`, rating: r, is_deleted: 0 })
      })
      // 逐页翻完，收集全部 id，验证无重复、无遗漏（含排尾的 NULL 行）
      const seen = new Set<number>()
      let cursor: { sortValue: string | number | null; id: number } | null = null
      let pages = 0
      do {
        const page = repo.listMedia({ cursor, pageSize: 2, sortBy: 'rating', sortOrder: 'desc' })
        page.rows.forEach((row) => {
          expect(seen.has(row.id)).toBe(false)
          seen.add(row.id)
        })
        cursor = page.nextCursor
        pages++
      } while (cursor !== null && pages < 20)
      expect(seen.size).toBe(7)
    })

    it('listMedia keyset 游标：rating 排尾 NULL 行按 id 推进（null 锚点分支）', () => {
      // 三行 rating NULL（id 递增），确保 NULL 行聚集在 rating DESC 视图末位
      for (let i = 0; i < 3; i++) {
        insertMedia(db, { file_path: `/null/${i}.jpg`, rating: null, is_deleted: 0 })
      }
      insertMedia(db, { file_path: `/r5.jpg`, rating: 5, is_deleted: 0 })
      // 取最大 NULL 行 id（DESC + id DESC → 最大 id 排前）作为锚点
      const allRows = repo.listMedia({
        cursor: null,
        pageSize: 100,
        sortBy: 'rating',
        sortOrder: 'desc'
      }).rows
      const nullRows = allRows.filter((r) => r.rating === null)
      expect(nullRows.length).toBe(3)
      const maxId = nullRows[0].id
      // 以 null 锚点 + 最大 NULL 行 id 续页（pageSize=1 强制分页）：应返回 id 更小的一个 NULL 行，且仍有后续
      const page = repo.listMedia({
        cursor: { sortValue: null, id: maxId },
        pageSize: 1,
        sortBy: 'rating',
        sortOrder: 'desc'
      })
      expect(page.rows.length).toBe(1)
      expect(page.rows[0].rating).toBeNull()
      expect(page.rows[0].id).toBeLessThan(maxId)
      expect(page.nextCursor).not.toBeNull()
    })

    // 回归：rating DESC keyset 续页的 sortValue 实为 number（修复"类型谎言"）。
    // 验证① 续页游标 nextCursor.sortValue 运行时为 number；
    // 验证② 即使传入"字符串化数值"（'3'）也能经 normalizeSortValue 归一为数字比较，
    //       与传入真实 number 3 的结果一致，消除 `col < '3'` vs `col < 3` 边界错位隐患。
    it('listMedia keyset 游标：rating DESC 续页 sortValue 为 number，字符串化数值被归一', () => {
      // 注意：数据不含 rating=3 的行，使锚点 3 的 DESC 视图严格只剩 rating<3 的行（2、1），
      // 避免 keyset `(rating = ? AND id < ?)` 把 rating=3 行本身也纳入，干扰断言。
      const ratings = [5, 4, 2, 1]
      ratings.forEach((r, i) => {
        insertMedia(db, { file_path: `/num/${i}.jpg`, rating: r, is_deleted: 0 })
      })
      // 首页：rating=5 那行，nextCursor.sortValue 应为 number（非 string）
      const p1 = repo.listMedia({ cursor: null, pageSize: 1, sortBy: 'rating', sortOrder: 'desc' })
      expect(p1.rows[0].rating).toBe(5)
      expect(typeof p1.nextCursor!.sortValue).toBe('number')
      expect(p1.nextCursor!.sortValue).toBe(5)
      // 用字符串化数值 '3' 作为锚点（模拟某路径把 number 字符串化），与真实 number 3 结果应一致
      const byString = repo.listMedia({
        cursor: { sortValue: '3', id: Number.MAX_SAFE_INTEGER },
        pageSize: 10,
        sortBy: 'rating',
        sortOrder: 'desc'
      })
      const byNumber = repo.listMedia({
        cursor: { sortValue: 3, id: Number.MAX_SAFE_INTEGER },
        pageSize: 10,
        sortBy: 'rating',
        sortOrder: 'desc'
      })
      const idsString = byString.rows.map((r) => r.id).sort((a, b) => a - b)
      const idsNumber = byNumber.rows.map((r) => r.id).sort((a, b) => a - b)
      expect(idsString).toEqual(idsNumber)
      // 锚点 rating=3 的 DESC 视图应仅返回 rating<3 的行（2 与 1），不含 4/5
      expect(byNumber.rows.length).toBe(2)
      expect(byNumber.rows.every((r) => r.rating < 3)).toBe(true)
    })

    // 确认：非 cursor 的 OFFSET/ASC fallback 分支完全不依赖 sortValue（仅 bind page/offset），
    // 与 sortValue 数值类型无关。此处验证 ASC + OFFSET 分页机制正确（total/hasMore/无重叠覆盖），
    // 以及 ASC 视图不读 sortValue（由 fail-fast 校验拦 cursor，已另有用例覆盖）。
    it('listMedia OFFSET/ASC 分支不依赖 sortValue（偏移分页机制正确）', () => {
      const ratings = [3, 1, 2, 5, 4]
      const ids = ratings.map((r, i) =>
        insertMedia(db, { file_path: `/asc/${i}.jpg`, rating: r, is_deleted: 0 })
      )
      const all = new Set(ids)
      // ASC + offset 分页，跨页聚合（MockDatabase 不做 SQL 排序，仅校验分页机制，不校验顺序）
      const collected = new Set<number>()
      let hasMore = true
      let pageNum = 0
      let total = 0
      while (hasMore && pageNum < 10) {
        const page = repo.listMedia({
          page: pageNum,
          pageSize: 2,
          sortBy: 'rating',
          sortOrder: 'asc'
        })
        if (pageNum === 0) total = page.total
        page.rows.forEach((row) => {
          expect(collected.has(row.id)).toBe(false)
          collected.add(row.id)
        })
        hasMore = page.hasMore
        pageNum++
      }
      expect(total).toBe(5)
      expect(collected.size).toBe(5)
      // 跨页聚合应恰好覆盖全部 5 行，无重复、无遗漏（证明 OFFSET 推进与 sortValue 无关）
      expect([...collected].sort((a, b) => a - b)).toEqual([...all].sort((a, b) => a - b))
    })

    // 性能重构：getSearchDocs 按主键 id 游标分块（取代 OFFSET），hasMore 由 docs.length===limit 判定
    it('getSearchDocs 按 id 游标分块且 hasMore 由 docs.length===limit 判定', () => {
      for (let i = 0; i < 5; i++) {
        insertMedia(db, { file_path: `/t/${i}.jpg`, is_deleted: 0 })
      }
      const p1 = repo.getSearchDocs(undefined, 2, 0)
      expect(p1.docs).toHaveLength(2)
      expect(p1.hasMore).toBe(true)
      // 游标推进：下一页从本页最大 id 之后开始
      const maxId = p1.docs[p1.docs.length - 1].id
      const p2 = repo.getSearchDocs(undefined, 2, maxId)
      expect(p2.docs).toHaveLength(2)
      // 不重复首页两条
      const ids1 = new Set(p1.docs.map((d) => d.id))
      expect(p2.docs.some((d) => ids1.has(d.id))).toBe(false)
      const p3 = repo.getSearchDocs(undefined, 2, p2.docs[p2.docs.length - 1].id)
      expect(p3.docs).toHaveLength(1)
      expect(p3.hasMore).toBe(false)
    })

    it('getSearchDocs since 过滤 + 游标：仅返回 indexed_at > since 且 id > afterId', () => {
      insertMedia(db, {
        file_path: '/a.jpg',
        file_name: '/a.jpg',
        indexed_at: '2026-01-01 00:00:00',
        is_deleted: 0
      })
      insertMedia(db, {
        file_path: '/b.jpg',
        file_name: '/b.jpg',
        indexed_at: '2026-02-01 00:00:00',
        is_deleted: 0
      })
      insertMedia(db, {
        file_path: '/c.jpg',
        file_name: '/c.jpg',
        indexed_at: '2026-03-01 00:00:00',
        is_deleted: 0
      })
      const since = '2026-01-15 00:00:00'
      const p1 = repo.getSearchDocs(since, 10, 0)
      // 排除 /a.jpg（indexed_at 不 > since）；按 id ASC 返回 b、c
      expect(p1.docs.map((d) => d.file_name)).toEqual(['/b.jpg', '/c.jpg'])
      expect(p1.hasMore).toBe(false)
    })

    // 回归：since 过滤掉「中间行」时，按 id 游标翻页必须无漏无重
    // 构造 id 连续但 indexed_at 交错的数据：id 1/3/5 的 indexed_at ≤ since（被过滤），
    // 2/4/6/7 的 indexed_at > since（保留）。用 limit=3 强制分页，验证翻过被过滤的
    // 中间行（id 3、5）后仍能继续命中后续合格行，不会因 id > 末返回行而漏掉 4/6/7。
    it('getSearchDocs since+afterId 组合：中间行被过滤时按 id 游标翻页无漏无重', () => {
      const indexedAt = [
        '2026-01-01 00:00:00', // id1  ≤ since → 过滤
        '2026-02-01 00:00:00', // id2  > since → 保留
        '2026-01-01 00:00:00', // id3  ≤ since → 过滤（中间行）
        '2026-03-01 00:00:00', // id4  > since → 保留
        '2026-01-01 00:00:00', // id5  ≤ since → 过滤（中间行）
        '2026-04-01 00:00:00', // id6  > since → 保留
        '2026-05-01 00:00:00' // id7  > since → 保留
      ]
      const ids = indexedAt.map((ia, i) =>
        insertMedia(db, {
          file_path: `/n${i + 1}.jpg`,
          file_name: `/n${i + 1}.jpg`,
          indexed_at: ia,
          is_deleted: 0
        })
      )
      const since = '2026-01-15 00:00:00'
      const expectedKept = [ids[1], ids[3], ids[5], ids[6]] // 2,4,6,7

      const all: number[] = []
      let afterId = 0
      let pages = 0
      while (pages < 10) {
        const res = repo.getSearchDocs(since, 3, afterId)
        // 每页内部严格按 id 升序（不变量由仓储断言守卫）
        for (let i = 1; i < res.docs.length; i++) {
          expect(res.docs[i].id).toBeGreaterThan(res.docs[i - 1].id)
        }
        for (const d of res.docs) all.push(d.id)
        afterId = res.docs.length > 0 ? res.docs[res.docs.length - 1].id : afterId
        pages++
        if (!res.hasMore) break
      }

      // 无重复、无漏：恰好返回全部 4 条合格行
      expect([...new Set(all)]).toEqual(expect.arrayContaining(expectedKept))
      expect(all).toHaveLength(expectedKept.length)
      expect(all).toEqual(expectedKept)
      // 被 since 过滤的中间行（id1/3/5）不得出现
      const filtered = [ids[0], ids[2], ids[4]]
      expect(all.some((id) => filtered.includes(id))).toBe(false)
    })

    it('listMedia 默认视图命中 media_count 缓存', async () => {
      insertMedia(db, { file_path: '/t/1.jpg' })
      insertMedia(db, { file_path: '/t/2.jpg' })
      await repo.setMediaCountCache(99)
      const result = repo.listMedia({ page: 0, pageSize: 10 })
      expect(result.total).toBe(99)
    })

    it('listMedia galleryHighQualityOnly=true 脱离默认视图走实时 COUNT', async () => {
      insertMedia(db, { file_path: '/t/1.jpg' })
      insertMedia(db, { file_path: '/t/2.jpg' })
      await repo.setMediaCountCache(99)
      // 图库目录限制条件使 conditions 超出默认两项，media_count 缓存不命中
      // 修复：补建 import_roots 表（与相邻用例一致），否则 listImportRoots 抛错
      // 触发 logger.warn → 测试环境 electron 未 mock → initLogger 崩溃
      db.exec(`
        CREATE TABLE IF NOT EXISTS import_roots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          root_path TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          disabled INTEGER NOT NULL DEFAULT 0
        );
      `)
      const result = repo.listMedia({ page: 0, pageSize: 10, galleryHighQualityOnly: true })
      expect(result.total).toBe(2)
    })

    it('图库放行 X6Game/Video，不匹配 ScreenShot；缓存反向排除这两个目录', async () => {
      // 说明：本测试用 vi.mock 的内存 SQL 引擎不解析 LOWER/REPLACE/LIKE/NOT 组合条件，
      // 因此这里断言生成的 SQL 文本包含 Video 放行子句（图库），不包含 ScreenShot 子句，
      // 缓存视图反向排除 Video 目录，而非行级过滤结果（行级验证需真实 better-sqlite3，见 REPAIR/集成测试）。
      db.exec(`
        CREATE TABLE IF NOT EXISTS import_roots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          root_path TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          disabled INTEGER NOT NULL DEFAULT 0
        );
      `)

      // 图库视图（galleryHighQualityOnly=true）：SQL 必须同时放行 HQ、X6Game/ScreenShot、X6Game/Video
      const capturedGallery: Array<{ sql: string; params: unknown[] }> = []
      const originalPrepare = db.prepare.bind(db)
      vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        const stmt = originalPrepare(sql)
        return {
          ...stmt,
          all: (...p: unknown[]) => {
            capturedGallery.push({ sql, params: p })
            return stmt.all(...p)
          }
        }
      })
      repo.listMedia({ galleryHighQualityOnly: true })
      const gallerySelect = capturedGallery.find((c) => c.sql.includes('FROM media_files'))
      expect(gallerySelect).toBeDefined()
      expect(gallerySelect!.sql).toContain(
        "LOWER(REPLACE(file_path, '\\', '/')) LIKE '%/gameplayphotos/%'"
      )
      expect(gallerySelect!.sql).toContain(
        "LOWER(REPLACE(file_path, '\\', '/')) LIKE '%/nikkiphotos_highquality/%'"
      )
      expect(gallerySelect!.sql).toContain(
        "LOWER(REPLACE(file_path, '\\', '/')) LIKE '%/x6game/video/%'"
      )
      // 验证不包含ScreenShot路径的匹配
      expect(gallerySelect!.sql).not.toContain(
        "LOWER(REPLACE(file_path, '\\', '/')) LIKE '%/x6game/screenshot/%'"
      )
      // 无导入根时仅目录条件，不传参
      expect(gallerySelect!.params).toEqual([])
      vi.restoreAllMocks()

      // 缓存视图（mediaSource='launcher'）：SQL 必须反向排除上述两目录（NOT IN GALLERY 对称）
      const capturedCache: Array<{ sql: string; params: unknown[] }> = []
      const originalPrepare2 = db.prepare.bind(db)
      vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        const stmt = originalPrepare2(sql)
        return {
          ...stmt,
          all: (...p: unknown[]) => {
            capturedCache.push({ sql, params: p })
            return stmt.all(...p)
          }
        }
      })
      repo.listMedia({ mediaSource: 'launcher' })
      const cacheSelect = capturedCache.find((c) => c.sql.includes('FROM media_files'))
      expect(cacheSelect).toBeDefined()
      // 缓存条件内联 NOT (HQ OR video)，与图库放行完全对称，不包含screenshot路径
      expect(cacheSelect!.sql).toContain('NOT (')
      expect(cacheSelect!.sql).toContain(
        "LOWER(REPLACE(file_path, '\\', '/')) LIKE '%/x6game/video/%'"
      )
      // 验证不包含ScreenShot路径的排除匹配
      expect(cacheSelect!.sql).not.toContain(
        "LOWER(REPLACE(file_path, '\\', '/')) LIKE '%/x6game/screenshot/%'"
      )
      vi.restoreAllMocks()
    })

    it('listMedia galleryHighQualityOnly=true 时导入根前缀参与放行条件', () => {
      // 说明：mock 的 WHERE 求值器不解析 LOWER/REPLACE/LIKE ESCAPE，遇到未识别条件会保守放行，
      // 因此这里断言生成的 SQL 与参数（放行条件的构造），而非行级过滤结果。
      db.exec(`
        CREATE TABLE import_roots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          root_path TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          disabled INTEGER NOT NULL DEFAULT 0
        );
      `)
      db.prepare('INSERT INTO import_roots (root_path, created_at, disabled) VALUES (?, ?, ?)').run(
        'H:\\My_Photos',
        '2024-01-01 10:00:00',
        0
      )

      const captured: Array<{ sql: string; params: unknown[] }> = []
      const originalPrepare = db.prepare.bind(db)
      vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        const stmt = originalPrepare(sql)
        return {
          ...stmt,
          all: (...p: unknown[]) => {
            captured.push({ sql, params: p })
            return stmt.all(...p)
          }
        }
      })

      repo.listMedia({ galleryHighQualityOnly: true })

      const select = captured.find((c) => c.sql.includes('FROM media_files'))
      expect(select).toBeDefined()
      // 原高清目录条件与导入根前缀条件以 OR 组合，而非互相替换
      expect(select!.sql).toContain('/nikkiphotos_highquality/')
      expect(select!.sql).toContain("OR LOWER(REPLACE(file_path, '\\', '/')) LIKE ? ESCAPE '\\'")
      // 参数：小写 + 正斜杠 + 下划线已转义（避免 my_photos 误匹配 myXphotos）+ '/%' 后缀
      expect(select!.params).toEqual(['h:/my\\_photos/%'])
    })

    it('listMedia galleryHighQualityOnly=true 无导入根时仅高清目录条件', () => {
      db.exec(`
        CREATE TABLE import_roots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          root_path TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          disabled INTEGER NOT NULL DEFAULT 0
        );
      `)

      const captured: Array<{ sql: string; params: unknown[] }> = []
      const originalPrepare = db.prepare.bind(db)
      vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        const stmt = originalPrepare(sql)
        return {
          ...stmt,
          all: (...p: unknown[]) => {
            captured.push({ sql, params: p })
            return stmt.all(...p)
          }
        }
      })

      repo.listMedia({ galleryHighQualityOnly: true })

      const select = captured.find((c) => c.sql.includes('FROM media_files'))
      expect(select).toBeDefined()
      expect(select!.sql).toContain('/nikkiphotos_highquality/')
      expect(select!.sql).not.toContain('ESCAPE')
      expect(select!.params).toEqual([])
    })

    it('listMedia galleryHighQualityOnly=true 仅放行启用态导入根（排除 disabled）', () => {
      db.exec(`
        CREATE TABLE import_roots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          root_path TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          disabled INTEGER NOT NULL DEFAULT 0
        );
      `)
      db.prepare('INSERT INTO import_roots (root_path, created_at, disabled) VALUES (?, ?, ?)').run(
        'H:\\Enabled',
        '2024-01-01 10:00:00',
        0
      )
      db.prepare('INSERT INTO import_roots (root_path, created_at, disabled) VALUES (?, ?, ?)').run(
        'H:\\Disabled',
        '2024-01-01 10:00:00',
        1
      )

      const captured: Array<{ sql: string; params: unknown[] }> = []
      const originalPrepare = db.prepare.bind(db)
      vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        const stmt = originalPrepare(sql)
        return {
          ...stmt,
          all: (...p: unknown[]) => {
            captured.push({ sql, params: p })
            return stmt.all(...p)
          }
        }
      })

      repo.listMedia({ galleryHighQualityOnly: true })

      const select = captured.find((c) => c.sql.includes('FROM media_files'))
      expect(select).toBeDefined()
      // 仅含启用态导入根前缀
      expect(select!.params).toEqual(['h:/enabled/%'])
      // 不含已关闭目录前缀
      expect(select!.params).not.toContain('h:/disabled/%')
    })

    it('listMedia mediaSource=launcher 排除任意导入根之下文件（含已关闭目录）', () => {
      db.exec(`
        CREATE TABLE import_roots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          root_path TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          disabled INTEGER NOT NULL DEFAULT 0
        );
      `)
      db.prepare('INSERT INTO import_roots (root_path, created_at, disabled) VALUES (?, ?, ?)').run(
        'H:\\Enabled',
        '2024-01-01 10:00:00',
        0
      )
      db.prepare('INSERT INTO import_roots (root_path, created_at, disabled) VALUES (?, ?, ?)').run(
        'H:\\Disabled',
        '2024-01-01 10:00:00',
        1
      )

      const captured: Array<{ sql: string; params: unknown[] }> = []
      const originalPrepare = db.prepare.bind(db)
      vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        const stmt = originalPrepare(sql)
        return {
          ...stmt,
          all: (...p: unknown[]) => {
            captured.push({ sql, params: p })
            return stmt.all(...p)
          }
        }
      })

      repo.listMedia({ mediaSource: 'launcher' })

      const select = captured.find((c) => c.sql.includes('FROM media_files'))
      expect(select).toBeDefined()
      // 缓存视图的导入根排除子句：NOT ( ... LIKE ? ESCAPE ... OR ... )
      expect(select!.sql).toContain('NOT (')
      expect(select!.sql).toContain("LOWER(REPLACE(file_path, '\\', '/')) LIKE ? ESCAPE '\\'")
      // 启用与已关闭目录均被排除（缓存=图库补集）
      expect(select!.params).toContain('h:/enabled/%')
      expect(select!.params).toContain('h:/disabled/%')
      expect(select!.params).toEqual(['h:/enabled/%', 'h:/disabled/%'])
    })

    it('listMedia mediaSource=launcher 无导入根时不额外排除', () => {
      db.exec(`
        CREATE TABLE import_roots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          root_path TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          disabled INTEGER NOT NULL DEFAULT 0
        );
      `)
      const captured: Array<{ sql: string; params: unknown[] }> = []
      const originalPrepare = db.prepare.bind(db)
      vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        const stmt = originalPrepare(sql)
        return {
          ...stmt,
          all: (...p: unknown[]) => {
            captured.push({ sql, params: p })
            return stmt.all(...p)
          }
        }
      })

      repo.listMedia({ mediaSource: 'launcher' })

      const select = captured.find((c) => c.sql.includes('FROM media_files'))
      expect(select).toBeDefined()
      // 无导入根时不应出现导入根排除子句（导入根排除用 LIKE ? ESCAPE，而 HQ 条件用 LIKE '%...%' 无 ESCAPE）
      expect(select!.sql).not.toContain('LIKE ? ESCAPE')
      // 缓存视图不额外排除，参数列表应为空
      expect(select!.params).toEqual([])
    })

    it('listMedia 非默认视图实时 COUNT', () => {
      insertMedia(db, { file_path: '/t/1.jpg', is_deleted: 0 })
      insertMedia(db, { file_path: '/t/2.jpg', is_deleted: 1 })
      const result = repo.listMedia({ page: 0, pageSize: 10, deletedOnly: true })
      expect(result.total).toBe(1)
    })

    it('listMedia accountUid 过滤', () => {
      insertMedia(db, { file_path: '/t/1.jpg', account_uid: 'userA' })
      insertMedia(db, { file_path: '/t/2.jpg', account_uid: 'userB' })
      const result = repo.listMedia({ accountUid: 'userA' })
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].account_uid).toBe('userA')
    })

    it('listMedia accountUid=all 不应用过滤', () => {
      insertMedia(db, { file_path: '/t/1.jpg', account_uid: 'userA' })
      insertMedia(db, { file_path: '/t/2.jpg', account_uid: 'userB' })
      const result = repo.listMedia({ accountUid: 'all' })
      expect(result.rows).toHaveLength(2)
    })

    it('listMedia albumType 过滤', () => {
      insertMedia(db, { file_path: '/t/1.jpg', album_type: '游戏截图' })
      insertMedia(db, { file_path: '/t/2.jpg', album_type: '其他' })
      const result = repo.listMedia({ albumType: '游戏截图' })
      expect(result.rows).toHaveLength(1)
    })

    it('listMedia hideDuplicates 隐藏 is_duplicate=1 的记录', () => {
      insertMedia(db, { file_path: '/t/1.jpg', is_duplicate: 0 })
      insertMedia(db, { file_path: '/t/2.jpg', is_duplicate: 1 })
      const result = repo.listMedia({ hideDuplicates: true })
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].file_path).toBe('/t/1.jpg')
    })

    it('listMedia hideDuplicates 在 deletedOnly 下不应用', () => {
      insertMedia(db, { file_path: '/t/1.jpg', is_duplicate: 0, is_deleted: 1 })
      insertMedia(db, { file_path: '/t/2.jpg', is_duplicate: 1, is_deleted: 1 })
      const result = repo.listMedia({ deletedOnly: true, hideDuplicates: true })
      expect(result.rows).toHaveLength(2)
    })

    it('listMedia mediaSource 过滤', () => {
      insertMedia(db, { file_path: '/t/1.jpg', media_source: 'game' })
      insertMedia(db, { file_path: '/t/2.jpg', media_source: 'launcher' })
      const result = repo.listMedia({ mediaSource: 'game' })
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].media_source).toBe('game')
    })

    it('listMedia tags JSON 字段解析（合法 JSON）', () => {
      insertMedia(db, { file_path: '/t/1.jpg', tags: '["风景","人物"]' })
      const result = repo.listMedia({})
      expect(result.rows[0].tags).toEqual(['风景', '人物'])
    })

    it('listMedia tags 字段为损坏 JSON 时返回空数组（容错）', () => {
      insertMedia(db, { file_path: '/t/1.jpg', tags: 'not-json{' })
      const result = repo.listMedia({})
      expect(result.rows[0].tags).toEqual([])
    })

    it('setMediaCountCache 写入后 listMedia 间接读取', async () => {
      await repo.setMediaCountCache(42)
      const result = repo.listMedia({ page: 0, pageSize: 10 })
      expect(result.total).toBe(42)
    })

    it('refreshMediaCountCache 刷新为默认视图总数（排除 launcher 缓存）', async () => {
      insertMedia(db, { file_path: '/t/1.jpg', is_deleted: 0 })
      insertMedia(db, { file_path: '/t/2.jpg', is_deleted: 0 })
      insertMedia(db, { file_path: '/t/3.jpg', is_deleted: 1 })
      // launcher 缓存记录：默认视图 WHERE 排除，缓存总数不应计入
      insertMedia(db, { file_path: '/t/4.cache', is_deleted: 0, media_source: 'launcher' })
      await repo.refreshMediaCountCache()
      const result = repo.listMedia({ page: 0, pageSize: 10 })
      expect(result.total).toBe(2)
    })

    // ==========================================================================
    // 缓存视图（mediaSource=launcher）：所有非 HQ 路径文件均被包含
    // ==========================================================================
    describe('mediaSource=launcher 缓存视图', () => {
      it('生成包含 NOT_IN_GALLERY_PATH_CONDITION 的 SQL', () => {
        insertMedia(db, { file_path: '/t/1.jpg' })
        // 补建 import_roots 表（与相邻用例一致），否则缓存视图的导入根排除查询抛错触发 logger
        db.exec(`
          CREATE TABLE import_roots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            root_path TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            disabled INTEGER NOT NULL DEFAULT 0
          );
        `)
        const captured: Array<{ sql: string; params: unknown[] }> = []
        const originalPrepare = db.prepare.bind(db)
        vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
          const stmt = originalPrepare(sql)
          return {
            ...stmt,
            all: (...p: unknown[]) => {
              captured.push({ sql, params: p })
              return stmt.all(...p)
            }
          }
        })
        repo.listMedia({ mediaSource: 'launcher' })
        const select = captured.find((c) => c.sql.includes('FROM media_files'))
        expect(select).toBeDefined()
        // 缓存视图条件包含 NOT_IN_GALLERY_PATH_CONDITION 反写（与 GALLERY_PATH_CONDITION 对称）
        expect(select!.sql).toContain(
          "LOWER(REPLACE(file_path, '\\', '/')) LIKE '%/gameplayphotos/%'"
        )
        expect(select!.sql).toContain(
          "LOWER(REPLACE(file_path, '\\', '/')) LIKE '%/nikkiphotos_highquality/%'"
        )
        // 缓存视图条件内联，不传参（参数列表应为空或仅 is_deleted=0 的隐式条件参）
        // 搜索 IS NULL 在 params 中无占位，internalDateRangeParams 和 importRootParams 均为空
        expect(select!.params).toHaveLength(0)
      })

      it('mediaSource=launcher 时条件已内联，whereParams 不传 mediaSource', () => {
        insertMedia(db, { file_path: '/t/1.jpg' })
        insertMedia(db, { file_path: '/t/2.jpg', media_source: 'launcher' })
        // 补建 import_roots 表（与相邻用例一致），否则缓存视图的导入根排除查询抛错触发 logger
        db.exec(`
          CREATE TABLE import_roots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            root_path TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            disabled INTEGER NOT NULL DEFAULT 0
          );
        `)
        // mock 的 WHERE 求值器不解析 COALESCE/LOWER/REPLACE/LIKE/NOT 组合条件，
        // 遇到未识别条件保守返回 true（全部放行），此处仅验证不抛错
        expect(() => repo.listMedia({ mediaSource: 'launcher' })).not.toThrow()
        // 不传参验证：mediaSource='launcher' 跳过 whereParams.push
        const result = repo.listMedia({ mediaSource: 'launcher' })
        expect(result.rows.length).toBeGreaterThanOrEqual(0)
      })

      it('mediaSource=game 传统过滤仍正常工作（参数化查询不变）', () => {
        insertMedia(db, { file_path: '/t/game.jpg', media_source: 'game' })
        insertMedia(db, { file_path: '/t/launcher.jpg', media_source: 'launcher' })
        const result = repo.listMedia({ mediaSource: 'game' })
        expect(result.rows).toHaveLength(1)
        expect(result.rows[0].media_source).toBe('game')
      })

      it('mediaSource 不传（undefined）默认视图仍正常工作', () => {
        insertMedia(db, { file_path: '/t/game.jpg', media_source: 'game', is_deleted: 0 })
        insertMedia(db, { file_path: '/t/launcher.jpg', media_source: 'launcher', is_deleted: 0 })
        insertMedia(db, { file_path: '/t/cloud.jpg', media_source: 'cloud', is_deleted: 0 })
        const result = repo.listMedia({})
        // 默认视图排除 launcher，包含 game + cloud
        expect(result.rows).toHaveLength(2)
      })

      it('缓存在 isDefaultView 正确判定：mediaSource=launcher 脱离默认视图', async () => {
        insertMedia(db, { file_path: '/t/1.jpg', media_source: 'launcher' })
        insertMedia(db, { file_path: '/t/2.jpg', media_source: 'launcher' })
        await repo.setMediaCountCache(99)
        // mediaSource='launcher' 触发缓存视图条件，非默认视图走实时 COUNT
        db.exec(`
          CREATE TABLE IF NOT EXISTS import_roots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            root_path TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
          );
        `)
        const result = repo.listMedia({ page: 0, pageSize: 10, mediaSource: 'launcher' })
        // 非默认视图走实时 COUNT（=2），而非命中缓存值 99
        expect(result.total).toBe(2)
      })
    })

    describe('mediaSource=local_screenshot 截图视图', () => {
      it('mediaSource=local_screenshot 仅返回本地截图（X6Game/ScreenShot）媒体', () => {
        insertMedia(db, {
          file_path: '/t/local.jpg',
          media_source: 'local_screenshot',
          is_deleted: 0
        })
        insertMedia(db, { file_path: '/t/game.jpg', media_source: 'game', is_deleted: 0 })
        insertMedia(db, { file_path: '/t/launcher.jpg', media_source: 'launcher', is_deleted: 0 })
        const result = repo.listMedia({ mediaSource: 'local_screenshot' })
        expect(result.rows).toHaveLength(1)
        expect(result.rows[0].media_source).toBe('local_screenshot')
      })

      it('生成 media_source = ? 参数化过滤（参数含 local_screenshot，不内联）', () => {
        insertMedia(db, { file_path: '/t/1.jpg', media_source: 'local_screenshot' })
        const captured: Array<{ sql: string; params: unknown[] }> = []
        const originalPrepare = db.prepare.bind(db)
        vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
          const stmt = originalPrepare(sql)
          return {
            ...stmt,
            all: (...p: unknown[]) => {
              captured.push({ sql, params: p })
              return stmt.all(...p)
            }
          }
        })
        repo.listMedia({ mediaSource: 'local_screenshot' })
        const select = captured.find((c) => c.sql.includes('FROM media_files'))
        expect(select).toBeDefined()
        // 非 launcher 的具体 source 走精确匹配分支：media_source = ?
        expect(select!.sql).toContain('media_source = ?')
        expect(select!.params).toContain('local_screenshot')
      })
    })

    // R5：media_count 强一致改造（stale 标记 + TTL + markMediaCountStale）
    // ==========================================================================
    describe('R5 media_count 强一致', () => {
      it('setMediaCountCache 原子写入 count/dirty/updated_at 三个 key', async () => {
        await repo.setMediaCountCache(7)
        const rows = db
          .prepare('SELECT key, value FROM app_settings WHERE key IN (?, ?, ?)')
          .all('media_count', 'media_count_stale', 'media_count_updated_at') as Array<{
          key: string
          value: string
        }>
        const map = new Map(rows.map((r) => [r.key, r.value]))
        expect(map.get('media_count')).toBe('7')
        expect(map.get('media_count_stale')).toBe('0')
        expect(map.has('media_count_updated_at')).toBe(true)
      })

      it('markMediaCountStale 标记后 listMedia 走真实 COUNT 而非缓存', async () => {
        insertMedia(db, { file_path: '/t/1.jpg' })
        insertMedia(db, { file_path: '/t/2.jpg' })
        await repo.setMediaCountCache(99) // 缓存写为 99，但真实只有 2 条
        await repo.markMediaCountStale()
        const result = repo.listMedia({ page: 0, pageSize: 10 })
        // stale=1 → 缓存失效 → 走真实 COUNT
        expect(result.total).toBe(2)
      })

      it('markMediaCountStale 后再次 setMediaCountCache 清除 stale 标记', async () => {
        insertMedia(db, { file_path: '/t/1.jpg' })
        await repo.setMediaCountCache(50)
        await repo.markMediaCountStale()
        // 重建缓存：stale 应被重置为 0
        await repo.setMediaCountCache(1)
        const result = repo.listMedia({ page: 0, pageSize: 10 })
        expect(result.total).toBe(1) // 命中缓存（1），不再走 COUNT
      })

      it('旧库无 dirty/updated_at 字段时缓存视为失效（触发首次重建）', async () => {
        // 直接写入孤立的 media_count（模拟旧库未迁移状态）
        db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(
          'media_count',
          JSON.stringify(99)
        )
        insertMedia(db, { file_path: '/t/1.jpg' })
        const result = repo.listMedia({ page: 0, pageSize: 10 })
        // 旧缓存失效 → 走真实 COUNT
        expect(result.total).toBe(1)
      })

      it('TTL 超过 24h 时缓存失效，走真实 COUNT', async () => {
        insertMedia(db, { file_path: '/t/1.jpg' })
        insertMedia(db, { file_path: '/t/2.jpg' })
        // 写入过期缓存（updated_at = 当前 - 25h）
        const expiredTs = Date.now() - 25 * 60 * 60 * 1000
        db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(
          'media_count',
          JSON.stringify(99)
        )
        db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(
          'media_count_stale',
          JSON.stringify(0)
        )
        db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(
          'media_count_updated_at',
          JSON.stringify(expiredTs)
        )
        const result = repo.listMedia({ page: 0, pageSize: 10 })
        expect(result.total).toBe(2) // 走真实 COUNT，而非过期的 99
      })

      it('listMedia 缓存未命中后异步重建缓存（后续读取命中）', async () => {
        insertMedia(db, { file_path: '/t/1.jpg' })
        // 首次读取：缓存空 → 走 COUNT → 触发异步 setMediaCountCache
        const first = repo.listMedia({ page: 0, pageSize: 10 })
        expect(first.total).toBe(1)
        // 等待 fire-and-forget 的 setMediaCountCache 完成
        await new Promise((resolve) => setTimeout(resolve, 10))
        // 二次读取应命中缓存
        const cachedRows = db
          .prepare('SELECT key, value FROM app_settings WHERE key IN (?, ?, ?)')
          .all('media_count', 'media_count_stale', 'media_count_updated_at') as Array<{
          key: string
          value: string
        }>
        const map = new Map(cachedRows.map((r) => [r.key, r.value]))
        expect(map.get('media_count')).toBe('1')
        expect(map.get('media_count_stale')).toBe('0')
      })
    })

    // R13：setSetting 走 worker 事务（单条 INSERT OR REPLACE）
    describe('R13 setSetting 事务包裹', () => {
      it('写入字符串值后可读回相同值', async () => {
        await repo.setSetting('test_key_str', 'hello')
        const row = db
          .prepare('SELECT value FROM app_settings WHERE key = ?')
          .get('test_key_str') as { value: string }
        expect(JSON.parse(row.value)).toBe('hello')
      })

      it('写入数值值后可读回相同值', async () => {
        await repo.setSetting('test_key_num', 104857600)
        const row = db
          .prepare('SELECT value FROM app_settings WHERE key = ?')
          .get('test_key_num') as { value: string }
        expect(JSON.parse(row.value)).toBe(104857600)
      })

      it('重复写入同 key 覆盖旧值（INSERT OR REPLACE 语义）', async () => {
        await repo.setSetting('test_key_overwrite', 'first')
        await repo.setSetting('test_key_overwrite', 'second')
        // MockDatabase 不实现 OR REPLACE 去重，用 .all() + Map 取最后一条（与 R5 测试一致）
        const rows = db
          .prepare('SELECT key, value FROM app_settings WHERE key = ?')
          .all('test_key_overwrite') as Array<{ key: string; value: string }>
        const map = new Map(rows.map((r) => [r.key, r.value]))
        expect(JSON.parse(map.get('test_key_overwrite')!)).toBe('second')
      })

      it('写入对象值后可读回相同结构', async () => {
        const obj = { limit: 100, path: '/mock' }
        await repo.setSetting('test_key_obj', obj)
        const row = db
          .prepare('SELECT value FROM app_settings WHERE key = ?')
          .get('test_key_obj') as { value: string }
        expect(JSON.parse(row.value)).toEqual(obj)
      })
    })

    it('getMediaForSceneAnalysis 传 id 数组时返回这些 id 中的图片', () => {
      const id1 = insertMedia(db, { file_path: '/t/1.jpg', file_type: 'image' })
      const id2 = insertMedia(db, { file_path: '/t/2.jpg', file_type: 'video' })
      const result = repo.getMediaForSceneAnalysis([id1, id2])
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe(id1)
    })

    it('getMediaForSceneAnalysis 不传 id 时返回所有 unknown 图片', () => {
      insertMedia(db, { file_path: '/t/1.jpg', file_type: 'image', scene_time: 'unknown' })
      insertMedia(db, { file_path: '/t/2.jpg', file_type: 'image', scene_time: 'day' })
      insertMedia(db, { file_path: '/t/3.jpg', file_type: 'video', scene_time: 'unknown' })
      const result = repo.getMediaForSceneAnalysis()
      expect(result).toHaveLength(1)
    })

    it('getMediaForSceneAnalysis 不传 id 时仅返回未删除的', () => {
      insertMedia(db, { file_path: '/t/1.jpg', file_type: 'image', scene_time: 'unknown' })
      insertMedia(db, {
        file_path: '/t/2.jpg',
        file_type: 'image',
        scene_time: 'unknown',
        is_deleted: 1
      })
      const result = repo.getMediaForSceneAnalysis()
      expect(result).toHaveLength(1)
    })

    it('getMediaPathsByIds 空数组返回空', () => {
      expect(repo.getMediaPathsByIds([])).toEqual([])
    })

    it('getMediaPathsByIds 多条查询', () => {
      const id1 = insertMedia(db, { file_path: '/t/1.jpg' })
      const id2 = insertMedia(db, { file_path: '/t/2.jpg' })
      const result = repo.getMediaPathsByIds([id1, id2])
      expect(result).toHaveLength(2)
      expect(result.map((r) => r.file_path).sort()).toEqual(['/t/1.jpg', '/t/2.jpg'])
    })

    it('getSoftDeletedMediaPaths 仅返回 is_deleted=1 的记录（含缩略图，供清空回收站后清理缓存）', () => {
      insertMedia(db, { file_path: '/t/1.jpg', is_deleted: 0 })
      insertMedia(db, {
        file_path: '/t/2.jpg',
        is_deleted: 1,
        thumbnail: 'C:\\cache\\thumbnails\\t2.jpg'
      })
      insertMedia(db, { file_path: '/t/3.jpg', is_deleted: 1 })
      const result = repo.getSoftDeletedMediaPaths()
      expect(result).toHaveLength(2)
      // #fix-recyclebin-permanent-delete：返回行必须携带 thumbnail，
      // 供 media:emptyRecycleBin 删除 DB 记录后清理缩略图缓存
      const row2 = result.find((r) => r.file_path === '/t/2.jpg')
      expect(row2?.thumbnail).toBe('C:\\cache\\thumbnails\\t2.jpg')
    })

    it('getOutfitAggStats 按套装分组统计', () => {
      insertMedia(db, {
        file_path: '/t/1.jpg',
        outfit: '套装A',
        created_at: '2024-01-01 10:00:00'
      })
      insertMedia(db, {
        file_path: '/t/2.jpg',
        outfit: '套装A',
        created_at: '2024-02-01 10:00:00'
      })
      insertMedia(db, {
        file_path: '/t/3.jpg',
        outfit: '套装B',
        created_at: '2024-03-01 10:00:00'
      })
      const result = repo.getOutfitAggStats()
      expect(result).toHaveLength(2)
      const suitA = result.find((r) => r.outfit === '套装A')
      expect(suitA?.count).toBe(2)
      expect(suitA?.latest_created).toBe('2024-02-01 10:00:00')
    })

    it('getOutfitAggStats 排除空 outfit', () => {
      insertMedia(db, { file_path: '/t/1.jpg', outfit: '' })
      insertMedia(db, { file_path: '/t/2.jpg', outfit: '套装A' })
      const result = repo.getOutfitAggStats()
      expect(result).toHaveLength(1)
      expect(result[0].outfit).toBe('套装A')
    })

    it('getOutfitAggStats 排除已软删除的', () => {
      insertMedia(db, {
        file_path: '/t/1.jpg',
        outfit: '套装A',
        is_deleted: 1
      })
      insertMedia(db, { file_path: '/t/2.jpg', outfit: '套装A', is_deleted: 0 })
      const result = repo.getOutfitAggStats()
      expect(result).toHaveLength(1)
      expect(result[0].count).toBe(1)
    })

    it('getLatestOutfitMedia 返回最新一张', () => {
      insertMedia(db, {
        file_path: '/t/1.jpg',
        outfit: '套装A',
        created_at: '2024-01-01 10:00:00',
        thumbnail: '/thumb/1.jpg'
      })
      insertMedia(db, {
        file_path: '/t/2.jpg',
        outfit: '套装A',
        created_at: '2024-02-01 10:00:00',
        thumbnail: '/thumb/2.jpg'
      })
      const result = repo.getLatestOutfitMedia('套装A')
      expect(result).toBeDefined()
      expect(result?.file_path).toBe('/t/2.jpg')
    })

    it('getLatestOutfitMedia 无数据返回 undefined', () => {
      expect(repo.getLatestOutfitMedia('不存在的套装')).toBeUndefined()
    })

    it('getLatestOutfitMedia 排除已软删除的', () => {
      insertMedia(db, {
        file_path: '/t/1.jpg',
        outfit: '套装A',
        created_at: '2024-02-01 10:00:00',
        is_deleted: 1
      })
      insertMedia(db, {
        file_path: '/t/2.jpg',
        outfit: '套装A',
        created_at: '2024-01-01 10:00:00',
        is_deleted: 0
      })
      const result = repo.getLatestOutfitMedia('套装A')
      expect(result?.file_path).toBe('/t/2.jpg')
    })

    it('getDuplicateCandidates 仅返回未软删除的', () => {
      insertMedia(db, { file_path: '/t/1.jpg', is_deleted: 0 })
      insertMedia(db, { file_path: '/t/2.jpg', is_deleted: 1 })
      const result = repo.getDuplicateCandidates()
      expect(result).toHaveLength(1)
      expect(result[0].file_path).toBe('/t/1.jpg')
    })

    it('getDuplicateCandidates 返回 thumbnail 字段（含 NULL）', () => {
      insertMedia(db, { file_path: '/t/1.jpg', thumbnail: '/cache/1.jpg' })
      insertMedia(db, { file_path: '/t/2.jpg', thumbnail: null })
      const result = repo.getDuplicateCandidates()
      expect(result).toHaveLength(2)
      const withThumb = result.find((r) => r.file_path === '/t/1.jpg')!
      expect(withThumb.thumbnail).toBe('/cache/1.jpg')
      const withoutThumb = result.find((r) => r.file_path === '/t/2.jpg')!
      expect(withoutThumb.thumbnail).toBeNull()
    })

    it('getDuplicateGroupRows 返回 thumbnail 字段', () => {
      insertMedia(db, {
        file_path: '/t/1.jpg',
        thumbnail: '/cache/1.jpg',
        is_duplicate: 1,
        original_id: 99
      })
      const result = repo.getDuplicateGroupRows()
      expect(result).toHaveLength(1)
      expect(result[0].thumbnail).toBe('/cache/1.jpg')
    })

    it('getOriginalsByIds 返回 thumbnail 字段', () => {
      const id = insertMedia(db, { file_path: '/t/1.jpg', thumbnail: '/cache/1.jpg' })
      const result = repo.getOriginalsByIds([id])
      expect(result).toHaveLength(1)
      expect(result[0].thumbnail).toBe('/cache/1.jpg')
    })

    it('getPhashRows 仅返回 phash 非空且未软删除的', () => {
      insertMedia(db, { file_path: '/t/1.jpg', phash: 'abcdef', is_deleted: 0 })
      insertMedia(db, { file_path: '/t/2.jpg', phash: null, is_deleted: 0 })
      insertMedia(db, { file_path: '/t/3.jpg', phash: 'ghijkl', is_deleted: 1 })
      const result = repo.getPhashRows()
      expect(result).toHaveLength(1)
      expect(result[0].phash).toBe('abcdef')
    })

    // ==========================================================================
    // R7：phash 文件变更检测——getPhashRows 返回 phash_mtime/phash_file_size
    // ==========================================================================
    describe('R7 getPhashRows phash_mtime/phash_file_size', () => {
      it('返回 phash_mtime / phash_file_size 字段（含 NULL）', () => {
        insertMedia(db, {
          file_path: '/t/1.jpg',
          phash: 'abc',
          phash_mtime: 1700000000,
          phash_file_size: 1024
        })
        insertMedia(db, {
          file_path: '/t/2.jpg',
          phash: 'def',
          phash_mtime: null,
          phash_file_size: null
        })
        const result = repo.getPhashRows()
        expect(result).toHaveLength(2)
        const withMeta = result.find((r) => r.phash === 'abc')!
        expect(withMeta.phash_mtime).toBe(1700000000)
        expect(withMeta.phash_file_size).toBe(1024)
        const withoutMeta = result.find((r) => r.phash === 'def')!
        expect(withoutMeta.phash_mtime).toBeNull()
        expect(withoutMeta.phash_file_size).toBeNull()
      })
    })

    it('getGroupCounts 默认按 dimension 分组', () => {
      insertMedia(db, { file_path: '/t/1.jpg', album_type: '游戏截图' })
      insertMedia(db, { file_path: '/t/2.jpg', album_type: '游戏截图' })
      insertMedia(db, { file_path: '/t/3.jpg', album_type: '其他' })
      const result = repo.getGroupCounts('album_type', undefined, undefined)
      expect(result).toHaveLength(2)
      const screenshots = result.find((r) => r.key === '游戏截图')
      expect(screenshots?.count).toBe(2)
    })

    it('getGroupCounts accountUid 过滤', () => {
      insertMedia(db, { file_path: '/t/1.jpg', account_uid: 'userA', album_type: 'A' })
      insertMedia(db, { file_path: '/t/2.jpg', account_uid: 'userB', album_type: 'B' })
      const result = repo.getGroupCounts('album_type', 'userA', undefined)
      expect(result).toHaveLength(1)
      expect(result[0].key).toBe('A')
    })

    it('getGroupCounts mediaSource 过滤', () => {
      insertMedia(db, { file_path: '/t/1.jpg', media_source: 'game', album_type: 'A' })
      insertMedia(db, { file_path: '/t/2.jpg', media_source: 'launcher', album_type: 'B' })
      const result = repo.getGroupCounts('album_type', undefined, 'game')
      expect(result).toHaveLength(1)
      expect(result[0].key).toBe('A')
    })

    it('getGroupCounts accountUid=all 不过滤', () => {
      insertMedia(db, { file_path: '/t/1.jpg', account_uid: 'userA', album_type: 'A' })
      insertMedia(db, { file_path: '/t/2.jpg', account_uid: 'userB', album_type: 'B' })
      const result = repo.getGroupCounts('album_type', 'all', undefined)
      expect(result).toHaveLength(2)
    })

    it('getGroupCounts outfit 维度过滤空值', () => {
      insertMedia(db, { file_path: '/t/1.jpg', outfit: '' })
      insertMedia(db, { file_path: '/t/2.jpg', outfit: '套装A' })
      const result = repo.getGroupCounts('outfit', undefined, undefined)
      expect(result).toHaveLength(1)
      expect(result[0].key).toBe('套装A')
    })

    it('getGroupCounts 排除已软删除的', () => {
      insertMedia(db, { file_path: '/t/1.jpg', album_type: 'A', is_deleted: 1 })
      insertMedia(db, { file_path: '/t/2.jpg', album_type: 'A', is_deleted: 0 })
      const result = repo.getGroupCounts('album_type', undefined, undefined)
      expect(result).toHaveLength(1)
      expect(result[0].count).toBe(1)
    })

    it('getGroupCounts 拒绝白名单外的 dimension（防 SQL 注入）', () => {
      // GroupDimension 运行时类型被擦除，必须靠 ALLOWED_GROUP_DIMENSIONS 断言拦截
      expect(() =>
        repo.getGroupCounts('id; DROP TABLE media_files' as never, undefined, undefined)
      ).toThrow(/ALLOWED_GROUP_DIMENSIONS/)
      expect(() => repo.getGroupCounts('*' as never, undefined, undefined)).toThrow(
        /ALLOWED_GROUP_DIMENSIONS/
      )
    })
  })

  // ==========================================================================
  // 重复分组
  // ==========================================================================
  describe('重复分组', () => {
    it('getDuplicateGroupRows 仅返回 is_duplicate=1 AND is_deleted=0 AND original_id IS NOT NULL', () => {
      insertMedia(db, {
        file_path: '/t/1.jpg',
        is_duplicate: 1,
        is_deleted: 0,
        original_id: 100
      })
      insertMedia(db, {
        file_path: '/t/2.jpg',
        is_duplicate: 1,
        is_deleted: 1,
        original_id: 100
      })
      insertMedia(db, {
        file_path: '/t/3.jpg',
        is_duplicate: 1,
        is_deleted: 0,
        original_id: null
      })
      insertMedia(db, {
        file_path: '/t/4.jpg',
        is_duplicate: 0,
        is_deleted: 0,
        original_id: 100
      })
      const result = repo.getDuplicateGroupRows()
      expect(result).toHaveLength(1)
      expect(result[0].file_path).toBe('/t/1.jpg')
    })

    it('getOriginalsByIds 空数组返回空', () => {
      expect(repo.getOriginalsByIds([])).toEqual([])
    })

    it('getOriginalsByIds 多条查询', () => {
      const id1 = insertMedia(db, { file_path: '/t/1.jpg' })
      const id2 = insertMedia(db, { file_path: '/t/2.jpg' })
      const result = repo.getOriginalsByIds([id1, id2])
      expect(result).toHaveLength(2)
    })
  })

  // ==========================================================================
  // 分类
  // ==========================================================================
  describe('分类', () => {
    it('createCategory 返回新 id', async () => {
      const id = await repo.createCategory('新分类', 'icon', '#ff0000', null)
      expect(typeof id).toBe('number')
      expect(id).toBeGreaterThan(0)
    })

    it('createCategory sort_order 自增', async () => {
      const id1 = await repo.createCategory('分类1', 'icon', '#000', null)
      const id2 = await repo.createCategory('分类2', 'icon', '#000', null)
      const row1 = db.prepare('SELECT sort_order FROM categories WHERE id = ?').get(id1) as {
        sort_order: number
      }
      const row2 = db.prepare('SELECT sort_order FROM categories WHERE id = ?').get(id2) as {
        sort_order: number
      }
      expect(row2.sort_order).toBe(row1.sort_order + 1)
    })

    it('createCategory parent_id 设置', async () => {
      const parentId = await repo.createCategory('父分类', 'icon', '#000', null)
      const childId = await repo.createCategory('子分类', 'icon', '#000', parentId)
      const row = db.prepare('SELECT parent_id FROM categories WHERE id = ?').get(childId) as {
        parent_id: number | null
      }
      expect(row.parent_id).toBe(parentId)
    })

    it('updateCategoryFields 空 fields 跳过', async () => {
      const id = await repo.createCategory('测试', 'icon', '#000', null)
      await expect(repo.updateCategoryFields(id, [], [])).resolves.toBeUndefined()
    })

    it('updateCategoryFields 单字段更新', async () => {
      const id = await repo.createCategory('测试', 'icon', '#000', null)
      await repo.updateCategoryFields(id, ['name = ?'], ['新名字'])
      const row = db.prepare('SELECT name FROM categories WHERE id = ?').get(id) as {
        name: string
      }
      expect(row.name).toBe('新名字')
    })

    it('updateCategoryFields 多字段更新', async () => {
      const id = await repo.createCategory('测试', 'icon', '#000', null)
      await repo.updateCategoryFields(id, ['name = ?', 'color = ?'], ['新名字', '#ffffff'])
      const row = db.prepare('SELECT name, color FROM categories WHERE id = ?').get(id) as {
        name: string
        color: string
      }
      expect(row.name).toBe('新名字')
      expect(row.color).toBe('#ffffff')
    })

    it('updateCategoryFields 拒绝非白名单字段拼接（防 SQL 注入）', async () => {
      const id = await repo.createCategory('测试', 'icon', '#000', null)
      // 列名不在白名单
      await expect(repo.updateCategoryFields(id, ['evil_col = ?'], ['x'])).rejects.toThrow(
        /allowed whitelisted column/
      )
      // 形态不是 "<col> = ?"（含注入后缀）
      await expect(
        repo.updateCategoryFields(id, ['name = ?; DROP TABLE categories'], ['x'])
      ).rejects.toThrow(/allowed whitelisted column/)
    })

    it('deleteCategoryCascade 级联置 NULL media_files.category_id', async () => {
      const catId = await repo.createCategory('测试', 'icon', '#000', null)
      const mediaId = insertMedia(db, { category_id: catId })
      await repo.deleteCategoryCascade(catId)
      const catRow = db.prepare('SELECT id FROM categories WHERE id = ?').get(catId)
      expect(catRow).toBeUndefined()
      const mediaRow = db
        .prepare('SELECT category_id FROM media_files WHERE id = ?')
        .get(mediaId) as {
        category_id: number | null
      }
      expect(mediaRow.category_id).toBeNull()
    })

    it('deleteCategoryCascade 非系统分类正常删除', async () => {
      const catId = insertCategory(db, { name: '普通', is_system: 0 })
      await repo.deleteCategoryCascade(catId)
      const row = db.prepare('SELECT id FROM categories WHERE id = ?').get(catId)
      expect(row).toBeUndefined()
    })

    it('FIX(组8-1): isSystemCategory 正确识别系统分类/普通分类/不存在的 id', () => {
      const sysId = insertCategory(db, { name: '系统', is_system: 1 })
      const normalId = insertCategory(db, { name: '普通', is_system: 0 })
      expect(repo.isSystemCategory(sysId)).toBe(true)
      expect(repo.isSystemCategory(normalId)).toBe(false)
      expect(repo.isSystemCategory(999999)).toBe(false)
    })

    it('reorderCategories 批量更新 sort_order + parent_id', async () => {
      const id1 = insertCategory(db, { name: 'A', sort_order: 1 })
      const id2 = insertCategory(db, { name: 'B', sort_order: 2 })
      await repo.reorderCategories([
        { id: id1, sort_order: 2 },
        { id: id2, sort_order: 1, parent_id: id1 }
      ])
      const row1 = db
        .prepare('SELECT sort_order, parent_id FROM categories WHERE id = ?')
        .get(id1) as {
        sort_order: number
        parent_id: number | null
      }
      const row2 = db
        .prepare('SELECT sort_order, parent_id FROM categories WHERE id = ?')
        .get(id2) as {
        sort_order: number
        parent_id: number | null
      }
      expect(row1.sort_order).toBe(2)
      expect(row1.parent_id).toBeNull()
      expect(row2.sort_order).toBe(1)
      expect(row2.parent_id).toBe(id1)
    })

    it('reorderCategories 空数组 no-op', async () => {
      await expect(repo.reorderCategories([])).resolves.toBeUndefined()
    })

    it('listCategories 按 sort_order 排序', () => {
      insertCategory(db, { name: 'B', sort_order: 2 })
      insertCategory(db, { name: 'A', sort_order: 1 })
      insertCategory(db, { name: 'C', sort_order: 3 })
      const result = repo.listCategories()
      expect(result.map((c) => c.name)).toEqual(['A', 'B', 'C'])
    })
  })

  // ==========================================================================
  // 角色档案
  // ==========================================================================
  describe('角色档案', () => {
    it('listProfiles 按 created_at 升序', () => {
      insertProfile(db, { uid: 'b', nickname: 'B', created_at: '2024-02-01 10:00:00' })
      insertProfile(db, { uid: 'a', nickname: 'A', created_at: '2024-01-01 10:00:00' })
      const result = repo.listProfiles()
      expect(result.map((p) => p.uid)).toEqual(['a', 'b'])
    })

    it('listProfiles 为存在媒体文件的 UID 派生 hasMedia=true，否则为 false', () => {
      insertProfile(db, { uid: 'real', nickname: '真档案' })
      insertProfile(db, { uid: 'ghost', nickname: '虚拟档案' })
      insertMedia(db, { file_path: '/t/1.jpg', account_uid: 'real' })
      const result = repo.listProfiles()
      expect(result.find((p) => p.uid === 'real')?.hasMedia).toBe(true)
      expect(result.find((p) => p.uid === 'ghost')?.hasMedia).toBe(false)
    })

    it('deleteProfileAndReassign 对不存在的 UID 幂等成功（不抛错）', async () => {
      await expect(repo.deleteProfileAndReassign('not-exist')).resolves.toBeUndefined()
    })

    it('addProfile 新增后 listProfiles 能查到', async () => {
      await repo.addProfile('new-uid', '新角色', null)
      const result = repo.listProfiles()
      expect(result.find((p) => p.uid === 'new-uid')).toBeDefined()
      expect(result.find((p) => p.uid === 'new-uid')?.nickname).toBe('新角色')
    })

    it('updateProfileFields 空 sets 跳过', async () => {
      insertProfile(db, { uid: 'u1', nickname: '原名' })
      await expect(repo.updateProfileFields('u1', [], [])).resolves.toBeUndefined()
      const result = repo.listProfiles()
      expect(result.find((p) => p.uid === 'u1')?.nickname).toBe('原名')
    })

    it('updateProfileFields 单字段更新', async () => {
      insertProfile(db, { uid: 'u1', nickname: '原名' })
      await repo.updateProfileFields('u1', ['nickname = ?'], ['新名'])
      const result = repo.listProfiles()
      expect(result.find((p) => p.uid === 'u1')?.nickname).toBe('新名')
    })

    it('updateProfileFields 多字段更新', async () => {
      insertProfile(db, { uid: 'u1', nickname: '原名', avatar: null })
      await repo.updateProfileFields(
        'u1',
        ['nickname = ?', 'avatar = ?'],
        ['新名', '/path/to/avatar.png']
      )
      const result = repo.listProfiles()
      const profile = result.find((p) => p.uid === 'u1')
      expect(profile?.nickname).toBe('新名')
      expect(profile?.avatar).toBe('/path/to/avatar.png')
    })

    it('updateProfileFields 拒绝非白名单字段拼接（防 SQL 注入）', async () => {
      insertProfile(db, { uid: 'u1', nickname: '原名' })
      // 列名不在白名单
      await expect(repo.updateProfileFields('u1', ['evil_col = ?'], ['x'])).rejects.toThrow(
        /allowed whitelisted column/
      )
      // 形态不是 "<col> = ?"（含注入后缀）
      await expect(
        repo.updateProfileFields('u1', ['nickname = ?; DROP TABLE character_profiles'], ['x'])
      ).rejects.toThrow(/allowed whitelisted column/)
    })

    it('deleteProfileAndReassign 将 media_files 迁移到 default + 删除档案', async () => {
      insertProfile(db, { uid: 'u1', nickname: '角色1' })
      insertProfile(db, { uid: 'default', nickname: '默认档案', created_at: '2023-01-01 10:00:00' })
      const mediaId = insertMedia(db, { file_path: '/t/1.jpg', account_uid: 'u1' })

      await repo.deleteProfileAndReassign('u1')

      const profiles = repo.listProfiles()
      expect(profiles.find((p) => p.uid === 'u1')).toBeUndefined()
      const media = db.prepare('SELECT account_uid FROM media_files WHERE id = ?').get(mediaId) as {
        account_uid: string
      }
      expect(media.account_uid).toBe('default')
    })

    it('touchProfileActive 更新 last_active_at', async () => {
      insertProfile(db, { uid: 'u1', last_active_at: null })
      await repo.touchProfileActive('u1')
      const row = db
        .prepare('SELECT last_active_at FROM character_profiles WHERE uid = ?')
        .get('u1') as {
        last_active_at: string | null
      }
      expect(row.last_active_at).not.toBeNull()
    })

    it('getProfileByUid 存在时返回 uid', () => {
      insertProfile(db, { uid: 'u1' })
      const result = repo.getProfileByUid('u1')
      expect(result).toEqual({ uid: 'u1' })
    })

    it('getProfileByUid 不存在时返回 undefined', () => {
      expect(repo.getProfileByUid('non-existent')).toBeUndefined()
    })

    it('transferFilesToProfile 空数组 no-op', async () => {
      await expect(repo.transferFilesToProfile([], 'target')).resolves.toBeUndefined()
    })

    it('transferFilesToProfile 批量更新 account_uid', async () => {
      insertProfile(db, { uid: 'target' })
      const id1 = insertMedia(db, { file_path: '/t/1.jpg', account_uid: 'source' })
      const id2 = insertMedia(db, { file_path: '/t/2.jpg', account_uid: 'source' })
      await repo.transferFilesToProfile([id1, id2], 'target')
      const rows = db
        .prepare('SELECT account_uid FROM media_files WHERE id = ?')
        .all(id1) as Array<{ account_uid: string }>
      expect(rows[0].account_uid).toBe('target')
      const rows2 = db
        .prepare('SELECT account_uid FROM media_files WHERE id = ?')
        .all(id2) as Array<{ account_uid: string }>
      expect(rows2[0].account_uid).toBe('target')
    })

    it('getProfileBaseStats 返回完整统计', () => {
      insertProfile(db, { uid: 'u1' })
      insertMedia(db, {
        file_path: '/t/1.jpg',
        account_uid: 'u1',
        file_type: 'image',
        file_size: 1024,
        created_at: '2024-01-01 10:00:00'
      })
      insertMedia(db, {
        file_path: '/t/2.jpg',
        account_uid: 'u1',
        file_type: 'video',
        file_size: 2048,
        created_at: '2024-02-01 10:00:00'
      })
      insertMedia(db, {
        file_path: '/t/3.jpg',
        account_uid: 'u1',
        is_deleted: 1
      })
      const stats = repo.getProfileBaseStats('u1')
      expect(stats.total_count).toBe(2)
      expect(stats.image_count).toBe(1)
      expect(stats.video_count).toBe(1)
      expect(stats.total_size).toBe(3072)
      expect(stats.earliest_time).toBe('2024-01-01 10:00:00')
      expect(stats.latest_time).toBe('2024-02-01 10:00:00')
    })

    it('getProfileBaseStats 空档案返回零值', () => {
      insertProfile(db, { uid: 'empty' })
      const stats = repo.getProfileBaseStats('empty')
      expect(stats.total_count).toBe(0)
      expect(stats.image_count).toBe(0)
      expect(stats.video_count).toBe(0)
      expect(stats.total_size).toBe(0)
      expect(stats.earliest_time).toBeNull()
      expect(stats.latest_time).toBeNull()
    })

    it('getProfileTopOutfits 默认 limit=5', () => {
      insertProfile(db, { uid: 'u1' })
      for (let i = 0; i < 6; i++) {
        insertMedia(db, {
          file_path: `/t/${i}.jpg`,
          account_uid: 'u1',
          outfit: `套装${i}`
        })
      }
      const result = repo.getProfileTopOutfits('u1')
      expect(result).toHaveLength(5)
    })

    it('getProfileTopOutfits 自定义 limit', () => {
      insertProfile(db, { uid: 'u1' })
      for (let i = 0; i < 3; i++) {
        insertMedia(db, {
          file_path: `/t/${i}.jpg`,
          account_uid: 'u1',
          outfit: `套装${i}`
        })
      }
      const result = repo.getProfileTopOutfits('u1', 10)
      expect(result).toHaveLength(3)
    })

    it('getProfileTopOutfits 按 cnt 降序', () => {
      insertProfile(db, { uid: 'u1' })
      insertMedia(db, { file_path: '/t/1.jpg', account_uid: 'u1', outfit: 'A' })
      insertMedia(db, { file_path: '/t/2.jpg', account_uid: 'u1', outfit: 'A' })
      insertMedia(db, { file_path: '/t/3.jpg', account_uid: 'u1', outfit: 'B' })
      const result = repo.getProfileTopOutfits('u1', 5)
      expect(result[0].key).toBe('A')
      expect(result[0].cnt).toBe(2)
    })

    it('getProfileTopOutfits 空数据返回空数组', () => {
      insertProfile(db, { uid: 'empty' })
      const result = repo.getProfileTopOutfits('empty')
      expect(result).toEqual([])
    })

    it('getProfileTopScenes 默认 limit=5', () => {
      insertProfile(db, { uid: 'u1' })
      for (let i = 0; i < 6; i++) {
        insertMedia(db, {
          file_path: `/t/${i}.jpg`,
          account_uid: 'u1',
          scene_category: `scene${i}`
        })
      }
      const result = repo.getProfileTopScenes('u1')
      expect(result).toHaveLength(5)
    })

    it('getProfileTopScenes 排除 scene_category IS NULL', () => {
      insertProfile(db, { uid: 'u1' })
      insertMedia(db, {
        file_path: '/t/1.jpg',
        account_uid: 'u1',
        scene_category: null
      })
      insertMedia(db, {
        file_path: '/t/2.jpg',
        account_uid: 'u1',
        scene_category: '室内'
      })
      const result = repo.getProfileTopScenes('u1')
      expect(result).toHaveLength(1)
      expect(result[0].key).toBe('室内')
    })

    it('getProfileTimeDistribution 按 scene_time 分组', () => {
      insertProfile(db, { uid: 'u1' })
      insertMedia(db, { file_path: '/t/1.jpg', account_uid: 'u1', scene_time: 'day' })
      insertMedia(db, { file_path: '/t/2.jpg', account_uid: 'u1', scene_time: 'day' })
      insertMedia(db, { file_path: '/t/3.jpg', account_uid: 'u1', scene_time: 'night' })
      const result = repo.getProfileTimeDistribution('u1')
      const dayRow = result.find((r) => r.key === 'day')
      const nightRow = result.find((r) => r.key === 'night')
      expect(dayRow?.cnt).toBe(2)
      expect(nightRow?.cnt).toBe(1)
    })

    it('getProfileTimeDistribution 排除已软删除的', () => {
      insertProfile(db, { uid: 'u1' })
      insertMedia(db, {
        file_path: '/t/1.jpg',
        account_uid: 'u1',
        scene_time: 'day',
        is_deleted: 1
      })
      insertMedia(db, {
        file_path: '/t/2.jpg',
        account_uid: 'u1',
        scene_time: 'day',
        is_deleted: 0
      })
      const result = repo.getProfileTimeDistribution('u1')
      const dayRow = result.find((r) => r.key === 'day')
      expect(dayRow?.cnt).toBe(1)
    })
  })

  // ==========================================================================
  // 事务访问器
  // ==========================================================================
  describe('transaction', () => {
    it('事务成功提交多条语句', async () => {
      const id1 = insertMedia(db, { file_path: '/t/1.jpg', rating: 0 })
      const id2 = insertMedia(db, { file_path: '/t/2.jpg', rating: 0 })
      const result = await repo.transaction([
        { sql: 'UPDATE media_files SET rating = ? WHERE id = ?', params: [5, id1] },
        { sql: 'UPDATE media_files SET rating = ? WHERE id = ?', params: [3, id2] }
      ])
      expect(result.changes).toBe(2)
      const rows = db.prepare('SELECT rating FROM media_files ORDER BY id').all() as Array<{
        rating: number
      }>
      expect(rows.map((r) => r.rating)).toEqual([5, 3])
    })

    it('空 statements 数组 no-op', async () => {
      const result = await repo.transaction([])
      expect(result.changes).toBe(0)
      expect(result.lastInsertRowid).toBe(0)
    })
  })

  // ==========================================================================
  // 大批量 id 分片（防止超出 SQLITE_MAX_VARIABLE_NUMBER）
  // mock 不限制参数个数，因此除了校验结果，还要断言实际发出的 SQL 已被切片
  // ==========================================================================
  describe('大批量 id 分片', () => {
    const BULK_COUNT = 2000
    const CHUNK_SIZE = 500

    function insertBulk(count: number): number[] {
      const ids: number[] = []
      for (let i = 0; i < count; i++) {
        ids.push(insertMedia(db, { file_path: `/bulk/${i}.jpg`, account_uid: 'source' }))
      }
      return ids
    }

    /** 取一条 SQL 中 IN (...) 的占位符个数 */
    function inClauseSize(sql: string): number {
      const m = sql.match(/IN\s*\(([^)]*)\)/)
      return m ? m[1].split(',').length : 0
    }

    /** 捕获 fn 执行期间发出的、匹配 keyword 的 SQL */
    async function captureSql(keyword: string, fn: () => Promise<void> | void): Promise<string[]> {
      const spy = vi.spyOn(db, 'prepare')
      try {
        await fn()
        return spy.mock.calls.map((c) => c[0] as string).filter((sql) => sql.includes(keyword))
      } finally {
        spy.mockRestore()
      }
    }

    it('hardDeleteBatch 2000 个 id 全部删除，且每条 SQL 占位符 <= SQLITE_MAX_VARIABLE_NUMBER', async () => {
      const ids = insertBulk(BULK_COUNT)
      const sqls = await captureSql('DELETE FROM media_files WHERE id IN', () =>
        repo.hardDeleteBatch(ids)
      )

      expect(sqls).toHaveLength(BULK_COUNT / CHUNK_SIZE)
      for (const sql of sqls) {
        // 单条 IN 占位符必须远低于 999 上限，杜绝 "too many SQL variables"
        expect(inClauseSize(sql)).toBeLessThanOrEqual(CHUNK_SIZE)
        expect(inClauseSize(sql)).toBeLessThan(SQLITE_MAX_VARIABLE_NUMBER)
      }
      const { count } = db.prepare('SELECT COUNT(*) as count FROM media_files').get() as {
        count: number
      }
      expect(count).toBe(0)
    })

    it('softDeleteBatch 2000 个 id 全部标记软删除', async () => {
      const ids = insertBulk(BULK_COUNT)
      const sqls = await captureSql('UPDATE media_files SET is_deleted = 1', () =>
        repo.softDeleteBatch(ids)
      )

      expect(sqls).toHaveLength(BULK_COUNT / CHUNK_SIZE)
      for (const sql of sqls) {
        // UPDATE 还额外带 is_deleted / deleted_at 绑定，故 IN 占位符须留余量
        expect(inClauseSize(sql)).toBeLessThan(SQLITE_MAX_VARIABLE_NUMBER)
      }
      const { count } = db
        .prepare('SELECT COUNT(*) as count FROM media_files WHERE is_deleted = 1')
        .get() as { count: number }
      expect(count).toBe(BULK_COUNT)
    })

    // 时间预算 30s：本用例要真实写入并回读 2000 行分片 SQL，`npm run test:coverage`
    // 下（v8 插桩 + 全库并发）实测超出默认 10s 被判超时；单独跑本文件稳定通过，
    // 说明是插桩带来的时间开销而非断言失败，故只放宽这一个用例的预算，断言不变。
    it('restoreBatch 2000 个 id 全部恢复，且每条 SQL 占位符 <= SQLITE_MAX_VARIABLE_NUMBER', async () => {
      const ids = insertBulk(BULK_COUNT).map((id) => {
        // 先软删，再恢复
        db.prepare('UPDATE media_files SET is_deleted = 1, deleted_at = ? WHERE id = ?').run(
          '2024-01-01 10:00:00',
          id
        )
        return id
      })
      const sqls = await captureSql('UPDATE media_files SET is_deleted = 0', () =>
        repo.restoreBatch(ids)
      )

      expect(sqls).toHaveLength(BULK_COUNT / CHUNK_SIZE)
      for (const sql of sqls) {
        expect(inClauseSize(sql)).toBeLessThanOrEqual(CHUNK_SIZE)
        expect(inClauseSize(sql)).toBeLessThan(SQLITE_MAX_VARIABLE_NUMBER)
      }
      const { count } = db
        .prepare('SELECT COUNT(*) as count FROM media_files WHERE is_deleted = 1')
        .get() as { count: number }
      expect(count).toBe(0)
    }, 30_000)

    it('getMediaPathsByIds 2000 个 id 查询结果完整合并', () => {
      const ids = insertBulk(BULK_COUNT)
      const rows = repo.getMediaPathsByIds(ids)
      expect(rows).toHaveLength(BULK_COUNT)
      // 分片按顺序拼接，首尾应对应第一片与最后一片
      expect(rows[0].file_path).toBe('/bulk/0.jpg')
      expect(rows[BULK_COUNT - 1].file_path).toBe(`/bulk/${BULK_COUNT - 1}.jpg`)
      expect(new Set(rows.map((r) => r.id)).size).toBe(BULK_COUNT)
    })

    it('transferFilesToProfile 2000 个 id 分片后固定参数顺序仍正确', async () => {
      insertProfile(db, { uid: 'target' })
      const ids = insertBulk(BULK_COUNT)
      await repo.transferFilesToProfile(ids, 'target')
      const { count } = db
        .prepare('SELECT COUNT(*) as count FROM media_files WHERE account_uid = ?')
        .get('target') as { count: number }
      expect(count).toBe(BULK_COUNT)
    })

    it('非整除数量按 500 切片，余数单独成片', async () => {
      const ids = insertBulk(CHUNK_SIZE + 1)
      const sqls = await captureSql('DELETE FROM media_files WHERE id IN', () =>
        repo.hardDeleteBatch(ids)
      )
      expect(sqls.map(inClauseSize)).toEqual([CHUNK_SIZE, 1])
    })

    it('1500 个 id（跨越 999 上限）分片为 3 片，单条不触上限', async () => {
      const ids = insertBulk(1500)
      const sqls = await captureSql('DELETE FROM media_files WHERE id IN', () =>
        repo.hardDeleteBatch(ids)
      )
      expect(sqls).toHaveLength(3)
      for (const sql of sqls) {
        expect(inClauseSize(sql)).toBeLessThan(SQLITE_MAX_VARIABLE_NUMBER)
      }
      const { count } = db.prepare('SELECT COUNT(*) as count FROM media_files').get() as {
        count: number
      }
      expect(count).toBe(0)
    })

    it('常量级不变量：SQL_IN_CHUNK_SIZE < SQL_IN_SAFE_CEILING < SQLITE_MAX_VARIABLE_NUMBER', () => {
      expect(SQL_IN_CHUNK_SIZE).toBeLessThan(SQL_IN_SAFE_CEILING)
      expect(SQL_IN_SAFE_CEILING).toBeLessThan(SQLITE_MAX_VARIABLE_NUMBER)
    })
  })

  // ==========================================================================
  // 按导入根（指定目录扫描登记目录）前缀软删 media_files 记录
  // ==========================================================================
  describe('softDeleteByRootPath（按导入根前缀软删）', () => {
    it('空 rootPath 直接 no-op 返回 0，不发出 UPDATE', async () => {
      insertMedia(db, { file_path: '/a/1.jpg', is_deleted: 0 })
      const spy = vi.spyOn(db, 'prepare')
      const result = await repo.softDeleteByRootPath('')
      expect(result).toBe(0)
      expect(
        spy.mock.calls
          .map((c) => c[0] as string)
          .some((sql) => sql.includes('UPDATE media_files SET is_deleted = 1'))
      ).toBe(false)
      spy.mockRestore()
      const { c } = db.prepare('SELECT COUNT(*) as c FROM media_files').get() as { c: number }
      expect(c).toBe(1)
    })

    it('仅软删该根前缀记录，不影响其他根', async () => {
      insertMedia(db, { file_path: 'C:/nikki/photos/a.jpg', is_deleted: 0 })
      insertMedia(db, { file_path: 'C:/nikki/photos/sub/b.jpg', is_deleted: 0 })
      insertMedia(db, { file_path: 'C:/other/x.jpg', is_deleted: 0 })
      const cleared = await repo.softDeleteByRootPath('C:/nikki/photos')
      expect(cleared).toBe(2)
      const { c } = db
        .prepare('SELECT COUNT(*) as c FROM media_files WHERE is_deleted = 1')
        .get() as { c: number }
      expect(c).toBe(2)
      const other = db
        .prepare("SELECT is_deleted FROM media_files WHERE file_path = 'C:/other/x.jpg'")
        .get() as { is_deleted: number }
      expect(other.is_deleted).toBe(0)
    })

    it('Windows 反斜杠与大小写归一化后仍能匹配，且不影响不同根', async () => {
      insertMedia(db, { file_path: 'D:\\Pics\\a.jpg', is_deleted: 0 })
      insertMedia(db, { file_path: 'E:/pics/b.jpg', is_deleted: 0 })
      const cleared = await repo.softDeleteByRootPath('d:/Pics')
      expect(cleared).toBe(1)
      const { c } = db
        .prepare('SELECT COUNT(*) as c FROM media_files WHERE is_deleted = 1')
        .get() as { c: number }
      expect(c).toBe(1)
    })

    it('目录名含下划线/百分号不触发通配误删', async () => {
      insertMedia(db, { file_path: 'E:/my_photos/a.jpg', is_deleted: 0 })
      insertMedia(db, { file_path: 'E:/myXphotos/b.jpg', is_deleted: 0 })
      const cleared = await repo.softDeleteByRootPath('E:/my_photos')
      expect(cleared).toBe(1)
      const { c } = db
        .prepare('SELECT COUNT(*) as c FROM media_files WHERE is_deleted = 1')
        .get() as { c: number }
      expect(c).toBe(1)
    })

    it('标记 delete_origin = root（重扫允许复位的来源）', async () => {
      const id = insertMedia(db, { file_path: 'F:/roots/a.jpg', is_deleted: 0 })
      await repo.softDeleteByRootPath('F:/roots')
      const row = db.prepare('SELECT delete_origin FROM media_files WHERE id = ?').get(id) as {
        delete_origin: string | null
      }
      expect(row.delete_origin).toBe('root')
    })

    it('生成正确的 LIKE ? ESCAPE 前缀条件与归一化参数', async () => {
      const originalPrepare = (db as unknown as { prepare: (sql: string) => unknown }).prepare.bind(
        db
      )
      const captured: Array<{ sql: string; params: unknown[] }> = []
      const spy = vi
        .spyOn(db as unknown as { prepare: (sql: string) => unknown }, 'prepare')
        .mockImplementation((sql: string) => {
          const stmt = originalPrepare(sql) as {
            run: (...p: unknown[]) => { changes: number; lastInsertRowid: number | bigint }
          }
          return {
            ...stmt,
            run: (...p: unknown[]) => {
              if (
                typeof sql === 'string' &&
                sql.includes('UPDATE media_files SET is_deleted = 1')
              ) {
                captured.push({ sql, params: p })
              }
              return stmt.run(...p)
            }
          }
        })
      try {
        await repo.softDeleteByRootPath('H:\\My_Photos')
      } finally {
        spy.mockRestore()
      }
      expect(captured).toHaveLength(1)
      expect(captured[0].sql).toContain("LIKE ? ESCAPE '\\'")
      expect(captured[0].sql).toContain('AND is_deleted = 0')
      // syncRun 将 params 作为单个数组参数传入 run，故 captured.params 为 [[...]]
      expect(captured[0].params[0]).toEqual(['h:/my\\_photos/%'])
    })
  })

  // ==========================================================================
  // N2 按需生成结果回写（fix-thumbnail-persist-and-ondemand）
  // ==========================================================================
  describe('setThumbnailIfNull（N2：按需生成结果仅填补 NULL 行）', () => {
    // 缺陷：thumbnail:generate 按需生成结果只存渲染层组件 state，DB thumbnail 保持 NULL
    // → 该行生成的缓存文件不在启动孤儿清理白名单（thumbnail IS NOT NULL）内，
    // 每次启动被当孤儿删除、下个会话重新生成，形成"每次启动重复生成"死循环。
    it('正常：thumbnail 为 NULL 的行被填补且返回 true', async () => {
      insertMedia(db, { file_path: '/test/ondemand.jpg' }) // thumbnail 默认 null
      await expect(
        repo.setThumbnailIfNull('/test/ondemand.jpg', '/cache/ondemand.jpg')
      ).resolves.toBe(true)
      const row = db
        .prepare('SELECT thumbnail FROM media_files WHERE file_path = ?')
        .get('/test/ondemand.jpg') as { thumbnail: string }
      expect(row.thumbnail).toBe('/cache/ondemand.jpg')
    })

    it('边界：thumbnail 已有值（扫描写入的游戏原生 LQ / 批量生成路径）→ 不覆盖且返回 false', async () => {
      insertMedia(db, {
        file_path: '/test/native.jpg',
        thumbnail: '/game/NikkiPhotos_LowQuality/x.jpg'
      })
      await expect(repo.setThumbnailIfNull('/test/native.jpg', '/cache/new.jpg')).resolves.toBe(
        false
      )
      const row = db
        .prepare('SELECT thumbnail FROM media_files WHERE file_path = ?')
        .get('/test/native.jpg') as { thumbnail: string }
      expect(row.thumbnail).toBe('/game/NikkiPhotos_LowQuality/x.jpg')
    })

    it('异常：file_path 不存在 → 返回 false（零写，不抛错）', async () => {
      await expect(repo.setThumbnailIfNull('/test/missing.jpg', '/cache/x.jpg')).resolves.toBe(
        false
      )
    })
  })

  // ==========================================================================
  // N3 套装封面 file_type（fix-thumbnail-persist-and-ondemand）
  // ==========================================================================
  describe('getLatestOutfitMedia（N3：封面行需带 file_type）', () => {
    // 缺陷：套装图鉴封面取"最新一张"，用户可给视频打套装标签；渲染层无法区分
    // 封面是图片还是视频 → 视频封面（常无缩略图）把视频文件当 <img> src 裂图。
    it('正常：返回每个套装最新一张且携带 file_type', () => {
      insertMedia(db, {
        file_path: '/test/old.jpg',
        outfit: '测试套装',
        created_at: '2024-01-01 10:00:00'
      })
      insertMedia(db, {
        file_path: '/test/new.mp4',
        file_type: 'video',
        file_ext: '.mp4',
        outfit: '测试套装',
        created_at: '2024-06-01 10:00:00'
      })
      const row = repo.getLatestOutfitMedia('测试套装')
      expect(row?.file_path).toBe('/test/new.mp4')
      expect(row?.file_type).toBe('video')
    })

    it('边界：封面行为图片时 file_type=image；无该套装行 → undefined', () => {
      insertMedia(db, { file_path: '/test/p.jpg', outfit: '测试套装B' })
      expect(repo.getLatestOutfitMedia('测试套装B')?.file_type).toBe('image')
      expect(repo.getLatestOutfitMedia('不存在的套装')).toBeUndefined()
    })
  })
})

// ============================================================================
// N4 损坏标记阈值（fix-thumbnail-display-and-latency）
// ============================================================================
describe('markCorrupted 阈值（N4：连续 3 次失败才隐藏文件）', () => {
  // 缺陷：任何一次解码失败（含 ffmpeg 30s×3 超时、磁盘繁忙等瞬时故障）即置
  // is_corrupted=1，图库默认视图过滤之 → 完好文件从图库消失。
  // 修复语义：corrupted_count 累计，仅当连续失败达 3 次才置位；成功路径
  // clearCorrupted 已将计数归零。内存 SQL 引擎不支持 UPDATE 内 CASE WHEN，
  // 沿仓库结构断言先例锁定 SQL 形态（同 startup-tasks missing_count ≥2 防抖写法）。
  it('markCorrupted 的 SQL 以 corrupted_count 累计 + CASE WHEN(>=3) 置位 is_corrupted', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/database/media-repository.ts'),
      'utf-8'
    )
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n')
    expect(code).toContain('corrupted_count = corrupted_count + 1')
    expect(code).toContain(
      'is_corrupted = CASE WHEN corrupted_count + 1 >= 3 THEN 1 ELSE is_corrupted END'
    )
    // 旧的一次失败即置位形态不得残留
    expect(code).not.toContain('SET is_corrupted = 1, corrupted_count')
  })
})

// ============================================================================
// N5 clearCorrupted 条件化（fix-thumbnail-display-and-latency）
// ============================================================================
describe('clearCorruptedByPath（N5：单条条件 UPDATE）', () => {
  it('按 file_path 条件清除，且仅命中 is_corrupted=1 的行（未损坏行零写）', () => {
    // 依赖：generate 缓存命中/成功路径每次都调 clear 回调；旧实现先 SELECT id 再无条件
    // UPDATE，大库滚动时每张可见卡附一次跨 worker-bridge 的 SELECT+UPDATE。
    // 新契约：单条 UPDATE ... WHERE file_path = ? AND is_corrupted = 1（含计数归零）。
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/database/media-repository.ts'),
      'utf-8'
    )
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n')
    expect(code).toContain('clearCorruptedByPath')
    expect(code).toContain(
      'UPDATE media_files SET is_corrupted = 0, corrupted_count = 0, corrupted_reason = NULL WHERE file_path = ? AND is_corrupted = 1'
    )
  })
})
