/**
 * 主窗口导航授信判定（主进程侧第一层防线）
 *
 * 背景：preload 是 webContents 级别的 webPreferences，对该窗口加载的**任何**文档都会执行，
 * 与页面来源无关。只要主框架被导航到白名单内的目标（历史实现放行 file:// 与任意
 * http://localhost 端口），contextBridge 就会在非应用自身的页面上重建完整 IPC 桥
 * ——本地 evil.html 或本机任意进程起的 HTTP 服务都能拿到 window.electronAPI。
 * preload 不受页面 CSP 约束，故 CSP 不构成这道防线。
 *
 * 策略（与 preload/origin-guard.ts 的放行集合必须逐字镜像，改一处要同步改另一处）：
 * - app://  /  media://：始终放行（应用自身文档，两个协议均以 standard+secure 注册）
 * - http://localhost:5173 / http://127.0.0.1:5173：仅 dev 放行（vite dev server）
 * - 其余一律拒绝，含 file://（生产与 dev 均无 file:// 文档依赖）
 *
 * 第二层防线在 preload 侧（readDocumentOrigin + isTrustedDocumentOrigin）：
 * 即便本层被绕过，非授信文档也拿不到 electronAPI。
 */
import { logFault } from '../utils/logger'

/** 事件来源，用于故障日志区分主帧/子帧 */
export type NavigationGuardSource = 'will-navigate' | 'will-frame-navigate'

/** dev server 源（electron.vite.config.ts renderer.server.port = 5173） */
const DEV_SERVER_ORIGINS: readonly string[] = ['http://localhost:5173', 'http://127.0.0.1:5173']

/**
 * 判断 URL 是否为应用自身文档。
 *
 * dev server 要求「同源且同端口」而非 `startsWith('http://localhost')`：
 * 后者会把本机任意端口（恶意软件 / 被劫持的 dev server）起的 HTTP 服务一并放行。
 */
export function isAppDocumentUrl(url: string, isDev: boolean): boolean {
  if (!url) return false
  if (url.startsWith('app://') || url.startsWith('media://')) return true
  if (!isDev) return false
  return DEV_SERVER_ORIGINS.some((origin) => url === origin || url.startsWith(`${origin}/`))
}

/**
 * 导航拦截处理：非授信目标直接 preventDefault 并写故障日志。
 *
 * @returns true 表示放行，false 表示已拦截
 */
export function guardNavigation(
  event: { preventDefault: () => void },
  url: string,
  options: { source: NavigationGuardSource; isDev: boolean }
): boolean {
  if (isAppDocumentUrl(url, options.isDev)) return true

  event.preventDefault()
  logFault('navigation-blocked', new Error(`已拦截越权导航: ${url}`), {
    source: options.source,
    url
  }).catch(() => {})
  return false
}
