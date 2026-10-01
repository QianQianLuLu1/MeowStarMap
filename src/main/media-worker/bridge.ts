/**
 * media worker 进程桥接层（主进程侧）
 *
 * 职责：
 * 1. 通过 utilityProcess.fork() 管理 worker 进程生命周期（惰性启动 + 退出时清理）
 * 2. 转发主进程指令到 worker（THUMBNAIL_BATCH_START / PHASH_BATCH_START / DUPLICATE_MARK_START / *_STOP / DISPOSE）
 * 3. 接收 worker 推送的事件（*_PROGRESS / *_COMPLETE / MEDIA_WORKER_LOG / WORKER_READY / WORKER_ERROR）
 *    并分发给注册的 handler
 * 4. worker 异常退出时合成失败的 *_COMPLETE 事件，避免 Manager 卡在 running 状态
 *
 * 通信链路：
 *   主进程 → worker：worker.postMessage(MediaWorkerCommand)
 *   worker → 主进程：worker.on('message', (event: MediaWorkerEvent) => ...)
 *
 * worker-entry.js 与 index.js 同目录（dist/main/main/media-worker/），通过 __dirname 解析。
 *
 * 与 ScannerWorkerBridge 的关系：
 * - 两个完全独立的 utilityProcess（scanner-worker 与 media-worker）
 * - 架构模式一致，但消息协议独立，避免任务类型耦合
 */
import { utilityProcess, type UtilityProcess } from 'electron'
import path from 'path'
import { logger } from '../utils/logger'
import { t } from '../i18n'
import { WorkerRestartPolicy, type WorkerCrashInfo } from '../utils/worker-restart-policy'
import type { MediaWorkerCommand, MediaWorkerEvent, ThumbnailQuality } from './worker-protocol'

/** WORKER_READY 握手超时：worker 启动不应超过 15s，超时即判启动失败 */
const READY_TIMEOUT_MS = 15_000

/** DISPOSE 确认等待超时兜底：远大于原 500ms，覆盖大库 WAL checkpoint 关闭耗时；超时仍走 kill */
const DISPOSE_CONFIRM_TIMEOUT_MS = 2000

export class MediaWorkerBridge {
  private worker: UtilityProcess | null = null
  private messageHandlers: ((event: MediaWorkerEvent) => void)[] = []
  // 跟踪三类任务运行状态：worker 异常退出时若任一为 true，需合成失败的 *_COMPLETE
  private isThumbnailRunning = false
  private isPhashRunning = false
  private isDuplicateRunning = false
  // 相似检测运行状态（与三类任务独立，各自取消/恢复互不干扰）
  private isSimilarRunning = false
  // worker 启动握手：等待 WORKER_READY 信号
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((err: Error) => void) | null = null
  // 自动重启策略：异常退出时延迟重启 worker 并尝试恢复运行中的任务
  private restartPolicy = new WorkerRestartPolicy({ workerName: 'MediaWorker' })
  // 崩溃事件监听器（Application 注入，用于弹窗提示用户）
  private crashListeners: ((info: WorkerCrashInfo) => void)[] = []
  // 最近一次任务参数（按类型保存，用于 worker 崩溃后重启时恢复任务）
  private lastThumbnailTask: {
    dbPath: string
    cacheDir: string
    thumbnailQuality: ThumbnailQuality
  } | null = null
  private lastPhashTask: { dbPath: string } | null = null
  private lastDuplicateTask: { dbPath: string } | null = null
  private lastSimilarTask: { dbPath: string; threshold: number } | null = null
  // FIX(组11-1): 恢复任务执行器（由 MediaWorkerManager 注入）。崩溃自动重启的恢复路径
  // 不再直连 bridge.startXxx——那会绕过 Manager 层的 isXxxRunning 互斥与 registerTask
  // 注册（恢复的任务对 task:cancel 不可取消、无 task:progress 进度，对用户完全不可见），
  // 且与用户在 2s 重启窗口内手动启动的同类型任务并发，共享 shouldStop* 标志互相干扰。
  private restoreExecutor:
    | ((tasks: {
        thumbnail: { cacheDir: string; thumbnailQuality: ThumbnailQuality } | null
        phash: boolean
        duplicate: boolean
        similar: { threshold: number } | null
      }) => Promise<void>)
    | null = null
  // dispose 标志：避免 dispose 后再触发重启
  private isDisposed = false
  // N2 批量让位状态记忆：worker 崩溃重启 / 惰性启动后补发，保证新 worker 进程持有最新状态
  private batchYieldActive = false
  // 自恢复期间停止 worker 的标志：stopWorkerForRestore 置位、对应 exit 处理完后复位。
  // 用于抑制 kill 兜底触发的非零码退出被误判为崩溃而自动重启。
  private terminatingForRestore = false
  // stopWorkerForRestore 等待 worker 回发 MEDIA_WORKER_DISPOSED 确认的 resolver（带超时兜底）
  private disposeResolve: (() => void) | null = null
  /**
   * 自恢复并发边界探针：worker 进程是否仍存活（持有 dbPath 文件句柄）。
   * stopWorkerForRestore 末尾已置 this.worker = null（即便 *_DISPOSED 超时兜底走 kill 亦然），
   * 调用方在 await stopWorkerForRestore 后据此断言句柄已释放、rename 覆盖 dbPath 前无进程占用。
   */
  hasLiveWorker(): boolean {
    return this.worker !== null
  }

  /**
   * 终结等待中的 WORKER_READY 握手：一律 reject，绝不只置 null。
   *
   * 所有提前终止路径（worker 退出 / 握手超时 / dispose）都必须走这里，
   * 否则 ensureWorker 里的 `await this.readyPromise` 会永久挂起，
   * 调用方（缩略图 / pHash / 去重任务）的 Promise 永远不 settle。
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
   * 惰性启动 worker（首次任务时调用）。
   * 若 worker 已存在，直接复用（dispose 时会置 null）。
   */
  private async ensureWorker(): Promise<void> {
    if (this.worker) return

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })

    // worker-entry 现由 electron-vite 单独打包为 media-worker.js，与 main bundle 同处 dist/main/main/app/
    this.worker = utilityProcess.fork(path.join(__dirname, 'media-worker.js'), [], {
      serviceName: 'media-worker',
      stdio: 'pipe'
    })

    this.worker.on('message', (msg: MediaWorkerEvent) => {
      this.handleWorkerMessage(msg)
    })

    this.worker.on('exit', (code) => {
      this.handleWorkerExit(code)
    })

    // 超时保护：15s 内未收到 WORKER_READY 则判启动失败，避免调用方无限等待
    const readyTimeout = setTimeout(() => {
      if (!this.readyReject) return
      logger.error(t('main.mediaWorker.log.readyTimeout'))
      void logger.fault('workerCrash', new Error(t('main.mediaWorker.error.workerReadyTimeout')), {
        workerName: 'media-worker',
        stage: 'ready-timeout'
      })
      // 拒绝握手并清理卡死的 worker，使后续调用可重新 fork
      this.failReadyHandshake(t('main.mediaWorker.error.workerStartFailed'))
      try {
        this.worker?.kill()
      } catch {}
      this.worker = null
      // 上报崩溃监听器：让用户看到"后台进程启动失败"提示，而非界面无限转圈
      this.notifyCrash({
        workerName: 'media-worker',
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

  /** worker 消息分发 */
  private handleWorkerMessage(msg: MediaWorkerEvent): void {
    switch (msg.type) {
      case 'WORKER_READY':
        // worker 启动完成，解除 ensureWorker 的等待
        if (this.readyResolve) {
          this.readyResolve()
          this.readyResolve = null
        }
        break

      case 'MEDIA_WORKER_LOG': {
        // 转发到主进程 logger（warn/error 级别，info 级别已在 worker 内丢弃）
        const logMsg = `[MediaWorker] ${msg.payload.message}`
        const args = msg.payload.args || []
        if (msg.payload.level === 'error') {
          logger.error(logMsg, ...args)
        } else if (msg.payload.level === 'warn') {
          logger.warn(logMsg, ...args)
        }
        break
      }

      case 'THUMBNAIL_PROGRESS':
      case 'THUMBNAIL_COMPLETE':
        // THUMBNAIL_COMPLETE 时重置状态
        if (msg.type === 'THUMBNAIL_COMPLETE') this.isThumbnailRunning = false
        this.messageHandlers.forEach((h) => h(msg))
        break

      case 'PHASH_PROGRESS':
      case 'PHASH_COMPLETE':
        if (msg.type === 'PHASH_COMPLETE') this.isPhashRunning = false
        this.messageHandlers.forEach((h) => h(msg))
        break

      case 'DUPLICATE_PROGRESS':
      case 'DUPLICATE_COMPLETE':
        if (msg.type === 'DUPLICATE_COMPLETE') this.isDuplicateRunning = false
        this.messageHandlers.forEach((h) => h(msg))
        break

      case 'SIMILAR_PROGRESS':
      case 'SIMILAR_CANDIDATES':
      case 'SIMILAR_COMPLETE':
        // SIMILAR_COMPLETE 时重置运行状态
        if (msg.type === 'SIMILAR_COMPLETE') this.isSimilarRunning = false
        this.messageHandlers.forEach((h) => h(msg))
        break

      case 'SIMILAR_ERROR':
        // 异常事件转发给 handler（如被订阅）；终态由随后到达的 SIMILAR_COMPLETE 或崩溃合成兜底
        this.messageHandlers.forEach((h) => h(msg))
        break

      case 'MEDIA_WORKER_DISPOSED':
        // 新增：worker 已关闭 DB 句柄，解除 stopWorkerForRestore 的等待（随后 kill 兜底）
        this.disposeResolve?.()
        break

      case 'WORKER_ERROR':
        logger.error(`[MediaWorker] 异常: ${msg.payload.message}`, msg.payload.stack ?? '')
        break
    }
  }

  /** worker 退出处理：异常退出时合成失败的 *_COMPLETE，并尝试自动重启 */
  private handleWorkerExit(code: number): void {
    const isCrash = code !== 0
    if (isCrash) {
      logger.error(`[MediaWorker] 异常退出，exit code=${code}`)
      void logger.fault('workerCrash', new Error(`media-worker 异常退出 exit=${code}`), {
        workerName: 'media-worker',
        exitCode: code,
        wasThumbnailRunning: this.isThumbnailRunning,
        wasPhashRunning: this.isPhashRunning,
        wasDuplicateRunning: this.isDuplicateRunning
      })
    }
    // 保存崩溃时正在运行的任务类型（用于重启后恢复）
    const wasThumbnailRunning = this.isThumbnailRunning
    const wasPhashRunning = this.isPhashRunning
    const wasDuplicateRunning = this.isDuplicateRunning
    const wasSimilarRunning = this.isSimilarRunning

    // 若任一任务正在进行中，合成对应的失败 COMPLETE 事件
    if (this.isThumbnailRunning) {
      this.isThumbnailRunning = false
      const fakeComplete: MediaWorkerEvent = {
        type: 'THUMBNAIL_COMPLETE',
        payload: {
          success: false,
          message: t('main.mediaWorker.error.thumbnailProcessExit'),
          processed: 0,
          total: 0
        }
      }
      this.messageHandlers.forEach((h) => h(fakeComplete))
    }
    if (this.isPhashRunning) {
      this.isPhashRunning = false
      const fakeComplete: MediaWorkerEvent = {
        type: 'PHASH_COMPLETE',
        payload: {
          success: false,
          message: t('main.mediaWorker.error.phashProcessExit'),
          processed: 0,
          total: 0
        }
      }
      this.messageHandlers.forEach((h) => h(fakeComplete))
    }
    if (this.isDuplicateRunning) {
      this.isDuplicateRunning = false
      const fakeComplete: MediaWorkerEvent = {
        type: 'DUPLICATE_COMPLETE',
        payload: {
          success: false,
          message: t('main.mediaWorker.error.duplicateProcessExit'),
          markedDuplicates: 0,
          totalGroups: 0
        }
      }
      this.messageHandlers.forEach((h) => h(fakeComplete))
    }
    if (this.isSimilarRunning) {
      this.isSimilarRunning = false
      const fakeComplete: MediaWorkerEvent = {
        type: 'SIMILAR_COMPLETE',
        payload: {
          success: false,
          message: t('main.mediaWorker.error.similarProcessExit'),
          rows: [],
          totalCandidates: 0,
          totalRows: 0
        }
      }
      this.messageHandlers.forEach((h) => h(fakeComplete))
    }
    this.worker = null
    // worker 在就绪前退出：reject 而非空置，避免 await ensureWorker 永久挂起
    this.failReadyHandshake('worker exited before ready')

    // 异常退出 + 未 dispose + 非自恢复停止：尝试自动重启并恢复运行中的任务
    if (isCrash && !this.isDisposed && !this.terminatingForRestore) {
      this.attemptAutoRestart(code, {
        thumbnail: wasThumbnailRunning,
        phash: wasPhashRunning,
        duplicate: wasDuplicateRunning,
        similar: wasSimilarRunning
      })
    }
    // 自恢复停止（stopWorkerForRestore）触发的退出：清除标志，允许后续正常启动/重启
    if (this.terminatingForRestore) {
      this.terminatingForRestore = false
    }
  }

  /**
   * 自动重启 worker 并尝试恢复崩溃时正在运行的任务。
   * 重启次数受 WorkerRestartPolicy 滑动窗口限制，避免崩溃循环。
   */
  private attemptAutoRestart(
    exitCode: number,
    runningTasks: { thumbnail: boolean; phash: boolean; duplicate: boolean; similar: boolean }
  ): void {
    const status = this.restartPolicy.canRestart()
    const crashedAt = new Date().toISOString()

    const info: WorkerCrashInfo = {
      workerName: 'media-worker',
      exitCode,
      restartAttempted: true,
      restartScheduled: false,
      restartCount: status.currentCount + 1,
      restartExhausted: status.exhausted,
      crashedAt
    }

    if (!status.allowed) {
      logger.error(
        `[MediaWorker] 自动重启次数耗尽（${status.currentCount}/${this.restartPolicy.maxRestartCount}）`
      )
      info.restartAttempted = false
      this.notifyCrash(info)
      return
    }

    const scheduled = this.restartPolicy.scheduleRestart(async () => {
      logger.info(t('main.mediaWorker.log.restarting'))
      try {
        await this.ensureWorker()
        logger.info(t('main.mediaWorker.log.restarted'))
        void logger.fault('workerRestart', new Error(t('main.mediaWorker.error.autoRestarted')), {
          workerName: 'media-worker',
          exitCode,
          restoredTasks: runningTasks
        })

        // 恢复崩溃时正在运行的任务
        // FIX(组11-1): 优先经 restoreExecutor（MediaWorkerManager 注入的 startXxx）恢复——
        // 复用 Manager 层的互斥去重、taskId 注册（可取消、有进度）与 pendingComplete 完成链；
        // 无注入时回退直连 bridge 方法（保留旧行为）
        if (this.restoreExecutor) {
          await this.restoreExecutor({
            thumbnail:
              runningTasks.thumbnail && this.lastThumbnailTask
                ? {
                    cacheDir: this.lastThumbnailTask.cacheDir,
                    thumbnailQuality: this.lastThumbnailTask.thumbnailQuality
                  }
                : null,
            phash: runningTasks.phash && !!this.lastPhashTask,
            duplicate: runningTasks.duplicate && !!this.lastDuplicateTask,
            similar:
              runningTasks.similar && this.lastSimilarTask
                ? { threshold: this.lastSimilarTask.threshold }
                : null
          })
          return
        }
        if (runningTasks.thumbnail && this.lastThumbnailTask) {
          const { dbPath, cacheDir, thumbnailQuality } = this.lastThumbnailTask
          try {
            await this.startThumbnailBatch(dbPath, cacheDir, thumbnailQuality)
            logger.info(t('main.mediaWorker.log.thumbnailRestored'))
          } catch (restoreErr) {
            logger.error(t('main.mediaWorker.log.thumbnailRestoreFailed'), restoreErr)
            void logger.fault('workerRestart', restoreErr, {
              workerName: 'media-worker',
              stage: 'restore-thumbnail-failed'
            })
          }
        }
        if (runningTasks.phash && this.lastPhashTask) {
          const { dbPath } = this.lastPhashTask
          try {
            await this.startPhashBatch(dbPath)
            logger.info(t('main.mediaWorker.log.phashRestored'))
          } catch (restoreErr) {
            logger.error(t('main.mediaWorker.log.phashRestoreFailed'), restoreErr)
            void logger.fault('workerRestart', restoreErr, {
              workerName: 'media-worker',
              stage: 'restore-phash-failed'
            })
          }
        }
        if (runningTasks.duplicate && this.lastDuplicateTask) {
          const { dbPath } = this.lastDuplicateTask
          try {
            await this.startDuplicateMark(dbPath)
            logger.info(t('main.mediaWorker.log.duplicateRestored'))
          } catch (restoreErr) {
            logger.error(t('main.mediaWorker.log.duplicateRestoreFailed'), restoreErr)
            void logger.fault('workerRestart', restoreErr, {
              workerName: 'media-worker',
              stage: 'restore-duplicate-failed'
            })
          }
        }
        if (runningTasks.similar && this.lastSimilarTask) {
          const { dbPath, threshold } = this.lastSimilarTask
          try {
            await this.startSimilarFind(dbPath, threshold)
            logger.info(t('main.mediaWorker.log.similarRestored'))
          } catch (restoreErr) {
            logger.error(t('main.mediaWorker.log.similarRestoreFailed'), restoreErr)
            void logger.fault('workerRestart', restoreErr, {
              workerName: 'media-worker',
              stage: 'restore-similar-failed'
            })
          }
        }
      } catch (restartErr) {
        logger.error(t('main.mediaWorker.log.restartFailed'), restartErr)
        void logger.fault('workerRestart', restartErr, {
          workerName: 'media-worker',
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
        logger.error(t('main.mediaWorker.log.crashListenerFailed'), err)
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
   * FIX(组11-1): 注入恢复任务执行器（MediaWorkerManager 在构造时调用）。
   * 执行器内部走 Manager.startXxx：崩溃恢复的任务与用户手动任务共用同一套
   * isXxxRunning 互斥、taskId 注册与 pendingComplete 完成链。
   */
  setRestoreExecutor(
    executor: (tasks: {
      thumbnail: { cacheDir: string; thumbnailQuality: ThumbnailQuality } | null
      phash: boolean
      duplicate: boolean
      similar: { threshold: number } | null
    }) => Promise<void>
  ): void {
    this.restoreExecutor = executor
  }

  /** 发送缩略图批量生成指令 */
  async startThumbnailBatch(
    dbPath: string,
    cacheDir: string,
    thumbnailQuality: ThumbnailQuality
  ): Promise<void> {
    await this.ensureWorker()
    this.isThumbnailRunning = true
    // 保存任务参数，用于 worker 崩溃后自动重启时恢复
    this.lastThumbnailTask = { dbPath, cacheDir, thumbnailQuality }
    const cmd: MediaWorkerCommand = {
      type: 'THUMBNAIL_BATCH_START',
      payload: { dbPath, cacheDir, thumbnailQuality }
    }
    this.worker!.postMessage(cmd)
    // N2：新 worker 进程不持有让位标志，启动批次后补发当前状态（含崩溃自动重启恢复路径）
    this.setBatchYield(this.batchYieldActive)
  }

  /** 发送 pHash 批量补算指令 */
  async startPhashBatch(dbPath: string): Promise<void> {
    await this.ensureWorker()
    this.isPhashRunning = true
    this.lastPhashTask = { dbPath }
    const cmd: MediaWorkerCommand = {
      type: 'PHASH_BATCH_START',
      payload: { dbPath }
    }
    this.worker!.postMessage(cmd)
  }

  /** 发送重复标记指令 */
  async startDuplicateMark(dbPath: string): Promise<void> {
    await this.ensureWorker()
    this.isDuplicateRunning = true
    this.lastDuplicateTask = { dbPath }
    const cmd: MediaWorkerCommand = {
      type: 'DUPLICATE_MARK_START',
      payload: { dbPath }
    }
    this.worker!.postMessage(cmd)
  }

  /** 发送相似检测指令 */
  async startSimilarFind(dbPath: string, threshold: number): Promise<void> {
    await this.ensureWorker()
    this.isSimilarRunning = true
    this.lastSimilarTask = { dbPath, threshold }
    const cmd: MediaWorkerCommand = {
      type: 'SIMILAR_FIND_START',
      payload: { dbPath, threshold }
    }
    this.worker!.postMessage(cmd)
  }

  /** 发送缩略图取消指令 */
  stopThumbnailBatch(): void {
    if (!this.worker) return
    const cmd: MediaWorkerCommand = { type: 'THUMBNAIL_STOP' }
    this.worker.postMessage(cmd)
  }

  /**
   * 发送批量让位开关（fix-thumbnail-skeleton-reveal N2）：
   * active=true 表示主进程有可视区按需生成在途，worker 批量条目间插入延迟。
   * worker 未启动时为 no-op（下次 THUMBNAIL_BATCH_START 后由 startThumbnailBatch
   * 末尾补发当前状态，覆盖惰性启动与崩溃自动重启两条路径）；
   * postMessage 失败仅忽略——让位是性能优化，不因发送失败中断批量任务。
   */
  setBatchYield(active: boolean): void {
    this.batchYieldActive = active
    if (!this.worker) return
    try {
      const cmd: MediaWorkerCommand = { type: 'MEDIA_WORKER_BATCH_YIELD', payload: { active } }
      this.worker.postMessage(cmd)
    } catch (err) {
      logger.warn(`[MediaWorker] 批量让位命令发送失败（不影响批量任务）`, err)
    }
  }

  /** 发送 pHash 取消指令 */
  stopPhashBatch(): void {
    if (!this.worker) return
    const cmd: MediaWorkerCommand = { type: 'PHASH_STOP' }
    this.worker.postMessage(cmd)
  }

  /** 发送重复标记取消指令 */
  stopDuplicateMark(): void {
    if (!this.worker) return
    const cmd: MediaWorkerCommand = { type: 'DUPLICATE_STOP' }
    this.worker.postMessage(cmd)
  }

  /** 发送相似检测取消指令 */
  stopSimilarFind(): void {
    if (!this.worker) return
    const cmd: MediaWorkerCommand = { type: 'SIMILAR_STOP' }
    this.worker.postMessage(cmd)
  }

  /**
   * 注册 worker 事件回调（progress/complete）。
   * @returns 取消订阅函数
   */
  onEvent(handler: (event: MediaWorkerEvent) => void): () => void {
    this.messageHandlers.push(handler)
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler)
    }
  }

  /**
   * 数据库自恢复期间停止 worker（可逆，不置 isDisposed）。
   *
   * 释放本 bridge 对 dbPath 持有的 better-sqlite3 句柄，避免 Windows 上用 rename 覆盖在线库时因其他
   * 进程占用目标文件而 EPERM 失败。与 dispose 不同：不置 isDisposed，被停止的 worker 会在下次
   * ensureWorker 时重新 fork 并打开还原后的库，实现"重启 worker 重建连接"。
   *
   * 握手拒绝交由 exit 回调兜底（handleWorkerExit），避免引入新的 i18n key。
   */
  /**
   * 等待 worker 在处理完 MEDIA_WORKER_DISPOSE 后回发 MEDIA_WORKER_DISPOSED 确认：DB 句柄已释放，主进程可安全 rename 还原。
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
    try {
      const cmd: MediaWorkerCommand = { type: 'MEDIA_WORKER_DISPOSE' }
      this.worker.postMessage(cmd)
      // 等待 worker 关闭 DB 句柄后回发的 MEDIA_WORKER_DISPOSED 确认（带超时兜底），
      // 不再盲等固定 500ms——确认到达即可立即 kill，避免恢复 rename 时句柄仍被 OS 短暂持有。
      await this.waitForWorkerDisposed(DISPOSE_CONFIRM_TIMEOUT_MS)
    } catch {
      // postMessage 失败忽略，后续 kill 兜底
    }
    // UtilityProcess 无 killed 属性，直接调用 kill()（对已退出进程调用是安全的，try/catch 兜底）
    try {
      this.worker.kill()
    } catch {}
    this.worker = null
    this.isThumbnailRunning = false
    this.isPhashRunning = false
    this.isDuplicateRunning = false
    this.isSimilarRunning = false
  }

  /**
   * 主进程退出前调用：发送 DISPOSE → 等待 500ms → 强制 kill。
   * worker 收到 DISPOSE 后会主动关闭 DB + kill 子进程 + 退出。
   * 复用 stopWorkerForRestore 的停进程逻辑，并追加 isDisposed（致命，不可复用）。
   */
  async dispose(): Promise<void> {
    if (this.isDisposed) return
    this.isDisposed = true
    this.restartPolicy.dispose()
    await this.stopWorkerForRestore()
    // dispose 语义：握手以 workerDisposed 拒绝（stopWorkerForRestore 已先行拒绝，此处保证最终消息一致）
    this.failReadyHandshake(t('main.mediaWorker.error.workerDisposed'))
  }
}
