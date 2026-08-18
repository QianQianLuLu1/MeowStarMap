/**
 * 错误码集中定义
 *
 * 设计目标：
 * - 集中维护所有错误码常量，避免散落的字符串硬编码
 * - 与 IPC_ERROR_CODES（ipc-types.ts）保持兼容并扩展缺失的类别（DATABASE、FILE_SYSTEM）
 * - 提供 ErrorCode 枚举类型，便于类型安全地引用
 *
 * 使用约定：
 * - AppError 及其子类的 code 字段必须取自本模块的常量
 * - 新增错误码时遵循命名规则：APP_<类别>_<具体错误>
 * - 已废弃的 IPC_* 前缀常量从 ipc-types.ts 重新导出以保持向后兼容
 */
import { IPC_ERROR_CODES } from '../types/ipc-types'

/**
 * 应用错误码常量
 *
 * 在 IPC_ERROR_CODES 基础上扩展了 DATABASE_ERROR 和 FILE_SYSTEM_ERROR 两个新类别，
 * 以覆盖数据库异常和文件系统异常两类常见错误。
 */
export const ERROR_CODES = {
  /** 参数校验失败（zod schema 不匹配 / 业务规则校验失败） */
  VALIDATION_ERROR: IPC_ERROR_CODES.VALIDATION_ERROR,
  /** 路径被白名单/黑名单拦截 */
  PATH_FORBIDDEN: IPC_ERROR_CODES.PATH_FORBIDDEN,
  /** 资源不存在 */
  NOT_FOUND: IPC_ERROR_CODES.NOT_FOUND,
  /** 权限不足或未授权操作 */
  UNAUTHORIZED: IPC_ERROR_CODES.UNAUTHORIZED,
  /** 资源冲突（如 UID 已存在） */
  CONFLICT: IPC_ERROR_CODES.CONFLICT,
  /** 用户主动取消 */
  CANCELED: IPC_ERROR_CODES.CANCELED,
  /** 前置条件不满足 */
  PRECONDITION_FAILED: IPC_ERROR_CODES.PRECONDITION_FAILED,
  /** 内部错误 */
  INTERNAL_ERROR: IPC_ERROR_CODES.INTERNAL_ERROR,

  // ===== 扩展错误码（IPC_ERROR_CODES 未覆盖） =====

  /** 数据库异常（连接失败 / SQL 错误 / 事务冲突 / 数据损坏） */
  DATABASE_ERROR: 'APP_DATABASE_ERROR',
  /** 文件系统异常（读写失败 / 权限不足 / 磁盘满 / 路径不存在） */
  FILE_SYSTEM_ERROR: 'APP_FILE_SYSTEM_ERROR'
} as const

/** 错误码字面量类型 */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/**
 * 错误类别枚举
 *
 * 用于程序化区分错误大类，比 code 字符串更易做 switch 处理。
 * 每个分类对应一个 AppError 子类。
 */
export enum ErrorCategory {
  /** 参数校验失败 */
  Validation = 'Validation',
  /** 资源不存在 */
  NotFound = 'NotFound',
  /** 权限不足或被禁止 */
  Permission = 'Permission',
  /** 数据库异常 */
  Database = 'Database',
  /** 文件系统异常 */
  FileSystem = 'FileSystem',
  /** 内部错误（兜底分类） */
  Internal = 'Internal'
}

/**
 * 错误码到错误类别的映射
 *
 * 用于从 IpcError.code 反推错误所属类别（如渲染层按类别决定提示样式）。
 * 未匹配的 code 默认归为 Internal。
 */
export const CODE_TO_CATEGORY: Readonly<Record<string, ErrorCategory>> = Object.freeze({
  [ERROR_CODES.VALIDATION_ERROR]: ErrorCategory.Validation,
  [ERROR_CODES.NOT_FOUND]: ErrorCategory.NotFound,
  [ERROR_CODES.PATH_FORBIDDEN]: ErrorCategory.Permission,
  [ERROR_CODES.UNAUTHORIZED]: ErrorCategory.Permission,
  [ERROR_CODES.DATABASE_ERROR]: ErrorCategory.Database,
  [ERROR_CODES.FILE_SYSTEM_ERROR]: ErrorCategory.FileSystem,
  [ERROR_CODES.INTERNAL_ERROR]: ErrorCategory.Internal,
  [ERROR_CODES.CONFLICT]: ErrorCategory.Internal,
  [ERROR_CODES.CANCELED]: ErrorCategory.Internal,
  [ERROR_CODES.PRECONDITION_FAILED]: ErrorCategory.Internal
})

/**
 * 根据 code 推断错误类别
 * 未注册的 code 归为 Internal。
 */
export function categoryOfCode(code: string): ErrorCategory {
  return CODE_TO_CATEGORY[code] ?? ErrorCategory.Internal
}

/**
 * 是否为可向用户展示的错误（用户可理解并采取行动）
 *
 * - Validation / NotFound / Permission / Canceled：可展示，用户可修正
 * - Database / FileSystem / Internal：内部错误，需谨慎展示（避免暴露内部细节）
 */
export function isUserFacing(category: ErrorCategory): boolean {
  return (
    category === ErrorCategory.Validation ||
    category === ErrorCategory.NotFound ||
    category === ErrorCategory.Permission
  )
}

/** 重新导出 IPC_ERROR_CODES 以便旧代码渐进迁移 */
export { IPC_ERROR_CODES }
