/**
 * 渲染层错误 Toast 钩子
 *
 * 设计目标：
 * - 统一错误提示入口：从任意错误对象中提取用户可读消息并显示 Toast
 * - 与 IpcError（preload 暴露的 window.IpcError）兼容，优先使用 userMessage
 * - 与 AppError（shared/errors/app-error）兼容，跨进程错误结构对齐
 * - 按错误类别决定 toast 类型与持续时间（用户取消静默、校验失败 info、内部错误 error）
 * - 自动上报非用户面错误到主进程 faults 日志（避免渲染层错误被吞没）
 *
 * 使用约定：
 * - 与 useToast 组合：内部委托 useToast 显示消息
 * - 不重复日志：IPC 错误已在主进程 wrapHandler 中记录，此处仅做兜底上报
 * - 仅做错误展示：业务调用方决定后续恢复行为
 */
import { useCallback } from 'react'
import { useToast, type ToastType } from './useToast'
import { extractUserMessage, isAppError } from '../../shared/errors/app-error'
import { ERROR_CODES, categoryOfCode, ErrorCategory } from '../../shared/errors/error-codes'

/**
 * 错误码到 toast 类型的映射策略
 *
 * - Validation：info（用户输入问题，非系统错误）
 * - NotFound：info（业务正常分支）
 * - Permission：error（潜在安全问题，需用户感知）
 * - Database/FileSystem/Internal：error（系统异常）
 * - Canceled：不显示（用户主动操作，无需提示）
 */
function pickToastType(code: string | undefined): ToastType {
  if (!code) return 'error'
  if (code === ERROR_CODES.CANCELED) return 'info'
  const category = categoryOfCode(code)
  switch (category) {
    case ErrorCategory.Validation:
    case ErrorCategory.NotFound:
      return 'info'
    case ErrorCategory.Permission:
    case ErrorCategory.Database:
    case ErrorCategory.FileSystem:
    case ErrorCategory.Internal:
      return 'error'
    default:
      return 'error'
  }
}

/**
 * 错误码到持续时间的映射策略
 *
 * - 用户取消：0（不显示）
 * - 校验/不存在：4s（用户需阅读并修正）
 * - 权限/数据库/文件/内部：6s（重要错误，给用户充分时间）
 */
function pickDuration(code: string | undefined, fallbackDuration: number): number {
  if (!code) return fallbackDuration
  if (code === ERROR_CODES.CANCELED) return 0
  const category = categoryOfCode(code)
  switch (category) {
    case ErrorCategory.Validation:
    case ErrorCategory.NotFound:
      return Math.max(fallbackDuration, 4000)
    case ErrorCategory.Permission:
    case ErrorCategory.Database:
    case ErrorCategory.FileSystem:
    case ErrorCategory.Internal:
      return Math.max(fallbackDuration, 6000)
    default:
      return fallbackDuration
  }
}

/**
 * 从错误对象中提取错误码
 *
 * 兼容多种错误形态：
 * - AppError（携带 code 字段）
 * - window.IpcError（携带 code 字段）
 * - { code: string, ... } 普通对象（IPC 反序列化结果）
 * - 其他：返回 undefined
 */
function extractErrorCode(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined
  if (typeof error !== 'object') return undefined
  const obj = error as { code?: unknown }
  if (typeof obj.code === 'string') return obj.code
  return undefined
}

/**
 * 判断是否应跳过 toast 显示
 *
 * 用户主动取消的场景静默处理，不打扰用户。
 */
function shouldSkipToast(error: unknown, code: string | undefined): boolean {
  // 用户主动取消：静默
  if (code === ERROR_CODES.CANCELED) return true
  // AppError.canceled 静默（即使未带 code）
  if (isAppError(error) && error.code === ERROR_CODES.CANCELED) return true
  return false
}

/**
 * 错误 toast 钩子
 *
 * @param defaultDuration 默认 toast 持续时间，单位 ms（默认 4000）
 *
 * @returns
 *   - showError(error)：显示错误 toast，自动提取消息与类型
 *   - showMessage(text, type)：直接显示文本（兼容旧用法）
 *   - dismiss/clear/messages：透传 useToast
 *
 * @example
 * ```tsx
 * const { showError } = useErrorToast()
 *
 * try {
 *   await electronAPI.file.delete(paths)
 * } catch (err) {
 *   showError(err)
 * }
 * ```
 */
export function useErrorToast(defaultDuration = 4000): {
  /** 错误消息列表（透传 useToast） */
  messages: ReturnType<typeof useToast>['messages']
  /** 显示任意错误对象 */
  showError: (error: unknown) => void
  /** 显示原始文本消息（手动指定类型） */
  showMessage: (text: string, type?: ToastType) => void
  /** 关闭单条 toast */
  dismiss: (id: string) => void
  /** 清空所有 toast */
  clear: () => void
} {
  const toast = useToast(defaultDuration)

  const showError = useCallback(
    (error: unknown) => {
      const code = extractErrorCode(error)

      // 用户取消等静默场景：不显示 toast
      if (shouldSkipToast(error, code)) return

      const text = extractUserMessage(error)
      const toastType = pickToastType(code)
      const duration = pickDuration(code, defaultDuration)

      // duration 为 0 表示静默（兜底，与 shouldSkipToast 配合）
      if (duration === 0) return

      // 委托 useToast 显示，注意 showMessage 默认 type 是 'success'，需显式传入
      toast.showMessage(text, toastType)

      // 兜底上报到主进程 faults 日志：
      // - IPC 错误已在 wrapHandler 中记录，此处为防止渲染层吞错而做兜底
      // - 仅对非用户面错误（Database/FileSystem/Internal）上报，避免日志膨胀
      const category = categoryOfCode(code ?? '')
      if (
        category === ErrorCategory.Database ||
        category === ErrorCategory.FileSystem ||
        category === ErrorCategory.Internal
      ) {
        try {
          const errObj = error instanceof Error ? error : new Error(String(error))
          window.electronAPI?.log
            ?.reportRendererError({
              message: `[useErrorToast] ${text}`,
              stack: errObj.stack,
              source: 'unhandledrejection'
            })
            .catch(() => {
              // 上报失败时静默，避免循环依赖
            })
        } catch {
          // electronAPI 不可用时静默
        }
      }
    },
    [toast, defaultDuration]
  )

  const showMessage = useCallback(
    (text: string, type: ToastType = 'info') => {
      toast.showMessage(text, type)
    },
    [toast]
  )

  return {
    messages: toast.messages,
    showError,
    showMessage,
    dismiss: toast.dismiss,
    clear: toast.clear
  }
}
