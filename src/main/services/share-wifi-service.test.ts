import { describe, it, expect, beforeEach, vi } from 'vitest'
import http from 'http'
import fs from 'fs'
import { EventEmitter } from 'events'
import Module from 'node:module'

/**
 * Slice 7c：share-wifi-service timeoutHandle 显式清理 — 回归测试
 *
 * 目的：验证 start() 失败路径（listen 失败）不会泄漏 server 引用
 *
 * 测试接缝（seam）：
 *   - 公共导出：wifiShareService.start / stop / getStatus
 *   - 通过 mock http / fs / os 观察行为
 */

// ============================================================
// Mock 声明（hoisted）
// ============================================================

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/test-userdata'),
    getVersion: vi.fn(() => '2.5.0')
  }
}))

vi.mock('fs', () => ({
  default: {
    statSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(),
    createReadStream: vi.fn(),
    promises: {
      appendFile: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue([]),
      unlink: vi.fn().mockResolvedValue(undefined)
    }
  }
}))

// logger 整体桩掉：避免单测写真实日志文件，同时便于断言错误留痕
vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fault: vi.fn()
  }
}))

vi.mock('os', () => ({
  default: {
    networkInterfaces: vi.fn(() => ({
      eth0: [{ family: 'IPv4', address: '192.168.1.100', internal: false }]
    }))
  }
}))

// 实现用 require('network-address') 加载（share-wifi-service.ts:25），
// 该 CJS require 不走 Vite 模块图，vi.mock 无法拦截；这里在加载被测模块前
// 直接拦截 Node 的 Module._load，固定返回 192.168.1.100（仅此 fork 生效）
const _originalLoad = Module._load
Module._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === 'network-address') return () => '192.168.1.100'
  return _originalLoad.call(this, request, parent, isMain)
}

// ============================================================
// Import after mock
// ============================================================
const { wifiShareService } = await import('./share-wifi-service')
const { logger } = await import('../utils/logger')
const { t } = await import('../i18n')

// ============================================================
// Helpers
// ============================================================

// serveFile 是私有方法：与 connection.test.ts 的 `(service as unknown as {...})` 同款
// 强制转换访问，避免为测试而放宽封装
type ShareFile = { path: string; name: string; size: number; type: string }
type ServeFile = (
  file: ShareFile,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  asThumb?: boolean
) => void
function serveFile(
  file: ShareFile,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  asThumb?: boolean
): void {
  const fn = (wifiShareService as unknown as { serveFile: ServeFile }).serveFile
  fn.call(wifiShareService, file, req, res, asThumb)
}

/** 假读流：EventEmitter 提供 on/once/emit，destroy 置 destroyed（与 fs.ReadStream 语义一致） */
class FakeStream extends EventEmitter {
  destroyed = false
  pipe = vi.fn()
  destroy = vi.fn(() => {
    this.destroyed = true
  })
}

/** 假响应：writeHead 置 headersSent、end 置 writableEnded（与 ServerResponse 语义一致） */
class FakeRes extends EventEmitter {
  headersSent = false
  writableEnded = false
  setHeader = vi.fn()
  writeHead = vi.fn(() => {
    this.headersSent = true
    return this
  })
  end = vi.fn(() => {
    this.writableEnded = true
    return this
  })
  destroy = vi.fn()
}

function makeReq(range?: string): http.IncomingMessage {
  return {
    headers: range ? { range } : {},
    socket: { remoteAddress: '127.0.0.1' },
    url: '/download?id=0'
  } as unknown as http.IncomingMessage
}

const TEST_FILE: ShareFile = {
  path: 'C:\\photos\\a.jpg',
  name: 'a.jpg',
  size: 1024,
  type: 'image/jpeg'
}

interface MockServer {
  setTimeout: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  listen: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  closeAllConnections: ReturnType<typeof vi.fn>
  address: ReturnType<typeof vi.fn>
  _errorCbs: ((err: Error) => void)[]
}

function createMockServer(listenMode: 'success' | 'fail' = 'success'): MockServer {
  const errorCbs: ((err: Error) => void)[] = []
  return {
    setTimeout: vi.fn(),
    once: vi.fn((event: string, cb: (err: Error) => void) => {
      if (event === 'error') errorCbs.push(cb)
    }),
    removeListener: vi.fn(),
    listen: vi.fn((_port: number, _host: string, cb: () => void) => {
      if (listenMode === 'success') {
        // 同步触发 listening 回调（兼容 fake timers）
        cb()
      } else {
        // 同步触发 error 回调
        errorCbs.forEach((fn) => fn(new Error('EADDRINUSE')))
      }
    }),
    close: vi.fn(),
    closeAllConnections: vi.fn(),
    address: vi.fn(() => ({ port: 54321, address: '192.168.1.100', family: 'IPv4' })),
    _errorCbs: errorCbs
  }
}

beforeEach(() => {
  wifiShareService.stop()
  vi.clearAllMocks()
  vi.mocked(fs.statSync).mockReturnValue({
    isFile: () => true,
    size: 1024
  } as never)
})

// ============================================================
// 测试用例
// ============================================================

describe('Slice 7c：share-wifi-service 资源清理', () => {
  describe('start() listen 失败路径', () => {
    it('listen 失败（EADDRINUSE）→ server.close 被调用，不泄漏', async () => {
      const mockServer = createMockServer('fail')
      const createServerSpy = vi.spyOn(http, 'createServer').mockReturnValue(mockServer as never)

      // start() 应抛出 EADDRINUSE 错误
      await expect(wifiShareService.start(['C:\\test.jpg'])).rejects.toThrow('EADDRINUSE')

      // 验证：mock server 的 close 被调用（资源被清理）
      expect(mockServer.close).toHaveBeenCalled()

      createServerSpy.mockRestore()
    })

    it('listen 失败后再次 start() 成功 → 不受上次失败影响', async () => {
      // 第一次：listen 失败
      const failServer = createMockServer('fail')
      const createServerSpy = vi.spyOn(http, 'createServer').mockReturnValue(failServer as never)

      await expect(wifiShareService.start(['C:\\test.jpg'])).rejects.toThrow()
      expect(failServer.close).toHaveBeenCalled()

      // 第二次：listen 成功
      const okServer = createMockServer('success')
      createServerSpy.mockReturnValue(okServer as never)

      const session = await wifiShareService.start(['C:\\test.jpg'])
      expect(session.active).toBe(true)
      expect(session.url).toContain('192.168.1.100')

      wifiShareService.stop()
      createServerSpy.mockRestore()
    })
  })

  describe('stop() 清理 timeoutHandle', () => {
    it('start 成功后 stop → 超时回调不再触发', async () => {
      const mockServer = createMockServer('success')
      const createServerSpy = vi.spyOn(http, 'createServer').mockReturnValue(mockServer as never)

      vi.useFakeTimers()

      const session = await wifiShareService.start(['C:\\test.jpg'], 0, 1000)
      expect(session.active).toBe(true)

      // stop 清理 timeoutHandle
      wifiShareService.stop()
      expect(wifiShareService.getStatus()).toBeNull()

      // 快进 5 秒，验证超时回调不再触发 stop（getStatus 仍为 null，不会重新激活）
      vi.advanceTimersByTime(5000)
      expect(wifiShareService.getStatus()).toBeNull()

      vi.useRealTimers()
      createServerSpy.mockRestore()
    })
  })

  describe('重复 start 清理旧 timer', () => {
    it('start 成功后再次 start → 旧 timeoutHandle 被清理，新 timer 正常工作', async () => {
      const mockServer = createMockServer('success')
      const createServerSpy = vi.spyOn(http, 'createServer').mockReturnValue(mockServer as never)

      vi.useFakeTimers()

      // 第一次 start，超时 10 秒
      const session1 = await wifiShareService.start(['C:\\test.jpg'], 0, 10000)
      expect(session1.active).toBe(true)

      // 第二次 start（会先 stop 旧的，清理旧 timer）
      const session2 = await wifiShareService.start(['C:\\test.jpg'], 0, 10000)
      expect(session2.active).toBe(true)

      // 快进 10 秒，应触发第二次的超时（stop 被调用）
      vi.advanceTimersByTime(10000)
      expect(wifiShareService.getStatus()).toBeNull()

      vi.useRealTimers()
      createServerSpy.mockRestore()
    })
  })

  describe('scheduleTimeout 防御性清理', () => {
    it('start 成功 → stop → 再 start：无遗留 timer 意外触发', async () => {
      const mockServer = createMockServer('success')
      const createServerSpy = vi.spyOn(http, 'createServer').mockReturnValue(mockServer as never)

      vi.useFakeTimers()

      // 第一次 start，超时 5 秒
      await wifiShareService.start(['C:\\test.jpg'], 0, 5000)
      // 立即 stop
      wifiShareService.stop()

      // 第二次 start，超时 10 秒
      await wifiShareService.start(['C:\\test.jpg'], 0, 10000)

      // 快进 5 秒（第一次的超时时间）—— 不应触发 stop（旧 timer 已清理）
      vi.advanceTimersByTime(5000)
      expect(wifiShareService.getStatus()?.active).toBe(true)

      // 快进到 10 秒（第二次的超时时间）—— 应触发 stop
      vi.advanceTimersByTime(5000)
      expect(wifiShareService.getStatus()).toBeNull()

      vi.useRealTimers()
      createServerSpy.mockRestore()
    })
  })
})

describe('H2：serveFile 读流错误兜底与 fd 释放', () => {
  /**
   * 背景：`stream.pipe(res)` 一返回，外层 try/catch 就失效了；之后文件被移走/占用、
   * 权限变更等异步错误既不被捕获也不留日志，fd 还可能一直不归还。
   * 以下用例全部用假流手动 emit 事件驱动，无真实 IO、无时序竞争。
   */

  it('无 Range：200 + createReadStream(path, {}) + pipe(res)', () => {
    const stream = new FakeStream()
    vi.mocked(fs.createReadStream).mockReturnValue(stream as unknown as fs.ReadStream)
    const res = new FakeRes()

    serveFile(TEST_FILE, makeReq(), res as unknown as http.ServerResponse)

    expect(fs.createReadStream).toHaveBeenCalledWith(TEST_FILE.path, {})
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Length': 1024 })
    expect(stream.pipe).toHaveBeenCalledWith(res)
  })

  it('合法 Range：206 + Content-Range + createReadStream(path, {start,end})', () => {
    const stream = new FakeStream()
    vi.mocked(fs.createReadStream).mockReturnValue(stream as unknown as fs.ReadStream)
    const res = new FakeRes()

    serveFile(TEST_FILE, makeReq('bytes=0-9'), res as unknown as http.ServerResponse)

    expect(fs.createReadStream).toHaveBeenCalledWith(TEST_FILE.path, { start: 0, end: 9 })
    expect(res.writeHead).toHaveBeenCalledWith(206, {
      'Content-Range': 'bytes 0-9/1024',
      'Content-Length': 10
    })
  })

  it('越界 Range：回落 200 全量（既有行为，本次不升级为 416）', () => {
    const stream = new FakeStream()
    vi.mocked(fs.createReadStream).mockReturnValue(stream as unknown as fs.ReadStream)
    const res = new FakeRes()

    serveFile(TEST_FILE, makeReq('bytes=0-99999'), res as unknown as http.ServerResponse)

    expect(fs.createReadStream).toHaveBeenCalledWith(TEST_FILE.path, {})
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Length': 1024 })
  })

  it('统计阶段同步抛错（文件被占用/已删除）→ 500 + 本地化文案，且异常不外泄', () => {
    const stream = new FakeStream()
    vi.mocked(fs.createReadStream).mockReturnValue(stream as unknown as fs.ReadStream)
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error('EACCES')
    })
    const res = new FakeRes()

    expect(() =>
      serveFile(TEST_FILE, makeReq(), res as unknown as http.ServerResponse)
    ).not.toThrow()

    expect(res.writeHead).toHaveBeenCalledWith(500, {
      'Content-Type': 'text/plain; charset=utf-8'
    })
    expect(res.end).toHaveBeenCalledWith(t('main.share.http.readFailed'))
    expect(logger.error).toHaveBeenCalled()
  })

  it('读流异步报错（响应头已发出）→ 销毁读流归还 fd + res.destroy 断连 + 错误留痕', () => {
    const stream = new FakeStream()
    vi.mocked(fs.createReadStream).mockReturnValue(stream as unknown as fs.ReadStream)
    const res = new FakeRes()

    serveFile(TEST_FILE, makeReq(), res as unknown as http.ServerResponse)
    expect(res.headersSent).toBe(true)

    const ioError = new Error('EIO')
    // 修复前：无人监听 'error'，这里会抛出未捕获异常，且无任何日志
    expect(() => stream.emit('error', ioError)).not.toThrow()

    expect(stream.destroy).toHaveBeenCalled()
    expect(stream.destroyed).toBe(true)
    // 头已发出，不能再改状态码，只能断连（否则客户端会拿到截断的"成功"响应）
    expect(res.destroy).toHaveBeenCalled()
    expect(res.writeHead).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      t('main.share.log.readFailed', { path: TEST_FILE.path }),
      ioError
    )
  })

  it('客户端提前断开（res close）→ 读流被销毁，不残留 fd', () => {
    const stream = new FakeStream()
    vi.mocked(fs.createReadStream).mockReturnValue(stream as unknown as fs.ReadStream)
    const res = new FakeRes()

    serveFile(TEST_FILE, makeReq(), res as unknown as http.ServerResponse)
    res.emit('close')

    expect(stream.destroy).toHaveBeenCalled()
    expect(stream.destroyed).toBe(true)
  })

  it('源流与响应先后报错（pipe 会转发）→ fail 只执行一次，不重复记日志', () => {
    const stream = new FakeStream()
    vi.mocked(fs.createReadStream).mockReturnValue(stream as unknown as fs.ReadStream)
    const res = new FakeRes()

    serveFile(TEST_FILE, makeReq(), res as unknown as http.ServerResponse)

    stream.emit('error', new Error('ENOENT'))
    res.emit('error', new Error('ECONNRESET'))

    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(res.destroy).toHaveBeenCalledTimes(1)
  })
})
