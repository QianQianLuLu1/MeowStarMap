/**
 * SQLITE_BUSY 感知写入重试封装（扫描 worker 专用）。
 *
 * 背景：
 * 扫描 worker 与主进程 DatabaseManager / database-worker 共享同一 WAL 数据库文件，
 * 各自持有独立连接并发写入。单次 better-sqlite3 事务已通过 `busy_timeout = 5000`
 * 在内部重试 5 秒；但当扫描分片写入与用户删改操作在 5 秒内**持续**冲突时，
 * 事务仍会抛 SQLITE_BUSY 中止，原 saveBatchToDatabase 将其包成 ScanBatchWriteError
 * 并导致整次扫描被中止。
 *
 * 本模块提供 executeWriteSafely：在 busy_timeout 之外，对锁类错误再做有限次
 * 指数退避重试（默认 200/400/800ms，总约 1.4s），把"瞬时冲突"窗口从 5s 提升到
 * 约 6.4s，专门吸收瞬时锁冲突，而非立即中止扫描。
 *
 * 设计约束：
 * - 仅对 SQLITE_BUSY / SQLITE_LOCKED 重试；约束违反、磁盘满等非锁错误必须
 *   **立即 rethrow**，以保持现有"系统性故障中止扫描"的语义不被削弱。
 * - isSqliteBusy 自包含实现，**不 import connection.ts**，避免扫描 worker
 *   进程耦合 DatabaseManager（worker 是独立 utilityProcess，应轻量自洽）。
 * - executeWriteSafely 为 async（重试间 await 退避），saveBatchToDatabase 已为 async，兼容。
 */

/** better-sqlite3 抛出的错误通常带有 .code 字段，等于 SQLite 错误码字符串 */
const SQLITE_LOCK_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED'])

/**
 * 判断错误是否为 SQLite 锁冲突（SQLITE_BUSY / SQLITE_LOCKED）。
 * 优先判定 err.code；message 包含 'database is locked' / 'busy' 作为兜底。
 */
export function isSqliteBusy(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown }
  if (typeof e.code === 'string' && SQLITE_LOCK_CODES.has(e.code)) return true
  if (typeof e.message === 'string') {
    const msg = e.message.toLowerCase()
    if (msg.includes('database is locked') || msg.includes('busy')) return true
  }
  return false
}

export interface ExecuteWriteSafelyOptions {
  /** 最大重试次数（不含首次执行），默认 3。退避耗尽后 rethrow 原错误。 */
  retries?: number
  /** 首次退避毫秒数，之后按 2 的幂指数增长（200→400→800…），默认 200。 */
  baseDelayMs?: number
  /** 每次重试前调用的诊断日志回调（建议传入 warn 级 workerLog）。 */
  log?: (message: string) => void
}

/**
 * 执行写入函数 fn，对 SQLITE_BUSY/LOCKED 错误做有限次指数退避重试。
 *
 * - fn 返回非 Promise 值（better-sqlite3 事务为同步），封装随 fn 返回值类型 T。
 * - 非锁错误立即 rethrow（不重试）。
 * - 锁错误：在达到 retries 上限前，按 baseDelayMs * 2^attempt 退避后重试；
 *   达到上限仍失败则 rethrow 原错误（由上层决定是否中止扫描）。
 */
export async function executeWriteSafely<T>(
  fn: () => T,
  opts?: ExecuteWriteSafelyOptions
): Promise<T> {
  const retries = opts?.retries ?? 3
  const baseDelayMs = opts?.baseDelayMs ?? 200
  let attempt = 0
  // 循环仅在"遇到锁错误且未达重试上限"时继续
  for (;;) {
    try {
      return fn()
    } catch (err) {
      if (!isSqliteBusy(err) || attempt >= retries) throw err
      const delay = baseDelayMs * Math.pow(2, attempt)
      attempt++
      opts?.log?.(
        `[Scanner] 数据库写入遇锁冲突(SQLITE_BUSY)，第 ${attempt}/${retries} 次重试（${delay}ms 后）`
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

/**
 * 执行 WAL 检查点。封装 pragma 调用，便于在扫描收尾阶段收缩 WAL 文件。
 *
 * - 默认 mode = 'TRUNCATE'：检查点完成后将 -wal 文件截断为 0 字节，**会等待写锁**
 *   （阻塞写者），因此只应在扫描写入阶段完全结束、连接空闲时调用。
 * - mode = 'PASSIVE'：仅在不阻塞写者的情况下尽可能推进检查点（不保证截断 WAL）。
 *
 * 调用方（finalizeScanCheckpoint）须自行用 try/catch 包裹，避免检查点失败影响扫描结果。
 */
export function walCheckpoint(
  db: { pragma: (sql: string) => unknown },
  mode: 'TRUNCATE' | 'PASSIVE' | 'FULL' = 'TRUNCATE'
): void {
  db.pragma(`wal_checkpoint(${mode})`)
}
