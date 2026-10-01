import { EventEmitter } from 'events'
import { BrowserWindow } from 'electron'
import { MediaWorkerBridge } from './bridge'
import type { ThumbnailQuality } from './worker-protocol'
import { ProgressThrottle } from '../utils/progress-throttle'
import { EtaCalculator } from '../utils/eta-calculator'
import { taskRegistry } from '../utils/task-registry'
import { t } from '../i18n'
import type { TaskProgress, TaskType } from '../../shared/types/progress'
import type { SimilarRowMeta } from './worker-protocol'
import type { SimilarCandidate } from './bktree-index'

// re-export 公开类型，保持外部 import 路径不变
export type { ThumbnailQuality, MediaWorkerCommand, MediaWorkerEvent } from './worker-protocol'

/**
 * 单个长任务的状态容器（每类任务独立持有，避免互相干扰）。
 * - taskId：当前任务 ID（用于 task:progress 推送与 task:cancel 取消）
 * - startedAt：开始时间戳
 * - cancelRequested：abort 监听器置 true，COMPLETE 据此跳过终态二次推送
 * - progressThrottle / etaCalculator：每任务独立节流器与 ETA 估算器
 */
interface TaskRuntime {
  taskId: string | null
  startedAt: number
  cancelRequested: boolean
  progressThrottle: ProgressThrottle
  etaCalculator: EtaCalculator
}

/** 创建一份独立的任务运行时状态 */
function createTaskRuntime(): TaskRuntime {
  return {
    taskId: null,
    startedAt: 0,
    cancelRequested: false,
    progressThrottle: new ProgressThrottle(200),
    etaCalculator: new EtaCalculator(10)
  }
}

/** 生成短随机 taskId，前缀区分任务类型 */
function generateTaskId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// 缩略图批量进度的渲染层广播节流窗口（THUMBNAIL_OPTIMIZATION_PLAN 节点1）：
// 批量进行中周期性通知渲染层刷新，使新落盘缩略图逐步可见，
// 不再等整批完成才有一次 media:updated（可视项「模糊数十秒才清晰」的主因）。
const THUMBNAIL_BROADCAST_THROTTLE_MS = 2000

/**
 * 缩略图 / pHash / 重复检测管理器（薄壳）
 *
 * 拆分到 utilityProcess 后，本类仅保留接口外壳：
 * - 通过 MediaWorkerBridge 转发任务指令到 worker 进程
 * - 接收 worker 推送的 *_PROGRESS / *_COMPLETE 事件，通过 EventEmitter 通知外部
 * - 维护三类任务的 pendingPromise，在收到 *_COMPLETE 时 resolve
 *
 * 所有 CPU 密集逻辑（sharp 缩放 / ffmpeg 抽帧 / DCT-II pHash 计算 / Union-Find 聚类）
 * 已迁移到 worker-entry.ts。
 *
 * 性能重构 v3 改造项三（2026-07-24）：
 * - 三类任务（thumbnail/phash/duplicate）注册到 TaskRegistry，支持 task:cancel 统一取消
 * - PROGRESS 事件通过 ProgressThrottle 节流后推送 task:progress（4~6 FPS）
 * - 通过 EtaCalculator 估算剩余时间（基于滑动窗口平均吞吐量）
 * - 兼容性：保留原有 stop*Batch 方法 + EventEmitter 推送，新增 task:progress 通道不破坏旧监听者
 *
 * 兼容性：startThumbnailBatch / startPhashBatch / startDuplicateMark 的返回值结构
 * 与原 thumbnail-phash-service.ts 完全一致，调用方无需修改。
 */
export class MediaWorkerManager extends EventEmitter {
  private bridge: MediaWorkerBridge
  private dbPath = ''
  // 缩略图进度渲染层广播（THUMBNAIL_OPTIMIZATION_PLAN 节点1）：由 Application 注入，
  // 未注入时行为与现状完全一致（不订阅、不调用）
  private thumbnailProgressNotifier: (() => void) | null = null
  private lastThumbnailBroadcastAt = 0
  // 三类任务各自的 pendingPromise resolver
  private pendingThumbnailComplete:
    | ((result: { success: boolean; message: string; processed: number; total: number }) => void)
    | null = null
  private pendingPhashComplete:
    | ((result: {
        success: boolean
        message: string
        processed: number
        total: number
        duplicatesResult?: { markedDuplicates: number; totalGroups: number }
      }) => void)
    | null = null
  private pendingDuplicateComplete:
    | ((result: {
        success: boolean
        message: string
        markedDuplicates: number
        totalGroups: number
      }) => void)
    | null = null
  // 三类任务运行标志（与 bridge 的 isXxxRunning 解耦，Manager 侧用于互斥拦截）
  private isThumbnailRunning = false
  private isPhashRunning = false
  private isDuplicateRunning = false
  // 相似检测运行标志（与三类任务独立，各自取消/恢复互不干扰）
  private isSimilarRunning = false
  private unsubscribe: (() => void) | null = null
  // 性能重构 v3：三类任务独立的运行时状态（taskId / 节流器 / ETA 估算器）
  private thumbnailRuntime: TaskRuntime = createTaskRuntime()
  private phashRuntime: TaskRuntime = createTaskRuntime()
  private duplicateRuntime: TaskRuntime = createTaskRuntime()
  // 相似检测独立的运行时状态（复用 TaskRegistry + 进度节流 + task:cancel）
  private similarRuntime: TaskRuntime = createTaskRuntime()
  // 相似检测 pending resolver + 候选边累积（SIMILAR_COMPLETE 时一并回传）
  private pendingSimilarComplete:
    | ((result: {
        success: boolean
        message: string
        cancelled: boolean
        rows: SimilarRowMeta[]
        candidates: SimilarCandidate[]
      }) => void)
    | null = null
  private pendingSimilarCandidates: SimilarCandidate[] = []

  constructor(bridge: MediaWorkerBridge) {
    super()
    this.bridge = bridge
    this.subscribeBridgeEvents()
    // FIX(组11-1): 崩溃自动重启的任务恢复改走本类 startXxx（注入 bridge）——
    // 复用 isXxxRunning 互斥（用户在 2s 重启窗口内手动启动同类型任务时，恢复被
    // "已在进行中"拒绝而非并发共享 shouldStop* 标志）、registerTask 任务注册
    // （可经 task:cancel 取消、有 task:progress 进度，对用户可见）与 pendingComplete 完成链
    bridge.setRestoreExecutor(async (tasks) => {
      if (tasks.thumbnail) {
        await this.startThumbnailBatch({
          cacheDir: tasks.thumbnail.cacheDir,
          thumbnailQuality: tasks.thumbnail.thumbnailQuality
        })
      }
      if (tasks.phash) await this.startPhashBatch()
      if (tasks.duplicate) await this.startDuplicateMark()
      if (tasks.similar) await this.startSimilarFind({ threshold: tasks.similar.threshold })
    })
  }

  /**
   * 注入缩略图批量的渲染层广播回调（THUMBNAIL_OPTIMIZATION_PLAN 节点1）。
   * 由 Application 装配为 `() => sendToRenderer(ctx, 'media:updated')`；
   * 传 null 可解除注入（回到「仅批量结束广播一次」的旧行为）。
   */
  setThumbnailProgressNotifier(fn: (() => void) | null): void {
    this.thumbnailProgressNotifier = fn
  }

  /** 节流通知渲染层刷新：窗口（2s）内的后续进度合并为一次 */
  private notifyThumbnailProgressThrottled(): void {
    if (!this.thumbnailProgressNotifier) return
    const now = Date.now()
    if (now - this.lastThumbnailBroadcastAt < THUMBNAIL_BROADCAST_THROTTLE_MS) return
    this.lastThumbnailBroadcastAt = now
    try {
      this.thumbnailProgressNotifier()
    } catch {
      // 广播失败不影响批处理主流程
    }
  }

  /** 批量结束时立即补发一次并重置节流窗口（覆盖崩溃恢复等无外层广播的路径，尾部数据不丢） */
  private notifyThumbnailBatchSettled(): void {
    this.lastThumbnailBroadcastAt = 0
    if (!this.thumbnailProgressNotifier) return
    try {
      this.thumbnailProgressNotifier()
    } catch {
      // 广播失败不影响批处理主流程
    }
  }

  /** 订阅 worker 事件，转发为 EventEmitter + 推送统一 task:progress */
  private subscribeBridgeEvents(): void {
    this.unsubscribe = this.bridge.onEvent((event) => {
      switch (event.type) {
        case 'THUMBNAIL_PROGRESS':
          this.emit('thumbnail:progress', { ...event.payload })
          this.notifyThumbnailProgressThrottled()
          this.handleProgress(
            this.thumbnailRuntime,
            'batch',
            event.payload.processed,
            event.payload.total,
            `生成缩略图 ${event.payload.currentFile}`
          )
          break
        case 'THUMBNAIL_COMPLETE':
          this.isThumbnailRunning = false
          this.emit('thumbnail:complete', event.payload)
          this.notifyThumbnailBatchSettled()
          this.handleComplete(this.thumbnailRuntime, event.payload.success, event.payload.message)
          if (this.pendingThumbnailComplete) {
            const resolve = this.pendingThumbnailComplete
            this.pendingThumbnailComplete = null
            resolve(event.payload)
          }
          break
        case 'PHASH_PROGRESS':
          this.emit('phash:progress', { ...event.payload })
          this.handleProgress(
            this.phashRuntime,
            'duplicate',
            event.payload.processed,
            event.payload.total,
            `计算 pHash ${event.payload.currentFile}`
          )
          break
        case 'PHASH_COMPLETE':
          this.isPhashRunning = false
          this.emit('phash:complete', event.payload)
          this.handleComplete(this.phashRuntime, event.payload.success, event.payload.message)
          if (this.pendingPhashComplete) {
            const resolve = this.pendingPhashComplete
            this.pendingPhashComplete = null
            resolve(event.payload)
          }
          break
        case 'DUPLICATE_PROGRESS':
          this.emit('duplicate:progress', { ...event.payload })
          // DUPLICATE_PROGRESS 的字段是 compared/totalPairs，与 thumbnail/phash 不同
          this.handleProgress(
            this.duplicateRuntime,
            'duplicate',
            event.payload.compared,
            event.payload.totalPairs,
            t('main.mediaWorker.progress.markingDuplicates')
          )
          break
        case 'DUPLICATE_COMPLETE':
          this.isDuplicateRunning = false
          this.emit('duplicate:complete', event.payload)
          this.handleComplete(this.duplicateRuntime, event.payload.success, event.payload.message)
          if (this.pendingDuplicateComplete) {
            const resolve = this.pendingDuplicateComplete
            this.pendingDuplicateComplete = null
            resolve(event.payload)
          }
          break
        case 'SIMILAR_PROGRESS':
          this.emit('similar:progress', { ...event.payload })
          this.handleProgress(
            this.similarRuntime,
            'duplicate', // 复用现有 TaskType（如需区分 UI 可加 'similar'）
            event.payload.scanned,
            event.payload.total,
            `比较图像相似度 ${event.payload.scanned}/${event.payload.total}`
          )
          break
        case 'SIMILAR_CANDIDATES':
          this.emit('similar:candidates', event.payload)
          if (this.pendingSimilarCandidates)
            this.pendingSimilarCandidates.push(...event.payload.batch)
          break
        case 'SIMILAR_COMPLETE':
          this.isSimilarRunning = false
          this.emit('similar:complete', event.payload)
          if (this.pendingSimilarComplete) {
            const resolve = this.pendingSimilarComplete
            this.pendingSimilarComplete = null
            resolve({
              success: event.payload.success,
              message: event.payload.message,
              cancelled: !!event.payload.cancelled,
              rows: event.payload.rows,
              candidates: this.pendingSimilarCandidates
            })
            this.pendingSimilarCandidates = []
          }
          this.handleComplete(this.similarRuntime, event.payload.success, event.payload.message)
          break
        case 'SIMILAR_ERROR':
          this.emit('similar:error', event.payload)
          // 终态由随后到达的 SIMILAR_COMPLETE 或 bridge 崩溃合成兜底，此处不 resolve
          break
        // MEDIA_WORKER_LOG / WORKER_READY / WORKER_ERROR 由 bridge 直接处理（写日志），无需此处转发
      }
    })
  }

  /**
   * 通用进度处理：补充 ETA + 节流推送 task:progress
   * @param runtime 任务运行时状态
   * @param taskType 任务类型（用于 task:progress.taskType）
   * @param current 已处理数
   * @param total 总数
   * @param message 当前操作描述
   */
  private handleProgress(
    runtime: TaskRuntime,
    taskType: TaskType,
    current: number,
    total: number,
    message: string
  ): void {
    if (!runtime.taskId || runtime.cancelRequested) return
    const safeTotal = total > 0 ? total : Math.max(current, 1)
    const { etaMs, perSec } = runtime.etaCalculator.push(current, safeTotal)
    const taskProgress: TaskProgress = {
      taskId: runtime.taskId,
      taskType,
      phase: 'processing',
      current,
      total: safeTotal,
      percent: Math.min(100, Math.floor((current / safeTotal) * 100)),
      processedPerSec: perSec,
      etaMs,
      message,
      startedAt: runtime.startedAt,
      canCancel: true
    }
    runtime.progressThrottle.push(taskProgress)
  }

  /**
   * 通用完成处理：推送终态进度 + 清理 taskRegistry
   * - 取消时（cancelRequested=true）：终态已由 abort 监听器立即推送，此处仅清理
   * - 正常完成 / 异常：推送 done / error 终态（ProgressThrottle 对终态立即推送）
   */
  private handleComplete(runtime: TaskRuntime, success: boolean, message: string): void {
    if (!runtime.taskId) return
    const taskId = runtime.taskId
    if (!runtime.cancelRequested) {
      runtime.progressThrottle.push({
        taskId,
        taskType: this.taskTypeOfRuntime(runtime),
        phase: success ? 'done' : 'error',
        current: 0,
        total: 0,
        percent: success ? 100 : 0,
        message,
        startedAt: runtime.startedAt,
        canCancel: false
      })
    }
    taskRegistry.unregister(taskId)
    runtime.taskId = null
    runtime.cancelRequested = false
    runtime.progressThrottle.dispose()
    runtime.etaCalculator.reset()
  }

  /** 根据 runtime 实例推断 TaskType（handleComplete 推送终态时使用） */
  private taskTypeOfRuntime(runtime: TaskRuntime): TaskType {
    if (runtime === this.thumbnailRuntime) return 'batch'
    if (runtime === this.phashRuntime) return 'duplicate'
    return 'duplicate'
  }

  /**
   * 启动任务前的统一注册逻辑：
   * - 生成 taskId
   * - 重置 runtime 状态
   * - 注册 taskRegistry + 监听 abort 信号
   * @param stopFn 取消函数（调用 bridge.stopXxxBatch）
   */
  private registerTask(
    runtime: TaskRuntime,
    taskType: TaskType,
    message: string,
    stopFn: () => void
  ): string {
    const taskId = generateTaskId(taskType === 'batch' ? 'thumbnail' : taskType)
    runtime.taskId = taskId
    runtime.startedAt = Date.now()
    runtime.cancelRequested = false
    runtime.etaCalculator.reset()
    runtime.progressThrottle.dispose()

    const controller = taskRegistry.register(taskId)
    controller.signal.addEventListener('abort', () => {
      runtime.cancelRequested = true
      // 立即推送 cancelled 终态
      runtime.progressThrottle.push({
        taskId,
        taskType,
        phase: 'cancelled',
        current: 0,
        total: 0,
        percent: 0,
        message,
        startedAt: runtime.startedAt,
        canCancel: false
      })
      // 转发停止指令到 worker
      stopFn()
    })
    return taskId
  }

  /** 推送事件到主窗口（可选订阅，渲染层不订阅也不影响功能） */
  private broadcastToMainWindow(channel: string, data: unknown): void {
    try {
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, data)
        }
      }
    } catch {
      // 窗口可能已关闭，忽略
    }
  }

  /**
   * 启动缩略图批量生成。
   * 调用方式与原 generateThumbnailsForUnprocessed 一致：返回 Promise 在任务完成时 resolve。
   */
  async startThumbnailBatch(params: {
    cacheDir: string
    thumbnailQuality?: ThumbnailQuality
  }): Promise<{ success: boolean; message: string; processed: number; total: number }> {
    if (this.isThumbnailRunning) {
      return {
        success: false,
        message: t('main.mediaWorker.error.thumbnailAlreadyRunning'),
        processed: 0,
        total: 0
      }
    }
    if (!this.dbPath) {
      return {
        success: false,
        message: t('main.scanner.error.dbPathNotInitialized'),
        processed: 0,
        total: 0
      }
    }

    this.isThumbnailRunning = true
    // 性能重构 v3：注册到 TaskRegistry，支持 task:cancel 取消
    this.registerTask(
      this.thumbnailRuntime,
      'batch',
      t('main.mediaWorker.message.thumbnailCancelled'),
      () => this.bridge.stopThumbnailBatch()
    )

    // 发送任务，等待 THUMBNAIL_COMPLETE
    return new Promise((resolve) => {
      this.pendingThumbnailComplete = resolve
      this.bridge
        .startThumbnailBatch(this.dbPath, params.cacheDir, params.thumbnailQuality ?? 'standard')
        .catch((err) => {
          // worker 启动失败或 postMessage 失败
          if (this.pendingThumbnailComplete) {
            const r = this.pendingThumbnailComplete
            this.pendingThumbnailComplete = null
            this.isThumbnailRunning = false
            r({
              success: false,
              message: t('main.mediaWorker.error.thumbnailStartFailed', {
                reason: err instanceof Error ? err.message : String(err)
              }),
              processed: 0,
              total: 0
            })
          }
          // 清理 taskRegistry（启动失败也要清理，避免泄漏）
          if (this.thumbnailRuntime.taskId) {
            taskRegistry.unregister(this.thumbnailRuntime.taskId)
            this.thumbnailRuntime.taskId = null
            this.thumbnailRuntime.progressThrottle.dispose()
          }
        })
    })
  }

  /**
   * 启动 pHash 批量补算（含链式 markDuplicates）。
   * 返回值结构与原 generatePhashForUnprocessed 一致。
   */
  async startPhashBatch(): Promise<{
    success: boolean
    message: string
    processed: number
    total: number
    duplicatesResult?: { markedDuplicates: number; totalGroups: number }
  }> {
    if (this.isPhashRunning) {
      return {
        success: false,
        message: t('main.mediaWorker.error.phashAlreadyRunning'),
        processed: 0,
        total: 0
      }
    }
    if (!this.dbPath) {
      return {
        success: false,
        message: t('main.scanner.error.dbPathNotInitialized'),
        processed: 0,
        total: 0
      }
    }

    this.isPhashRunning = true
    // 性能重构 v3：注册到 TaskRegistry
    this.registerTask(
      this.phashRuntime,
      'duplicate',
      t('main.mediaWorker.message.phashCancelled'),
      () => this.bridge.stopPhashBatch()
    )

    return new Promise((resolve) => {
      this.pendingPhashComplete = resolve
      this.bridge.startPhashBatch(this.dbPath).catch((err) => {
        if (this.pendingPhashComplete) {
          const r = this.pendingPhashComplete
          this.pendingPhashComplete = null
          this.isPhashRunning = false
          r({
            success: false,
            message: t('main.mediaWorker.error.phashStartFailed', {
              reason: err instanceof Error ? err.message : String(err)
            }),
            processed: 0,
            total: 0
          })
        }
        if (this.phashRuntime.taskId) {
          taskRegistry.unregister(this.phashRuntime.taskId)
          this.phashRuntime.taskId = null
          this.phashRuntime.progressThrottle.dispose()
        }
      })
    })
  }

  /**
   * 启动重复标记（手动触发）。
   * 返回值结构与原 markDuplicates 一致。
   */
  async startDuplicateMark(): Promise<{
    success: boolean
    message: string
    markedDuplicates: number
    totalGroups: number
  }> {
    if (this.isDuplicateRunning) {
      return {
        success: false,
        message: t('main.mediaWorker.error.duplicateAlreadyRunning'),
        markedDuplicates: 0,
        totalGroups: 0
      }
    }
    if (!this.dbPath) {
      return {
        success: false,
        message: t('main.scanner.error.dbPathNotInitialized'),
        markedDuplicates: 0,
        totalGroups: 0
      }
    }

    this.isDuplicateRunning = true
    // 性能重构 v3：注册到 TaskRegistry
    this.registerTask(
      this.duplicateRuntime,
      'duplicate',
      t('main.mediaWorker.message.duplicateCancelled'),
      () => this.bridge.stopDuplicateMark()
    )

    return new Promise((resolve) => {
      this.pendingDuplicateComplete = resolve
      this.bridge.startDuplicateMark(this.dbPath).catch((err) => {
        if (this.pendingDuplicateComplete) {
          const r = this.pendingDuplicateComplete
          this.pendingDuplicateComplete = null
          this.isDuplicateRunning = false
          r({
            success: false,
            message: t('main.mediaWorker.error.duplicateStartFailed', {
              reason: err instanceof Error ? err.message : String(err)
            }),
            markedDuplicates: 0,
            totalGroups: 0
          })
        }
        if (this.duplicateRuntime.taskId) {
          taskRegistry.unregister(this.duplicateRuntime.taskId)
          this.duplicateRuntime.taskId = null
          this.duplicateRuntime.progressThrottle.dispose()
        }
      })
    })
  }

  /**
   * 启动相似检测：派发 SIMILAR_FIND_START 到 worker，
   * 累积 SIMILAR_CANDIDATES 候选边，SIMILAR_COMPLETE 时 resolve 行 + 候选。
   * 复用 TaskRegistry + 进度节流 + task:cancel（取消 → bridge.stopSimilarFind）。
   */
  async startSimilarFind(params: { threshold: number }): Promise<{
    success: boolean
    message: string
    cancelled: boolean
    rows: SimilarRowMeta[]
    candidates: SimilarCandidate[]
  }> {
    if (this.isSimilarRunning) {
      return {
        success: false,
        message: t('main.mediaWorker.error.similarAlreadyRunning'),
        cancelled: false,
        rows: [],
        candidates: []
      }
    }
    if (!this.dbPath) {
      return {
        success: false,
        message: t('main.scanner.error.dbPathNotInitialized'),
        cancelled: false,
        rows: [],
        candidates: []
      }
    }
    this.isSimilarRunning = true
    // 性能重构 v3：注册到 TaskRegistry，支持 task:cancel 取消
    this.registerTask(this.similarRuntime, 'duplicate', t('duplicates.task.similarCancelled'), () =>
      this.bridge.stopSimilarFind()
    )

    return new Promise((resolve) => {
      this.pendingSimilarCandidates = []
      this.pendingSimilarComplete = resolve
      this.bridge.startSimilarFind(this.dbPath, params.threshold).catch((err) => {
        // worker 启动失败或 postMessage 失败
        if (this.pendingSimilarComplete) {
          const r = this.pendingSimilarComplete
          this.pendingSimilarComplete = null
          this.isSimilarRunning = false
          r({
            success: false,
            message: t('main.mediaWorker.error.similarStartFailed', {
              reason: err instanceof Error ? err.message : String(err)
            }),
            cancelled: false,
            rows: [],
            candidates: []
          })
        }
        // 清理 taskRegistry（启动失败也要清理，避免泄漏）
        if (this.similarRuntime.taskId) {
          taskRegistry.unregister(this.similarRuntime.taskId)
          this.similarRuntime.taskId = null
          this.similarRuntime.cancelRequested = false
          this.similarRuntime.progressThrottle.dispose()
        }
      })
    })
  }

  /** 取消相似检测（向后兼容；task:cancel 通道也会触发） */
  stopSimilarFind(): void {
    this.bridge.stopSimilarFind()
  }

  /** 取消缩略图批量生成（保留向后兼容，task:cancel 通道也会触发） */
  stopThumbnailBatch(): void {
    this.bridge.stopThumbnailBatch()
  }

  /**
   * 批量让位开关（fix-thumbnail-skeleton-reveal N2）：
   * 由 Application 装配为 ThumbnailGenerator 按需活动监听——主进程有可视区按需
   * 生成在途时 active=true，worker 批量条目间插入延迟；恢复空闲时置回 false。
   * worker 未启动时 bridge 侧为 no-op，启动批次时由 startThumbnailBatch 补发当前状态。
   */
  setBatchYield(active: boolean): void {
    this.bridge.setBatchYield(active)
  }

  /** 取消 pHash 批量补算（保留向后兼容） */
  stopPhashBatch(): void {
    this.bridge.stopPhashBatch()
  }

  /** 取消重复标记（保留向后兼容） */
  stopDuplicateMark(): void {
    this.bridge.stopDuplicateMark()
  }

  /** 缩略图任务是否运行中 */
  isThumbnailBatchRunning(): boolean {
    return this.isThumbnailRunning
  }

  /** pHash 任务是否运行中 */
  isPhashBatchRunning(): boolean {
    return this.isPhashRunning
  }

  /** 重复标记任务是否运行中 */
  isDuplicateMarkRunning(): boolean {
    return this.isDuplicateRunning
  }

  /**
   * 注入数据库路径。
   * worker 进程通过此路径独立打开 better-sqlite3 连接（与主进程 DatabaseManager 共享同一 db 文件）。
   * 由 Application 在 dbManager.initialize 之后调用。
   */
  setDbPath(dbPath: string): void {
    this.dbPath = dbPath
  }

  /** 主进程退出前清理：清理所有未完成任务的 taskRegistry 注册项 */
  dispose(): void {
    for (const runtime of [
      this.thumbnailRuntime,
      this.phashRuntime,
      this.duplicateRuntime,
      this.similarRuntime
    ]) {
      if (runtime.taskId) {
        taskRegistry.unregister(runtime.taskId)
        runtime.taskId = null
        runtime.cancelRequested = false
      }
      runtime.progressThrottle.dispose()
      runtime.etaCalculator.reset()
    }
    if (this.pendingSimilarComplete) {
      this.pendingSimilarComplete = null
      this.pendingSimilarCandidates = []
    }
  }
}
