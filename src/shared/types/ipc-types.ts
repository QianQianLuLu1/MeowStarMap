/**
 * IPC 统一类型定义（主进程 / 渲染进程 / preload 共享）
 *
 * 设计目标：
 * - 全局统一响应结构 IpcResponse<T>，消除此前 success/data/直接返回值/抛异常混用风格
 * - 统一错误结构 IpcError，携带错误码便于渲染进程程序化处理
 * - 错误码常量集中在 IPC_ERROR_CODES，避免硬编码字符串
 *
 * 使用约定：
 * - 主进程 wrapHandler 自动将 handler 返回值 T 包装为 { success: true, data: T }
 * - handler 抛出 AppError 时包装为 { success: false, error: IpcError }
 * - 渲染进程通过 preload 暴露的 API 获取 IpcResponse<T>，自行检查 success 字段
 */

/**
 * 统一错误结构
 *
 * 字段说明：
 * - code：错误码，见 IPC_ERROR_CODES / ERROR_CODES，渲染进程据此程序化处理
 * - message：技术错误消息（开发者排查用，可能含技术细节）
 * - userMessage：用户可读的提示文本（UI 展示用，可选）；渲染层应优先使用此字段
 * - details：调试详情（不包含敏感信息）
 */
export interface IpcError {
  /** 错误码，见 IPC_ERROR_CODES */
  code: string
  /** 用户可读的错误消息 */
  message: string
  /** 用户可读的提示文本（UI 展示用，可选）；渲染层应优先使用此字段 */
  userMessage?: string
  /** 可选的调试详情（不包含敏感信息） */
  details?: unknown
}

/**
 * 统一响应结构
 *
 * 成功：{ success: true, data: T }
 * 失败：{ success: false, error: IpcError }
 */
export type IpcResponse<T = unknown> =
  { success: true; data: T } | { success: false; error: IpcError }

/**
 * 进度通知载荷
 */
export interface IpcProgress {
  current: number
  total: number
}

/**
 * IPC 错误码常量
 *
 * 命名规则：IPC_<类别>_<具体错误>
 * 渲染进程通过 code 字段程序化区分错误类型，而非解析 message 字符串
 */
export const IPC_ERROR_CODES = {
  /** 参数校验失败（zod schema 不匹配） */
  VALIDATION_ERROR: 'IPC_VALIDATION_ERROR',
  /** 路径被白名单/黑名单拦截 */
  PATH_FORBIDDEN: 'IPC_PATH_FORBIDDEN',
  /** 资源不存在 */
  NOT_FOUND: 'IPC_NOT_FOUND',
  /** 权限不足或未授权操作 */
  UNAUTHORIZED: 'IPC_UNAUTHORIZED',
  /** 资源冲突（如 UID 已存在） */
  CONFLICT: 'IPC_CONFLICT',
  /** 用户主动取消（如对话框取消、二次确认拒绝） */
  CANCELED: 'IPC_CANCELED',
  /** 前置条件不满足（如数据库未初始化） */
  PRECONDITION_FAILED: 'IPC_PRECONDITION_FAILED',
  /** 未捕获的内部错误 */
  INTERNAL_ERROR: 'IPC_INTERNAL_ERROR'
} as const

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[keyof typeof IPC_ERROR_CODES]

/**
 * 兼容旧 IpcResult 类型（src/main/types/ipc.ts 已迁移至本文件）
 *
 * 历史代码中部分 handler 仍可能返回 { success, message?, ...data } 形式，
 * 此类型保留用于过渡期类型兼容，新代码应使用 IpcResponse<T>。
 * @deprecated 请使用 IpcResponse<T>
 */
export interface LegacyIpcResult<T = unknown> {
  success: boolean
  data?: T
  message?: string
}
