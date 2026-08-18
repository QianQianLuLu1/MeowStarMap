/**
 * 视频编辑 worker 进程桥接层（主进程侧）
 *
 * 职责：
 * 1. 通过 utilityProcess.fork() 管理 worker 进程生命周期（惰性启动 + 退出时清理）
 * 2. 转发主进程指令到 worker（EDIT_START / EDIT_STOP / EDITOR_DISPOSE）
 * 3. 接收 worker 推送的事件（EDIT_PROGRESS / EDIT_COMPLETE / WORKER_READY / WORKER_ERROR）
 *    并转发到统一 task:progress 通道
 * 4. 通过 TaskRegistry 支持取消（task:cancel → EDITOR_STOP → worker 停止当前任务）
 * 5. 批量调度：runWithConcurrency 控制并发，单任务失败不中断批量
 *
 * 通信链路：
 *   主进程 → worker：worker.postMessage(VideoEditorCommand)
 *   worker → 主进程：worker.on('message', (event: VideoEditorEvent) => ...)
 *
 * 详见 docs/VIDEO_EDIT_PLAN.md §10。
 */
import { utilityProcess, type UtilityProcess } from 'electron'
import path from 'path'
import { logger } from '../utils/logger'
import { ProgressThrottle } from '../utils/progress-throttle'
import { EtaCalculator } from '../utils/eta-calculator'
import { taskRegistry } from '../utils/task-registry'
import { runWithConcurrency } from '../utils/concurrency'
import type { TaskProgress, TaskType } from '../../shared/types/progress'
import type { VideoEditorCommand, VideoEditorEvent } from './worker-protocol'
import type { VideoEditTask } from './types'

/** WORKER_READY 握手超时：worker 启动不应超过 15s，超时即判启动失败 */
const READY_TIMEOUT_MS = 15_000

/** 视频编辑最大并发数（CPU 密集型，过高会导致单任务时长线性增加） */
const MAX_VIDEO_EDIT_CONCURRENCY = 2

/** 单视频编辑任务的 taskType（与 progress.ts 已有类型对齐） */
const SINGLE_TASK_TYPE: TaskType = 'watermark'
/** 批量任务的 taskType */
const BATCH_TASK_TYPE: TaskType = 'batch'

interface PendingResolver {
  resolve: (outputPath: string) => void
  reject: (err: Error) => void
}

export class VideoEditorBridge {
  private worker: UtilityProcess | null = null
  /** worker 启动握手：等待 WORKER_READY 信号 */
  private readyPromise: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((err: Error) => void) | null = null
  /** 当前任务 ID（用于 task:progress 推送与取消） */
  private currentTaskId: string | null = null
  /** 当前任务类型（单视频 / 批量） */
  private currentTaskType: TaskType = SINGLE_TASK_TYPE
  /** 任务开始时间戳 */
  private startedAt = 0
  /** 进度节流器（复用现有实现，200ms 节流） */
  private progressThrottle = new ProgressThrottle(200)
  /** ETA 估算器 */
  private etaCalculator = new EtaCalculator(10)
  /** 用户已请求取消：abort 监听器置 true，避免终态二次推送 */
  private cancelRequested = false
  /** 批量任务总数（用于 ETA 计算） */
  private batchTotal = 1
  /** 待解决的 Promise（按任务 index 索引，worker 串行处理） */
  private pendingResolvers = new Map<number, PendingResolver>()
  /**
   * FIX(组16-1): 编辑互斥标志。editSingle 与 editBatch 共享实例状态
   * （currentTaskId/currentTaskType/progressThrottle/pendingResolvers），
   * 且 editSingle 恒用 pendingResolvers[0]——并发调用时后者覆盖前者的
   * currentTaskId 与 resolver，先到调用方的 Promise 永不 settle（渲染端 await 挂起），
   * EDIT_COMPLETE 按索引解析到错误的调用方（输出路径错配）。video.ts handler 无互斥
   * 防重入，故在 bridge 层以同步标志拒绝并发。
   */
  private isEditing = false

  /**
   * 终结等待中的 WORKER_READY 握手：一律 reject，绝不只置 null。
   *
   * 所有提前终止路径（worker 退出 / 握手超时 / dispose）都必须走这里，
   * 否则 ensureWorker 里的 `await this.readyPromise` 会永久挂起。
   * 与 media-worker / scanner-worker / thumbnail 三处 bridge 保持一致的 reject 语义。
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
   * 惰性启动 worker。
   * 若 worker 已存在，直接复用（dispose 时会置 null）。
   */
  private async ensureWorker(): Promise<void> {
    if (this.worker) return

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })

    // worker-entry 现由 electron-vite 单独打包为 video-worker.js，与 main bundle 同处 dist/main/main/app/
    this.worker = utilityProcess.fork(path.join(__dirname, 'video-worker.js'), [], {
      serviceName: 'video-editor-worker',
      stdio: 'pipe'
    })

    this.worker.on('message', (msg: VideoEditorEvent) => {
      this.handleWorkerMessage(msg)
    })

    this.worker.on('exit', (code) => {
      this.handleWorkerExit(code)
    })

    // 超时保护：15s 内未收到 WORKER_READY 则判启动失败，避免调用方无限等待
    const readyTimeout = setTimeout(() => {
      if (!this.readyReject) return
      logger.error('[VideoEditorWorker] 启动超时（15s 未收到 WORKER_READY），判为启动失败')
      void logger.fault('workerCrash', new Error('video-editor-worker 启动超时'), {
        workerName: 'video-editor-worker',
        stage: 'ready-timeout'
      })
      this.failReadyHandshake('后台进程启动失败（video-editor-worker 未在限定时间内就绪）')
      try {
        this.worker?.kill()
      } catch {}
      this.worker = null
    }, READY_TIMEOUT_MS)

    try {
      await this.readyPromise
    } finally {
      clearTimeout(readyTimeout)
    }
  }

  /** worker 消息分发 */
  private handleWorkerMessage(msg: VideoEditorEvent): void {
    switch (msg.type) {
      case 'WORKER_READY':
        if (this.readyResolve) {
          this.readyResolve()
          this.readyResolve = null
        }
        break

      case 'EDITOR_LOG': {
        const logMsg = `[VideoEditorWorker] ${msg.payload.message}`
        if (msg.payload.level === 'error') {
          logger.error(logMsg)
        } else {
          logger.warn(logMsg)
        }
        break
      }

      case 'EDIT_PROGRESS': {
        this.handleProgress(msg.payload)
        break
      }

      case 'EDIT_COMPLETE': {
        this.handleComplete(msg.payload)
        break
      }

      case 'WORKER_ERROR':
        logger.error(`[VideoEditorWorker] 异常: ${msg.payload.message}`, msg.payload.stack ?? '')
        break
    }
  }

  /** 处理进度事件：补充 ETA + 节流推送 task:progress */
  private handleProgress(payload: {
    current: number
    total: number
    percent: number
    message: string
  }): void {
    if (!this.currentTaskId || this.cancelRequested) return

    const total = payload.total || this.batchTotal
    const { etaMs, perSec } = this.etaCalculator.push(payload.current, total)
    const taskProgress: TaskProgress = {
      taskId: this.currentTaskId,
      taskType: this.currentTaskType,
      phase: 'processing',
      current: payload.current,
      total,
      percent: Math.min(100, Math.floor(payload.percent)),
      processedPerSec: perSec,
      etaMs,
      message: payload.message,
      startedAt: this.startedAt,
      canCancel: true
    }
    this.progressThrottle.push(taskProgress)
  }

  /** 处理单任务完成事件：resolve pending promise + 推送终态进度（批量场景） */
  private handleComplete(payload: {
    success: boolean
    message: string
    index: number
    outputPath?: string
  }): void {
    // resolve 对应的 pending promise
    const resolver = this.pendingResolvers.get(payload.index)
    if (resolver) {
      this.pendingResolvers.delete(payload.index)
      if (payload.success) {
        resolver.resolve(payload.outputPath || '')
      } else {
        resolver.reject(new Error(payload.message))
      }
    }
  }

  /** worker 退出处理：合成失败结果，避免主进程卡在等待状态 */
  private handleWorkerExit(code: number): void {
    if (code !== 0) {
      logger.error(`[VideoEditorWorker] 异常退出，exit code=${code}`)
    }
    // reject 所有 pending promise，避免主进程卡死
    const errorMsg = '视频编辑进程异常退出'
    for (const [, resolver] of this.pendingResolvers) {
      resolver.reject(new Error(errorMsg))
    }
    this.pendingResolvers.clear()

    // 推送 error 终态
    if (this.currentTaskId) {
      this.progressThrottle.push({
        taskId: this.currentTaskId,
        taskType: this.currentTaskType,
        phase: 'error',
        current: 0,
        total: 0,
        percent: 0,
        message: errorMsg,
        startedAt: this.startedAt,
        canCancel: false
      })
      taskRegistry.unregister(this.currentTaskId)
      this.currentTaskId = null
      this.cancelRequested = false
      this.progressThrottle.dispose()
      this.etaCalculator.reset()
    }
    this.worker = null
    // worker 在就绪前退出：reject 而非空置，避免 await ensureWorker 永久挂起
    this.failReadyHandshake('worker exited before ready')
  }

  /**
   * 单视频编辑。
   * @returns 输出文件路径
   */
  async editSingle(task: VideoEditTask): Promise<string> {
    // FIX(组16-1): 同步互斥守卫（在 await 之前置位，JS 单线程保证原子）——
    // 与 editBatch 并发会互相覆盖共享状态，详见 isEditing 字段注释
    if (this.isEditing) {
      throw new Error('已有视频编辑任务正在进行，请等待完成后再试')
    }
    this.isEditing = true
    try {
      return await this.editSingleInner(task)
    } finally {
      this.isEditing = false
    }
  }

  private async editSingleInner(task: VideoEditTask): Promise<string> {
    await this.ensureWorker()

    const taskId = `video-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.currentTaskId = taskId
    this.currentTaskType = SINGLE_TASK_TYPE
    this.startedAt = Date.now()
    this.batchTotal = 1
    this.cancelRequested = false
    this.etaCalculator.reset()
    this.progressThrottle.dispose()

    const controller = taskRegistry.register(taskId)
    controller.signal.addEventListener('abort', () => {
      this.cancelRequested = true
      this.progressThrottle.push({
        taskId,
        taskType: SINGLE_TASK_TYPE,
        phase: 'cancelled',
        current: 0,
        total: 0,
        percent: 0,
        message: '视频编辑已取消',
        startedAt: this.startedAt,
        canCancel: false
      })
      this.worker?.postMessage({ type: 'EDIT_STOP' })
    })

    // 单视频编辑：index=0, total=1
    const promise = new Promise<string>((resolve, reject) => {
      this.pendingResolvers.set(0, { resolve, reject })
    })

    const cmd: VideoEditorCommand = {
      type: 'EDIT_START',
      payload: { task, taskId, index: 0, total: 1 }
    }
    this.worker!.postMessage(cmd)

    try {
      const outputPath = await promise
      // 推送终态进度
      this.progressThrottle.push({
        taskId,
        taskType: SINGLE_TASK_TYPE,
        phase: 'done',
        current: 1,
        total: 1,
        percent: 100,
        message: '视频导出成功',
        startedAt: this.startedAt,
        canCancel: false
      })
      return outputPath
    } catch (err) {
      // 失败时推送 error 终态（除非是用户取消）
      if (!this.cancelRequested) {
        this.progressThrottle.push({
          taskId,
          taskType: SINGLE_TASK_TYPE,
          phase: 'error',
          current: 0,
          total: 1,
          percent: 0,
          message: err instanceof Error ? err.message : String(err),
          startedAt: this.startedAt,
          canCancel: false
        })
      }
      throw err
    } finally {
      taskRegistry.unregister(taskId)
      this.currentTaskId = null
      this.cancelRequested = false
      this.progressThrottle.dispose()
      this.etaCalculator.reset()
      this.pendingResolvers.clear()
    }
  }

  /**
   * 批量视频编辑。
   * @returns 失败任务的序号列表
   */
  async editBatch(
    tasks: VideoEditTask[],
    concurrency: number = 2
  ): Promise<{ failedIndexes: number[] }> {
    if (tasks.length === 0) {
      return { failedIndexes: [] }
    }

    // FIX(组16-1): 同步互斥守卫——与 editSingle 并发会互相覆盖共享状态，详见 isEditing 字段注释
    if (this.isEditing) {
      throw new Error('已有视频编辑任务正在进行，请等待完成后再试')
    }
    this.isEditing = true
    try {
      return await this.editBatchInner(tasks, concurrency)
    } finally {
      this.isEditing = false
    }
  }

  private async editBatchInner(
    tasks: VideoEditTask[],
    concurrency: number
  ): Promise<{ failedIndexes: number[] }> {
    await this.ensureWorker()

    const taskId = `video-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.currentTaskId = taskId
    this.currentTaskType = BATCH_TASK_TYPE
    this.startedAt = Date.now()
    this.batchTotal = tasks.length
    this.cancelRequested = false
    this.etaCalculator.reset()
    this.progressThrottle.dispose()

    const controller = taskRegistry.register(taskId)
    controller.signal.addEventListener('abort', () => {
      this.cancelRequested = true
      this.progressThrottle.push({
        taskId,
        taskType: BATCH_TASK_TYPE,
        phase: 'cancelled',
        current: 0,
        total: tasks.length,
        percent: 0,
        message: '批量编辑已取消',
        startedAt: this.startedAt,
        canCancel: false
      })
      this.worker?.postMessage({ type: 'EDIT_STOP' })
    })

    const failedIndexes: number[] = []
    const effectiveConcurrency = Math.min(Math.max(1, concurrency), MAX_VIDEO_EDIT_CONCURRENCY)

    try {
      await runWithConcurrency(
        tasks.map((task, index) => async () => {
          if (taskRegistry.isCancelled(taskId)) return

          // 为每个任务注册 pending resolver
          const promise = new Promise<string>((resolve, reject) => {
            this.pendingResolvers.set(index, { resolve, reject })
          })

          const cmd: VideoEditorCommand = {
            type: 'EDIT_START',
            payload: { task, taskId, index, total: tasks.length }
          }
          this.worker!.postMessage(cmd)

          try {
            await promise
          } catch (err) {
            if (!taskRegistry.isCancelled(taskId)) {
              failedIndexes.push(index)
              logger.warn(
                `[VideoEditorBridge] 任务 #${index} 失败: ${err instanceof Error ? err.message : String(err)}`
              )
            }
          } finally {
            this.pendingResolvers.delete(index)
          }
        }),
        effectiveConcurrency
      )

      // 推送终态进度
      const phase: TaskProgress['phase'] = this.cancelRequested
        ? 'cancelled'
        : failedIndexes.length > 0
          ? 'done'
          : 'done'
      const message =
        failedIndexes.length === 0
          ? `批量导出完成（共 ${tasks.length} 个）`
          : `批量导出完成（成功 ${tasks.length - failedIndexes.length} 个，失败 ${failedIndexes.length} 个）`
      this.progressThrottle.push({
        taskId,
        taskType: BATCH_TASK_TYPE,
        phase,
        current: tasks.length - failedIndexes.length,
        total: tasks.length,
        percent: 100,
        message,
        startedAt: this.startedAt,
        canCancel: false
      })

      return { failedIndexes }
    } finally {
      taskRegistry.unregister(taskId)
      this.currentTaskId = null
      this.cancelRequested = false
      this.progressThrottle.dispose()
      this.etaCalculator.reset()
      this.pendingResolvers.clear()
    }
  }

  /**
   * 主进程退出前调用：发送 EDITOR_DISPOSE → 等待 500ms → 强制 kill。
   * worker 收到 DISPOSE 后会主动 kill 子进程 + 退出。
   */
  async dispose(): Promise<void> {
    // dispose 期间若仍有调用方在等待握手，必须 reject（早于 return，覆盖 worker 已为 null 的情况）：
    // 此时 worker 即将被 kill，exit 回调与超时定时器都不会再兜底 reject
    this.failReadyHandshake('video-editor-worker 已释放（dispose）')
    if (!this.worker) return
    try {
      const cmd: VideoEditorCommand = { type: 'EDITOR_DISPOSE' }
      this.worker.postMessage(cmd)
      // 给 worker 500ms 时间清理（kill 子进程）
      await new Promise((resolve) => setTimeout(resolve, 500))
    } catch {
      // postMessage 失败忽略，后续 kill 兜底
    }
    try {
      this.worker.kill()
    } catch {}
    this.worker = null
    // 清理 taskRegistry + 进度节流
    if (this.currentTaskId) {
      taskRegistry.unregister(this.currentTaskId)
      this.currentTaskId = null
      this.cancelRequested = false
    }
    // reject 所有 pending promise，避免主进程卡死
    for (const [, resolver] of this.pendingResolvers) {
      resolver.reject(new Error('应用退出'))
    }
    this.pendingResolvers.clear()
    this.progressThrottle.dispose()
    this.etaCalculator.reset()
  }
}
