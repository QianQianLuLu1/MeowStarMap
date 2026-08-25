/**
 * 数据库写 worker 进程入口
 *
 * 由主进程通过 utilityProcess.fork() 启动，承接所有 media_files / categories / character_profiles
 * 等表的写操作（INSERT / UPDATE / DELETE），避免 better-sqlite3 同步 I/O 阻塞主进程事件循环。
 *
 * 改造点（相对主进程 DatabaseManager）：
 * 1. 独立持有 better-sqlite3 连接，与主进程共享同一 db 文件（WAL 多连接并发安全）
 * 2. 不执行 schema 迁移、不创建索引（DDL 仍由主进程 DatabaseManager.initialize 完成）
 * 3. 仅响应 DB_EXECUTE / DB_EXECUTE_BATCH / DB_TRANSACTION / DB_DISPOSE 四类指令
 * 4. 事务与批量写均使用 better-sqlite3 原生 db.transaction，任一 statement 失败自动回滚
 *
 * 优雅关闭：
 * - 收到 DB_DISPOSE 后立即关闭 DB（含 WAL checkpoint）+ process.exit(0)
 * - process.on('exit') 兜底：防止 DB_DISPOSE 未送达时 DB 未正确关闭
 * - 未捕获异常：发送 DB_WORKER_ERROR 后清理退出
 */
// 步骤4：原生模块改为惰性加载，使 ABI 不匹配时崩溃能被 worker 的未捕获异常处理捕获并发送 DB_WORKER_ERROR
import type DatabaseType from 'better-sqlite3'
import type { DbWorkerCommand, DbWorkerEvent, DbRunResult, DbStatement } from './worker-protocol'

// ============ worker 模块级状态 ============

// 惰性加载 better-sqlite3：首次调用时才 require
let DatabaseImpl: typeof import('better-sqlite3') | null = null
function getDatabaseImpl(): typeof import('better-sqlite3') {
  if (!DatabaseImpl) {
    const mod = require('better-sqlite3')
    // 真实 better-sqlite3 是 CJS 模块，require 返回构造函数本身；Vitest mock 返回 { default: ... }
    DatabaseImpl = (
      typeof mod === 'function' ? mod : mod.default
    ) as typeof import('better-sqlite3')
  }
  return DatabaseImpl
}

let db: DatabaseType.Database | null = null
let currentDbPath = ''

// ============ worker log 转发 ============

/**
 * worker 内部日志转发。
 * - info 级别在 worker 内部丢弃（避免跨进程 IPC 开销）
 * - warn / error 级别通过 DB_LOG 转发到主进程
 */
function workerLog(level: 'info' | 'warn' | 'error', message: string, ...args: unknown[]): void {
  if (level === 'info') return
  try {
    const event: DbWorkerEvent = {
      type: 'DB_LOG',
      payload: { level, message, args: args.length > 0 ? args : undefined }
    }
    process.parentPort?.postMessage(event)
  } catch {
    // parentPort 不可用时丢弃日志
  }
}

/** 发送事件到主进程 */
function sendEvent(event: DbWorkerEvent): void {
  try {
    process.parentPort?.postMessage(event)
  } catch {
    // parentPort 不可用时丢弃事件
  }
}

/** 将 better-sqlite3 RunResult 序列化为可 IPC 传输的纯 JSON 结构 */
function toRunResult(result: DatabaseType.RunResult): DbRunResult {
  return {
    changes: result.changes,
    // bigint → number（lastInsertRowid 在 SQLite 中是 bigint，IPC 序列化会丢失精度）
    lastInsertRowid:
      typeof result.lastInsertRowid === 'bigint'
        ? Number(result.lastInsertRowid)
        : result.lastInsertRowid
  }
}

// ============ DB 连接管理 ============

/**
 * 打开 DB 连接（DB_OPEN 时调用一次）。
 * PRAGMA 与主进程 DatabaseManager 保持一致，确保 WAL 多连接并发安全。
 * 额外添加 busy_timeout=5000：与主进程写冲突时自动重试 5 秒。
 */
function openDatabase(dbPath: string): void {
  if (db && currentDbPath === dbPath) return
  if (db) {
    try {
      db.close()
    } catch {}
    db = null
  }
  const newDb = new (getDatabaseImpl())(dbPath)
  // PRAGMA 与主进程 DatabaseManager 一致（WAL 多连接并发安全保证）
  newDb.pragma('journal_mode = WAL')
  newDb.pragma('foreign_keys = ON')
  newDb.pragma('synchronous = NORMAL')
  newDb.pragma('cache_size = -20000')
  newDb.pragma('temp_store = MEMORY')
  newDb.pragma('mmap_size = 268435456')
  newDb.pragma('wal_autocheckpoint = 1000')
  // busy_timeout：WAL 模式下与主进程并发写入冲突时自动重试 5 秒
  newDb.pragma('busy_timeout = 5000')
  db = newDb
  currentDbPath = dbPath
}

// ============ 写操作执行 ============

/** 执行单条写操作 */
function executeStatement(statement: DbStatement): DbRunResult {
  if (!db) throw new Error('Database not opened in worker')
  const params = statement.params ?? []
  const result = db.prepare(statement.sql).run(params)
  return toRunResult(result)
}

/**
 * 执行事务写操作（所有 statements 在同一事务中，任一失败回滚）
 * 使用 better-sqlite3 原生 db.transaction，保证原子性。
 */
function executeTransaction(statements: DbStatement[]): DbRunResult {
  if (!db) throw new Error('Database not opened in worker')
  let changes = 0
  let lastInsertRowid = 0
  const tx = db.transaction(() => {
    for (const stmt of statements) {
      const params = stmt.params ?? []
      const result = db!.prepare(stmt.sql).run(params)
      changes += result.changes
      if (typeof result.lastInsertRowid === 'bigint') {
        lastInsertRowid = Number(result.lastInsertRowid)
      } else {
        lastInsertRowid = result.lastInsertRowid
      }
    }
  })
  tx()
  return { changes, lastInsertRowid }
}

/**
 * 执行批量写操作（事务包裹，返回累积 changes）。
 *
 * 事务化原因：逐条裸执行时中途失败会留下"改了一半"的数据（例如批量软删除只生效前 N 条），
 * 且每条语句各自触发一次隐式提交，批量写入慢一个数量级。
 * 语义与 executeTransaction 已一致，保留独立入口只为兼容既有 DB_EXECUTE_BATCH 协议。
 */
function executeBatch(statements: DbStatement[]): DbRunResult {
  return executeTransaction(statements)
}

// ============ 资源清理与退出 ============

/**
 * worker 退出前清理：WAL checkpoint + 关闭 DB。
 * 必须使用同步操作，避免异步 I/O 延迟进程退出。
 * WAL checkpoint 使用 PASSIVE 模式，不阻塞等待读者，尽力合并 WAL。
 */
function cleanupDb(): void {
  try {
    if (db) {
      try {
        db.pragma('wal_checkpoint(PASSIVE)')
      } catch {}
      db.close()
      db = null
    }
  } catch {}
}

/**
 * 清理资源并退出 worker。
 * FIX(组9-1): bridge 以 `code !== 0` 判定崩溃并触发自动重启与崩溃通知，
 * 致命路径（DB_OPEN 失败 / 未捕获异常 / 未处理 rejection）必须以非零码退出，
 * 否则 exit 0 被当作正常退出，重启策略与 fault 日志永远不会触发。
 * DB_DISPOSE 等正常退出路径保持 exit 0。
 */
function cleanupAndExit(exitCode = 0, graceful = false): void {
  cleanupDb()
  if (graceful) {
    // 新增：DB_DISPOSE 正常退出——先回发确认表示 DB 句柄已释放，主进程据此可安全 rename 还原。
    // 用 setImmediate 延迟 process.exit，确保 IPC 消息在事件循环中被写出，避免同步 process.exit 截断未发送的消息。
    try {
      sendEvent({ type: 'DB_WORKER_DISPOSED' })
    } catch {}
    setImmediate(() => process.exit(exitCode))
  } else {
    process.exit(exitCode)
  }
}

// ============ 消息处理 ============

// utilityProcess 中 parentPort 推送的 'message' 事件参数是 Node.js 的 MessageEvent（仅含 data 字段），
// 但 lib.dom.d.ts 也声明了 MessageEvent（含 lastEventId/origin/source 等），两者冲突。
// 此处用最小结构类型 { data: unknown } 避免冲突，运行时只读 data 字段
process.parentPort?.on('message', (event: { data: unknown }) => {
  const msg = event.data as DbWorkerCommand
  switch (msg.type) {
    case 'DB_OPEN': {
      try {
        openDatabase(msg.payload.dbPath)
        sendEvent({ type: 'DB_READY' })
      } catch (err) {
        // DB 打开失败是致命错误：通知主进程后退出
        const message = err instanceof Error ? err.message : String(err)
        sendEvent({
          type: 'DB_WORKER_ERROR',
          payload: { message: `DB_OPEN 失败: ${message}` }
        })
        // FIX(组9-1): 致命错误以非零码退出，让 bridge 的 isCrash 判定生效（触发自动重启与崩溃通知）
        cleanupAndExit(1)
      }
      break
    }
    case 'DB_EXECUTE': {
      const { requestId, statement } = msg.payload
      try {
        const result = executeStatement(statement)
        sendEvent({ type: 'DB_RESULT', payload: { requestId, success: true, result } })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        sendEvent({
          type: 'DB_RESULT',
          payload: { requestId, success: false, message }
        })
      }
      break
    }
    case 'DB_EXECUTE_BATCH': {
      const { requestId, statements } = msg.payload
      try {
        const result = executeBatch(statements)
        sendEvent({ type: 'DB_RESULT', payload: { requestId, success: true, result } })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        sendEvent({
          type: 'DB_RESULT',
          payload: { requestId, success: false, message }
        })
      }
      break
    }
    case 'DB_TRANSACTION': {
      const { requestId, statements } = msg.payload
      try {
        const result = executeTransaction(statements)
        sendEvent({ type: 'DB_RESULT', payload: { requestId, success: true, result } })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        workerLog('warn', `[DBWorker] 事务执行失败: ${message}`)
        sendEvent({
          type: 'DB_RESULT',
          payload: { requestId, success: false, message }
        })
      }
      break
    }
    case 'DB_DISPOSE': {
      cleanupAndExit(0, true)
      break
    }
  }
})

// ============ 兜底清理 ============

// process.exit 触发时清理（Node.js 原生事件，一定会触发）
// FIX(组9-1): exit 事件期间不再调用 process.exit（退出码已定），仅做资源清理
process.on('exit', () => cleanupDb())

// 未捕获异常：发送 DB_WORKER_ERROR 后清理退出
process.on('uncaughtException', (err) => {
  sendEvent({
    type: 'DB_WORKER_ERROR',
    payload: { message: err.message, stack: err.stack }
  })
  // FIX(组9-1): 致命错误以非零码退出，让 bridge 的 isCrash 判定生效
  cleanupAndExit(1)
})

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason))
  sendEvent({
    type: 'DB_WORKER_ERROR',
    payload: { message: err.message, stack: err.stack }
  })
  // FIX(组9-1): 致命错误以非零码退出，让 bridge 的 isCrash 判定生效
  cleanupAndExit(1)
})
