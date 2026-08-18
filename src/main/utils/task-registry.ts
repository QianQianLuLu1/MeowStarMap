/**
 * 任务注册表（性能重构 v3 改造项三）
 * 文档：docs/PERFORMANCE_REFACTOR_PLAN.md §4.4.3
 *
 * 目标：统一管理可取消任务，提供 AbortController 给任务执行器轮询。
 * - register(taskId) 注册新任务并返回 AbortController
 * - cancel(taskId) 触发 AbortController.abort()
 * - unregister(taskId) 任务结束后清理（避免 Map 无限增长）
 *
 * 任务执行器应在循环中检查 controller.signal.aborted，
 * 触发时主动清理已处理结果并推送 task:cancelled 事件。
 *
 * 注意：仅持有 AbortController 引用，不持有任务闭包（避免内存泄漏）。
 */
export class TaskRegistry {
  /** taskId → AbortController 映射 */
  private tasks = new Map<string, AbortController>()

  /**
   * 注册新任务，返回 AbortController 供任务执行器使用。
   * 若 taskId 已存在（极端情况），先 abort 旧任务再注册新任务。
   */
  register(taskId: string): AbortController {
    // 已存在的任务先 abort（避免 abort 信号永远无法触发）
    const existing = this.tasks.get(taskId)
    if (existing && !existing.signal.aborted) {
      existing.abort()
    }
    const controller = new AbortController()
    this.tasks.set(taskId, controller)
    return controller
  }

  /**
   * 取消任务。
   * @returns true 已触发取消；false 任务不存在或已结束
   */
  cancel(taskId: string): boolean {
    const controller = this.tasks.get(taskId)
    if (!controller || controller.signal.aborted) {
      return false
    }
    controller.abort()
    return true
  }

  /**
   * 查询任务是否已取消（执行器循环中检查）。
   * 任务不存在时返回 false（视为不可取消，继续执行）
   */
  isCancelled(taskId: string): boolean {
    const controller = this.tasks.get(taskId)
    return !!controller && controller.signal.aborted
  }

  /**
   * 任务结束后清理注册项。
   * - done / cancelled / error 都应调用
   * - 避免 Map 无限增长
   */
  unregister(taskId: string): void {
    this.tasks.delete(taskId)
  }

  /** 获取当前活动任务数（用于诊断 / UI 提示） */
  size(): number {
    return this.tasks.size
  }

  /** 取消所有活动任务（应用退出时调用） */
  cancelAll(): void {
    for (const controller of this.tasks.values()) {
      if (!controller.signal.aborted) {
        controller.abort()
      }
    }
    this.tasks.clear()
  }
}

/**
 * 单例任务注册表。
 * 主进程所有长任务通过此实例注册与取消。
 */
export const taskRegistry = new TaskRegistry()
