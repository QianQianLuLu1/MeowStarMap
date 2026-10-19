import type { ApiErrorBody, ApiErrorCode } from '../../../shared/sync/protocol'

/**
 * HTTP 层结构化错误：status/code 由路由语义决定，message 直接进入 ApiErrorBody
 * （协议错误体形状 {error: {code, message}}，冻结于 src/shared/sync/protocol.ts）。
 */
export class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ApiHttpError'
  }
}

export function apiErrorBody(code: ApiErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } }
}
