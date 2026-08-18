/**
 * 分级任务调度队列
 *
 * 在已有的 scanner worker + media worker 双 utilityProcess 架构之上，提供主进程侧的优先级管控：
 * - 高优先级任务（用户主动触发）：立即执行，可抢占正在运行的低优先级任务
 * - 低优先级任务（后台自动触发）：FIFO 入队，串行执行，等高优先级空闲时 pump
 *
 * 设计原则：
 * - 调度器只负责「何时执行」，不关心任务内部实现
 * - worker 进程消息协议完全不变，暂停通过现有 STOP 消息实现
 * - 抢占后低优先级任务不自动恢复，依赖任务幂等性由下次启动或手动触发补全
 *
 * 不引入新依赖，纯 EventEmitter + Promise 实现。
 */
import { EventEmitter } from 'events'
import { logger } from '../utils/logger'

export type TaskPriority = 'high' | 'low'

export interface LowTaskOptions {
  /** 任务唯一标识（用于日志和去重判断，可选） */
  id?: string
  /**
   * 抢占取消回调：高优先级任务到来时调用，用于向 worker 发送 STOP。
   * 调用后任务应在合理时间内（<2s）通过 run() 的 Promise resolve。
   */
  cancel?: () => void
}

interface LowTask {
  id: string
  // 接受任意返回值的 Promise，调用方无需为丢弃返回值而包装
  run: () => Promise<unknown>
  cancel?: () => void
  cancelToken: { cancelled: boolean }
  /** 任务完成（成功/失败/取消）时 resolve */
  resolve: () => void
}

/** 高优先级任务到来时，等待低优先级任务自行退出的最大时长 */
const PREEMPT_WAIT_MS = 2000

/**
 * TaskScheduler 单例
 *
 * 事件：
 * - 'low-task-start' { id }
 * - 'low-task-complete' { id, success }
 * - 'high-task-start'
 * - 'high-task-complete'
 * - 'preempt' { cancelledIds }
 */
export class TaskScheduler extends EventEmitter {
  /** 低优先级等待队列（FIFO） */
  private lowQueue: LowTask[] = []
  /** 当前正在执行的低优先级任务（受 maxLowConcurrency 限制） */
  private runningLow: Set<LowTask> = new Set()
  /** 当前正在执行的高优先级任务计数 */
  private highRunning = 0
  /** 全局暂停标志（启动期 / 退出清理时置 true） */
  private paused = false
  /** 后台任务最大并发数：保守值 1，避免与高优先级争抢 CPU/IO/DB */
  private readonly maxLowConcurrency = 1

  /**
   * 高优先级任务入口（用户主动触发）。
   *
   * 行为：
   * 1. highRunning++
   * 2. 若 runningLow 非空，调用每个任务的 cancel() 回调，等待最多 PREEMPT_WAIT_MS
   * 3. 执行 fn，返回其 Promise
   * 4. highRunning--，若归零则 pump 队列
   *
   * @param fn 任务主体
   * @returns fn 的返回值（透传）
   */
  async runHighPriority<T>(fn: () => Promise<T>): Promise<T> {
    this.highRunning++
    this.emit('high-task-start')

    // 抢占：若低优先级任务正在运行，调用 cancel 并等待
    if (this.runningLow.size > 0) {
      const cancelledIds = this.preemptRunningLow()
      if (cancelledIds.length > 0) {
        this.emit('preempt', { cancelledIds })
        logger.warn(
          `[Scheduler] 高优先级任务抢占，已取消 ${cancelledIds.length} 个低优先级任务: ${cancelledIds.join(', ')}`
        )
        await this.waitForRunningLowDrain()
      }
    }

    try {
      return await fn()
    } finally {
      this.highRunning--
      this.emit('high-task-complete')
      if (this.highRunning === 0) {
        this.pump()
      }
    }
  }

  /**
   * 低优先级任务入口（后台自动触发）。
   *
   * 行为：
   * 1. 包装为 LowTask 加入队列尾部
   * 2. 若满足条件（未暂停 + 高优先级空闲 + runningLow 未满），立即 pump
   * 3. pump 时检查 cancelToken.cancelled，跳过已取消的任务（resolve）
   *
   * 返回的 Promise 在任务实际执行完成或被取消时 resolve。
   * 调用方不依赖返回值（低优先级场景均为 fire-and-forget），如需结果请用闭包变量传递。
   *
   * @param fn 任务主体（应捕获自身异常，否则会被调度器 catch）
   * @param opts 可选配置（id / cancel 回调）
   */
  enqueueLow(fn: () => Promise<unknown>, opts: LowTaskOptions = {}): Promise<void> {
    return new Promise<void>((resolve) => {
      const task: LowTask = {
        id: opts.id || `low-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        run: fn,
        cancel: opts.cancel,
        cancelToken: { cancelled: false },
        resolve
      }
      this.lowQueue.push(task)
      this.pump()
    })
  }

  /**
   * 暂停调度器（启动期 / 退出清理时调用）。
   * 已在运行的低优先级任务不会被立即取消（需配合 cancelAllLow）。
   */
  pause(): void {
    this.paused = true
  }

  /** 恢复调度器（主窗口 ready-to-show 后调用） */
  resume(): void {
    this.paused = false
    this.pump()
  }

  /** 调度器是否暂停 */
  isPaused(): boolean {
    return this.paused
  }

  /**
   * 取消所有低优先级任务（队列中 + 正在运行）。
   * 退出清理时调用：队列中的标记 cancelled + resolve，正在运行的调用 cancel() 回调。
   * 不等待任务完成，由调用方决定是否等待（performCleanup 已有超时兜底）。
   */
  cancelAllLow(): void {
    // 队列中的任务标记 cancelled + resolve（让 await 的调用方继续）
    while (this.lowQueue.length > 0) {
      const task = this.lowQueue.shift()!
      task.cancelToken.cancelled = true
      try {
        task.resolve()
      } catch {}
    }

    // 正在运行的任务调用 cancel（不等待，由 worker 自行退出并发 COMPLETE）
    for (const task of this.runningLow) {
      try {
        task.cancel?.()
      } catch (err) {
        logger.warn(`[Scheduler] 取消低优先级任务 ${task.id} 失败:`, err)
      }
    }
  }

  /** 当前队列长度（用于诊断日志） */
  getQueueLength(): number {
    return this.lowQueue.length
  }

  /** 当前正在运行的低优先级任务数 */
  getRunningLowCount(): number {
    return this.runningLow.size
  }

  /** 当前正在运行的高优先级任务数 */
  getHighRunningCount(): number {
    return this.highRunning
  }

  // ============ 内部方法 ============

  /**
   * 抢占正在运行的低优先级任务。
   * @returns 被调用 cancel 的任务 id 列表
   */
  private preemptRunningLow(): string[] {
    const cancelledIds: string[] = []
    for (const task of this.runningLow) {
      try {
        task.cancel?.()
        cancelledIds.push(task.id)
      } catch (err) {
        logger.warn(`[Scheduler] 抢占取消任务 ${task.id} 失败:`, err)
      }
    }
    return cancelledIds
  }

  /**
   * 等待 runningLow 清空（最多 PREEMPT_WAIT_MS）。
   * 超时后强制返回，高优先级任务继续执行（WAL 模式下并发安全）。
   */
  private waitForRunningLowDrain(): Promise<void> {
    if (this.runningLow.size === 0) return Promise.resolve()

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.removeListener('low-task-complete', onTaskComplete)
        if (this.runningLow.size > 0) {
          logger.warn(
            `[Scheduler] 等待低优先级任务退出超时（${PREEMPT_WAIT_MS}ms），强制继续，当前剩余 ${this.runningLow.size} 个`
          )
        }
        resolve()
      }, PREEMPT_WAIT_MS)

      const onTaskComplete = () => {
        if (this.runningLow.size === 0) {
          clearTimeout(timeout)
          this.removeListener('low-task-complete', onTaskComplete)
          resolve()
        }
      }
      this.on('low-task-complete', onTaskComplete)
    })
  }

  /**
   * 从队列取出任务执行。
   * 满足以下条件时 pump：
   * - 未暂停
   * - 高优先级空闲（highRunning === 0）
   * - runningLow 未满（< maxLowConcurrency）
   * - 队列非空
   */
  private pump(): void {
    while (
      !this.paused &&
      this.highRunning === 0 &&
      this.runningLow.size < this.maxLowConcurrency &&
      this.lowQueue.length > 0
    ) {
      const task = this.lowQueue.shift()!
      // 跳过已取消的任务（resolve 让 await 的调用方继续）
      if (task.cancelToken.cancelled) {
        try {
          task.resolve()
        } catch {}
        continue
      }
      this.runningLow.add(task)
      this.emit('low-task-start', { id: task.id })
      void this.executeLowTask(task)
    }
  }

  /**
   * 执行单个低优先级任务，完成后从 runningLow 移除并继续 pump。
   * 任何异常都被 catch，避免调度器进入不可用状态。
   */
  private async executeLowTask(task: LowTask): Promise<void> {
    let success = false
    try {
      await task.run()
      success = true
    } catch (err) {
      logger.error(`[Scheduler] 低优先级任务 ${task.id} 执行失败:`, err)
    } finally {
      this.runningLow.delete(task)
      this.emit('low-task-complete', { id: task.id, success })
      try {
        task.resolve()
      } catch {}
      this.pump()
    }
  }
}
