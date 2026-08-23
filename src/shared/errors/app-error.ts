/**
 * 全局应用错误基类与分类错误子类
 *
 * 设计目标：
 * - 统一主进程/渲染进程的错误载体，替代 Error + 字符串消息的混用模式
 * - 携带 code 字段便于程序化处理（与 IpcError.code 对齐）
 * - 携带 userMessage 字段提供用户可读的提示文本（可选，避免技术细节暴露给最终用户）
 * - 携带 cause 字段保留原始错误链（用于日志排查，不跨 IPC 传输）
 * - 提供静态工厂方法快速创建常见错误类型
 * - 提供 6 个分类子类（ValidationError/NotFoundError/PermissionError/DatabaseError/FileSystemError/InternalError）
 *   便于 catch 块按类型分支处理
 * - 实现 toJSON() 便于跨 IPC 序列化
 *
 * 使用约定：
 * - 主进程 handler 抛出 AppError 时，wrapHandler 自动捕获并转为 IpcError
 * - 渲染进程可通过 throw new AppError(...) 上报业务错误
 * - 不要在 AppError 中携带敏感数据（密码、token、完整文件路径等），details 字段仅放调试上下文
 * - userMessage 用于 UI 展示，应使用用户可理解的语言，避免技术细节
 * - cause 用于日志排查，序列化时不跨 IPC 传输
 */
import { IPC_ERROR_CODES, type IpcErrorCode } from '../types/ipc-types'
import { ERROR_CODES, type ErrorCode } from './error-codes'

// shared 层不能依赖任一侧 i18n 实例（会拖入 electron / react 依赖），
// 默认 userMessage 的翻译函数由主/渲染进程 i18n 初始化时注入（先例：preload 的 __setPluginI18nT）
let translate: (key: string, options?: Record<string, unknown>) => string = (key) => key

/** 注入翻译函数（src/main/i18n 与 src/renderer/i18n 初始化时调用） */
export function setAppErrorTranslator(
  fn: (key: string, options?: Record<string, unknown>) => string
): void {
  translate = fn
}

/**
 * AppError 构造选项
 */
export interface AppErrorOptions {
  /** 用户可读的提示文本（不暴露技术细节） */
  userMessage?: string
  /** 原始错误链，用于日志排查 */
  cause?: unknown
}

/**
 * IPC 序列化结构（与 IpcError 接口对齐并扩展 userMessage 字段）
 */
export interface AppErrorIpcPayload {
  /** 错误码，对应 ERROR_CODES 中的值 */
  code: string
  /** 技术错误消息（开发者排查用） */
  message: string
  /** 用户可读的提示文本（UI 展示用，可选） */
  userMessage?: string
  /** 可选的调试详情（不包含敏感信息） */
  details?: unknown
}

export class AppError extends Error {
  /** 错误码，对应 ERROR_CODES 中的值 */
  readonly code: string
  /** 可选的调试详情（不包含敏感信息） */
  readonly details?: unknown
  /** 用户可读的提示文本（UI 展示用） */
  readonly userMessage?: string
  /** 原始错误链（仅用于日志，不跨 IPC 传输） */
  readonly cause?: unknown

  constructor(code: string, message: string, details?: unknown, options?: AppErrorOptions) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
    this.userMessage = options?.userMessage
    this.cause = options?.cause

    // 维持 V8 异常栈格式（在 TypeScript 编译后保留 instanceof 行为）
    Object.setPrototypeOf(this, AppError.prototype)
  }

  /** 参数校验失败 */
  static validation(message: string, details?: unknown, options?: AppErrorOptions): AppError {
    return new AppError(IPC_ERROR_CODES.VALIDATION_ERROR, message, details, options)
  }

  /** 路径被白名单/黑名单拦截 */
  static forbidden(message: string, details?: unknown, options?: AppErrorOptions): AppError {
    return new AppError(IPC_ERROR_CODES.PATH_FORBIDDEN, message, details, options)
  }

  /** 资源不存在 */
  static notFound(message: string, details?: unknown, options?: AppErrorOptions): AppError {
    return new AppError(IPC_ERROR_CODES.NOT_FOUND, message, details, options)
  }

  /** 权限不足 */
  static unauthorized(message: string, details?: unknown, options?: AppErrorOptions): AppError {
    return new AppError(IPC_ERROR_CODES.UNAUTHORIZED, message, details, options)
  }

  /** 资源冲突（如唯一约束冲突） */
  static conflict(message: string, details?: unknown, options?: AppErrorOptions): AppError {
    return new AppError(IPC_ERROR_CODES.CONFLICT, message, details, options)
  }

  /** 用户主动取消 */
  static canceled(
    message: string = translate('appError.canceled'),
    details?: unknown,
    options?: AppErrorOptions
  ): AppError {
    return new AppError(IPC_ERROR_CODES.CANCELED, message, details, options)
  }

  /** 前置条件不满足 */
  static preconditionFailed(
    message: string,
    details?: unknown,
    options?: AppErrorOptions
  ): AppError {
    return new AppError(IPC_ERROR_CODES.PRECONDITION_FAILED, message, details, options)
  }

  /** 内部错误 */
  static internal(message: string, details?: unknown, options?: AppErrorOptions): AppError {
    return new AppError(IPC_ERROR_CODES.INTERNAL_ERROR, message, details, options)
  }

  /**
   * 序列化为 IpcError 结构
   * 便于 wrapHandler 在 catch 块中直接使用
   *
   * 注意：cause 字段不跨 IPC 传输（可能包含敏感信息），仅用于主进程本地日志
   */
  toIpcError(): AppErrorIpcPayload {
    const payload: AppErrorIpcPayload = {
      code: this.code,
      message: this.message
    }
    if (this.userMessage !== undefined) {
      payload.userMessage = this.userMessage
    }
    if (this.details !== undefined) {
      payload.details = this.details
    }
    return payload
  }

  /**
   * JSON 序列化钩子
   * 确保 JSON.stringify(appError) 输出 { code, message, userMessage?, details? } 而非 Error 默认的 {}
   */
  toJSON(): AppErrorIpcPayload {
    return this.toIpcError()
  }
}

// ============ 分类错误子类 ============
// 每个子类绑定一个错误码，便于 catch 块按 instanceof 分支处理
// 同时提供更语义化的构造函数，鼓励调用方提供 userMessage 和 cause

/**
 * 参数校验错误
 *
 * 用于 zod schema 不匹配、业务规则校验失败、参数格式错误等场景。
 * 默认 userMessage 提示用户检查输入。
 */
export class ValidationError extends AppError {
  constructor(message: string, details?: unknown, options?: AppErrorOptions) {
    super(ERROR_CODES.VALIDATION_ERROR, message, details, options)
    this.name = 'ValidationError'
    Object.setPrototypeOf(this, ValidationError.prototype)
  }
}

/**
 * 资源不存在错误
 *
 * 用于查询的记录/文件/目录不存在的场景。
 */
export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown, options?: AppErrorOptions) {
    super(ERROR_CODES.NOT_FOUND, message, details, options)
    this.name = 'NotFoundError'
    Object.setPrototypeOf(this, NotFoundError.prototype)
  }
}

/**
 * 权限不足错误
 *
 * 用于路径白名单拦截、未授权操作、权限校验失败等场景。
 */
export class PermissionError extends AppError {
  constructor(message: string, details?: unknown, options?: AppErrorOptions) {
    super(ERROR_CODES.PATH_FORBIDDEN, message, details, options)
    this.name = 'PermissionError'
    Object.setPrototypeOf(this, PermissionError.prototype)
  }
}

/**
 * 数据库错误
 *
 * 用于 better-sqlite3 抛出的 SQL 错误、事务冲突、连接异常、数据损坏等场景。
 * 通常 cause 字段应携带原始的 better-sqlite3 错误对象。
 */
export class DatabaseError extends AppError {
  constructor(message: string, details?: unknown, options?: AppErrorOptions) {
    super(ERROR_CODES.DATABASE_ERROR, message, details, {
      userMessage: options?.userMessage ?? translate('appError.database'),
      cause: options?.cause
    })
    this.name = 'DatabaseError'
    Object.setPrototypeOf(this, DatabaseError.prototype)
  }
}

/**
 * 文件系统错误
 *
 * 用于 fs 模块抛出的读写错误、磁盘满、路径不存在、权限不足等场景。
 * 通常 cause 字段应携带原始的 Node.js ERR_* 错误对象。
 */
export class FileSystemError extends AppError {
  constructor(message: string, details?: unknown, options?: AppErrorOptions) {
    super(ERROR_CODES.FILE_SYSTEM_ERROR, message, details, {
      userMessage: options?.userMessage ?? translate('appError.fileSystem'),
      cause: options?.cause
    })
    this.name = 'FileSystemError'
    Object.setPrototypeOf(this, FileSystemError.prototype)
  }
}

/**
 * 内部错误
 *
 * 兜底分类，用于未预期的异常、运行时错误、第三方库抛出的未知错误等。
 * 通常 cause 字段应携带原始错误对象。
 */
export class InternalError extends AppError {
  constructor(message: string, details?: unknown, options?: AppErrorOptions) {
    super(ERROR_CODES.INTERNAL_ERROR, message, details, {
      userMessage: options?.userMessage ?? translate('appError.internal'),
      cause: options?.cause
    })
    this.name = 'InternalError'
    Object.setPrototypeOf(this, InternalError.prototype)
  }
}

// ============ 类型守卫与工具函数 ============

/**
 * 类型守卫：判断未知错误是否为 AppError
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}

/**
 * 类型守卫：判断是否为 ValidationError 实例或其子类
 */
export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError
}

/**
 * 类型守卫：判断是否为 NotFoundError 实例或其子类
 */
export function isNotFoundError(error: unknown): error is NotFoundError {
  return error instanceof NotFoundError
}

/**
 * 类型守卫：判断是否为 PermissionError 实例或其子类
 */
export function isPermissionError(error: unknown): error is PermissionError {
  return error instanceof PermissionError
}

/**
 * 类型守卫：判断是否为 DatabaseError 实例或其子类
 */
export function isDatabaseError(error: unknown): error is DatabaseError {
  return error instanceof DatabaseError
}

/**
 * 类型守卫：判断是否为 FileSystemError 实例或其子类
 */
export function isFileSystemError(error: unknown): error is FileSystemError {
  return error instanceof FileSystemError
}

/**
 * 类型守卫：判断是否为 InternalError 实例或其子类
 */
export function isInternalError(error: unknown): error is InternalError {
  return error instanceof InternalError
}

/**
 * 辅助：将任意错误转为 IpcError 结构
 * - AppError 直接转换（保留 userMessage）
 * - 普通 Error 提取 message，code 标记为 INTERNAL_ERROR
 * - 其他值 String() 化
 *
 * 同时保留 cause 链信息（如原始错误是 AppError 则附带其 cause）
 */
export function toIpcError(error: unknown): AppErrorIpcPayload {
  if (isAppError(error)) {
    return error.toIpcError()
  }
  if (error instanceof Error) {
    return {
      code: IPC_ERROR_CODES.INTERNAL_ERROR,
      message: error.message
    }
  }
  return {
    code: IPC_ERROR_CODES.INTERNAL_ERROR,
    message: String(error)
  }
}

/**
 * 辅助：从任意错误中提取用户可读的消息
 *
 * 优先级：AppError.userMessage > AppError.message > Error.message > String(error)
 *
 * 渲染层 useErrorToast 钩子使用此函数决定 toast 显示文本。
 */
export function extractUserMessage(
  error: unknown,
  fallback = translate('appError.fallback')
): string {
  if (isAppError(error)) {
    return error.userMessage ?? error.message
  }
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return fallback
}

export type { IpcErrorCode, ErrorCode }
