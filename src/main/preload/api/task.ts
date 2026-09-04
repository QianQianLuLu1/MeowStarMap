// 任务命名空间：统一任务进度通道
// - task.onProgress 订阅 task:progress 事件（主进程节流 4~6 FPS 推送）
// - task.cancel 触发 task:cancel IPC，主进程通过 TaskRegistry 触发 AbortController.abort()
// 各长任务（扫描/重复检测/批量编辑/水印/导入）共用此通道，taskType 字段区分
import { call, subscribe } from '../ipc'
import type { TaskCancelResult } from '../../../shared/types/electron-api'
// 性能重构 v3 改造项三：统一任务进度类型（shared 契约为 preload 内联副本的超集，可选 stages 字段）
import type { TaskProgress } from '../../../shared/types/progress'

/** electronAPI.task：性能重构 v3 改造项三——统一任务进度通道 */
export const taskAPI = {
  cancel: (taskId: string) => call<TaskCancelResult>('task:cancel', taskId),
  onProgress: (callback: (progress: TaskProgress) => void) => subscribe('task:progress', callback),
  // 挂载即拉快照：渲染进程 ScanProgress 挂载时调用，补偿订阅前丢失的进度事件（等效重放）
  getActive: () => call<TaskProgress | null>('task:getActive')
}
