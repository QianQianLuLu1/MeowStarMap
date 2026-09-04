/**
 * 解密网络解码子进程桥接层（主进程侧）
 *
 * FIX(组17-1)：cloth_diy/home_build 分享码的网络解码 FFI 从主进程全局 mutex 下沉到
 * 专用 utilityProcess。本桥生命周期管理复用 media-worker bridge 范式（惰性 fork +
 * WORKER_READY 15s 握手 + failReadyHandshake 不变式 + WorkerRestartPolicy），请求关联
 * 复用 thumbnail worker bridge 范式（pending Map + requestId）。
 *
 * 硬超时设计（关键）：8s 超时必须在主进程侧用 Promise.race 实现，不能依赖子进程内部
 * 定时器——同步 FFI 冻结期间子进程事件循环停摆，setTimeout 永远不触发。超时后 kill
 * 冻结的 worker（收不到 DISPOSE 消息，只能强杀，C 堆由 OS 回收），重启策略自动恢复。
 *
 * 降级语义：decodeNetwork 永不 reject——超时/崩溃/未就绪一律 resolve {ok:false,reason}，
 * 由 decryption-service 转成"优雅降级"（success:true + error，本地字段照常返回），
 * 与 DLL 返回 status≠0 时的既有行为一致。
 */
import { utilityProcess, type UtilityProcess } from 'electron'
import path from 'path'
import { logger } from '../utils/logger'
import { t } from '../i18n'
import { WorkerRestartPolicy, type WorkerCrashInfo } from '../utils/worker-restart-policy'
import { findDllPath } from './dll-path'
import type {
  DecryptionWorkerCommand,
  DecryptionWorkerEvent,
  NetworkDecodeKind,
  NetworkDecodeResult
} from './worker-protocol'

/** WORKER_READY 握手超时：含 DLL 加载 + ABI 校验，超时即判启动失败 */
const READY_TIMEOUT_MS = 15_000
/**
 * 单请求硬超时。必须短于用户可感知的"卡死"阈值且长于正常网络往返；
 * 超时即 kill worker（同步 FFI 无 JS 层取消手段）。
 */
const REQUEST_TIMEOUT_MS = 8_000
/** dispose 后等待 worker 主动退出的最大时间 */
const DISPOSE_GRACE_MS = 500

interface PendingRequest {
  resolve: (result: NetworkDecodeResult) => void
  timer: NodeJS.Timeout
}

export class DecryptionWorkerBridge {
  private worker: UtilityProcess | null = null
  private pending: Map<string, PendingRequest> = new Map()
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((err: Error) => void) | null = null
  // 并发调用去重：worker 为 null 时多个 decodeNetwork 同时触发 ensureWorker，只 fork 一次
  private ensurePromise: Promise<void> | null = null
  private restartPolicy = new WorkerRestartPolicy({ workerName: 'DecryptionWorker' })
  private crashListeners: ((info: WorkerCrashInfo) => void)[] = []
  private isDisposed = false

  /**
   * 终结等待中的 WORKER_READY 握手：一律 reject，绝不只置 null。
   * 所有提前终止路径（worker 退出 / 握手超时 / dispose）都必须走这里，
   * 否则 startWorker 里的 await 会永久挂起，decodeNetwork 永不 settle。
   */
  private failReadyHandshake(reason: string): void {
    const reject = this.readyReject
    this.readyResolve = null
    this.readyReject = null
    this.readyPromise = null
    // 最后再 reject：先清干净状态，避免 await 恢复后读到半清理状态
    reject?.(new Error(reason))
  }

  /** 惰性启动 worker（首次 decodeNetwork 时调用）；并发调用复用同一次启动 */
  private async ensureWorker(): Promise<void> {
    if (this.worker) return
    if (!this.ensurePromise) {
      this.ensurePromise = this.startWorker().finally(() => {
        this.ensurePromise = null
      })
    }
    return this.ensurePromise
  }

  private async startWorker(): Promise<void> {
    // DLL 路径只能在主进程解析（utilityProcess 内 electron app 不可用）
    let dllPath: string
    try {
      dllPath = findDllPath()
    } catch (err) {
      logger.error(t('main.decryption.log.dllResolveFailed'), err)
      void logger.fault('workerCrash', err instanceof Error ? err : new Error(String(err)), {
        workerName: 'decryption-worker',
        stage: 'dll-not-found'
      })
      throw err
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })

    // worker-entry 由 electron-vite 单独打包为 decryption-worker.js，与 main bundle 同目录
    this.worker = utilityProcess.fork(path.join(__dirname, 'decryption-worker.js'), [], {
      serviceName: 'decryption-worker',
      stdio: 'pipe'
    })

    this.worker.on('message', (msg: DecryptionWorkerEvent) => {
      this.handleWorkerMessage(msg)
    })
    this.worker.on('exit', (code) => {
      this.handleWorkerExit(code)
    })

    // INIT 下发 dllPath；worker 完成 DLL 加载 + ABI 校验后才回 WORKER_READY
    try {
      const init: DecryptionWorkerCommand = { type: 'DECRYPT_WORKER_INIT', payload: { dllPath } }
      this.worker.postMessage(init)
    } catch (err) {
      logger.error(t('main.decryption.log.initSendFailed'), err)
      this.failReadyHandshake(t('main.decryption.error.initSendFailed'))
      try {
        this.worker.kill()
      } catch {}
      this.worker = null
      throw err instanceof Error ? err : new Error(String(err))
    }

    // 15s 握手超时：DLL 加载失败 / ABI 不符 / 进程未起，都由这里兜底
    const readyTimeout = setTimeout(() => {
      if (!this.readyReject) return
      logger.error(t('main.decryption.log.readyTimeout'))
      void logger.fault('workerCrash', new Error(t('main.decryption.error.workerReadyTimeout')), {
        workerName: 'decryption-worker',
        stage: 'ready-timeout'
      })
      this.failReadyHandshake(t('main.decryption.error.workerStartFailed'))
      try {
        this.worker?.kill()
      } catch {}
      this.worker = null
      this.notifyCrash({
        workerName: 'decryption-worker',
        exitCode: -1,
        restartAttempted: false,
        restartScheduled: false,
        restartCount: 0,
        restartExhausted: false,
        crashedAt: new Date().toISOString(),
        stage: 'startup-timeout'
      })
    }, READY_TIMEOUT_MS)

    try {
      await this.readyPromise
    } finally {
      clearTimeout(readyTimeout)
    }
  }

  /**
   * 网络解码请求（永不 reject）。
   * 超时 → 优雅失败 + kill 冻结 worker；worker 正常返回 status≠0 也只是数据轮次，
   * 由调用方映射为错误文案。
   */
  async decodeNetwork(kind: NetworkDecodeKind, codeStr: string): Promise<NetworkDecodeResult> {
    if (this.isDisposed) return { ok: false, reason: 'disposed' }
    try {
      await this.ensureWorker()
    } catch {
      return { ok: false, reason: 'not-ready' }
    }
    // ensureWorker 成功但期间被 dispose / 崩溃退出（worker 已置 null）
    if (!this.worker || this.isDisposed) return { ok: false, reason: 'not-ready' }
    // 闭包内 TS 无法保持属性的非空收窄，先捕获局部引用
    const worker = this.worker

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise<NetworkDecodeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        logger.error(
          t('main.decryption.log.decodeTimeout', {
            ms: String(REQUEST_TIMEOUT_MS),
            requestId
          })
        )
        void logger.fault('workerCrash', new Error(t('main.decryption.error.decodeTimeout')), {
          workerName: 'decryption-worker',
          stage: 'request-timeout'
        })
        // 冻结的 worker 收不到 DISPOSE，只能强杀；exit 处理器会清理其余 pending 并调度重启
        try {
          this.worker?.kill()
        } catch {}
        resolve({ ok: false, reason: 'timeout' })
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(requestId, { resolve, timer })
      try {
        const cmd: DecryptionWorkerCommand = {
          type: 'NETWORK_DECODE',
          payload: { requestId, kind, codeStr }
        }
        worker.postMessage(cmd)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        logger.warn(t('main.decryption.log.requestSendFailed'), err)
        resolve({ ok: false, reason: 'worker-crashed' })
      }
    })
  }

  /** worker 消息分发 */
  private handleWorkerMessage(msg: DecryptionWorkerEvent): void {
    switch (msg.type) {
      case 'WORKER_READY':
        if (this.readyResolve) {
          this.readyResolve()
          this.readyResolve = null
        }
        break

      case 'NETWORK_DECODE_RESULT': {
        const entry = this.pending.get(msg.payload.requestId)
        if (!entry) {
          // 超时后迟到的结果：请求方已按 timeout 降级，忽略即可
          logger.debug(
            `[DecryptionWorker] 忽略迟到的解码结果（requestId=${msg.payload.requestId}）`
          )
          return
        }
        clearTimeout(entry.timer)
        this.pending.delete(msg.payload.requestId)
        entry.resolve({
          ok: true,
          status: msg.payload.status,
          networkData: msg.payload.networkData,
          errorMessage: msg.payload.errorMessage
        })
        break
      }

      case 'DECRYPT_WORKER_LOG': {
        const logMsg = `[DecryptionWorker] ${msg.payload.message}`
        if (msg.payload.level === 'error') {
          logger.error(logMsg)
        } else {
          logger.warn(logMsg)
        }
        break
      }

      case 'WORKER_ERROR':
        logger.error(`[DecryptionWorker] 异常: ${msg.payload.message}`)
        break
    }
  }

  /** worker 退出处理：终结握手 + 降级全部 pending + 异常退出时按策略重启 */
  private handleWorkerExit(code: number): void {
    const isCrash = code !== 0
    if (isCrash) {
      logger.error(`[DecryptionWorker] 异常退出，exit code=${code}`)
      void logger.fault('workerCrash', new Error(`decryption-worker 异常退出 exit=${code}`), {
        workerName: 'decryption-worker',
        exitCode: code,
        pendingRequests: this.pending.size
      })
    }
    this.worker = null
    // worker 在就绪前退出：reject 而非空置，避免 await ensureWorker 永久挂起
    this.failReadyHandshake('worker exited before ready')
    // 一次性请求语义：运行中请求全部按崩溃降级（无任务需恢复）
    this.resolveAllPending('worker-crashed')

    if (isCrash && !this.isDisposed) {
      this.attemptAutoRestart(code)
    }
  }

  /** 自动重启 worker；次数受 WorkerRestartPolicy 滑动窗口限制，避免崩溃循环 */
  private attemptAutoRestart(exitCode: number): void {
    const status = this.restartPolicy.canRestart()
    const info: WorkerCrashInfo = {
      workerName: 'decryption-worker',
      exitCode,
      restartAttempted: true,
      restartScheduled: false,
      restartCount: status.currentCount + 1,
      restartExhausted: status.exhausted,
      crashedAt: new Date().toISOString()
    }

    if (!status.allowed) {
      logger.error(
        t('main.decryption.log.restartExhausted', {
          current: String(status.currentCount),
          max: String(this.restartPolicy.maxRestartCount)
        })
      )
      info.restartAttempted = false
      this.notifyCrash(info)
      return
    }

    const scheduled = this.restartPolicy.scheduleRestart(async () => {
      logger.info(t('main.decryption.log.restarting'))
      try {
        await this.ensureWorker()
        logger.info(t('main.decryption.log.restarted'))
        void logger.fault('workerRestart', new Error(t('main.decryption.error.autoRestarted')), {
          workerName: 'decryption-worker',
          exitCode
        })
      } catch (restartErr) {
        logger.error(t('main.decryption.log.restartFailed'), restartErr)
        void logger.fault(
          'workerRestart',
          restartErr instanceof Error ? restartErr : new Error(String(restartErr)),
          {
            workerName: 'decryption-worker',
            stage: 'restart-failed'
          }
        )
      }
    })

    info.restartScheduled = scheduled
    this.notifyCrash(info)
  }

  private resolveAllPending(reason: 'worker-crashed' | 'disposed'): void {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(requestId)
      entry.resolve({ ok: false, reason })
    }
  }

  /** 通知所有崩溃监听器 */
  private notifyCrash(info: WorkerCrashInfo): void {
    for (const listener of this.crashListeners) {
      try {
        listener(info)
      } catch (err) {
        logger.error(t('main.decryption.log.crashListenerFailed'), err)
      }
    }
  }

  /**
   * 注册崩溃事件监听器（app/recovery.ts 注入，用于弹窗提示用户）。
   * @returns 取消订阅函数
   */
  onCrash(listener: (info: WorkerCrashInfo) => void): () => void {
    this.crashListeners.push(listener)
    return () => {
      this.crashListeners = this.crashListeners.filter((l) => l !== listener)
    }
  }

  /** 主进程退出前调用：发 DISPOSE → 等 500ms → kill 兜底，并降级全部 pending */
  async dispose(): Promise<void> {
    this.isDisposed = true
    this.restartPolicy.dispose()
    // 早于 return 覆盖 worker 已为 null 的情况：等待握手的调用方必须被终结
    this.failReadyHandshake(t('main.decryption.error.workerDisposed'))
    this.resolveAllPending('disposed')
    if (!this.worker) return
    try {
      const cmd: DecryptionWorkerCommand = { type: 'DECRYPT_WORKER_DISPOSE' }
      this.worker.postMessage(cmd)
      await new Promise((resolve) => setTimeout(resolve, DISPOSE_GRACE_MS))
    } catch {
      // postMessage 失败忽略，后续 kill 兜底
    }
    try {
      this.worker.kill()
    } catch {}
    this.worker = null
  }
}
