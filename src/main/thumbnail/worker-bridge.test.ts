/**
 * ThumbnailWorkerBridge 单元测试
 *
 * 测试目标：src/main/thumbnail/worker-bridge.ts
 * 测试层级：L2（依赖 mock，无真实 worker 进程）
 *
 * Mock 策略：
 * - electron.utilityProcess.fork → 返回 EventEmitter 模拟 worker
 * - ../utils/logger → vi.fn() 捕获调用
 *
 * 测试覆盖：
 * - processImage：握手成功后转发 THUMBNAIL_PROCESS_START、按 requestId 关联结果
 * - WORKER_READY 握手失败路径（回归：崩溃时永久挂死）
 *   worker 就绪前退出 / 10s 握手超时 / fork 失败 / dispose 均须 settle，
 *   且对调用方表现为"worker 不可用"，由 ThumbnailGenerator 降级到内联 sharp
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { UtilityProcess } from 'electron'
import type { ThumbnailProcessInput } from './worker-protocol'

// ---- Mock electron ----
const mockFork = vi.fn()
vi.mock('electron', () => ({
  utilityProcess: {
    fork: (...args: unknown[]) => mockFork(...args)
  }
}))

// ---- Mock logger ----
const mockLoggerError = vi.fn()
const mockLoggerWarn = vi.fn()
vi.mock('../utils/logger', () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: vi.fn(),
    debug: vi.fn(),
    fault: vi.fn()
  }
}))

import { ThumbnailWorkerBridge } from './worker-bridge'

/** 创建模拟 worker 对象（EventEmitter + postMessage + kill） */
function createMockWorker(): UtilityProcess & {
  postMessage: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
} {
  const emitter = new EventEmitter() as unknown as UtilityProcess & {
    postMessage: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
  }
  emitter.postMessage = vi.fn()
  emitter.kill = vi.fn()
  return emitter
}

const input: ThumbnailProcessInput = {
  requestId: 'req-1',
  filePath: '/src/a.png',
  fileHash: 'hash1',
  quality: 'standard',
  cacheDir: '/cache'
}

describe('ThumbnailWorkerBridge', () => {
  let bridge: ThumbnailWorkerBridge
  let mockWorker: ReturnType<typeof createMockWorker>

  beforeEach(() => {
    vi.clearAllMocks()
    mockFork.mockReset()
    mockWorker = createMockWorker()
    mockFork.mockReturnValue(mockWorker)
    bridge = new ThumbnailWorkerBridge()
  })

  afterEach(async () => {
    // 清理可能残留的握手 / 请求定时器，避免跨用例泄漏
    // 参照 scanner-worker-bridge.test.ts 的模式：fake timers 下推进 dispose 500ms 宽限
    vi.useFakeTimers()
    const disposePromise = bridge.dispose().catch(() => {})
    vi.advanceTimersByTime(500)
    await disposePromise
    vi.useRealTimers()
  })

  // ============ 正常路径 ============
  describe('processImage', () => {
    it('握手成功后应转发 THUMBNAIL_PROCESS_START 并按 requestId 关联结果', async () => {
      const p = bridge.processImage(input)
      mockWorker.emit('message', { type: 'WORKER_READY' })
      // 等待握手完成后 worker 才会收到命令
      await vi.waitFor(() => expect(mockWorker.postMessage).toHaveBeenCalled())

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        type: 'THUMBNAIL_PROCESS_START',
        payload: input
      })

      mockWorker.emit('message', {
        type: 'THUMBNAIL_PROCESS_COMPLETE',
        payload: {
          requestId: 'req-1',
          success: true,
          outputPath: '/cache/hash1.jpg',
          errorMessage: '',
          outputSize: 1024
        }
      })

      await expect(p).resolves.toMatchObject({ success: true, outputPath: '/cache/hash1.jpg' })
      expect(bridge.isAvailable()).toBe(true)
    })
  })

  // ============ WORKER_READY 握手失败路径（回归：崩溃时永久挂死）============
  // 任何提前终止路径都必须 settle readyPromise，只置 null 会让 processImage 永久挂起
  describe('WORKER_READY 握手失败路径', () => {
    it('worker 在就绪前退出应降级返回 worker unavailable 而非永久挂起', async () => {
      const p = bridge.processImage(input)
      // 未发送 WORKER_READY，直接崩溃退出
      mockWorker.emit('exit', 1)

      await expect(p).resolves.toMatchObject({
        requestId: 'req-1',
        success: false,
        errorMessage: 'worker unavailable'
      })
      expect(bridge.isAvailable()).toBe(false)
    })

    it('10s 内未收到 WORKER_READY 应降级并 kill worker', async () => {
      vi.useFakeTimers()
      const p = bridge.processImage(input)
      vi.advanceTimersByTime(10_000)

      await expect(p).resolves.toMatchObject({
        success: false,
        errorMessage: 'worker unavailable'
      })
      expect(mockWorker.kill).toHaveBeenCalledTimes(1)
      // 超时后置降级标志，后续请求不再重复 fork
      expect(bridge.isAvailable()).toBe(false)
      mockFork.mockClear()
      await bridge.processImage({ ...input, requestId: 'req-2' })
      expect(mockFork).not.toHaveBeenCalled()
    })

    it('fork 失败应降级返回 worker unavailable', async () => {
      mockFork.mockImplementation(() => {
        throw new Error('fork failed')
      })
      await expect(bridge.processImage(input)).resolves.toMatchObject({
        success: false,
        errorMessage: 'worker unavailable'
      })
      expect(bridge.isAvailable()).toBe(false)
    })

    it('就绪前退出后下一次请求应可重新 fork', async () => {
      const p1 = bridge.processImage(input)
      mockWorker.emit('exit', 1)
      await p1

      // 未置 workerFailed，允许重新 fork
      mockFork.mockClear()
      mockWorker = createMockWorker()
      mockFork.mockReturnValue(mockWorker)

      const p2 = bridge.processImage({ ...input, requestId: 'req-2' })
      expect(mockFork).toHaveBeenCalledTimes(1)
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await vi.waitFor(() => expect(mockWorker.postMessage).toHaveBeenCalled())
      mockWorker.emit('message', {
        type: 'THUMBNAIL_PROCESS_COMPLETE',
        payload: {
          requestId: 'req-2',
          success: true,
          outputPath: '/cache/hash1.jpg',
          errorMessage: '',
          outputSize: 1
        }
      })
      await expect(p2).resolves.toMatchObject({ success: true })
    })

    it('dispose 时握手仍在等待应 settle，不留悬挂 Promise', async () => {
      vi.useFakeTimers()
      const p = bridge.processImage(input)

      const disposePromise = bridge.dispose()
      vi.advanceTimersByTime(500)
      await disposePromise

      await expect(p).resolves.toMatchObject({
        success: false,
        errorMessage: 'worker unavailable'
      })
    })
  })

  // ============ handleWorkerExit ============
  describe('handleWorkerExit', () => {
    it('worker 退出应 reject 所有 pending 请求', async () => {
      const p = bridge.processImage(input)
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await vi.waitFor(() => expect(mockWorker.postMessage).toHaveBeenCalled())

      mockWorker.emit('exit', 1)
      await expect(p).rejects.toThrow('thumbnail worker exited')
    })
  })
})
