/**
 * 数据库写 worker 进程通信协议
 *
 * 主进程 ↔ database worker 之间的消息类型定义。
 *
 * 设计原则：
 * 1. 写操作（INSERT / UPDATE / DELETE）走 worker，避免 better-sqlite3 同步 I/O 阻塞主进程事件循环
 * 2. 查询逻辑保留主进程，直接走主进程 db 连接（读多写少，且查询需要同步语义）
 * 3. worker 持有独立的 db 连接（WAL 模式 + busy_timeout），与主进程并发安全
 * 4. 主进程侧维护写请求队列（requestId → Promise），worker 按 FIFO 顺序处理
 *
 * 通信链路：
 *   主进程 → worker：worker.postMessage(DbWorkerCommand)
 *   worker → 主进程：worker.on('message', (event: DbWorkerEvent) => ...)
 *
 * 与 media-worker / scanner-worker 的关系：
 * - 三个完全独立的 utilityProcess，架构模式一致，但消息协议独立
 * - database-worker 不执行业务逻辑，仅执行 SQL 写操作，是通用的 DB 写入器
 */

// ============ 配套类型 ============

/** 单条 SQL 语句（参数化） */
export interface DbStatement {
  /** SQL 文本，使用 ? 占位符 */
  sql: string
  /** 与 ? 一一对应的参数（basic-sqlite3 支持 unknown[]） */
  params?: unknown[]
}

/** better-sqlite3 RunResult 的可序列化子集（ bigint 已转为 number ） */
export interface DbRunResult {
  /** 受影响行数 */
  changes: number
  /** 最后插入的 rowid（bigint 在 IPC 序列化中会丢失精度，统一转 number） */
  lastInsertRowid: number
}

/** 写请求类型，对应 MediaRepository 的 4 类写操作语义 */
export type DbWriteKind = 'exec' | 'execBatch' | 'transaction'

// ============ 主进程 → worker ============

export type DbWorkerCommand =
  // 初始化：打开指定路径的数据库文件（worker 启动后首条消息）
  | { type: 'DB_OPEN'; payload: { dbPath: string } }
  // 单条写操作：prepare(sql).run(params)
  | {
      type: 'DB_EXECUTE'
      payload: { requestId: number; statement: DbStatement }
    }
  // 批量写操作：worker 侧同样用 db.transaction 包裹，任一 statement 失败整批回滚
  | {
      type: 'DB_EXECUTE_BATCH'
      payload: { requestId: number; statements: DbStatement[] }
    }
  // 事务写操作：所有 statements 在同一事务中执行，任一失败则回滚
  | {
      type: 'DB_TRANSACTION'
      payload: { requestId: number; statements: DbStatement[] }
    }
  // 主进程退出前调用，worker 主动关闭 DB + 退出
  | { type: 'DB_DISPOSE' }

// ============ worker → 主进程 ============

export type DbWorkerEvent =
  // worker 启动完成 + DB_OPEN 成功后通知主进程可接收写请求
  | { type: 'DB_READY' }
  // 单条 / 批量 / 事务 写操作完成
  | {
      type: 'DB_RESULT'
      payload: {
        requestId: number
        success: boolean
        /** DB_EXECUTE 返回 RunResult；DB_EXECUTE_BATCH / DB_TRANSACTION 返回累积 changes */
        result?: DbRunResult
        /** 失败时的错误信息 */
        message?: string
      }
    }
  // 日志转发（info 级别在 worker 内丢弃，warn/error 转发到主进程 logger）
  | {
      type: 'DB_LOG'
      payload: { level: 'info' | 'warn' | 'error'; message: string; args?: unknown[] }
    }
  // worker 未捕获异常
  | { type: 'DB_WORKER_ERROR'; payload: { message: string; stack?: string } }
  // 新增：worker 处理完 DB_DISPOSE 并关闭 DB 句柄后回发，主进程据此确认可安全 rename 还原
  | { type: 'DB_WORKER_DISPOSED' }
