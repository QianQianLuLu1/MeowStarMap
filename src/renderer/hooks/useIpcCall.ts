/**
 * 渲染层 IPC 调用错误处理钩子
 *
 * 设计目标：
 * - 统一包装 IPC 调用：自动管理 loading 状态、错误捕获、toast 显示
 * - 与 useErrorToast 集成：错误时自动展示用户可读 toast
 * - 类型安全：通过泛型保留 electronAPI 调用链的类型签名
 * - 不吞错：返回值结构带 error 字段，调用方仍可按需处理特定错误码
 * - 幂等安全：可重复触发同一调用，自动取消上一次的 loading 状态
 *
 * 使用约定：
 * - 仅包装返回 Promise 的 IPC 调用（如 electronAPI.file.delete）
 * - 不适用于流式/事件订阅式 API（如 electronAPI.scanner.onProgress）
 * - 默认开启错误 toast，可通过 options.silent 关闭（用于需要自定义处理的场景）
 *
 * @example 基础用法
 * ```tsx
 * const { call, loading, error } = useIpcCall()
 *
 * const handleDelete = async () => {
 *   const result = await call(electronAPI.file.delete, paths)
 *   if (result.success) {
 *     // result.data 即业务返回值
 *     showMessage('已删除', 'success')
 *   }
 *   // 失败时 toast 已自动显示，无需手动处理
 * }
 * ```
 *
 * @example 静默模式（自定义错误处理）
 * ```tsx
 * const { call } = useIpcCall({ silent: true })
 * const result = await call(electronAPI.scanner.start)
 * if (!result.success) {
 *   if (result.error.code === ERROR_CODES.CANCELED) return
 *   // 自定义处理
 * }
 * ```
 */
import { useCallback, useRef, useState } from 'react'
import { useErrorToast } from './useErrorToast'
import { ERROR_CODES } from '../../shared/errors/error-codes'
import { extractUserMessage } from '../../shared/errors/app-error'
import i18n from '../i18n'

/**
 * IPC 调用返回的结果类型
 *
 * 成功：{ success: true, data: T }
 * 失败：{ success: false, error: IpcErrorLike }
 *
 * IpcErrorLike 是 window.IpcError 实例的结构化类型，包含 code/message/userMessage?/details?
 * 当 preload 抛出 IpcError 时，可通过 result.error.code 程序化判断错误类型。
 */
export interface IpcCallResult<T> {
  success: boolean
  data?: T
  error?: IpcErrorLike
}

/**
 * IPC 错误形态：与 preload 暴露的 IpcError 类对齐
 */
export interface IpcErrorLike {
  code: string
  message: string
  userMessage?: string
  details?: unknown
  stack?: string
}

/**
 * useIpcCall 选项
 */
export interface UseIpcCallOptions {
  /**
   * 是否静默模式（默认 false）
   * - false：失败时自动显示 toast
   * - true：不显示 toast，调用方自行处理
   */
  silent?: boolean
  /**
   * 是否在调用失败时仍向上抛出错误（默认 false）
   * - false：错误被捕获并返回，不抛出
   * - true：先显示 toast，再抛出原错误
   *
   * 用于错误边界 (ErrorBoundary) 需要捕获的场景
   */
  rethrow?: boolean
  /**
   * 是否自动取消静默错误（默认 true）
   * 用户取消（CANCELED）时默认不显示 toast，即使 silent=false
   */
  silentOnCancel?: boolean
}

/**
 * 提取函数返回值类型的工具类型
 *
 * 用于从 (...args) => Promise<T> 中提取 T。
 */
type UnwrapPromise<T> = T extends Promise<infer U> ? U : T

/**
 * 提取函数参数元组类型的工具类型
 */
type ArgsTuple<T> = T extends (...args: infer A) => unknown ? A : never

/**
 * 提取 IPC API 函数的类型签名
 *
 * 支持函数表达式形式：electronAPI.file.delete
 *
 * 注意：参数与返回类型必须用 any[]/any 而非 unknown[]/unknown，否则 TS 在
 * 推断 TFn 时会反向收缩为 never[]，导致 call 调用处的参数被推断为 never。
 * 这是 TypeScript 反向推断的固有限制，React useCallback 等通用工具也采用此模式。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IpcFn = (...args: any[]) => Promise<any>

/**
 * useIpcCall 钩子返回值
 */
export interface UseIpcCallReturn {
  /** 当前是否有调用进行中 */
  loading: boolean
  /** 最近一次调用的错误（成功后为 null） */
  error: IpcErrorLike | null
  /**
   * 执行 IPC 调用
   *
   * @param fn IPC API 函数引用（如 electronAPI.file.delete）
   * @param args 调用参数（与 fn 签名一致）
   * @returns IpcCallResult<T>，包含 success/data 或 error
   *
   * @example
   * ```ts
   * const result = await call(electronAPI.file.delete, paths)
   * if (result.success) { ... }
   * ```
   */
  call: <TFn extends IpcFn>(
    fn: TFn,
    ...args: ArgsTuple<TFn>
  ) => Promise<IpcCallResult<UnwrapPromise<ReturnType<TFn>>>>
  /** 重置 loading/error 状态 */
  reset: () => void
}

/**
 * 判断是否为 IpcError 形态（来自 preload）
 *
 * preload 抛出的 window.IpcError 实例携带 code 字段；
 * 也兼容其他携带 code 字段的错误对象。
 */
function isIpcErrorLike(error: unknown): error is IpcErrorLike {
  if (error === null || error === undefined) return false
  if (typeof error !== 'object') return false
  const obj = error as { code?: unknown; message?: unknown }
  return typeof obj.code === 'string' && typeof obj.message === 'string'
}

/**
 * IPC 调用错误处理钩子
 *
 * @param options 配置选项
 *
 * @example
 * ```tsx
 * function DeleteButton({ paths }: { paths: string[] }) {
 *   const { call, loading } = useIpcCall()
 *
 *   return (
 *     <button disabled={loading} onClick={() => call(electronAPI.file.delete, paths)}>
 *       {loading ? '删除中...' : '删除'}
 *     </button>
 *   )
 * }
 * ```
 */
export function useIpcCall(options: UseIpcCallOptions = {}): UseIpcCallReturn {
  const { silent = false, rethrow = false, silentOnCancel = true } = options
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<IpcErrorLike | null>(null)

  // 使用 ref 持有最新的 useErrorToast 实例，避免闭包陈旧
  const toastRef = useRef(useErrorToast())
  // 每次渲染更新 ref，确保 showError 始终是最新的
  toastRef.current = useErrorToast()

  const call = useCallback(
    async <TFn extends IpcFn>(
      fn: TFn,
      ...args: ArgsTuple<TFn>
    ): Promise<IpcCallResult<UnwrapPromise<ReturnType<TFn>>>> => {
      setLoading(true)
      // 保留前一次错误直到本次调用完成，避免 UI 闪烁
      try {
        const data = (await fn(...args)) as UnwrapPromise<ReturnType<TFn>>
        setError(null)
        return { success: true, data }
      } catch (rawError) {
        const ipcError: IpcErrorLike = isIpcErrorLike(rawError)
          ? rawError
          : {
              code: ERROR_CODES.INTERNAL_ERROR,
              message: extractUserMessage(rawError, i18n.t('errorFallback.ipcFailed'))
            }
        setError(ipcError)

        // 错误 toast 显示策略：
        // - silent=true：不显示
        // - silentOnCancel=true 且 code=CANCELED：不显示（用户主动取消）
        // - 否则：显示
        const shouldShowToast =
          !silent && !(silentOnCancel && ipcError.code === ERROR_CODES.CANCELED)
        if (shouldShowToast) {
          toastRef.current.showError(rawError)
        }

        if (rethrow) {
          throw rawError
        }

        return { success: false, error: ipcError }
      } finally {
        setLoading(false)
      }
    },
    [silent, rethrow, silentOnCancel]
  )

  const reset = useCallback(() => {
    setLoading(false)
    setError(null)
  }, [])

  return {
    loading,
    error,
    call,
    reset
  }
}
