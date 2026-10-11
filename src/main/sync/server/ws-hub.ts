import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WsEvent } from '../../../shared/sync/protocol'
import type { SyncLogger } from '../identity-service'

/**
 * 极简 RFC6455 服务端 hub（照上游 pc-companion WebSocketHub 语义移植，未引入 ws 包）：
 * - 握手：校验 Sec-WebSocket-Key 与 Version: 13 → 回 Sec-WebSocket-Accept
 * - 服务器→客户端：text 帧（顶层即 WsEvent JSON）；优雅关闭发 close 帧
 * - 客户端→服务器：仅处理 ping(0x9)→pong(0x8a，原样回显 payload) 与
 *   close(0x8)→回关并清理；其余帧忽略（协议无订阅/配置类消息）
 * - 已知限制（与上游一致）：按 data 事件逐 chunk 解析，跨 TCP 包分片或
 *   一包多帧不解析——Android RealtimeWebSocket 仅发送单个 ≤125B 的 ping，实际无影响
 */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
// 上方 SHA-1 为 RFC 6455 §1.3 规定的 Sec-WebSocket-Accept 固定推导公式（非安全原语），
// 与 GUID 常量一样属于协议 wire format，不可替换为其他哈希。
const OP_TEXT = 0x01
const OP_CLOSE = 0x08
const OP_PING = 0x09
const OP_PONG = 0x0a
const FIN = 0x80
const CONTROL_PAYLOAD_MAX = 125

function textFrame(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8')
  if (data.length < 126) {
    return Buffer.concat([Buffer.from([FIN | OP_TEXT, data.length]), data])
  }
  if (data.length <= 0xffff) {
    const head = Buffer.alloc(4)
    head[0] = FIN | OP_TEXT
    head[1] = 126
    head.writeUInt16BE(data.length, 2)
    return Buffer.concat([head, data])
  }
  const head = Buffer.alloc(10)
  head[0] = FIN | OP_TEXT
  head[1] = 127
  head.writeBigUInt64BE(BigInt(data.length), 2)
  return Buffer.concat([head, data])
}

function closeFrame(): Buffer {
  return Buffer.from([FIN | OP_CLOSE, 0x00])
}

export class WebSocketHub {
  private readonly sockets = new Set<Duplex>()

  constructor(private readonly logger?: SyncLogger) {}

  get size(): number {
    return this.sockets.size
  }

  upgrade(req: IncomingMessage, socket: Duplex): boolean {
    const key = req.headers['sec-websocket-key']
    const version = req.headers['sec-websocket-version']
    if (typeof key !== 'string' || version !== '13') return false
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n'
      ].join('\r\n')
    )
    this.sockets.add(socket)
    const remove = () => {
      this.sockets.delete(socket)
    }
    socket.on('close', remove)
    socket.on('error', remove)
    socket.on('data', (chunk: Buffer) => this.handleClientFrame(socket, chunk))
    return true
  }

  send(socket: Duplex, event: WsEvent): void {
    if (!socket.destroyed) socket.write(textFrame(JSON.stringify(event)))
  }

  broadcast(event: WsEvent): void {
    const frame = textFrame(JSON.stringify(event))
    for (const socket of this.sockets) {
      if (!socket.destroyed) socket.write(frame)
    }
  }

  /** 优雅关闭：全部客户端发 close 帧后结束连接（服务器停机路径） */
  close(): void {
    for (const socket of this.sockets) {
      if (!socket.destroyed) {
        socket.write(closeFrame())
        socket.end()
      }
    }
    this.sockets.clear()
  }

  private handleClientFrame(socket: Duplex, chunk: Buffer): void {
    if (chunk.length < 2) return
    const opcode = chunk[0]! & 0x0f
    if (opcode === OP_CLOSE) {
      socket.write(closeFrame())
      socket.end()
      return
    }
    if (opcode === OP_PING) {
      const masked = Boolean(chunk[1]! & 0x80)
      let length = chunk[1]! & 0x7f
      let offset = 2
      if (length === 126 && chunk.length >= 4) {
        length = chunk.readUInt16BE(2)
        offset = 4
      }
      if (length === 127) return // 64-bit 长度对控制帧非法（RFC6455 §5.5），忽略
      const bodyOffset = offset + (masked ? 4 : 0)
      let payload = chunk.subarray(bodyOffset, bodyOffset + length)
      if (masked && chunk.length >= bodyOffset + length) {
        const mask = chunk.subarray(offset, bodyOffset)
        const unmasked = Buffer.from(payload)
        for (let i = 0; i < unmasked.length; i++) unmasked[i] = unmasked[i]! ^ mask[i % 4]!
        payload = unmasked
      }
      // pong 载荷上限 125（RFC6455 控制帧约束）；超长回空 pong
      const reply = payload.length <= CONTROL_PAYLOAD_MAX ? payload : Buffer.alloc(0)
      socket.write(Buffer.concat([Buffer.from([FIN | OP_PONG, reply.length]), reply]))
      return
    }
    // text/binary 等客户端帧协议未定义，忽略
  }
}
