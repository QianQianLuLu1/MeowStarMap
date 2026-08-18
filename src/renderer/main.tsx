import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import { installGlobalErrorHandler } from './utils/global-error-handler'
import './styles/globals.css'
// P2-01 + P3：i18n 初始化（同步加载 zh-CN，异步预加载持久化语言）
// 必须在 React 渲染前执行，初始化后 i18n 实例即可用
import { initializeI18n } from './i18n'

// P0-2：在 React 渲染之前安装全局错误监听器，捕获 window.onerror 和 unhandledrejection
installGlobalErrorHandler()

// P3：先预加载用户持久化的语言（若有），避免非中文用户首次看到中文闪烁
// 预加载失败时仍正常渲染（回退到 zh-CN），保证应用可用
initializeI18n().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {/* P0-4：全局 ErrorBoundary 捕获组件渲染异常，避免白屏 */}
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  )
  // P0-白屏修复·诊断联动：渲染进程挂载完成后上报就绪，主进程据此取消 8s 白屏超时诊断。
  // 可选链：preload 未就绪时静默跳过，不影响正常渲染。
  window.electronAPI?.reportReady?.()
})
