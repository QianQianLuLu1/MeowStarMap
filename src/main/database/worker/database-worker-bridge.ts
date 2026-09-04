/**
 * 数据库写 worker 进程桥接层（主进程侧）
 *
 * 职责：
 * 1. 通过 utilityProcess.fork() 管理 worker 进程生命周期（惰性启动 + 退出时清理）
 * 2. 转发主进程写指令到 worker（DB_EXECUTE / DB_EXECUTE_BATCH / DB_TRANSACTION / DB_DISPOSE）
 * 3. 维护写请求队列：requestId → { resolve, reject } 的 Map
 *    worker 返回 DB_RESULT 时按 requestId 匹配并 resolve/reject 对应 Promise
 * 4. worker 异常退出时 reject 所有 pending 请求，避免调用方永久等待
 * 5. 提供 async API：execute / executeBatch / transaction / dispose
 *
 * 通信链路：
 *   主进程 → worker：worker.postMessage(DbWorkerCommand)
 *   worker → 主进程：worker.on('message', (event: DbWorkerEvent) => ...)
 *
 * 与 MediaWorkerBridge 的关系：
 * - 两个完全独立的 utilityProcess（database-worker 与 media-worker）
 * - 架构模式一致，但消息协议独立，避免任务类型耦合
 *
 * 写请求队列设计：
 * - requestId 单调递增（number），避免复用导致 Promise 错配
 * - pendingRequests: Map<requestId, { resolve, reject, sql }>
 *   保存 sql 用于错误诊断（reject 时附带原始 SQL）
 * - worker 退出时遍历 pendingRequests 全部 reject
 */
import { utilityProcess, type UtilityProcess } from 'electron'
import path from 'path'
import { logger } from '../../utils/logger'
import { t } from '../../i18n'
import { WorkerRestartPolicy, type WorkerCrashInfo } from '../../utils/worker-restart-policy'
import type { DbWorkerCommand, DbWorkerEvent, DbRunResult, DbStatement } from './worker-protocol'

/** 写请求的 Promise 解析器（保存 sql 用于错误诊断） */
interface PendingRequest {
  resolve: (result: DbRunResult) => void
  reject: (error: Error) => void
  /** 原始 SQL（错误诊断用，DB_EXECUTE_BATCH / DB_TRANSACTION 取首条） */
  sql: string
  /** 入队时间戳（用于诊断卡死的请求） */
  enqueuedAt: number
}

export class DatabaseWorkerBridge {
  /** FIX(组9-2): 单个写请求的超时上限——worker 存活但卡死（超大事务/busy_timeout
   * 反复等锁/native 死锁）时，调用方（收藏/评分/软删除等用户操作）不再无限等待 */
  private static readonly REQUEST_TIMEOUT_MS = 60_000
  /** FIX(组9-2): 超时巡检间隔 */
  private static readonly SWEEP_INTERVAL_MS = 15_000
  /** DISPOSE 确认等待超时兜底：远大于原 500ms，覆盖大库 WAL checkpoint 关闭耗时；超时仍走 kill */
  private static readonly DISPOSE_CONFIRM_TIMEOUT_MS = 2000
  /** FIX(组9-2): 超时巡检定时器（首个请求入队时惰性启动，队列清空后自动停止） */
  private requestSweepTimer: NodeJS.Timeout | null = null

  private worker: UtilityProcess | null = null
  /** 写请求队列：requestId → Promise 解析器 */
  private pendingRequests: Map<number, PendingRequest> = new Map()
  /** 单调递增的 requestId 生成器 */
  private nextRequestId = 1
  /** worker 启动握手：等待 DB_READY 信号 */
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  // FIX(组9-1): 握手失败时的 reject 句柄——worker 致命错误/退出时让 readyPromise 落定，
  // 避免启动阶段 await readyPromise 的首个写请求永久挂起
  private readyReject: ((reason: Error) => void) | null = null
  /** 当前已 OPEN 的 db 路径（避免重复 DB_OPEN） */
  private currentDbPath: string | null = null
  /** dispose 标志：避免 dispose 后再发起请求 */
  private isDisposed = false
  /**
   * 自恢复期间停止 worker 的标志：stopWorkerForRestore 置位、对应 exit 处理完后复位。
   * 用于抑制 kill 兜底触发的非零码退出被误判为崩溃而自动重启（dispose 已用 isDisposed 抑制）。
   */
  private terminatingForRestore = false
  // stopWorkerForRestore 等待 worker 回发 DB_WORKER_DISPOSED 确认的 resolver（带超时兜底）
  private disposeResolve: (() => void) | null = null
  /**
   * 自恢复并发边界探针：worker 进程是否仍存活（持有 dbPath 文件句柄）。
   * stopWorkerForRestore 末尾已置 this.worker = null（即便 *_DISPOSED 超时兜底走 kill 亦然），
   * 调用方在 await stopWorkerForRestore 后据此断言句柄已释放、rename 覆盖 dbPath 前无进程占用。
   */
  hasLiveWorker(): boolean {
    return this.worker !== null
  }
  /** 自动重启策略：异常退出时延迟重启 worker */
  private restartPolicy = new WorkerRestartPolicy({ workerName: 'DatabaseWorker' })
  /** 崩溃事件监听器（Application 注入，用于弹窗提示用户） */
  private crashListeners: ((info: WorkerCrashInfo) => void)[] = []

  /**
   * 惰性启动 worker 并打开指定路径的数据库。
   *
   * 流程：
   * 1. fork worker（worker 立即注册 parentPort.on('message') 等待指令）
   * 2. 发送 DB_OPEN，worker 打开 DB 后回送 DB_READY
   * 3. 主进程 await readyPromise，等待 DB_READY 信号
   *
   * @param dbPath 数据库文件绝对路径
   * @returns worker 就绪后 resolve
   */
  private async ensureWorker(dbPath: string): Promise<void> {
    if (this.isDisposed) {
      throw new Error(t('main.databaseWorker.error.bridgeDisposed'))
    }

    // worker 已存在：检查 dbPath 是否变化
    if (this.worker) {
      if (this.currentDbPath !== dbPath) {
        // dbPath 变化：重新发送 DB_OPEN（worker 会先关闭旧连接再打开新路径）
        this.currentDbPath = dbPath
        const reopenCmd: DbWorkerCommand = { type: 'DB_OPEN', payload: { dbPath } }
        this.worker.postMessage(reopenCmd)
      }
      return
    }

    // 首次启动 worker：构造 readyPromise，等 worker 回送 DB_READY 后 resolve
    // FIX(组9-1): 同时保存 reject 句柄，握手失败时可落定 Promise
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })

    // worker-entry.js 与 bridge.js 同目录（开发和打包环境均成立）
    // 编译后 __dirname 为 dist/main/main/database/worker/，与 database-worker.js 同目录
    this.worker = utilityProcess.fork(path.join(__dirname, 'database-worker.js'), [], {
      serviceName: 'database-worker',
      stdio: 'pipe'
    })

    this.worker.on('message', (msg: DbWorkerEvent) => {
      this.handleWorkerMessage(msg)
    })

    this.worker.on('exit', (code) => {
      this.handleWorkerExit(code)
    })

    // 发送 DB_OPEN：worker 打开 DB 后回送 DB_READY
    this.currentDbPath = dbPath
    const cmd: DbWorkerCommand = { type: 'DB_OPEN', payload: { dbPath } }
    this.worker.postMessage(cmd)

    // 等待 DB_READY（无超时保护：worker 加载 better-sqlite3 native 模块可能耗时 1-2s）
    await this.readyPromise
  }

  /**
   * FIX(组9-1): 握手失败统一入口：清空握手状态并 reject readyPromise。
   * worker 发送 DB_WORKER_ERROR 或在 DB_READY 前退出时调用，
   * 保证 ensureWorker 的 await 能收到异常而非永久挂起。
   */
  private failReadyHandshake(reason: string): void {
    const reject = this.readyReject
    this.readyPromise = null
    this.readyResolve = null
    this.readyReject = null
    reject?.(new Error(reason))
  }

  /** worker 消息分发 */
  private handleWorkerMessage(msg: DbWorkerEvent): void {
    switch (msg.type) {
      case 'DB_READY':
        // worker 启动完成 / DB_OPEN 成功，解除 ensureWorker 的等待
        if (this.readyResolve) {
          this.readyResolve()
          this.readyResolve = null
        }
        break

      case 'DB_RESULT': {
        const { requestId, success, result, message } = msg.payload
        const pending = this.pendingRequests.get(requestId)
        if (!pending) {
          // worker 返回了已超时/已被 reject 的请求结果：忽略
          return
        }
        this.pendingRequests.delete(requestId)
        if (success) {
          pending.resolve(result ?? { changes: 0, lastInsertRowid: 0 })
        } else {
          pending.reject(
            new Error(
              t('main.databaseWorker.error.writeFailed', {
                message: message ?? t('main.databaseWorker.error.unknown'),
                sql: pending.sql
              })
            )
          )
        }
        break
      }

      case 'DB_LOG': {
        const logMsg = `[DBWorker] ${msg.payload.message}`
        const args = msg.payload.args || []
        if (msg.payload.level === 'error') {
          logger.error(logMsg, ...args)
        } else if (msg.payload.level === 'warn') {
          logger.warn(logMsg, ...args)
        }
        break
      }

      case 'DB_WORKER_DISPOSED':
        // 新增：worker 已关闭 DB 句柄，解除 stopWorkerForRestore 的等待（随后 kill 兜底）
        this.disposeResolve?.()
        break

      case 'DB_WORKER_ERROR':
        logger.error(`[DBWorker] 异常: ${msg.payload.message}`, msg.payload.stack ?? '')
        // FIX(组9-1): DB_OPEN 失败等致命错误会先于 exit 到达，若握手尚未完成需立即 reject，
        // 否则首个写请求要等到 exit 事件才落定（worker 消息处理崩溃时甚至永不落定）
        if (this.readyReject) {
          this.failReadyHandshake(`[DBWorker] worker 致命错误: ${msg.payload.message}`)
        }
        break
    }
  }

  /** worker 退出处理：reject 所有 pending 请求，异常退出时尝试自动重启 */
  private handleWorkerExit(code: number): void {
    const isCrash = code !== 0
    if (isCrash) {
      logger.error(`[DBWorker] 异常退出，exit code=${code}`)
      void logger.fault('workerCrash', new Error(`database-worker 异常退出 exit=${code}`), {
        workerName: 'database-worker',
        exitCode: code,
        pendingRequests: this.pendingRequests.size
      })
    }
    // reject 所有未完成的写请求，避免调用方永久 await
    if (this.pendingRequests.size > 0) {
      const err = new Error(`[DBWorker] worker 进程退出（exit code=${code}），写请求被中止`)
      for (const [, pending] of this.pendingRequests) {
        try {
          pending.reject(err)
        } catch {}
      }
      this.pendingRequests.clear()
    }
    // 保留 currentDbPath 用于重启后重新打开 db（仅异常退出 + 未 dispose 场景）
    const dbPathForRestart = this.currentDbPath
    this.worker = null
    this.readyResolve = null
    // FIX(组9-1): worker 在 DB_READY 前退出时 reject 握手 Promise，避免 ensureWorker 永久挂起
    if (this.readyReject) {
      this.failReadyHandshake(`[DBWorker] worker 在握手完成前退出（exit code=${code}）`)
    }
    if (!isCrash) {
      // 正常退出：清空 currentDbPath
      this.currentDbPath = null
    }

    // 异常退出 + 未 dispose + 非自恢复停止：尝试自动重启（不恢复已 reject 的写请求，调用方需自行重试）
    if (isCrash && !this.isDisposed && !this.terminatingForRestore) {
      this.attemptAutoRestart(code, dbPathForRestart)
    }
    // 自恢复停止（stopWorkerForRestore）触发的退出：清除标志，允许后续正常启动/重启
    if (this.terminatingForRestore) {
      this.terminatingForRestore = false
    }
  }

  /**
   * 自动重启 worker。
   * 注意：database worker 不自动恢复 pending 写请求（事务状态不可重建），
   * 调用方收到 reject 后应自行决定是否重试。重启仅让后续 ensureWorker 自然走通。
   */
  private attemptAutoRestart(exitCode: number, dbPathForRestart: string | null): void {
    const status = this.restartPolicy.canRestart()
    const crashedAt = new Date().toISOString()

    const info: WorkerCrashInfo = {
      workerName: 'database-worker',
      exitCode,
      restartAttempted: true,
      restartScheduled: false,
      restartCount: status.currentCount + 1,
      restartExhausted: status.exhausted,
      crashedAt
    }

    if (!status.allowed) {
      logger.error(
        `[DBWorker] 自动重启次数耗尽（${status.currentCount}/${this.restartPolicy.maxRestartCount}）`
      )
      info.restartAttempted = false
      this.notifyCrash(info)
      // 重启耗尽后清空 currentDbPath，让下次 ensureWorker 走首次启动路径
      this.currentDbPath = null
      return
    }

    const scheduled = this.restartPolicy.scheduleRestart(async () => {
      logger.info(t('main.databaseWorker.log.restarting'))
      try {
        if (dbPathForRestart) {
          // ensureWorker 会重新 fork worker + 发送 DB_OPEN
          await this.ensureWorker(dbPathForRestart)
          logger.info(t('main.databaseWorker.log.restartedWithDb'))
        } else {
          // 无 dbPath 信息：仅 fork worker，等下次 execute 时再 DB_OPEN
          // FIX(组9-1): 同步维护 reject 句柄，保证该 worker 异常退出时握手也能被 reject
          this.readyPromise = new Promise<void>((resolve, reject) => {
            this.readyResolve = resolve
            this.readyReject = reject
          })
          this.worker = utilityProcess.fork(path.join(__dirname, 'database-worker.js'), [], {
            serviceName: 'database-worker',
            stdio: 'pipe'
          })
          this.worker.on('message', (msg: DbWorkerEvent) => {
            this.handleWorkerMessage(msg)
          })
          this.worker.on('exit', (code) => {
            this.handleWorkerExit(code)
          })
          logger.info(t('main.databaseWorker.log.restartedPendingOpen'))
        }
        void logger.fault(
          'workerRestart',
          new Error(t('main.databaseWorker.error.autoRestarted')),
          {
            workerName: 'database-worker',
            exitCode,
            restoredDbPath: !!dbPathForRestart
          }
        )
      } catch (restartErr) {
        logger.error(t('main.databaseWorker.log.restartFailed'), restartErr)
        void logger.fault('workerRestart', restartErr, {
          workerName: 'database-worker',
          stage: 'restart-failed'
        })
      }
    })

    info.restartScheduled = scheduled
    this.notifyCrash(info)
  }

  /** 通知所有崩溃监听器 */
  private notifyCrash(info: WorkerCrashInfo): void {
    for (const listener of this.crashListeners) {
      try {
        listener(info)
      } catch (err) {
        logger.error(t('main.databaseWorker.log.crashListenerFailed'), err)
      }
    }
  }

  /**
   * 注册 worker 崩溃事件监听器（Application 注入，用于弹窗提示用户）。
   * @returns 取消订阅函数
   */
  onCrash(listener: (info: WorkerCrashInfo) => void): () => void {
    this.crashListeners.push(listener)
    return () => {
      this.crashListeners = this.crashListeners.filter((l) => l !== listener)
    }
  }

  /** 生成下一个 requestId */
  private generateRequestId(): number {
    return this.nextRequestId++
  }

  /** 将 SQL 注册到 pending 队列，返回 Promise */
  private enqueueRequest(requestId: number, sql: string): Promise<DbRunResult> {
    this.startRequestSweep()
    return new Promise<DbRunResult>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        sql,
        enqueuedAt: Date.now()
      })
    })
  }

  /**
   * FIX(组9-2): 惰性启动写请求超时巡检。
   * 原实现 pendingRequests 无任何超时机制：worker 进程存活但卡死时写请求 Promise
   * 永久 pending（enqueuedAt 已采集但无人消费），调用方无限等待且无诊断信号。
   */
  private startRequestSweep(): void {
    if (this.requestSweepTimer) return
    this.requestSweepTimer = setInterval(
      () => this.sweepStaleRequests(),
      DatabaseWorkerBridge.SWEEP_INTERVAL_MS
    )
    // unref：巡检定时器不阻止主进程退出
    this.requestSweepTimer.unref?.()
  }

  /** FIX(组9-2): 巡检并 reject 超时的写请求（worker 可能卡死的诊断信号） */
  private sweepStaleRequests(): void {
    if (this.pendingRequests.size === 0) {
      // 队列已空：停止巡检，下次入队时再启动
      if (this.requestSweepTimer) {
        clearInterval(this.requestSweepTimer)
        this.requestSweepTimer = null
      }
      return
    }
    const now = Date.now()
    for (const [requestId, pending] of this.pendingRequests) {
      if (now - pending.enqueuedAt > DatabaseWorkerBridge.REQUEST_TIMEOUT_MS) {
        this.pendingRequests.delete(requestId)
        const timeoutSec = Math.round(DatabaseWorkerBridge.REQUEST_TIMEOUT_MS / 1000)
        const err = new Error(
          `[DBWorker] 写请求超时（>${timeoutSec}s 未响应，worker 进程可能卡死）| SQL: ${pending.sql}`
        )
        void logger.fault('workerCrash', err, {
          workerName: 'database-worker',
          requestId,
          enqueuedAt: new Date(pending.enqueuedAt).toISOString(),
          pendingRequests: this.pendingRequests.size,
          stage: 'request-timeout'
        })
        try {
          pending.reject(err)
        } catch {}
      }
    }
  }

  /**
   * 单条写操作。
   * @param dbPath 数据库路径（用于 ensureWorker）
   * @param sql SQL 文本
   * @param params 参数数组
   */
  async execute(dbPath: string, sql: string, params?: unknown[]): Promise<DbRunResult> {
    await this.ensureWorker(dbPath)
    const requestId = this.generateRequestId()
    const promise = this.enqueueRequest(requestId, sql)
    const cmd: DbWorkerCommand = {
      type: 'DB_EXECUTE',
      payload: { requestId, statement: { sql, params } }
    }
    this.worker!.postMessage(cmd)
    return promise
  }

  /**
   * 批量写操作。worker 侧以 db.transaction 包裹执行，任一 statement 失败整批回滚。
   * 语义与 transaction 一致，保留此入口仅为兼容既有调用点。
   */
  async executeBatch(dbPath: string, statements: DbStatement[]): Promise<DbRunResult> {
    if (statements.length === 0) {
      return { changes: 0, lastInsertRowid: 0 }
    }
    await this.ensureWorker(dbPath)
    const requestId = this.generateRequestId()
    const promise = this.enqueueRequest(requestId, statements[0].sql)
    const cmd: DbWorkerCommand = {
      type: 'DB_EXECUTE_BATCH',
      payload: { requestId, statements }
    }
    this.worker!.postMessage(cmd)
    return promise
  }

  /**
   * 事务写操作（所有 statements 在同一事务中，任一失败回滚）。
   * 返回事务累积 changes；失败时 reject。
   */
  async transaction(dbPath: string, statements: DbStatement[]): Promise<DbRunResult> {
    if (statements.length === 0) {
      return { changes: 0, lastInsertRowid: 0 }
    }
    await this.ensureWorker(dbPath)
    const requestId = this.generateRequestId()
    const promise = this.enqueueRequest(requestId, statements[0].sql)
    const cmd: DbWorkerCommand = {
      type: 'DB_TRANSACTION',
      payload: { requestId, statements }
    }
    this.worker!.postMessage(cmd)
    return promise
  }

  /**
   * 数据库自恢复期间停止 worker（可逆，不置 isDisposed）。
   *
   * 释放本 bridge 对 dbPath 持有的 better-sqlite3 句柄，避免 Windows 上用 rename 覆盖在线库时因其他
   * 进程占用目标文件而 EPERM 失败。与 dispose 不同：不置 isDisposed，被停止的 worker 会在下次
   * ensureWorker(dbPath) 时重新 fork 并打开还原后的库，实现"重启 worker 重建连接"，从根本上消除
   * runPostRestoreRepair 第三个连接指向被改名旧文件的数据分叉。
   *
   * 握手拒绝交由 exit 回调兜底（handleWorkerExit），避免引入新的 i18n key。
   */
  /**
   * 等待 worker 在处理完 DB_DISPOSE 后回发 DB_WORKER_DISPOSED 确认：DB 句柄已释放，主进程可安全 rename 还原。
   * 超时（worker 崩溃/卡死未能确认）即 resolve，交由 stopWorkerForRestore 的 kill 兜底。
   */
  private waitForWorkerDisposed(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.disposeResolve = null
        resolve()
      }, timeoutMs)
      this.disposeResolve = () => {
        clearTimeout(timer)
        this.disposeResolve = null
        resolve()
      }
    })
  }

  async stopWorkerForRestore(): Promise<void> {
    if (!this.worker) {
      this.terminatingForRestore = false
      return
    }
    this.terminatingForRestore = true
    // FIX(组9-2): 停止超时巡检定时器
    if (this.requestSweepTimer) {
      clearInterval(this.requestSweepTimer)
      this.requestSweepTimer = null
    }
    try {
      const cmd: DbWorkerCommand = { type: 'DB_DISPOSE' }
      this.worker.postMessage(cmd)
      // 等待 worker 关闭 DB 句柄后回发的 DB_WORKER_DISPOSED 确认（带超时兜底），
      // 不再盲等固定 500ms——确认到达即可立即 kill，避免恢复 rename 时句柄仍被 OS 短暂持有。
      await this.waitForWorkerDisposed(DatabaseWorkerBridge.DISPOSE_CONFIRM_TIMEOUT_MS)
    } catch {
      // postMessage 失败忽略，后续 kill 兜底
    }
    // UtilityProcess 无 killed 属性，直接调用 kill()（对已退出进程调用是安全的，try/catch 兜底）
    try {
      this.worker.kill()
    } catch {}
    this.worker = null
    this.readyResolve = null
    // FIX(组9-1): 停止期间若握手仍在进行，同样 reject 兜底，避免调用方永久挂起
    if (this.readyReject) {
      this.failReadyHandshake(t('main.databaseWorker.error.handshakeAborted'))
    }
    this.currentDbPath = null
    // 停止后所有 pending 请求都不再有可能收到响应，reject 兜底
    if (this.pendingRequests.size > 0) {
      const err = new Error(t('main.databaseWorker.error.requestsAborted'))
      for (const [, pending] of this.pendingRequests) {
        try {
          pending.reject(err)
        } catch {}
      }
      this.pendingRequests.clear()
    }
  }

  /**
   * 主进程退出前调用：发送 DB_DISPOSE → 等待 worker 回发 DB_WORKER_DISPOSED 确认（超时兜底）→ 强制 kill。
   * worker 收到 DB_DISPOSE 后会主动 WAL checkpoint + close + exit。
   * 复用 stopWorkerForRestore 的停进程逻辑，并追加 isDisposed（致命，不可复用）。
   */
  async dispose(): Promise<void> {
    if (this.isDisposed) return
    this.isDisposed = true
    this.restartPolicy.dispose()
    await this.stopWorkerForRestore()
  }
}
