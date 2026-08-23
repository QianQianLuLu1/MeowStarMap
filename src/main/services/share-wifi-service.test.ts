import { describe, it, expect, beforeEach, vi } from 'vitest'
import http from 'http'
import fs from 'fs'
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
    promises: {
      appendFile: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue([]),
      unlink: vi.fn().mockResolvedValue(undefined)
    }
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

// ============================================================
// Helpers
// ============================================================

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
