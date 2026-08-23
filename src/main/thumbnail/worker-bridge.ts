/**
 * 缩略图单文件 worker 进程桥接层（主进程侧）
 *
 * 职责：
 * 1. 通过 utilityProcess.fork() 管理 worker 进程生命周期（惰性启动 + 退出时清理）
 * 2. 转发主进程的缩略图请求到 worker（THUMBNAIL_PROCESS_START）
 * 3. 接收 worker 推送的事件（THUMBNAIL_PROCESS_COMPLETE / THUMBNAIL_WORKER_LOG / WORKER_READY / WORKER_ERROR）
 *    并按 requestId 关联到 pending Promise
 * 4. worker 异常退出时 reject 所有 pending Promise，触发降级到主进程内联 sharp
 *
 * 通信链路：
 *   主进程 → worker：worker.postMessage(ThumbnailWorkerCommand)
 *   worker → 主进程：worker.on('message', (event: ThumbnailWorkerEvent) => ...)
 *
 * 与 scanner-worker / media-worker 的差异：
 * - 单文件 worker 无自动重启策略：崩溃后下次请求重新 fork，避免崩溃循环
 * - WORKER_READY 10s 超时（worker 启动不应慢，超时即降级）
 * - 多请求并发：pending Map 按 requestId 关联，30s 超时自动 reject
 * - 无进度推送（单文件原子操作，sharp 单张 50~200ms）
 *
 * worker-entry.js 与 bridge.js 同目录（开发和打包环境均成立）。
 */
import { utilityProcess, type UtilityProcess } from 'electron'
import path from 'path'
import { logger } from '../utils/logger'
import { t } from '../i18n'
import type {
  ThumbnailWorkerCommand,
  ThumbnailWorkerEvent,
  ThumbnailProcessInput,
  ThumbnailProcessOutput
} from './worker-protocol'

/** 单文件请求超时保护：sharp 单张不应超过 30s */
const REQUEST_TIMEOUT_MS = 30_000
/** WORKER_READY 握手超时：worker 启动不应超过 10s */
const READY_TIMEOUT_MS = 10_000
/** dispose 后等待 worker 退出的最大时间 */
const DISPOSE_GRACE_MS = 500

interface PendingRequest {
  resolve: (output: ThumbnailProcessOutput) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class ThumbnailWorkerBridge {
  private worker: UtilityProcess | null = null
  // 多请求并发的 pending 关联表
  private pending: Map<string, PendingRequest> = new Map()
  // worker 启动握手：等待 WORKER_READY 信号
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((err: Error) => void) | null = null
  private readyTimer: NodeJS.Timeout | null = null
  // 降级标志：fork 失败 / READY 超时 / 已 dispose 时置 true
  private workerFailed = false
  private isDisposed = false

  /**
   * 判断 worker 是否可用（供 ThumbnailGenerator 决定是否走 worker 路径）。
   * - 已 dispose：返回 false
   * - fork 失败 / READY 超时（workerFailed=true）：返回 false
   * - worker 已崩溃（worker=null）：返回 false（下次调用会重新 fork）
   */
  isAvailable(): boolean {
    return !this.isDisposed && !this.workerFailed && this.worker !== null
  }

  /**
   * 终结等待中的 WORKER_READY 握手：一律 reject，绝不只置 null。
   *
   * 所有提前终止路径（worker 退出 / 握手超时 / fork 失败 / dispose）都必须走这里，
   * 否则 ensureWorker 里的 `await this.readyPromise` 会永久挂起，processImage 永远不 settle。
   * 与 media-worker / scanner-worker 两处 bridge 保持一致的 reject 语义。
   */
  private failReadyHandshake(reason: string): void {
    const reject = this.readyReject
    this.readyResolve = null
    this.readyReject = null
    this.readyPromise = null
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    // 最后再 reject：先清干净状态，避免 await 恢复后读到半清理状态
    reject?.(new Error(reason))
  }

  /**
   * 惰性启动 worker（首次 processImage 时调用）。
   * 若 worker 已存在直接复用；fork 失败或 READY 超时则置降级标志。
   */
  private async ensureWorker(): Promise<void> {
    if (this.worker) return
    if (this.workerFailed || this.isDisposed) return

    try {
      this.worker = utilityProcess.fork(path.join(__dirname, 'thumbnail-worker.js'), [], {
        serviceName: 'thumbnail-worker',
        stdio: 'pipe'
      })
    } catch (forkErr) {
      logger.error(t('main.thumbnail.log.forkFailed'), forkErr)
      this.workerFailed = true
      void logger.fault('workerCrash', new Error(t('main.thumbnail.error.workerForkFailed')), {
        workerName: 'thumbnail-worker',
        stage: 'fork-failed',
        error: forkErr instanceof Error ? forkErr.message : String(forkErr)
      })
      return
    }

    // fork 成功后才建立握手 Promise：fork 失败路径直接 return、无人 await，
    // 若提前建好再 reject 会产生 unhandledRejection
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })

    this.worker.on('message', (msg: ThumbnailWorkerEvent) => {
      this.handleWorkerMessage(msg)
    })

    this.worker.on('exit', (code) => {
      this.handleWorkerExit(code)
    })

    // WORKER_READY 10s 超时：reject 握手 + 降级到主进程内联（与其余 bridge 一致的 reject 路径）
    this.readyTimer = setTimeout(() => {
      if (!this.readyReject) return
      logger.error(t('main.thumbnail.log.readyTimeout'))
      void logger.fault('workerCrash', new Error(t('main.thumbnail.error.workerReadyTimeout')), {
        workerName: 'thumbnail-worker',
        stage: 'ready-timeout'
      })
      this.workerFailed = true
      this.failReadyHandshake(t('main.thumbnail.error.workerStartFailed'))
      // kill 当前 worker（已无意义）
      try {
        this.worker?.kill()
      } catch {}
      this.worker = null
    }, READY_TIMEOUT_MS)

    // finally 保证 reject 路径（超时 / 就绪前退出）也清理定时器，避免残留 timer 误杀新 worker
    try {
      await this.readyPromise
    } finally {
      if (this.readyTimer) {
        clearTimeout(this.readyTimer)
        this.readyTimer = null
      }
    }
  }

  /** worker 消息分发 */
  private handleWorkerMessage(msg: ThumbnailWorkerEvent): void {
    switch (msg.type) {
      case 'WORKER_READY':
        if (this.readyResolve) {
          this.readyResolve()
          this.readyResolve = null
        }
        break

      case 'THUMBNAIL_PROCESS_COMPLETE': {
        // 按 requestId 取出 resolver
        const pending = this.pending.get(msg.payload.requestId)
        if (pending) {
          clearTimeout(pending.timer)
          this.pending.delete(msg.payload.requestId)
          pending.resolve(msg.payload)
        }
        // 未知 requestId（已超时被清理）：忽略，避免无效 resolve
        break
      }

      case 'THUMBNAIL_WORKER_LOG': {
        const logMsg = `[ThumbnailWorker] ${msg.payload.message}`
        const args = msg.payload.args || []
        if (msg.payload.level === 'error') {
          logger.error(logMsg, ...args)
        } else if (msg.payload.level === 'warn') {
          logger.warn(logMsg, ...args)
        }
        break
      }

      case 'WORKER_ERROR':
        logger.error(`[ThumbnailWorker] 异常: ${msg.payload.message}`, msg.payload.stack ?? '')
        break
    }
  }

  /** worker 退出处理：reject 所有 pending，置 worker=null（不自动重启，下次调用重新 fork） */
  private handleWorkerExit(code: number): void {
    const isCrash = code !== 0

    // reject 所有 pending 请求
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('thumbnail worker exited'))
      this.pending.delete(requestId)
    }
    this.pending.clear()

    // 清理 READY 握手状态：若 worker 在就绪前退出，reject 而非空置
    // （helper 内部一并清理 readyTimer）
    this.failReadyHandshake('worker exited before ready')

    this.worker = null

    if (isCrash && !this.isDisposed) {
      logger.error(`[ThumbnailWorker] 异常退出，exit code=${code}（下次请求重新 fork）`)
      void logger.fault('workerCrash', new Error(`thumbnail-worker 异常退出 exit=${code}`), {
        workerName: 'thumbnail-worker',
        exitCode: code
      })
    }
    // 不自动重启：单文件 worker 与 scanner/media-worker 不同，
    // 降级到主进程内联 sharp 即可，下次请求会重新 ensureWorker → fork
  }

  /**
   * 处理单个缩略图请求。
   * - worker 不可用：直接返回 success=false + errorMessage='worker unavailable'，调用方走内联 fallback
   * - 30s 超时：自动 reject pending，调用方走内联 fallback
   * - worker 解码失败：返回 success=false + sharp 错误信息，调用方走 markCorrupted（不兜底）
   */
  async processImage(input: ThumbnailProcessInput): Promise<ThumbnailProcessOutput> {
    // worker 不可用（已 dispose / fork 失败 / worker=null），尝试 ensureWorker 一次
    if (!this.worker) {
      try {
        await this.ensureWorker()
      } catch (err) {
        // 握手 reject（超时 / 就绪前退出 / dispose）不外抛：
        // 按"worker 不可用"返回，由 ThumbnailGenerator 降级到内联 sharp
        logger.warn(t('main.thumbnail.log.handshakeFailed'), err)
      }
    }
    if (!this.isAvailable()) {
      return {
        requestId: input.requestId,
        success: false,
        outputPath: null,
        errorMessage: 'worker unavailable',
        outputSize: 0
      }
    }

    return new Promise<ThumbnailProcessOutput>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 30s 超时：从 pending 移除并 reject，调用方 catch 后走内联 fallback
        this.pending.delete(input.requestId)
        reject(new Error(`thumbnail worker 超时 (${REQUEST_TIMEOUT_MS}ms)`))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(input.requestId, { resolve, reject, timer })

      try {
        const cmd: ThumbnailWorkerCommand = {
          type: 'THUMBNAIL_PROCESS_START',
          payload: input
        }
        this.worker!.postMessage(cmd)
      } catch (postErr) {
        // postMessage 失败：清理 pending 并走 reject（调用方走内联 fallback）
        clearTimeout(timer)
        this.pending.delete(input.requestId)
        reject(postErr instanceof Error ? postErr : new Error(String(postErr)))
      }
    })
  }

  /**
   * 主进程退出前调用：发送 DISPOSE → 等待 500ms → 强制 kill。
   * worker 收到 DISPOSE 后会主动 process.exit(0)。
   */
  async dispose(): Promise<void> {
    this.isDisposed = true
    // dispose 期间若仍有调用方在等待握手，必须 reject（早于 return，覆盖 worker 已为 null 的情况）：
    // 此时 worker 即将被 kill，exit 回调与超时定时器都不会再兜底 reject
    this.failReadyHandshake(t('main.thumbnail.error.workerDisposed'))
    if (!this.worker) return

    try {
      const cmd: ThumbnailWorkerCommand = { type: 'THUMBNAIL_WORKER_DISPOSE' }
      this.worker.postMessage(cmd)
      // 给 worker 500ms 时间退出
      await new Promise((resolve) => setTimeout(resolve, DISPOSE_GRACE_MS))
    } catch {
      // postMessage 失败忽略，后续 kill 兜底
    }

    try {
      this.worker.kill()
    } catch {}
    this.worker = null

    // 清理 pending（dispose 时主进程也即将退出，reject 所有 pending 避免泄漏）
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('thumbnail worker disposed'))
    }
    this.pending.clear()
  }
}
