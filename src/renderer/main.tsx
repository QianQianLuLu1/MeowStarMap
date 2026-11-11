import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import { installGlobalErrorHandler } from './utils/global-error-handler'
import './styles/globals.css'
// P2-01 + P3：i18n 初始化（同步加载 zh-CN，异步预加载持久化语言）
// 必须在 React 渲染前执行，初始化后 i18n 实例即可用
import { initializeI18n } from './i18n'
import { setRemoteImagesEnabled } from './utils/resonance/remote-images-enabled'

// P0-2：在 React 渲染之前安装全局错误监听器，捕获 window.onerror 和 unhandledrejection
installGlobalErrorHandler()

/**
 * 外部图片总开关（#218「保持可回滚」）：启动前从持久化设置同步到渲染层 flag，
 * 保证「关闭」在重启后依旧零网络。读不到设置（预览版 / 桥未就绪）时保持既有默认开启；
 * 读到非法值由 setRemoteImagesEnabled 按安全默认关闭并记明确错误，不静默吞掉。
 */
async function syncRemoteImagesPreference(): Promise<void> {
  const get = window.electronAPI?.settings?.get
  if (!get) return
  try {
    setRemoteImagesEnabled(await get('referenceData.remoteImagesEnabled', true))
  } catch (err) {
    console.error('[remoteImages] failed to read switch, falling back to disabled', err)
    setRemoteImagesEnabled(null)
  }
}

// P3：先预加载用户持久化的语言（若有），避免非中文用户首次看到中文闪烁
// 预加载失败时仍正常渲染（回退到 zh-CN），保证应用可用
initializeI18n().finally(async () => {
  await syncRemoteImagesPreference()
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
