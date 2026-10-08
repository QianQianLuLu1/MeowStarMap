/**
 * @layer L1
 * @module src/main/scanner/rescan-restore-sql
 * @coverage 重扫复位谓词：真实 SQL 语义断言（需 node:sqlite）+ 无引擎依赖的谓词结构断言（全 Node 版本必跑）
 * @dependencies node:sqlite（Node ≥ 22.5 内置真实 SQLite 引擎——better-sqlite3 为 Electron ABI 编译，
 *               无法在 vitest/Node 下加载，故用内置引擎驱动与生产完全一致的 UPSERT 做语义断言）
 * @remarks 回收站语义修复（D2）的核心回归：软删除改为纯 DB 标记后，文件保留在原路径，
 *          若重扫 UPSERT 无条件复位 is_deleted，用户删除的每张照片都会在下次扫描复活。
 *          谓词通过 COALESCE(delete_origin, '') <> 'user' 排除用户主动软删的记录。
 *
 * 为什么需要「结构断言」这一档（与语义断言分工，不重复）：
 * - `.node-version` 与 CI 目前钉 Node 20，那里根本没有 node:sqlite，语义档必然降级跳过；
 *   若只留语义档，CI 上这个谓词就无人看守。
 * - 兄弟用例 `scan-worker-recovery.test.ts` 用正则断言「谓词被接进 UPSERT 的两条 CASE 臂」（接线），
 *   但正则看不见 **布尔优先级**：把游戏树条件的外层括号删掉，`(A OR B) AND C` 会退化成
 *   `A OR (B AND C)`——所有命中游戏树的照片都被无条件复位，D2 原地复发，而那条正则仍然匹配。
 *   结构断言正是用来拦这一类的。
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import { RESCAN_RESTORE_GAME_TREE, RESCAN_RESTORE_PREDICATE } from '../rescan-restore-sql'

// node:sqlite 是实验性内置模块，vite 5 无法静态外部化（Failed to load url sqlite），
// 故经 createRequire 运行时加载；类型仍从 @types/node 静态导入（纯类型导入会被擦除，Node 20 安全）
const nodeRequire = createRequire(import.meta.url)

/** 真实 SQLite 引擎构造器；node:sqlite 不可用（Node < 22.5）时保持 null */
let SqliteCtor: (new (path: string) => DatabaseSyncType) | null = null
try {
  SqliteCtor = (nodeRequire('node:sqlite') as { DatabaseSync: new (p: string) => DatabaseSyncType })
    .DatabaseSync
} catch {
  // 显式告警而非静默跳过：CI 的 Node 20 属于预期降级，但本地必须在 Node ≥ 22.5 复核语义档
  console.warn(
    '[rescan-restore-sql] ⚠ node:sqlite 不可用（需 Node >= 22.5，当前 ' +
      process.versions.node +
      '）：真实 SQL 语义用例已跳过，本轮仅运行无引擎依赖的谓词结构断言。' +
      'CI（Node 20）下属预期降级；本地请用 Node ≥ 22.5 复核完整 4 条语义用例。'
  )
}
const hasSqliteEngine = SqliteCtor !== null

interface MediaRow {
  file_path: string
  is_deleted: number
  deleted_at: string | null
  delete_origin: string | null
}

/**
 * 提取 SQL 片段中处于**括号深度 0** 的布尔算符（AND / OR），按出现顺序返回。
 *
 * 口径：
 * - 单引号字符串字面量内部一律忽略（SQLite 里 `''` 是字面量内的转义单引号，不结束字面量）；
 * - 括号深度 > 0 时忽略（那是子表达式里的算符，不影响顶层优先级）；
 * - 算符前后必须是词边界，`RANDOM` 里的 "AND"、`ORACLE` 里的 "OR" 不得误判。
 *
 * 用途：验证「游戏树条件整体带括号」与「谓词只有一个顶层 AND」，即布尔优先级不被破坏。
 */
function topLevelOperators(sql: string): Array<{ op: 'AND' | 'OR'; index: number }> {
  const found: Array<{ op: 'AND' | 'OR'; index: number }> = []
  let depth = 0
  let inLiteral = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (inLiteral) {
      if (ch === "'") {
        if (sql[i + 1] === "'")
          i++ // '' 转义：吃掉第二个引号，仍留在字面量内
        else inLiteral = false
      }
      continue
    }
    if (ch === "'") {
      inLiteral = true
      continue
    }
    if (ch === '(') {
      depth++
      continue
    }
    if (ch === ')') {
      depth--
      continue
    }
    if (depth !== 0) continue
    const matched = /^(AND|OR)\b/i.exec(sql.slice(i))
    if (!matched) continue
    const prev = i === 0 ? '' : sql[i - 1]
    if (/[\w]/.test(prev)) continue // 前一个字符是单词字符 → 属于更长标识符的一部分
    found.push({ op: matched[1].toUpperCase() as 'AND' | 'OR', index: i })
    i += matched[1].length - 1
  }
  return found
}

describe('topLevelOperators（结构断言工具自身：正常 / 异常 / 边界）', () => {
  it('正常：顶层 AND/OR 按出现顺序捕获，括号内的不计入', () => {
    expect(topLevelOperators('(a = 1 OR b = 2) AND c = 3').map((o) => o.op)).toEqual(['AND'])
  })

  it('边界：空串、无算符、纯字面量的片段返回空数组', () => {
    expect(topLevelOperators('')).toEqual([])
    expect(topLevelOperators('a = 1')).toEqual([])
    expect(topLevelOperators("x = 'AND OR 里面不算'")).toEqual([])
  })

  it('异常：标识符子串（RANDOM / ORACLE）与 "" 转义不得误判为顶层算符', () => {
    expect(topLevelOperators('RANDOM(1) = 0')).toEqual([])
    expect(topLevelOperators('ORACLE_FLAG IS NULL')).toEqual([])
    // COALESCE(x, '') 的空串字面量：两个连续引号是「开+闭」，不能让解析器错位到字面量外
    expect(topLevelOperators("COALESCE(x, '') <> 'user'")).toEqual([])
  })
})

describe('谓词结构断言（无引擎依赖，全 Node 版本必跑）', () => {
  it('游戏树条件整体加括号：顶层不得出现任何布尔算符', () => {
    // 去掉外层括号 → OR 泄漏到顶层 → 此处变红（正则文本断言看不见这一步）
    expect(topLevelOperators(RESCAN_RESTORE_GAME_TREE)).toEqual([])
  })

  it('谓词与游戏树条件拼出的顶层算符恰为一个 AND（既不多也不少）', () => {
    const ops = topLevelOperators(RESCAN_RESTORE_PREDICATE)
    expect(ops.map((o) => o.op)).toEqual(['AND'])
  })

  it('谓词右操作数锁定 delete_origin 排除口径（弱化或改写即红）', () => {
    const ops = topLevelOperators(RESCAN_RESTORE_PREDICATE)
    expect(ops).toHaveLength(1)
    const rhs = RESCAN_RESTORE_PREDICATE.slice(ops[0].index + ops[0].op.length).trim()
    expect(rhs).toBe("COALESCE(delete_origin, '') <> 'user'")
  })

  it('NULL 存量记录仍按旧行为复位（COALESCE 兜底不得缺失）', () => {
    // 若改成裸 `delete_origin <> 'user'`，NULL 比较结果为 NULL（falsy）→ 升级前的存量
    // 软删记录永不被复位，会连带破坏「移除扫描源后重扫回到图库」的既有行为
    expect(RESCAN_RESTORE_PREDICATE).toContain('COALESCE(delete_origin')
  })
})

/** 建最小 media_files 表：仅含谓词与复位逻辑涉及的列 */
function createDb(): DatabaseSyncType {
  const db = new SqliteCtor!(':memory:')
  db.exec(`
    CREATE TABLE media_files (
      file_path TEXT PRIMARY KEY,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      delete_origin TEXT
    )
  `)
  return db
}

/** 预置一条软删除记录（is_deleted=1），模拟回收站中的条目 */
function seedSoftDeleted(
  db: DatabaseSyncType,
  filePath: string,
  deleteOrigin: string | null
): void {
  db.prepare(
    'INSERT INTO media_files (file_path, is_deleted, deleted_at, delete_origin) VALUES (?, 1, ?, ?)'
  ).run(filePath, '2026-01-01 10:00:00', deleteOrigin)
}

/**
 * 模拟重扫 UPSERT：与 worker-entry.ts saveBatchToDatabase 的 ON CONFLICT 复位分支同构——
 * 扫描物理确认文件存在，插入冲突时按谓词决定是否把 is_deleted 复位回 0。
 */
function rescanUpsert(db: DatabaseSyncType, filePath: string): void {
  db.prepare(
    `
    INSERT INTO media_files (file_path, is_deleted) VALUES (?, 0)
    ON CONFLICT(file_path) DO UPDATE SET
      is_deleted = CASE WHEN ${RESCAN_RESTORE_PREDICATE} THEN 0 ELSE is_deleted END,
      deleted_at = CASE WHEN ${RESCAN_RESTORE_PREDICATE} THEN NULL ELSE deleted_at END
  `
  ).run(filePath)
}

function getRow(db: DatabaseSyncType, filePath: string): MediaRow {
  const row = db
    .prepare(
      'SELECT file_path, is_deleted, deleted_at, delete_origin FROM media_files WHERE file_path = ?'
    )
    .get(filePath)
  return row as unknown as MediaRow
}

// 引擎可用才跑真实 SQL：Node 20（CI / .node-version 当前口径）下整组 skipped + 上方 console.warn 指路，
// 结构断言档不受门控，谓词被删改时 CI 仍能拦住。
describe.runIf(hasSqliteEngine)('重扫复位谓词语义（rescan-restore-sql，真实 SQL 执行）', () => {
  it("delete_origin='user' 的游戏目录树记录：重扫不复活（is_deleted 保持 1）", () => {
    const db = createDb()
    const path = 'D:/games/InfinityNikki/GamePlayPhotos/10001/photo.jpg'
    seedSoftDeleted(db, path, 'user')

    rescanUpsert(db, path)

    const row = getRow(db, path)
    expect(row.is_deleted).toBe(1)
    expect(row.deleted_at).toBe('2026-01-01 10:00:00')
  })

  it("delete_origin='root' 的游戏目录树记录：重扫复位回图库（is_deleted→0、deleted_at→NULL）", () => {
    const db = createDb()
    const path = 'D:/games/InfinityNikki/X6Game/ScreenShot/shot.jpg'
    seedSoftDeleted(db, path, 'root')

    rescanUpsert(db, path)

    const row = getRow(db, path)
    expect(row.is_deleted).toBe(0)
    expect(row.deleted_at).toBeNull()
  })

  it('delete_origin IS NULL 的存量记录：重扫复位（与修复前行为一致，不引入回归）', () => {
    const db = createDb()
    const path = 'D:/games/InfinityNikki/GamePlayPhotos/10001/legacy.jpg'
    seedSoftDeleted(db, path, null)

    rescanUpsert(db, path)

    const row = getRow(db, path)
    expect(row.is_deleted).toBe(0)
    expect(row.deleted_at).toBeNull()
  })

  it("非游戏目录树（导入根）的 'user' 记录：谓词不命中，保持软删除", () => {
    const db = createDb()
    const path = 'F:/my-photos/import-root/favorite.jpg'
    seedSoftDeleted(db, path, 'user')

    rescanUpsert(db, path)

    const row = getRow(db, path)
    expect(row.is_deleted).toBe(1)
    expect(row.deleted_at).toBe('2026-01-01 10:00:00')
  })
})
