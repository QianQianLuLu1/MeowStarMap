/**
 * T08：WiFi 局域网分享服务
 * 基于原生 http 模块的简易文件下载服务（非标准 WebDAV，仅支持浏览/下载）
 *
 * 设计原则：
 * - 仅绑定到本机局域网 IP，不暴露公网
 * - 一次性会话：单次启动后默认 10 分钟超时自动关闭
 * - 大文件支持 Range 请求（206 Partial Content），保证视频断点续传
 * - P0-C：PIN 码鉴权，防止局域网未授权访问
 */
import http from 'http'
import os from 'os'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { randomInt } from 'node:crypto'
import { logger } from '../utils/logger'
import { t } from '../i18n'
// P2-A：统一使用 media-constants 的 getMimeType（单一权威来源）
import { getMimeType } from '../utils/media-constants'
// 文件读流统一走公共工具：自带 error 监听 + fd 归还（H2：避免异步错误无人处理与 fd 泄漏）
import { createManagedReadStream, type ByteRange } from '../utils/managed-read-stream'

// T08：优先采用零依赖开源库 network-address，按默认路由返回对外局域网地址，
// 避免从 os.networkInterfaces() 取“第一个”网卡而误绑 VPN / Tailscale / 公网接口。
// 该库为 CJS、无自带类型声明，此处用 require 引入并补充函数签名类型（保持严格模式类型安全）。

const networkAddress: (options?: { ipv6?: boolean }) => string = require('network-address')

// 默认超时时间（10 分钟）
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
// 默认监听端口（0 表示由系统分配可用端口）
const DEFAULT_PORT = 0

export interface WifiShareSession {
  active: boolean
  port: number
  url: string
  // P0-C / F-S3：6 位 PIN 码，UI 展示给用户，客户端首次请求需携带
  pin: string
  // 分享的文件列表（绝对路径）
  files: Array<{ path: string; name: string; size: number; type: string }>
  startedAt: number
  timeoutMs: number
}

// F-S3：PIN 失败锁定配置
const MAX_FAILED_ATTEMPTS = 5
const LOCK_DURATION_MS = 5 * 60 * 1000
// F-S3：私有网段白名单，覆盖以下来源（入站客户端仍需过此校验）：
// - IPv4 私有段：10.x / 172.16-31.x / 192.168.x
// - 兼容 IPv6 映射的 IPv4：::ffff:192.168.x（Node 在 IPv6 socket 上以该形式呈现 IPv4 客户端）
// - IPv6 ULA：fd00::/8（家庭局域网的 fdxx: 前缀地址）
// - IPv6 链路本地：fe80::/10（fe80-febf 范围，含常见 fe80:）
// i 标志用于兼容 IPv6 地址的大小写十六进制写法
const PRIVATE_IP_REGEX =
  /^(?:(?:::ffff:)?(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|127\.)|fd[0-9a-f]{2}:|fe[89ab][0-9a-f]:|::1)/i

// 文件列表图标（内联 SVG，等价于渲染进程图标库的 IconImage / IconVideo）
const IMAGE_ICON_SVG = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`

const VIDEO_ICON_SVG = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`

class WifiShareService {
  private server: http.Server | null = null
  private session: WifiShareSession | null = null
  private timeoutHandle: NodeJS.Timeout | null = null
  // P0-C：已认证会话 token 集合（PIN 校验通过后颁发，后续请求携带 token 免再次校验）
  private authTokens: Set<string> = new Set()
  // F-S3：PIN 失败计数 + 锁定时间戳（5 次错误锁定 5 分钟）
  private failedAttempts: number = 0
  private lockUntil: number = 0

  /**
   * 启动分享服务
   * @param files 待分享的文件路径数组
   * @param port 监听端口，0 表示系统分配
   * @param timeoutMs 超时自动关闭时间
   */
  async start(
    files: string[],
    port: number = DEFAULT_PORT,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): Promise<WifiShareSession> {
    // 已在运行则先停止
    if (this.session?.active) {
      this.stop()
    }

    const fileInfos = await this.collectFiles(files)
    if (fileInfos.length === 0) {
      throw new Error(t('main.share.error.noFilesToShare'))
    }

    // P0-C / F-S3：生成 6 位数字 PIN 码（原 4 位强度不足）
    // 使用密码学安全的 randomInt（含下界不含上界，得到 100000–999999 的 6 位数字，等概率且不可预测）
    const pin = randomInt(100000, 1000000).toString()
    // 清空旧的认证 token 与失败计数
    this.authTokens.clear()
    this.failedAttempts = 0
    this.lockUntil = 0

    this.server = http.createServer((req, res) => this.handleRequest(req, res))
    // 请求超时 30 秒（防止挂起连接）
    this.server.setTimeout(30000)

    // F-S3：绑定到全部网卡（0.0.0.0），确保手机经任意本地 IP 均可达；
    // 展示用 lanIp 仅用于 UI，安全边界由 PRIVATE_IP_REGEX 网关（拒绝非私有远端）保证，不会暴露公网。
    const lanIp = this.getLanIp()
    let actualPort: number
    try {
      actualPort = await new Promise<number>((resolve, reject) => {
        this.server!.once('error', reject)
        this.server!.listen(port, '0.0.0.0', () => {
          this.server!.removeListener('error', reject)
          const addr = this.server!.address()
          resolve(typeof addr === 'object' && addr ? addr.port : 0)
        })
      })
    } catch (err) {
      // Slice 7c：listen 失败（如 EADDRINUSE）必须清理已创建的 server，
      // 否则 this.server 引用泄漏，后续 start() 无法重新创建 server
      this.server!.close()
      this.server = null
      throw err
    }

    const url = `http://${lanIp}:${actualPort}/`

    this.session = {
      active: true,
      port: actualPort,
      url,
      pin,
      files: fileInfos,
      startedAt: Date.now(),
      timeoutMs
    }

    this.scheduleTimeout(timeoutMs)
    logger.info(`[WifiShare] 服务已启动：${url}，PIN：${pin}，共 ${fileInfos.length} 个文件`)
    return this.session
  }

  stop(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle)
      this.timeoutHandle = null
    }
    if (this.server) {
      this.server.closeAllConnections?.()
      this.server.close()
      this.server = null
    }
    if (this.session) {
      logger.info(`[WifiShare] 服务已停止（端口 ${this.session.port}）`)
    }
    this.session = null
    // P0-C：清理认证 token
    this.authTokens.clear()
    // F-S3：清理失败计数与锁定状态
    this.failedAttempts = 0
    this.lockUntil = 0
  }

  getStatus(): WifiShareSession | null {
    return this.session
  }

  /**
   * 收集文件信息并校验可访问性
   */
  private async collectFiles(files: string[]): Promise<WifiShareSession['files']> {
    const result: WifiShareSession['files'] = []
    for (const filePath of files) {
      try {
        const stat = fs.statSync(filePath)
        if (!stat.isFile()) continue
        // P2-A：保留点号以匹配 media-constants getMimeType 签名
        const ext = path.extname(filePath).toLowerCase()
        result.push({
          path: filePath,
          name: path.basename(filePath),
          size: stat.size,
          type: getMimeType(ext)
        })
      } catch {
        // 文件不可访问则跳过
      }
    }
    return result
  }

  // P2-A：getMimeType 已改用 media-constants 单一权威来源

  /**
   * 处理 HTTP 请求：根路径展示文件列表，/download?id=N 下载文件
   * P0-C：除 /auth 外所有路径需通过 PIN 鉴权（query 或 Cookie 携带 token）
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.session) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(t('main.share.http.serviceNotStarted'))
      return
    }

    // F-S3：校验客户端 IP 必须为私有 IPv4 段（10./172.16-31./192.168.）
    // 拒绝任何非局域网来源，避免被外部探测
    const remoteAddr = req.socket.remoteAddress ?? ''
    if (!PRIVATE_IP_REGEX.test(remoteAddr)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(t('main.share.http.forbiddenNonLan'))
      logger.warn(t('main.share.log.rejectedNonLan', { addr: remoteAddr }))
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const pathname = decodeURIComponent(url.pathname)

    // 安全收紧：CORS 头不再使用通配符 '*'。
    // 仅当请求来源（Origin）属于本机回环或私有网段时，才回显该 Origin 并下发
    // Access-Control-Allow-Credentials，以配合 HttpOnly Cookie 鉴权；
    // 公网 / 无法识别来源一律不回显，浏览器将拒绝跨域访问，从而降低 token 经 URL / 代理日志泄露的风险。
    const origin = req.headers.origin
    if (origin && this.isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
    }

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.writeHead(204)
      res.end()
      return
    }

    // P0-C：PIN 码认证端点 —— POST /auth?pin=XXXX，校验通过颁发 token（Set-Cookie）
    if (pathname === '/auth') {
      this.handleAuth(url.searchParams.get('pin') ?? '', res)
      return
    }

    // P0-C：除 /auth 外所有路径需校验 token
    if (!this.isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${t('main.share.http.authTitle')}</title><style>body{font-family:-apple-system,sans-serif;background:#f5f5f7;color:#1d1d1f;padding:24px;}h1{font-size:20px;margin-bottom:12px;}.card{background:#fff;border-radius:12px;padding:20px;max-width:360px;margin:0 auto;}input{width:100%;padding:12px;font-size:18px;text-align:center;letter-spacing:8px;border:1px solid #d2d2d7;border-radius:8px;box-sizing:border-box;margin:8px 0;}button{width:100%;padding:12px;background:#007aff;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;}button:active{background:#0051d5;}.err{color:#ff3b30;font-size:13px;margin-top:8px;}</style></head><body><div class="card"><h1>${t('main.share.http.authPrompt')}</h1><p style="color:#6e6e73;font-size:13px;margin-bottom:8px;">${t('main.share.http.authHint')}</p><form onsubmit="fetch('/auth?pin='+document.getElementById('pin').value).then(r=>r.ok?location.reload():r.text().then(t=>document.getElementById('err').textContent=t)).catch(()=>document.getElementById('err').textContent='${t('main.share.http.networkError')}');return false;"><input id="pin" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="${t('main.share.http.pinPlaceholder')}" autofocus><button type="submit">${t('main.share.http.authSubmit')}</button><div class="err" id="err"></div></form></div></body></html>`
      )
      return
    }

    if (pathname === '/' || pathname === '/index.html') {
      this.serveIndexPage(res)
      return
    }

    if (pathname.startsWith('/download')) {
      const idParam = url.searchParams.get('id')
      const id = idParam ? parseInt(idParam, 10) : NaN
      if (Number.isNaN(id) || id < 0 || id >= this.session.files.length) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(t('main.share.http.fileNotFound'))
        return
      }
      this.serveFile(this.session.files[id], req, res)
      return
    }

    // /thumb?id=N 提供缩略图（小图预览，复用原图但限制输出大小为 200x200）
    if (pathname.startsWith('/thumb')) {
      const idParam = url.searchParams.get('id')
      const id = idParam ? parseInt(idParam, 10) : NaN
      if (Number.isNaN(id) || id < 0 || id >= this.session.files.length) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(t('main.share.http.fileNotFound'))
        return
      }
      this.serveFile(this.session.files[id], req, res, true)
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(t('main.share.http.pathNotFound'))
  }

  /**
   * P0-C：处理 PIN 码认证
   * 校验通过后生成随机 token，通过 Set-Cookie 返回，同时记录到 authTokens 集合
   * F-S3：5 次错误锁定 5 分钟，锁定期间直接拒绝
   */
  private handleAuth(pin: string, res: http.ServerResponse): void {
    if (!this.session) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(t('main.share.http.serviceNotStarted'))
      return
    }

    // F-S3：锁定期间直接拒绝，并提示剩余时间
    const now = Date.now()
    if (now < this.lockUntil) {
      const remainSec = Math.ceil((this.lockUntil - now) / 1000)
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(t('main.share.http.tooManyAttempts', { seconds: String(remainSec) }))
      return
    }

    if (pin !== this.session.pin) {
      this.failedAttempts++
      if (this.failedAttempts >= MAX_FAILED_ATTEMPTS) {
        this.lockUntil = now + LOCK_DURATION_MS
        this.failedAttempts = 0
        logger.warn(
          t('main.share.log.pinLocked', {
            count: String(MAX_FAILED_ATTEMPTS),
            minutes: String(LOCK_DURATION_MS / 60000)
          })
        )
        res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(t('main.share.http.locked', { minutes: String(LOCK_DURATION_MS / 60000) }))
      } else {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(
          t('main.share.http.pinWrong', {
            count: String(MAX_FAILED_ATTEMPTS - this.failedAttempts)
          })
        )
      }
      return
    }

    // 认证成功：清空失败计数
    this.failedAttempts = 0
    this.lockUntil = 0

    // 生成 32 字节随机 token
    const token = crypto.randomBytes(32).toString('hex')
    this.authTokens.add(token)
    // 设置 Cookie（HttpOnly 防 XSS 读取，SameSite=Lax 允许导航跳转携带，Path=/ 覆盖所有路径）
    res.setHeader(
      'Set-Cookie',
      `auth_token=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(this.session.timeoutMs / 1000)}`
    )
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(t('main.share.http.authSuccess'))
    logger.info(t('main.share.log.authSuccess', { token: token.slice(0, 8) }))
  }

  /**
   * 校验请求来源（Origin）是否属于本机回环或私有网段。
   * 仅当源站满足下列情形才允许把 Access-Control-Allow-Origin 回显为该来源，
   * 避免对任意公网来源放行：
   * - 本机回环：localhost / 127.0.0.1 / ::1
   * - 私有 IPv4：10.x / 172.16-31.x / 192.168.x
   * - IPv6 ULA（fd00::/8）/ 链路本地（fe80::/10），含 ::ffff: 映射的 IPv4
   * 复用现有 PRIVATE_IP_REGEX 的判定思路（对 host 名直接做前缀匹配）。
   */
  private isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) return false
    let host: string
    try {
      host = new URL(origin).hostname
    } catch {
      return false
    }
    // 本机回环（IPv6 回环在 URL 中可能为 [::1]，需去括号）
    const normalized = host.replace(/^\[|\]$/g, '').toLowerCase()
    if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1') {
      return true
    }
    // 私有网段：PRIVATE_IP_REGEX 已覆盖 ::ffff: 映射、私有 IPv4、IPv6 ULA / 链路本地
    return PRIVATE_IP_REGEX.test(normalized)
  }

  /**
   * P0-C：校验请求是否已认证
   * 优先检查 Cookie 中的 auth_token，回退到 query 参数 ?token=（用于 <img> 等无法带 Cookie 的场景）
   */
  private isAuthorized(req: http.IncomingMessage): boolean {
    if (this.authTokens.size === 0) return false

    // 1. 检查 Cookie
    const cookie = req.headers.cookie ?? ''
    const match = cookie.match(/auth_token=([a-f0-9]+)/)
    if (match && this.authTokens.has(match[1])) return true

    // 2. 检查 query 参数 token（用于 <img src> 等场景）
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const tokenParam = url.searchParams.get('token')
    if (tokenParam && this.authTokens.has(tokenParam)) return true

    return false
  }

  /**
   * 渲染文件列表页（HTML）
   */
  private serveIndexPage(res: http.ServerResponse): void {
    if (!this.session) return
    const items = this.session.files
      .map(
        (f, i) => `
        <li class="file-item" onclick="location.href='/download?id=${i}'">
          <div class="icon">${f.type.startsWith('image/') ? IMAGE_ICON_SVG : VIDEO_ICON_SVG}</div>
          <div class="info">
            <div class="name">${this.escapeHtml(f.name)}</div>
            <div class="meta">${this.formatSize(f.size)}</div>
          </div>
          <a class="dl" href="/download?id=${i}">下载</a>
        </li>`
      )
      .join('')

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>无限暖暖相册分享</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f7; color: #1d1d1f; padding: 16px; }
  h1 { font-size: 20px; margin-bottom: 8px; }
  .summary { color: #6e6e73; font-size: 13px; margin-bottom: 16px; }
  ul { list-style: none; }
  .file-item { display: flex; align-items: center; gap: 12px; padding: 12px; background: #fff; border-radius: 12px; margin-bottom: 8px; cursor: pointer; transition: transform 0.15s; }
  .file-item:active { transform: scale(0.98); }
  .icon { display: flex; align-items: center; }
  .info { flex: 1; min-width: 0; }
  .name { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { font-size: 12px; color: #6e6e73; margin-top: 2px; }
  .dl { color: #007aff; text-decoration: none; font-size: 14px; padding: 6px 12px; border: 1px solid #007aff; border-radius: 8px; }
  .dl:active { background: #007aff; color: #fff; }
</style>
</head>
<body>
  <h1>无限暖暖相册分享</h1>
  <p class="summary">共 ${this.session.files.length} 个文件，点击即可下载</p>
  <ul>${items}</ul>
</body>
</html>`

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  }

  /**
   * 提供文件下载（支持 Range 请求，206 Partial Content）
   *
   * 异步错误兜底（H2）：`stream.pipe(res)` 一返回，外层 try 块就结束了，之后任何
   * 异步阶段的错误（文件被移走/被占用、权限变更 EACCES/EPERM、磁盘 IO 错误）都不会
   * 进入 catch。`Readable.pipe()` 只会把源流错误转发给 res，res 上没有 error 监听器时
   * 会升级为未捕获异常或静默 reset（客户端看到 ECONNRESET、服务端零日志）。
   * 因此这里对流和响应都挂监听，统一交给 fail() 处理，并在任何终止路径归还 fd。
   */
  private serveFile(
    file: WifiShareSession['files'][number],
    req: http.IncomingMessage,
    res: http.ServerResponse,
    asThumb = false
  ): void {
    let stream: fs.ReadStream | null = null
    let settled = false

    // 单一失败出口：stream 'error' / res 'error' / 同步异常共用；settled 保证只执行一次
    // （pipe() 会把同一个错误同时送到 stream 与 res，两个监听都会触发 fail）
    const fail = (err: unknown): void => {
      if (settled) return
      settled = true

      // 无论走哪条路径都先归还 fd（Windows 上未关闭的 fd 会锁住文件）
      if (stream && !stream.destroyed) stream.destroy()

      // 响应已完整结束：无需再补状态码
      if (res.writableEnded) return

      try {
        if (res.headersSent) {
          // 头已发出，HTTP 语义上无法再改状态码：断连优于让客户端拿到截断的"成功"响应
          res.destroy()
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(t('main.share.http.readFailed'))
        }
      } catch {
        // 响应已不可用（连接已断/已被销毁）：此时再操作响应会抛错，
        // 而这里本身就在错误处理路径上，不能让兜底逻辑自身抛出未捕获异常
      }

      logger.error(t('main.share.log.readFailed', { path: file.path }), err)
    }

    try {
      const stat = fs.statSync(file.path)
      const fileSize = stat.size
      const range = this.parseRange(req.headers.range, fileSize)

      res.setHeader('Content-Type', asThumb ? 'image/jpeg' : file.type)
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`
      )

      // 先建流再 writeHead：建流若同步抛错（如 Range 非法），响应头仍未发出，可正常回 500
      stream = createManagedReadStream(file.path, { range, onError: fail })

      if (range) {
        res.writeHead(206, {
          'Content-Range': `bytes ${range.start}-${range.end}/${fileSize}`,
          'Content-Length': range.end - range.start + 1
        })
      } else {
        res.writeHead(200, { 'Content-Length': fileSize })
      }

      // 响应侧错误（客户端断连、写失败）与提前关闭都要兜底，否则源流可能一直持有 fd
      res.on('error', fail)
      res.on('close', () => {
        if (stream && !stream.destroyed) stream.destroy()
      })

      stream.pipe(res)
    } catch (err) {
      fail(err)
    }
  }

  /**
   * 解析 Range 请求头（bytes=start-end）。
   * 越界或不合法返回 undefined → 回落为 200 全量（保持既有行为；播放器对 416 的
   * 兼容性差异较大，本次不升级为 416）。
   */
  private parseRange(header: string | undefined, fileSize: number): ByteRange | undefined {
    if (!header) return undefined
    const match = /bytes=(\d*)-(\d*)/.exec(header)
    if (!match) return undefined

    const start = match[1] ? parseInt(match[1], 10) : 0
    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1
    if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
    if (start < 0 || end >= fileSize || start > end) return undefined

    return { start, end }
  }

  /**
   * 获取本机局域网地址，用于绑定分享服务。
   *
   * 选择策略（确保绑定到真实家庭局域网、且不会被误绑到 VPN / Tailscale / 公网网卡）：
   *  1) 优先使用 network-address：它按“默认路由”探测对外局域网地址，
   *     不会像 os.networkInterfaces() 那样简单返回“第一个”网卡；
   *  2) 若默认路由探测失败或返回 0.0.0.0 / 127.0.0.1，则回退到网卡扫描：
   *     a. 优先返回 IPv4 私有网段（10. / 172.16-31. / 192.168.）；
   *     b. 若无 IPv4 私有地址，返回 IPv6 ULA(fd00::/8) 或链路本地(fe80::/10)；
   *     c. 仍无则回退 127.0.0.1（仅本机可达）。
   *
   * 注意：仅确定“绑定地址”，入站客户端仍需通过 PRIVATE_IP_REGEX 白名单校验。
   */
  private getLanIp(): string {
    // 1) 优先按默认路由拿到对外局域网地址；并校验其确实落在某张“非虚拟、非回环”
    //    的真实网卡上，避免 network-address 在默认路由指向 VMware/Docker 虚拟网卡时
    //    误选其私有 IP（如 VMware NAT 192.168.184.x）。
    const byRoute = this.getAddressByDefaultRoute()
    if (byRoute && byRoute !== '0.0.0.0' && byRoute !== '127.0.0.1' && this.isLanAddress(byRoute)) {
      return byRoute
    }
    // 2) 回退：扫描网卡（跳过虚拟网卡），优先 IPv4 私有段，其次 IPv6 ULA / 链路本地
    return this.getLanIpFromInterfaces()
  }

  /**
   * 通过默认路由探测对外局域网地址（基于 socket 默认路由，零依赖开源库 network-address）。
   * 若探测异常则回退到网卡扫描，不影响启动。
   */
  private getAddressByDefaultRoute(): string {
    try {
      return networkAddress()
    } catch {
      return ''
    }
  }

  /**
   * 兜底：遍历网卡，优先返回 IPv4 私有段，其次 IPv6 ULA / 链路本地，最后 127.0.0.1。
   * 仅接受私有网段，过滤 VPN / 公网网卡。
   */
  private getLanIpFromInterfaces(): string {
    const interfaces = os.networkInterfaces()
    let ipv6Candidate = ''
    for (const name of Object.keys(interfaces)) {
      const list = interfaces[name]
      if (!list) continue
      for (const item of list) {
        if (item.internal) continue
        // 跳过虚拟/隧道网卡（VMware/Docker/VPN 等），其私有 IP 不可作为对外分享地址
        if (this.isVirtualAdapter(name, item.address)) continue
        if (item.family === 'IPv4') {
          // 仅接受私有网段，避免误绑 VPN / 公网接口
          if (this.isPrivateIpv4(item.address)) {
            return item.address
          }
        } else if (item.family === 'IPv6') {
          // 收集第一个 ULA(fd00::/8) 或链路本地(fe80::/10) 作为 IPv6 候选
          if (!ipv6Candidate && this.isPrivateIpv6(item.address)) {
            ipv6Candidate = item.address
          }
        }
      }
    }
    return ipv6Candidate || '127.0.0.1'
  }

  /** 判断是否为私有 IPv4 网段（10.x / 172.16-31.x / 192.168.x） */
  private isPrivateIpv4(address: string): boolean {
    return /^(10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address)
  }

  /**
   * 判断网卡名称是否属于虚拟/隧道适配器（VMware / VirtualBox / Docker /
   * Hyper-V / VPN / Tailscale / ZeroTier / WireGuard 等）。这些适配器的私有 IP
   * （如 VMware NAT 192.168.184.x、Docker 桥接 172.17.x）不可作为对外分享地址。
   */
  private isVirtualAdapter(name: string, _address: string): boolean {
    const n = name.toLowerCase()
    return /(vmware|vmnet|virtualbox|vbox|docker|hyper-v|vethernet|tailscale|zerotier|wireguard|wg-|vpn|tap-|tun-)/.test(
      n
    )
  }

  /**
   * 判断给定地址是否落在某张“非回环、非虚拟”的真实网卡上。
   * 用于在采用 network-address 默认路由结果前做二次校验，避免误选虚拟网卡 IP。
   */
  private isLanAddress(addr: string): boolean {
    const target = addr.split('%')[0].toLowerCase()
    const interfaces = os.networkInterfaces()
    for (const name of Object.keys(interfaces)) {
      const list = interfaces[name]
      if (!list) continue
      for (const item of list) {
        if (item.internal) continue
        if (this.isVirtualAdapter(name, item.address)) continue
        if (item.address.split('%')[0].toLowerCase() === target) return true
      }
    }
    return false
  }

  /**
   * 判断是否为私有 IPv6 地址：ULA(fd00::/8) 或链路本地(fe80::/10)。
   * 忽略可能存在的 zone id（如 fe80::1%eth0）。
   */
  private isPrivateIpv6(address: string): boolean {
    const a = address.split('%')[0].toLowerCase()
    return /^fd[0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a)
  }

  private scheduleTimeout(timeoutMs: number): void {
    this.timeoutHandle = setTimeout(() => {
      logger.info(`[WifiShare] 超时自动关闭（${Math.floor(timeoutMs / 60000)} 分钟）`)
      this.stop()
    }, timeoutMs)
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }
}

export const wifiShareService = new WifiShareService()
