/**
 * 统一 IPC 返回结构
 * 所有主进程 IPC 处理器均应返回 IpcResult<T>，消除此前 success/data、直接返回值、抛出异常等混用风格。
 */
export interface IpcResult<T = unknown> {
  success: boolean
  data?: T
  message?: string
}

export interface IpcProgress {
  current: number
  total: number
}
