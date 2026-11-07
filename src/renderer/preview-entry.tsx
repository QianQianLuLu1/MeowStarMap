// 预览版入口：在 main.tsx 之前先注入 Mock 层
// 必须在 React 渲染前执行：在 window 上注入 electronAPI/IpcError Mock
import { installPreviewMock } from './preview/mock/install'
// favicon 走 JS 资产 import 才能被 assetsInlineLimit 内联为 data URI；
// HTML <link> 引用的资产 Vite 一律外发文件，单文件 preview.html 会断链。
import faviconUrl from './favicon.ico'

installPreviewMock()

const faviconLink = document.createElement('link')
faviconLink.rel = 'icon'
faviconLink.type = 'image/x-icon'
faviconLink.href = faviconUrl
document.head.appendChild(faviconLink)

// 复用 exe 版入口（i18n 初始化 + ErrorBoundary + App 渲染）
import './main'
