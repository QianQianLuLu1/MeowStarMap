import { protocol, app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { diagLog, logStartupError } from '../utils/startup-diagnostic'
import { t } from '../i18n'

// 编译后本文件 __dirname === dist/main/main/app
// 回退 3 层到达 dist/renderer（与 window-manager.ts 现有路径计算一致）
// WXNN_RENDERER_DIR 仅供集成测试指定临时渲染目录，生产环境不设置，保持原路径计算
const RENDERER_DIR = process.env.WXNN_RENDERER_DIR
  ? path.resolve(process.env.WXNN_RENDERER_DIR)
  : path.resolve(__dirname, '../../../renderer')

/** 渲染产物扩展名（含点号、小写）→ MIME。未知类型回退 application/octet-stream */
const RENDERER_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain',
  '.webmanifest': 'application/manifest+json'
}

let registered = false

/**
 * 注册 app:// 协议处理器：把 app://renderer/<path> 映射到 dist/renderer/<path>。
 *
 * 为什么用 fs.readFile 而不是 net.fetch(file://...app.asar/...)：
 * - fs 是 Electron 官方明确支持 asar 虚拟文件系统的 Node API；
 * - net.fetch 走 Chromium 网络栈，主进程经它读 asar 内文件无官方背书，
 *   线上（2.3.5）实测触发 ERR_FAILED (-2) 白屏。
 *
 * 为什么显式设置 Content-Length：协议响应按该头校验，缺失同样会触发
 * ERR_FAILED (-2)（历史上 fs.readFile + Response(Buffer) 无该头即踩此坑）。
 * 取两者之长：asar 安全读取 + 完整响应头。
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
      new Error(t('main.rendererProtocol.error.calledBeforeReady'))
    )
    // 未就绪时不得置位 registered：否则就绪后合法调用被 if(registered) return 拦截，
    // app:// 永久未注册，窗口加载死协议导致白屏且无法自愈
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
        diagLog('PROTO', `403 ${request.url} -> ${filePath}`)
        return new Response('Forbidden', { status: 403 })
      }

      // 文件不存在返回 404（避免把 ENOENT 交给网络栈转成 Chromium 错误）
      if (!fs.existsSync(filePath)) {
        diagLog('PROTO', `404 ${request.url} -> ${filePath} (missing)`)
        return new Response('Not Found', { status: 404 })
      }

      const data = await fs.promises.readFile(filePath)
      const ext = path.extname(filePath).toLowerCase()
      const headers: Record<string, string> = {
        'Content-Type': RENDERER_MIME[ext] ?? 'application/octet-stream',
        // 显式 Content-Length：协议响应按此头校验，缺失可能触发 ERR_FAILED (-2)
        'Content-Length': String(data.byteLength)
      }
      diagLog(
        'PROTO',
        `200 ${request.url} -> ${filePath} (${data.byteLength}B ${headers['Content-Type']})`
      )
      return new Response(data, { headers })
    } catch (error) {
      // 兜底：非法 % 转义 / readFile ENOENT/EISDIR 等一律 404，绝不向外抛
      const msg = error instanceof Error ? error.message : String(error)
      diagLog('PROTO', `ERR->404 ${request.url}: ${msg}`)
      return new Response('Not Found', { status: 404 })
    }
  })
}
