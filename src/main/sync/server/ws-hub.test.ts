/**
 * WebSocketHub 单元测试（P6：连接开闭留痕）。
 *
 * 依赖声明：仅 node:events 与 vitest；被测模块零 Electron 依赖，socket 用
 *   EventEmitter + write/end 桩模拟 Duplex（握手/关闭语义不需要真 TCP）。
 * 启动说明：npx vitest run src/main/sync/server/ws-hub.test.ts
 * 错误处理：logger 抛异常时 hub 必须 fail-open（握手/关闭行为不受影响）。
 * 参数校验：握手头缺失/版本非法时 upgrade 返回 false 并留 warn 痕。
 * 基础测试：握手成功留 open 痕、close 事件留 closed 痕、非法握手留 warn 痕、
 *   logger 抛错不影响 upgrade 结果。
 */
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { WebSocketHub } from './ws-hub'

function makeSocket(remoteAddress = '192.168.1.23'): Duplex & {
  write: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
} {
  const emitter = new EventEmitter() as unknown as Duplex & {
    write: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
    destroyed: boolean
    remoteAddress: string
  }
  emitter.write = vi.fn()
  emitter.end = vi.fn()
  emitter.destroyed = false
  emitter.remoteAddress = remoteAddress
  return emitter
}

function makeUpgradeReq(headers: Record<string, string> = {}): IncomingMessage {
  return {
    headers: {
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      ...headers
    }
  } as unknown as IncomingMessage
}

function makeLoggedHub() {
  const logs = { info: [] as string[], warn: [] as string[] }
  const hub = new WebSocketHub({
    info: (message: string) => logs.info.push(message),
    warn: (message: string) => logs.warn.push(message)
  })
  return { hub, logs }
}

describe('P6：WebSocketHub 连接开闭日志', () => {
  it('握手成功：info 留痕含 [NikkiSync]、远端地址与连接数', () => {
    const { hub, logs } = makeLoggedHub()
    const socket = makeSocket()
    expect(hub.upgrade(makeUpgradeReq(), socket)).toBe(true)
    const line = logs.info.find((m) => m.includes('ws connection opened'))
    expect(line).toBeDefined()
    expect(line).toContain('[NikkiSync]')
    expect(line).toContain('192.168.1.23')
    expect(line).toContain('total=1')
  })

  it('连接关闭：close 事件后 info 留痕且连接数归零', () => {
    const { hub, logs } = makeLoggedHub()
    const socket = makeSocket()
    hub.upgrade(makeUpgradeReq(), socket)
    socket.emit('close')
    const line = logs.info.find((m) => m.includes('ws connection closed'))
    expect(line).toBeDefined()
    expect(line).toContain('[NikkiSync]')
    expect(line).toContain('total=0')
    expect(hub.size).toBe(0)
  })

  it('非法握手（缺 key）：upgrade 返回 false 并留 warn 痕', () => {
    const { hub, logs } = makeLoggedHub()
    const req = { headers: { 'sec-websocket-version': '13' } } as unknown as IncomingMessage
    expect(hub.upgrade(req, makeSocket())).toBe(false)
    const line = logs.warn.find((m) => m.includes('ws handshake rejected'))
    expect(line).toBeDefined()
    expect(line).toContain('[NikkiSync]')
  })

  it('fail-open：logger 抛异常不影响握手结果', () => {
    const hub = new WebSocketHub({
      info: () => {
        throw new Error('logger down')
      },
      warn: () => {
        throw new Error('logger down')
      }
    })
    expect(hub.upgrade(makeUpgradeReq(), makeSocket())).toBe(true)
    expect(hub.size).toBe(1)
  })
})
