// IpcError 类 Mock：与 src/main/preload.ts 中 IpcError 保持构造签名一致
// 业务代码用 err instanceof window.IpcError 判断错误类型，预览版需在 window.IpcError 上挂同名类

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

// 预览版专用错误码：所有不可用功能统一抛此错误，组件已有 try/catch + Toast 自动降级
export const PREVIEW_UNSUPPORTED = 'PREVIEW_UNSUPPORTED'

export function unsupported(feature: string): IpcError {
  return new IpcError(
    PREVIEW_UNSUPPORTED,
    `预览版不支持：${feature}`,
    { feature },
    `此功能需要 exe 程序支持，请下载安装完整版`
  )
}
