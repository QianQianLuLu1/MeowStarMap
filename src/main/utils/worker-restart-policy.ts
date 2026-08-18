/**
 * utilityProcess 自动重启策略（共享工具）
 *
 * 职责：
 * 1. 维护滑动窗口内的重启时间戳，判断是否允许再次重启
 * 2. 不直接调用 fork——具体重启动作由各 bridge 通过回调执行
 * 3. 提供重启计数与冷却期，避免崩溃循环导致 CPU 飙升
 *
 * 设计要点：
 * - 滑动窗口：保留最近 RESTART_WINDOW_MS 内的重启时间戳，超出窗口的自动清理
 * - 上限：窗口内重启次数超过 MAX_RESTART_COUNT 则不再重启，转为永久失败
 * - 冷却：每次重启间隔 RESTART_DELAY_MS，给 OS 释放资源的时间
 */
import { logger } from './logger'

/** 重启事件信息（传递给监听器） */
export interface WorkerCrashInfo {
  workerName: string
  exitCode: number
  restartAttempted: boolean
  restartScheduled: boolean
  /** 当前窗口内已重启次数（含本次） */
  restartCount: number
  /** 是否已超过重启上限，不再尝试 */
  restartExhausted: boolean
  /** 崩溃时间戳（ISO） */
  crashedAt: string
  /**
   * 故障阶段。缺省为 'crash'（worker 运行中异常退出）。
   * 'startup-timeout'：worker fork 后未在限定时间内回 WORKER_READY，握手已被 reject。
   */
  stage?: 'crash' | 'startup-timeout'
}

/** 重启策略配置 */
export interface RestartPolicyOptions {
  workerName: string
  maxRestartCount?: number
  restartWindowMs?: number
  restartDelayMs?: number
}

const DEFAULT_MAX_RESTART_COUNT = 3
const DEFAULT_RESTART_WINDOW_MS = 10 * 60 * 1000 // 10 分钟
const DEFAULT_RESTART_DELAY_MS = 2000

export class WorkerRestartPolicy {
  readonly workerName: string
  readonly maxRestartCount: number
  readonly restartWindowMs: number
  readonly restartDelayMs: number

  private restartTimestamps: number[] = []
  private restartTimer: NodeJS.Timeout | null = null
  private isDisposed = false

  constructor(options: RestartPolicyOptions) {
    this.workerName = options.workerName
    this.maxRestartCount = options.maxRestartCount ?? DEFAULT_MAX_RESTART_COUNT
    this.restartWindowMs = options.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS
    this.restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS
  }

  /** 标记为已 dispose，阻止后续重启调度 */
  dispose(): void {
    this.isDisposed = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  /**
   * 判断是否允许重启，并返回当前状态。
   * 不修改内部状态——调用方在真正决定重启时调用 recordRestart()。
   */
  canRestart(): { allowed: boolean; currentCount: number; exhausted: boolean } {
    const now = Date.now()
    this.pruneOldTimestamps(now)
    const currentCount = this.restartTimestamps.length
    const exhausted = currentCount >= this.maxRestartCount
    return {
      allowed: !this.isDisposed && !exhausted,
      currentCount,
      exhausted
    }
  }

  /**
   * 调度一次延迟重启。
   * @param performRestart 实际重启回调（由 bridge 提供，重新 fork worker + 恢复任务）
   * @returns 是否已调度（false=已 dispose 或超出上限）
   */
  scheduleRestart(performRestart: () => void): boolean {
    if (this.isDisposed) return false
    const status = this.canRestart()
    if (!status.allowed) {
      logger.error(
        `[${this.workerName}] 重启次数已达上限（${this.maxRestartCount}/${this.restartWindowMs}ms），不再自动重启`
      )
      return false
    }

    // 记录重启时间戳（在调度时即记录，避免冷却期内被多次触发）
    this.restartTimestamps.push(Date.now())

    logger.info(
      `[${this.workerName}] 将在 ${this.restartDelayMs}ms 后自动重启（第 ${this.restartTimestamps.length}/${this.maxRestartCount} 次）`
    )

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.isDisposed) return
      try {
        performRestart()
      } catch (err) {
        logger.error(`[${this.workerName}] 重启回调执行失败:`, err)
      }
    }, this.restartDelayMs)

    return true
  }

  /** 清理超出窗口的重启时间戳 */
  private pruneOldTimestamps(now: number): void {
    const threshold = now - this.restartWindowMs
    this.restartTimestamps = this.restartTimestamps.filter((ts) => ts >= threshold)
  }

  /** 获取当前窗口内已重启次数（不含正在调度的） */
  getRestartCount(): number {
    this.pruneOldTimestamps(Date.now())
    return this.restartTimestamps.length
  }
}
