// 预览版入口：在 main.tsx 之前先注入 Mock 层
// 必须在 React 渲染前执行：在 window 上注入 electronAPI/IpcError Mock
import { installPreviewMock } from './preview/mock/install'

installPreviewMock()

// 复用 exe 版入口（i18n 初始化 + ErrorBoundary + App 渲染）
import './main'
