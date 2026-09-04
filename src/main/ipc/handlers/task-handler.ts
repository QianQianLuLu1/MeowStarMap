import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs } from '../validator'
import { logger } from '../../utils/logger'
// 性能重构 v3 改造项三：统一任务取消通道
import { taskRegistry } from '../../utils/task-registry'
// 活动任务快照：task:getActive 拉取挂载前丢失的进度事件（扫描 + 索引）
import { getActiveTask } from '../../utils/active-task-store'
import { t } from '../../i18n'

/**
 * task 域 IPC handler：统一任务取消通道。
 */
export function registerTaskHandlers(ctx: HandlerContext): void {
  // ---- task 域（性能重构 v3 改造项三）----
  // 统一任务取消通道：渲染进程通过 electronAPI.task.cancel(taskId) 触发
  // 主进程调用 taskRegistry.cancel(taskId) 触发 AbortController.abort()
  // 各长任务 wrapper 监听 abort 信号，自行清理并推送 task:cancelled 终态进度
  // 兼容性：scanner:stop 通道保留，task:cancel 是更高层级的统一入口
  ipcMain.handle(
    'task:cancel',
    wrapHandler(
      ctx,
      z.tuple([
        z
          .string()
          .min(1, t('main.task.validation.taskIdRequired'))
          .max(128, t('main.task.validation.taskIdMaxLength'))
      ]),
      async ([taskId]) => {
        const cancelled = taskRegistry.cancel(taskId)
        if (!cancelled) {
          // 任务不存在或已结束：返回 cancelled=false，渲染进程可据此更新 UI
          logger.warn(`[task:cancel] 任务不存在或已结束: ${taskId}`)
        }
        return { cancelled, taskId }
      }
    )
  )

  // 挂载即拉快照：返回当前活动任务（scan 优先，其次 indexing），无则 null。
  // 渲染进程 ScanProgress 挂载时调用一次，补偿订阅前已丢失的进度事件（等效重放）。
  ipcMain.handle(
    'task:getActive',
    wrapHandlerNoArgs(ctx, async () => getActiveTask())
  )
}
