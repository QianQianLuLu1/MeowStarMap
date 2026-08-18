/**
 * P0-2：渲染进程全局错误处理器
 *
 * ErrorBoundary 只能捕获组件渲染过程中的同步异常，无法捕获：
 * - 资源加载失败（img/script/iframe 等）
 * - 异步代码（setTimeout/setInterval/Promise）
 * - 事件处理器中的错误
 *
 * 本模块通过 window.onerror 和 window.addEventListener('unhandledrejection')
 * 兜底捕获这些错误，并通过 IPC 上报到主进程 faults 日志
 */

let installed = false

/** 安装全局错误监听器（幂等，多次调用安全） */
export function installGlobalErrorHandler(): void {
  if (installed) return
  installed = true

  // 捕获资源加载失败、脚本异常、运行时错误
  // 注意：addEventListener('error') 能捕获资源加载失败，window.onerror 不能
  window.addEventListener('error', (event) => {
    try {
      const message = event.message || event.error?.message || 'Unknown error'
      window.electronAPI?.log?.reportRendererError({
        message,
        stack: event.error?.stack,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        source: 'window.onerror'
      })
    } catch (e) {
      // P2-C18：原 catch {} 完全静默，错误处理器自身失败时无任何线索
      console.warn('[GlobalErrorHandler] error 事件处理失败:', e)
    }
  })

  // 捕获未处理的 Promise 拒绝
  window.addEventListener('unhandledrejection', (event) => {
    try {
      const reason = event.reason
      const err = reason instanceof Error ? reason : new Error(String(reason))
      window.electronAPI?.log?.reportRendererError({
        message: err.message,
        stack: err.stack,
        source: 'unhandledrejection'
      })
    } catch (e) {
      // P2-C18：原 catch {} 完全静默，错误处理器自身失败时无任何线索
      console.warn('[GlobalErrorHandler] unhandledrejection 事件处理失败:', e)
    }
  })
}
