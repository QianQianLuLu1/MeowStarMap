/**
 * 扫描 worker 进程桥接层（主进程侧）
 *
 * 职责：
 * 1. 通过 utilityProcess.fork() 管理 worker 进程生命周期（惰性启动 + 退出时清理）
 * 2. 转发主进程指令到 worker（SCAN_START / SCAN_STOP / SCAN_DISPOSE）
 * 3. 接收 worker 推送的事件（SCAN_PROGRESS / SCAN_COMPLETE / SCAN_LOG / WORKER_READY / WORKER_ERROR）
 *    并分发给注册的 handler
 * 4. worker 异常退出时合成失败的 SCAN_COMPLETE 事件，避免 ScannerManager 卡在 running 状态
 *
 * 性能重构 v3 改造项三（2026-07-24）：
 * - SCAN_PROGRESS 通过 ProgressThrottle 节流后推送 task:progress（4~6 FPS）
 * - 通过 EtaCalculator 估算剩余时间（基于滑动窗口平均吞吐量）
 * - 注册到 TaskRegistry，支持 task:cancel 取消（保留 scanner:stop 向后兼容）
 *
 * 通信链路：
 *   主进程 → worker：worker.postMessage(WorkerCommand)
 *   worker → 主进程：worker.on('message', (event: WorkerEvent) => ...)
 *
 * worker-entry.js 与 index.js 同目录（dist/main/main/），通过 __dirname 解析。
 */
import { utilityProcess, type UtilityProcess } from 'electron'
import path from 'path'
import { logger } from '../utils/logger'
import { t } from '../i18n'
import { ProgressThrottle } from '../utils/progress-throttle'
import { EtaCalculator } from '../utils/eta-calculator'
import { taskRegistry } from '../utils/task-registry'
import { WorkerRestartPolicy, type WorkerCrashInfo } from '../utils/worker-restart-policy'
import type { TaskProgress } from '../../shared/types/progress'
import type { WorkerCommand, WorkerEvent, ScanOptions } from './worker-protocol'
// 活动任务快照：扫描进度缓存到共享 store，供 task:getActive 在渲染挂载时拉取（补偿 IPC 无重放）
import { setActiveScanTask, getActiveScanTask } from '../utils/active-task-store'

/** WORKER_READY 握手超时：worker 启动不应超过 15s，超时即判启动失败 */
const READY_TIMEOUT_MS = 15_000

export class ScannerWorkerBridge {
  private worker: UtilityProcess | null = null
  private messageHandlers: ((event: WorkerEvent) => void)[] = []
  // 跟踪扫描状态：worker 异常退出时若 isScanning=true，需合成失败的 SCAN_COMPLETE
  private isScanning = false
  // worker 启动握手：等待 WORKER_READY 信号
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((err: Error) => void) | null = null
  // 性能重构 v3：进度节流 + ETA 计算
  private progressThrottle = new ProgressThrottle(200)
  private etaCalculator = new EtaCalculator(10)
  // 当前扫描任务 ID（用于 task:progress 推送与取消）
  private currentTaskId: string | null = null
  // 扫描开始时间戳（用于 task:progress.startedAt）
  private scanStartedAt = 0
  // 用户已请求取消：abort 监听器置 true，SCAN_COMPLETE 据此跳过终态二次推送
  private cancelRequested = false
  // 自动重启策略：异常退出时延迟重启 worker 并尝试恢复扫描任务
  private restartPolicy = new WorkerRestartPolicy({ workerName: 'ScannerWorker' })
  // 崩溃事件监听器（Application 注入，用于弹窗提示用户）
  private crashListeners: ((info: WorkerCrashInfo) => void)[] = []
  // 最近一次扫描参数（用于 worker 崩溃后重启时恢复扫描任务）
  private lastScanOptions: { dbPath: string; options: ScanOptions } | null = null
  // FIX(组2-3): 恢复扫描执行器（由 ScannerManager 注入）。崩溃自动重启的恢复路径不再
  // 直连 bridge.startScan，改经 Manager.startScan 走完整的 pendingComplete 状态机与
  // running 去重，使恢复扫描的完成结果可被上层消费（广播 scanner:complete + 链式动作）。
  private restoreExecutor: ((options: ScanOptions) => Promise<void>) | null = null
  // dispose 标志：避免 dispose 后再触发重启
  private isDisposed = false
  // FIX(组2-4): 启动超时标志——超时回调已 kill worker 并 notifyCrash(restartScheduled:false)，
  // kill 触发的 exit 事件不应再进入崩溃分支（二次 fault/崩溃通知与计划外的自动重启）
  private startupTimedOut = false
  // R14：主进程心跳定时器。每 5s 向 worker 发送 WORKER_PING，
  // worker 超过 15s 未收到则视为父进程已退出，自行停止并退出。
  private pingInterval: NodeJS.Timeout | null = null

  /**
   * 终结等待中的 WORKER_READY 握手：一律 reject，绝不只置 null。
   *
   * 所有提前终止路径（worker 退出 / 握手超时 / dispose）都必须走这里，
   * 否则 ensureWorker 里的 `await this.readyPromise` 会永久挂起，startScan 永远不 settle。
   */
  private failReadyHandshake(reason: string): void {
    const reject = this.readyReject
    this.readyResolve = null
    this.readyReject = null
    this.readyPromise = null
    // 最后再 reject：先清干净状态，避免 await 恢复后读到半清理状态
    reject?.(new Error(reason))
  }

  /**
   * 惰性启动 worker（首次 startScan 时调用）。
   * 若 worker 已存在，直接复用（dispose 时会置 null，无需 killed 判断）。
   */
  private async ensureWorker(): Promise<void> {
    if (this.worker) return

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })

    // worker-entry 现由 electron-vite 单独打包为 scanner-worker.js，与 main bundle 同处 dist/main/main/app/
    this.worker = utilityProcess.fork(path.join(__dirname, 'scanner-worker.js'), [], {
      serviceName: 'scanner-worker',
      stdio: 'pipe'
    })

    this.worker.on('message', (msg: WorkerEvent) => {
      this.handleWorkerMessage(msg)
    })

    this.worker.on('exit', (code) => {
      this.handleWorkerExit(code)
    })

    // 超时保护：15s 内未收到 WORKER_READY 则判启动失败，避免调用方无限等待
    const readyTimeout = setTimeout(() => {
      if (!this.readyReject) return
      logger.error(t('main.scanner.log.bridgeReadyTimeout'))
      void logger.fault('workerCrash', new Error(t('main.scanner.error.workerReadyTimeout')), {
        workerName: 'scanner-worker',
        stage: 'ready-timeout'
      })
      this.failReadyHandshake(t('main.scanner.error.workerStartFailed'))
      // FIX(组2-4): 标记启动超时，随后的 exit 事件只做状态清理，不再当崩溃处理
      this.startupTimedOut = true
      try {
        this.worker?.kill()
      } catch {}
      this.worker = null
      // 上报崩溃监听器：让用户看到"后台进程启动失败"提示，而非界面无限转圈
      this.notifyCrash({
        workerName: 'scanner-worker',
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

    // R14：启动主进程心跳，每 5s 向 worker 发送 WORKER_PING。
    // worker 超过 15s 未收到则视为父进程已崩溃，自行停止并退出。
    this.startHeartbeat()
  }

  /**
   * R14：启动主进程心跳定时器。
   * 若已有定时器在运行（worker 重启场景），先清理旧的再启动新的。
   */
  private startHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
    }
    this.pingInterval = setInterval(() => {
      if (this.worker && !this.isDisposed) {
        try {
          const cmd: WorkerCommand = { type: 'WORKER_PING' }
          this.worker.postMessage(cmd)
        } catch {
          // worker 已退出或 postMessage 失败，忽略（exit 事件会清理定时器）
        }
      }
    }, 5000)
    // unref：心跳定时器不阻止主进程退出
    this.pingInterval.unref?.()
  }

  /** R14：停止心跳定时器（worker 退出或 dispose 时调用） */
  private stopHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  /** worker 消息分发 */
  private handleWorkerMessage(msg: WorkerEvent): void {
    switch (msg.type) {
      case 'WORKER_READY':
        // worker 启动完成，解除 ensureWorker 的等待
        // FIX(组2-4): 成功就绪即清除超时标记，避免残留标志吞掉该 worker 后续的真实崩溃 exit
        this.startupTimedOut = false
        if (this.readyResolve) {
          this.readyResolve()
          this.readyResolve = null
        }
        break

      case 'SCAN_LOG': {
        // 转发到主进程 logger（warn/error 级别，info 级别已在 worker 内丢弃）
        const logMsg = `[ScannerWorker] ${msg.payload.message}`
        const args = msg.payload.args || []
        if (msg.payload.level === 'error') {
          logger.error(logMsg, ...args)
        } else if (msg.payload.level === 'warn') {
          logger.warn(logMsg, ...args)
        }
        break
      }

      case 'SCAN_PROGRESS': {
        // 性能重构 v3：补充 ETA + total，并节流推送 task:progress
        const progress = msg.payload
        // total 优先使用 worker 已发送的字段；否则使用 found 作为估算值（已发现文件数）
        const total = progress.total ?? Math.max(progress.found, progress.scanned, 1)
        const { etaMs, perSec } = this.etaCalculator.push(progress.scanned, total)
        // 推送给所有注册的 handler（ScannerManager 订阅后会 emit 'progress' 事件）
        // 透传补充字段（旧监听者忽略可选字段，向后兼容）
        const enriched: typeof progress = {
          ...progress,
          total,
          etaMs,
          perSec,
          taskId: this.currentTaskId ?? undefined
        }
        this.messageHandlers.forEach((h) => h({ type: 'SCAN_PROGRESS', payload: enriched }))

        // 同步推送统一进度通道（节流 200ms）
        // 取消后不再推送非终态进度，避免 abort 后残留的 SCAN_PROGRESS 被发出
        if (this.currentTaskId && !this.cancelRequested) {
          const taskProgress: TaskProgress = {
            taskId: this.currentTaskId,
            taskType: 'scan',
            phase: 'processing',
            current: progress.scanned,
            total,
            percent: Math.min(100, Math.floor((progress.scanned / total) * 100)),
            processedPerSec: perSec,
            etaMs,
            message: progress.currentPath || `扫描进度 ${progress.scanned}/${total}`,
            // 透传 scan 专属子行字段，供弹窗展示当前路径与已发现文件数
            currentPath: progress.currentPath,
            found: progress.found,
            startedAt: this.scanStartedAt,
            canCancel: true
          }
          this.progressThrottle.push(taskProgress)
          // 缓存最新非终态快照，供 task:getActive 等效重放（补偿订阅前丢失事件）
          setActiveScanTask(taskProgress)
        }
        break
      }

      case 'SCAN_COMPLETE': {
        // 扫描结束，重置状态并通知 handler
        this.isScanning = false
        // FIX(组2-1): 真实 SCAN_COMPLETE（成功或失败）即本次扫描已终结，清空恢复参数——
        // 此后非扫描期 worker 崩溃不再按旧参数整体重跑用户未请求的扫描。
        // 崩溃路径合成的假 SCAN_COMPLETE 不经过此处（直接调 messageHandlers），恢复参数保留。
        this.lastScanOptions = null
        this.messageHandlers.forEach((h) => h(msg))

        // 性能重构 v3：推送终态进度
        // - 取消时（cancelRequested=true）：终态已由 abort 监听器立即推送，此处仅清理
        // - 正常完成 / 异常：推送 done / error 终态（绕过节流立即发送）
        if (this.currentTaskId) {
          if (!this.cancelRequested) {
            const success = msg.payload.success
            const taskProgress: TaskProgress = {
              taskId: this.currentTaskId,
              taskType: 'scan',
              phase: success ? 'done' : 'error',
              current: 0,
              total: 0,
              percent: success ? 100 : 0,
              message: msg.payload.message,
              startedAt: this.scanStartedAt,
              canCancel: false
            }
            this.progressThrottle.push(taskProgress)
          }
          taskRegistry.unregister(this.currentTaskId)
          this.currentTaskId = null
          this.cancelRequested = false
          this.progressThrottle.dispose()
          this.etaCalculator.reset()
          // 扫描结束：清空活动快照，使 task:getActive 立即返回 null（弹窗进入终态渐隐）
          setActiveScanTask(null)
        }
        break
      }

      case 'WORKER_ERROR':
        logger.error(`[ScannerWorker] 异常: ${msg.payload.message}`, msg.payload.stack ?? '')
        break
    }
  }

  /** worker 退出处理：异常退出时合成失败的 SCAN_COMPLETE，并尝试自动重启 */
  private handleWorkerExit(code: number): void {
    // FIX(组2-4): 启动超时路径的 kill 已发出 notifyCrash(restartScheduled:false) 并 fault，
    // 该 kill 触发的 exit 事件只做状态清理后返回——不再二次崩溃通知、不触发计划外自动重启
    if (this.startupTimedOut) {
      this.startupTimedOut = false
      this.worker = null
      this.failReadyHandshake('worker exited before ready')
      this.stopHeartbeat()
      return
    }
    const isCrash = code !== 0
    if (isCrash) {
      logger.error(`[ScannerWorker] 异常退出，exit code=${code}`)
      void logger.fault('workerCrash', new Error(`scanner-worker 异常退出 exit=${code}`), {
        workerName: 'scanner-worker',
        exitCode: code,
        wasScanning: this.isScanning
      })
    }
    // 若扫描正在进行中，合成一个失败的 SCAN_COMPLETE，避免 ScannerManager 卡在 running 状态
    if (this.isScanning) {
      this.isScanning = false
      const fakeComplete: WorkerEvent = {
        type: 'SCAN_COMPLETE',
        payload: { success: false, message: t('main.scanner.error.scanProcessExit') }
      }
      this.messageHandlers.forEach((h) => h(fakeComplete))

      // 性能重构 v3：清理 taskRegistry + 推送 error 终态（避免渲染进程 UI 卡在 processing）
      if (this.currentTaskId) {
        this.progressThrottle.push({
          taskId: this.currentTaskId,
          taskType: 'scan',
          phase: 'error',
          current: 0,
          total: 0,
          percent: 0,
          message: t('main.scanner.error.scanProcessExit'),
          startedAt: this.scanStartedAt,
          canCancel: false
        })
        taskRegistry.unregister(this.currentTaskId)
        this.currentTaskId = null
        this.cancelRequested = false
        this.progressThrottle.dispose()
        this.etaCalculator.reset()
        // 扫描进程崩溃退出：清空活动快照，避免 task:getActive 返回陈旧进度
        setActiveScanTask(null)
      }
    }
    this.worker = null
    // worker 在就绪前退出：reject 而非空置，避免 await ensureWorker 永久挂起
    this.failReadyHandshake('worker exited before ready')
    // R14：worker 退出后停止心跳，避免向已退出的 worker 发送 ping
    this.stopHeartbeat()

    // 异常退出 + 未 dispose：尝试自动重启并恢复扫描任务
    if (isCrash && !this.isDisposed) {
      this.attemptAutoRestart(code)
    }
  }

  /**
   * 自动重启 worker 并尝试恢复扫描任务。
   * 重启次数受 WorkerRestartPolicy 滑动窗口限制，避免崩溃循环。
   */
  private attemptAutoRestart(exitCode: number): void {
    const status = this.restartPolicy.canRestart()
    const crashedAt = new Date().toISOString()

    const info: WorkerCrashInfo = {
      workerName: 'scanner-worker',
      exitCode,
      restartAttempted: true,
      restartScheduled: false,
      restartCount: status.currentCount + 1,
      restartExhausted: status.exhausted,
      crashedAt
    }

    if (!status.allowed) {
      // 重启次数耗尽：仅通知监听器，不调度重启
      logger.error(
        `[ScannerWorker] 自动重启次数耗尽（${status.currentCount}/${this.restartPolicy.maxRestartCount}）`
      )
      info.restartAttempted = false
      this.notifyCrash(info)
      return
    }

    const scheduled = this.restartPolicy.scheduleRestart(async () => {
      // 重启回调：重新 fork worker，若有 lastScanOptions 则恢复扫描
      logger.info(t('main.scanner.log.bridgeRestarting'))
      try {
        await this.ensureWorker()
        logger.info(t('main.scanner.log.bridgeRestarted'))
        void logger.fault('workerRestart', new Error(t('main.scanner.error.autoRestarted')), {
          workerName: 'scanner-worker',
          exitCode,
          restoredScan: !!this.lastScanOptions
        })

        // 恢复扫描任务（若有保存的参数）
        if (this.lastScanOptions) {
          const { dbPath, options } = this.lastScanOptions
          try {
            // FIX(组2-3): 优先经 restoreExecutor（ScannerManager 注入的 startScan）恢复——
            // 复用 Manager 的 running 去重与 pendingComplete 完成链；无注入时回退直连启动
            if (this.restoreExecutor) {
              await this.restoreExecutor(options)
            } else {
              await this.startScan(dbPath, options)
            }
            logger.info(t('main.scanner.log.scanTaskRestored'))
          } catch (restoreErr) {
            logger.error(t('main.scanner.log.scanTaskRestoreFailed'), restoreErr)
            void logger.fault('workerRestart', restoreErr, {
              workerName: 'scanner-worker',
              stage: 'restore-scan-failed'
            })
          }
        }
      } catch (restartErr) {
        logger.error(t('main.scanner.log.bridgeRestartFailed'), restartErr)
        void logger.fault('workerRestart', restartErr, {
          workerName: 'scanner-worker',
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
        logger.error(t('main.scanner.log.bridgeCrashListenerFailed'), err)
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

  /**
   * FIX(组2-3): 注入恢复扫描执行器（ScannerManager 在构造时调用）。
   * 执行器内部走 Manager.startScan：崩溃恢复的扫描与用户手动扫描共用同一套
   * running 去重、taskId 注册与完成事件链。
   */
  setRestoreExecutor(executor: (options: ScanOptions) => Promise<void>): void {
    this.restoreExecutor = executor
  }

  /** 发送扫描指令（SCAN_START） */
  async startScan(dbPath: string, options: ScanOptions): Promise<void> {
    // FIX(组2-2): 崩溃自动重启的恢复回调与本方法并发（用户在 2s 重启窗口内手动重扫）时，
    // 直接放行会覆盖 currentTaskId——旧 taskId 泄漏在 taskRegistry，worker 收到两个 SCAN_START。
    // 以 isScanning 拒绝重复启动；调用方（Manager 的 catch / 恢复回调的 try/catch）已处理该失败。
    if (this.isScanning) {
      throw new Error(t('main.scanner.error.duplicateScanStart'))
    }
    await this.ensureWorker()
    this.isScanning = true

    // 性能重构 v3：注册任务到 TaskRegistry，支持 task:cancel 统一取消
    // taskId 唯一标识本次扫描，渲染进程从 SCAN_PROGRESS.taskId 取得后可调用 task:cancel
    const taskId = `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.currentTaskId = taskId
    this.scanStartedAt = Date.now()
    this.cancelRequested = false
    // 保存扫描参数，用于 worker 崩溃后自动重启时恢复扫描
    this.lastScanOptions = { dbPath, options }
    this.etaCalculator.reset()
    this.progressThrottle.dispose() // 清理上一轮节流残留状态

    const controller = taskRegistry.register(taskId)
    // 监听 abort：用户调用 task:cancel 时立即推送 cancelled 终态 + 转发 SCAN_STOP 到 worker
    // worker 收到 SCAN_STOP 后会停止扫描并发送 SCAN_COMPLETE(success=false)
    controller.signal.addEventListener('abort', () => {
      this.cancelRequested = true
      // 推送 cancelled 终态（ProgressThrottle 对终态立即推送，绕过节流）
      this.progressThrottle.push({
        taskId,
        taskType: 'scan',
        phase: 'cancelled',
        current: 0,
        total: 0,
        percent: 0,
        message: t('main.scanner.message.scanCancelled'),
        startedAt: this.scanStartedAt,
        canCancel: false
      })
      // 转发停止指令到 worker（向后兼容 scanner:stop 通道）
      this.stopScan()
    })

    const cmd: WorkerCommand = {
      type: 'SCAN_START',
      payload: { dbPath, options }
    }
    this.worker!.postMessage(cmd)
  }

  /** 发送停止指令（SCAN_STOP） */
  stopScan(): void {
    if (!this.worker) return
    const cmd: WorkerCommand = { type: 'SCAN_STOP' }
    this.worker.postMessage(cmd)
  }

  /**
   * 返回当前活动扫描任务快照（非终态），无活动扫描时返回 null。
   * 供 task:getActive 调用：渲染进程挂载时一次性拉取，补偿订阅前丢失的进度事件。
   */
  getActiveScanTask(): TaskProgress | null {
    return getActiveScanTask()
  }

  /**
   * 注册 worker 事件回调（progress/complete）。
   * @returns 取消订阅函数
   */
  onEvent(handler: (event: WorkerEvent) => void): () => void {
    this.messageHandlers.push(handler)
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler)
    }
  }

  /**
   * 主进程退出前调用：发送 SCAN_STOP（立即停止扫描循环）→ SCAN_DISPOSE（清理并退出）→ 强制 kill。
   * R14：显式发送 SCAN_STOP，确保 worker 正在扫描时能立即停止，而非等 DISPOSE 的 process.exit 截断。
   */
  async dispose(): Promise<void> {
    this.isDisposed = true
    this.restartPolicy.dispose()
    // R14：先停止心跳，避免 dispose 过程中继续发送 ping
    this.stopHeartbeat()
    // dispose 期间若仍有调用方在等待握手，必须 reject（早于 return，覆盖 worker 已为 null 的情况）：
    // 此时 worker 即将被 kill，exit 回调与超时定时器都不会再兜底 reject
    this.failReadyHandshake(t('main.scanner.error.workerDisposed'))
    if (!this.worker) return
    try {
      // R14：先发 SCAN_STOP 让 worker 立即停止扫描循环（shouldStop=true），
      // 再发 SCAN_DISPOSE 让 worker 清理 DB + 子进程并退出。
      this.worker.postMessage({ type: 'SCAN_STOP' } satisfies WorkerCommand)
      const cmd: WorkerCommand = { type: 'SCAN_DISPOSE' }
      this.worker.postMessage(cmd)
      // 给 worker 500ms 时间清理（关闭 DB + kill 子进程）
      await new Promise((resolve) => setTimeout(resolve, 500))
    } catch {
      // postMessage 失败忽略，后续 kill 兜底
    }
    // UtilityProcess 无 killed 属性，直接调用 kill()（对已退出进程调用是安全的，try/catch 兜底）
    try {
      this.worker.kill()
    } catch {}
    this.worker = null
    this.isScanning = false
    // 性能重构 v3：清理进度节流与任务注册项，避免应用退出时残留
    if (this.currentTaskId) {
      taskRegistry.unregister(this.currentTaskId)
      this.currentTaskId = null
      this.cancelRequested = false
    }
    this.progressThrottle.dispose()
    this.etaCalculator.reset()
  }
}
