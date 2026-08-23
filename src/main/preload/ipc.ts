/**
 * preload IPC 基础层：统一调用入口 / 响应解包 / 事件订阅 / 错误类
 *
 * 本模块是 preload 拆分后全部命名空间模块（./api/*）的公共依赖，
 * 必须保持零顶层副作用、仅依赖 electron（见 preload-logger.ts 的设计约束：
 * preload 顶层求值失败会导致 window.electronAPI 暴露失败 → 渲染进程白屏）。
 */
import { ipcRenderer } from 'electron'
import type { IpcResponse } from '../../shared/types/ipc-types'

// ============ IPC 响应解包层 ============
// 主进程所有 handler 经 wrapHandler 包装后返回 IpcResponse<T>：
//   { success: true, data: T } | { success: false, error: { code, message, details? } }
// preload 在此统一解包：成功返回 T，失败抛出 IpcError（携带 code/message/details）。
// 渲染层调用方式保持不变：const data = await electronAPI.file.delete(paths)
// 错误处理：try { ... } catch (err) { if (err instanceof IpcError) { err.code ... } }

/**
 * 渲染进程可见的 IPC 错误类
 * 主进程 AppError 通过 IPC 序列化为 { code, message, userMessage?, details? } 后，由 preload 还原为 IpcError 抛出
 */
export class IpcError extends Error {
  readonly code: string
  readonly userMessage?: string
  readonly details?: unknown

  constructor(code: string, message: string, details?: unknown, userMessage?: string) {
    super(message)
    this.name = 'IpcError'
    this.code = code
    this.userMessage = userMessage
    this.details = details
    Object.setPrototypeOf(this, IpcError.prototype)
  }
}

/**
 * 统一 IPC 调用入口：invoke + 解包 IpcResponse
 * 成功返回业务数据 T，失败抛出 IpcError
 */
export async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as IpcResponse<T>
  if (res && res.success) {
    return res.data
  }
  if (res && !res.success && res.error) {
    throw new IpcError(res.error.code, res.error.message, res.error.details, res.error.userMessage)
  }
  // 兜底：返回值结构不符合 IpcResponse 契约
  throw new IpcError('IPC_MALFORMED_RESPONSE', `IPC 响应格式异常: ${channel}`, res)
}

/**
 * 事件订阅助手：订阅主进程推送事件，返回退订函数
 *
 * 与各命名空间原先手写的 `ipcRenderer.on + removeListener 闭包` 模式语义一致：
 * listener 剥离首个 IpcRendererEvent 参数，回调直接收到业务载荷。
 */
export function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}
