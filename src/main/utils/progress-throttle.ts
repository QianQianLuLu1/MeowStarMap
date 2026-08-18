/**
 * 进度节流器（性能重构 v3 改造项三）
 * 文档：docs/PERFORMANCE_REFACTOR_PLAN.md §4.4.2
 *
 * 目标：长任务进度更新频率控制在 4~6 次/秒，防止 IPC 风暴阻塞 UI 线程。
 * - 首次推送立即发送（保证 UI 快速进入处理状态）
 * - 后续推送按 intervalMs 节流，尾部用 setTimeout 保证最后一次进度被发出
 * - 100% / done / cancelled / error 等终态立即发送（绕过节流）
 *
 * 使用 BrowserWindow.getAllWindows 推送到所有可见窗口；
 * 已销毁的窗口通过 isDestroyed() 过滤，避免调用 webContents.send 抛错。
 */
import { BrowserWindow } from 'electron'
import type { TaskProgress } from '../../shared/types/progress'

export class ProgressThrottle {
  /** 上次推送时间戳 */
  private lastEmit = 0
  /** 待发送的进度（节流窗口内缓存最新一次） */
  private pendingProgress: TaskProgress | null = null
  /** 尾部推送定时器 */
  private timer: NodeJS.Timeout | null = null
  /** 节流间隔（毫秒），默认 200ms = 5 FPS */
  private readonly intervalMs: number

  constructor(intervalMs = 200) {
    // 限制最小 100ms（10 FPS）最大 1000ms（1 FPS），避免极端配置
    this.intervalMs = Math.min(1000, Math.max(100, intervalMs))
  }

  /**
   * 推入一条进度。
   * - 终态（done/cancelled/error）立即推送
   * - 非终态按节流间隔推送
   */
  push(p: TaskProgress): void {
    const isTerminal = p.phase === 'done' || p.phase === 'cancelled' || p.phase === 'error'
    if (isTerminal) {
      // 终态：清空待发缓存并立即推送
      this.clearTimer()
      this.pendingProgress = null
      this.emit(p)
      return
    }

    const now = Date.now()
    if (now - this.lastEmit >= this.intervalMs) {
      this.lastEmit = now
      this.pendingProgress = null
      this.emit(p)
    } else {
      // 缓存最新进度，等待节流窗口结束后发送
      this.pendingProgress = p
      if (!this.timer) {
        const delay = this.intervalMs - (now - this.lastEmit)
        this.timer = setTimeout(
          () => {
            const pending = this.pendingProgress
            this.timer = null
            this.pendingProgress = null
            if (pending) {
              this.lastEmit = Date.now()
              this.emit(pending)
            }
          },
          Math.max(0, delay)
        )
      }
    }
  }

  /** 推送进度到所有可见窗口 */
  private emit(p: TaskProgress): void {
    const windows = BrowserWindow.getAllWindows()
    for (const w of windows) {
      if (!w.isDestroyed()) {
        w.webContents.send('task:progress', p)
      }
    }
  }

  /** 清空尾部定时器（dispose / cancel 时调用） */
  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** 重置节流状态（任务结束后调用，清理定时器） */
  dispose(): void {
    this.clearTimer()
    this.pendingProgress = null
    this.lastEmit = 0
  }
}
