import https from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { API_ROUTES, PROTOCOL_VERSION, type WsEvent } from '../../../shared/sync/protocol'
import type { SyncLogger } from '../identity-service'
import { createApiRequestHandler, type ApiRequestHandler } from './api-router'
import { WebSocketHub } from './ws-hub'
import type { SyncApiServices } from './types'

/**
 * SyncServer 门面 — 主进程常驻 HTTPS 同步服务器（协议 v1 + WebSocket）。
 *
 * - TLS：证书由装配层经 SyncIdentityService 提供（自签，指纹用于 QR 配对）
 * - 端口策略：默认 27124（上游无固定端口约定，配对 URI 显式携带 host:port）；
 *   EADDRINUSE 时 +1 重试至 portRetryLimit，port=0 时交由系统分配不重试
 * - 生命周期：start 幂等；stop 优雅关闭（停收新连接 → WS 发 close 帧 →
 *   活动流 3s 宽限后强制断开）；广播接口供装配层事件汇调用
 * - 部署：主进程内运行（复用阶段 2/3 服务与 DB 连接；IO 全异步流式，
 *   客户端为局域网 1-2 台手机，不阻塞事件循环），见 04 计划 §6
 */

/** 默认端口（WXNN 自定；配对 QR 显式携带实际绑定端口） */
export const SYNC_SERVER_DEFAULT_PORT = 27124
const DEFAULT_PORT_RETRY_LIMIT = 10
const REQUEST_TIMEOUT_MS = 30_000
const STOP_GRACE_MS = 3_000

export interface SyncServerTls {
  key: string
  cert: string
}

export interface SyncServerOptions {
  tls: SyncServerTls
  host?: string
  port?: number
  /** EADDRINUSE 时向后的重试次数（尝试 port..port+limit）；port=0 时无意义 */
  portRetryLimit?: number
  maxJsonBodyBytes?: number
  logger?: SyncLogger
}

export interface SyncServerAddress {
  host: string
  port: number
  secure: boolean
}

export interface SyncServerStatus {
  running: boolean
  host: string
  port: number
  connections: number
}

export class SyncServer {
  private readonly services: SyncApiServices
  private readonly options: Required<Omit<SyncServerOptions, 'tls' | 'logger'>> &
    Pick<SyncServerOptions, 'tls' | 'logger'>
  private readonly hub: WebSocketHub
  private readonly requestHandler: ApiRequestHandler
  private server: https.Server | undefined
  private address: SyncServerAddress | undefined

  constructor(services: SyncApiServices, options: SyncServerOptions) {
    this.services = services
    this.options = {
      host: options.host ?? '0.0.0.0',
      port: options.port ?? SYNC_SERVER_DEFAULT_PORT,
      portRetryLimit: options.portRetryLimit ?? DEFAULT_PORT_RETRY_LIMIT,
      maxJsonBodyBytes: options.maxJsonBodyBytes ?? 1024 * 1024,
      tls: options.tls,
      logger: options.logger
    }
    this.hub = new WebSocketHub(options.logger)
    this.requestHandler = createApiRequestHandler({
      services,
      config: { maxJsonBodyBytes: this.options.maxJsonBodyBytes },
      logger: options.logger
    })
  }

  get connectionCount(): number {
    return this.hub.size
  }

  getStatus(): SyncServerStatus {
    return {
      running: this.server !== undefined,
      host: this.address?.host ?? this.options.host,
      port: this.address?.port ?? this.options.port,
      connections: this.hub.size
    }
  }

  /** 启动（幂等）。端口冲突时 +1 重试；port=0 交由系统分配 */
  async start(): Promise<SyncServerAddress> {
    if (this.server && this.address) return { ...this.address }
    const server = https.createServer(
      { key: this.options.tls.key, cert: this.options.tls.cert },
      (req, res) => {
        void this.requestHandler(req, res)
      }
    )
    server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
      void this.handleUpgrade(req, socket)
    })
    server.setTimeout(REQUEST_TIMEOUT_MS)

    const basePort = this.options.port
    const attempts = basePort === 0 ? 1 : this.options.portRetryLimit + 1
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt++) {
      const port = basePort === 0 ? 0 : basePort + attempt
      try {
        await this.listen(server, port)
        const bound = server.address()
        if (!bound || typeof bound === 'string') {
          throw new Error('sync server did not expose a TCP address')
        }
        this.server = server
        this.address = { host: this.options.host, port: bound.port, secure: true }
        this.options.logger?.info(
          `[sync] HTTPS sync server listening at ${this.options.host}:${bound.port}`
        )
        return { ...this.address }
      } catch (error) {
        lastError = error
        if (basePort === 0) break
        if (!isAddressInUse(error)) break
        this.options.logger?.warn(`[sync] port ${port} is already in use, trying the next port`)
      }
    }
    try {
      server.close()
    } catch {
      // 从未成功监听
    }
    throw lastError instanceof Error ? lastError : new Error('sync server failed to start')
  }

  /** 优雅停止：停收新连接 → WS 客户端发 close 帧 → 活动流宽限后强制断开 */
  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    this.address = undefined
    this.hub.close()
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      server.close(() => finish())
      const timer = setTimeout(() => {
        try {
          server.closeAllConnections()
        } catch {
          // 旧版 Node 无此 API；close 回调兜底
        }
        finish()
      }, STOP_GRACE_MS)
      timer.unref()
    })
    this.options.logger?.info('[sync] HTTPS sync server stopped')
  }

  /** 向全部已连接客户端广播 WsEvent（asset.* / library.rescan.*） */
  broadcastEvent(event: WsEvent): void {
    this.hub.broadcast(event)
  }

  private listen(server: https.Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, this.options.host, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://wxnn.local')
      if (url.pathname !== API_ROUTES.websocket) {
        socket.destroy()
        return
      }
      // 升级请求即签名：GET + 原始 url + 4 头 + 空 body（对齐 Android RealtimeWebSocket）
      const auth = await this.services.verifyRequest({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers
      })
      if (!auth.ok) {
        socket.destroy()
        return
      }
      if (!this.hub.upgrade(req, socket)) {
        socket.destroy()
        return
      }
      const identity = await this.services.getServerIdentity()
      const hello: WsEvent = {
        event: 'server.hello',
        protocolVersion: PROTOCOL_VERSION,
        serverId: identity.serverId,
        libraryRevision: this.services.getCurrentRevision(),
        occurredAt: new Date().toISOString()
      }
      this.hub.send(socket, hello)
    } catch (error) {
      this.options.logger?.warn(
        `[sync] websocket upgrade failed: ${error instanceof Error ? error.message : String(error)}`
      )
      socket.destroy()
    }
  }
}

function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE'
}
