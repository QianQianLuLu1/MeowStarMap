import { protocol, app, net } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import url from 'node:url'
import { logStartupError } from '../utils/startup-diagnostic'

// 编译后本文件 __dirname === dist/main/main/app
// 回退 3 层到达 dist/renderer（与 window-manager.ts 现有路径计算一致）
const RENDERER_DIR = path.resolve(__dirname, '../../../renderer')

let registered = false

/**
 * 注册 app:// 协议处理器：把 app://renderer/<path> 映射到 dist/renderer/<path>。
 * - 使用 Electron 官方推荐 net.fetch(file://) 范式，由 Chromium 网络栈自动填充
 *   Content-Length（消除 ERR_FAILED (-2)）、推断正确 MIME，并透明处理 app.asar
 *   虚拟文件系统内的资源读取。
 * - 越界路径返回 403，缺失文件返回 404，handler 内部异常兜底 404/500 绝不向外抛。
 *
 * 必须在 app.whenReady() 之后调用（protocol.handle 内部访问 session.defaultSession，
 * 提前调用会抛 "Session can only be received when app is ready"）。scheme 特权声明
 * registerSchemesAsPrivileged 才需在 whenReady 之前完成。
 */
export function registerRendererProtocol(): void {
  if (registered) return

  // 纵深防御：protocol.handle 内部会访问 session.defaultSession，必须在
  // app.whenReady() 之后调用。未就绪时记日志并返回，避免抛未捕获异常阻塞进程。
  if (!app.isReady()) {
    logStartupError(
      'renderer-protocol',
      new Error('registerRendererProtocol 在 app.whenReady() 之前被调用')
    )
    // FIX(组6-3): 未就绪时不得置位 registered——原实现提前置 true，防御分支返回后
    // 后续（app 就绪时）的合法调用被 if(registered) return 拦截，app:// 永久未注册，
    // 窗口加载死协议导致白屏且无法自愈
    return
  }
  registered = true

  protocol.handle('app', async (request) => {
    try {
      const requestUrl = new URL(request.url)
      const rel = decodeURIComponent(requestUrl.pathname) // 忽略 hostname('renderer')，仅取 pathname 作为相对路径
      const filePath = path.normalize(path.join(RENDERER_DIR, rel))

      // 防目录穿越：解析后的真实路径必须仍在 RENDERER_DIR 内
      if (filePath !== RENDERER_DIR && !filePath.startsWith(RENDERER_DIR + path.sep)) {
        return new Response('Forbidden', { status: 403 })
      }

      // 文件不存在返回 404（避免把 ENOENT 交给 net.fetch 转成 Chromium 错误）
      if (!fs.existsSync(filePath)) {
        return new Response('Not Found', { status: 404 })
      }

      // 使用 Electron 官方的 net.fetch(file://) 范式，Chromium 网络栈自动填充
      // Content-Length、设置正确 MIME，并透明处理 asar 虚拟文件系统
      return net.fetch(url.pathToFileURL(filePath).toString())
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })
}
