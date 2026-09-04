/**
 * MediaWorkerBridge 单元测试
 *
 * 测试目标：src/main/media-worker/bridge.ts
 * 测试层级：L2（依赖 mock，无真实 worker 进程）
 *
 * Mock 策略：
 * - electron.utilityProcess.fork → 返回 EventEmitter 模拟 worker
 * - ../utils/logger → vi.fn() 捕获调用
 *
 * 测试覆盖：
 * - startThumbnailBatch / startPhashBatch / startDuplicateMark：惰性启动 + 发送命令 + 设置运行状态
 * - stopThumbnailBatch / stopPhashBatch / stopDuplicateMark：发送 STOP、worker 为 null 时静默返回
 * - onEvent：订阅 / 取消订阅 / 多 handler
 * - handleWorkerMessage：WORKER_READY / MEDIA_WORKER_LOG / 三类 PROGRESS / 三类 COMPLETE / WORKER_ERROR
 * - handleWorkerExit：正常/异常退出、三类任务运行中合成 fakeComplete
 * - dispose：DISPOSE → 等待 worker 回发确认（MEDIA_WORKER_DISPOSED，带 2000ms 超时兜底）→ kill、异常容错
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { UtilityProcess } from 'electron'

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

import { MediaWorkerBridge } from './bridge'

/**
 * 创建模拟 worker 对象（EventEmitter + postMessage + kill）
 */
function createMockWorker(): UtilityProcess & {
  postMessage: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
} {
  const emitter = new EventEmitter() as unknown as UtilityProcess & {
    postMessage: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
  }
  emitter.postMessage = vi.fn((cmd: unknown) => {
    // 模拟 worker 处理完 MEDIA_WORKER_DISPOSE 后关闭 DB 句柄并回发确认（用微任务确保 disposeResolve 已就绪）
    if (
      cmd &&
      typeof cmd === 'object' &&
      (cmd as { type?: string }).type === 'MEDIA_WORKER_DISPOSE'
    ) {
      queueMicrotask(() => emitter.emit('message', { type: 'MEDIA_WORKER_DISPOSED' }))
    }
  })
  emitter.kill = vi.fn()
  return emitter
}

describe('MediaWorkerBridge', () => {
  let bridge: MediaWorkerBridge
  let mockWorker: ReturnType<typeof createMockWorker>

  beforeEach(() => {
    vi.clearAllMocks()
    mockFork.mockReset()
    mockWorker = createMockWorker()
    mockFork.mockReturnValue(mockWorker)
    bridge = new MediaWorkerBridge()
  })

  afterEach(async () => {
    // 清理可能残留的握手 / 任务定时器，避免跨用例泄漏
    // 参照 scanner-worker-bridge.test.ts 的模式：fake timers 下推进 dispose 500ms 宽限
    vi.useFakeTimers()
    const disposePromise = bridge.dispose().catch(() => {})
    vi.advanceTimersByTime(500)
    await disposePromise
    vi.useRealTimers()
  })

  // 辅助：触发 worker 启动握手
  async function readyWorker() {
    const p = bridge.startThumbnailBatch('/db', '/cache', 'standard')
    mockWorker.emit('message', { type: 'WORKER_READY' })
    await p
    mockWorker.postMessage.mockClear()
  }

  // ============ startThumbnailBatch ============
  describe('startThumbnailBatch', () => {
    it('首次调用应通过 utilityProcess.fork 惰性启动 worker', async () => {
      const p = bridge.startThumbnailBatch('/db', '/cache', 'standard')
      expect(mockFork).toHaveBeenCalledTimes(1)
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p
    })

    it('fork 时应使用 serviceName=media-worker 与 stdio=pipe', async () => {
      const p = bridge.startThumbnailBatch('/db', '/cache', 'standard')
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      expect(mockFork).toHaveBeenCalledWith(expect.stringContaining('media-worker.js'), [], {
        serviceName: 'media-worker',
        stdio: 'pipe'
      })
    })

    it('应发送 THUMBNAIL_BATCH_START 命令携带 dbPath/cacheDir/quality', async () => {
      const p = bridge.startThumbnailBatch('/db/path', '/cache/dir', 'high')
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        type: 'THUMBNAIL_BATCH_START',
        payload: { dbPath: '/db/path', cacheDir: '/cache/dir', thumbnailQuality: 'high' }
      })
    })

    it('已有 worker 时应复用不重复 fork', async () => {
      const p1 = bridge.startThumbnailBatch('/db', '/cache', 'standard')
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p1

      mockFork.mockClear()
      await bridge.startThumbnailBatch('/db', '/cache', 'low')
      expect(mockFork).not.toHaveBeenCalled()
    })
  })

  // ============ startPhashBatch ============
  describe('startPhashBatch', () => {
    it('应发送 PHASH_BATCH_START 命令携带 dbPath', async () => {
      const p = bridge.startPhashBatch('/db/path')
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        type: 'PHASH_BATCH_START',
        payload: { dbPath: '/db/path' }
      })
    })

    it('已有 worker 时应复用不重复 fork', async () => {
      const p1 = bridge.startThumbnailBatch('/db', '/cache', 'standard')
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p1

      mockFork.mockClear()
      await bridge.startPhashBatch('/db')
      expect(mockFork).not.toHaveBeenCalled()
    })
  })

  // ============ startDuplicateMark ============
  describe('startDuplicateMark', () => {
    it('应发送 DUPLICATE_MARK_START 命令携带 dbPath', async () => {
      const p = bridge.startDuplicateMark('/db/path')
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        type: 'DUPLICATE_MARK_START',
        payload: { dbPath: '/db/path' }
      })
    })

    it('已有 worker 时应复用不重复 fork', async () => {
      const p1 = bridge.startThumbnailBatch('/db', '/cache', 'standard')
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p1

      mockFork.mockClear()
      await bridge.startDuplicateMark('/db')
      expect(mockFork).not.toHaveBeenCalled()
    })
  })

  // ============ stopThumbnailBatch / stopPhashBatch / stopDuplicateMark ============
  describe('stopThumbnailBatch', () => {
    it('应发送 THUMBNAIL_STOP 命令', async () => {
      await readyWorker()
      bridge.stopThumbnailBatch()
      expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'THUMBNAIL_STOP' })
    })

    it('worker 为 null 时应静默返回', () => {
      expect(() => bridge.stopThumbnailBatch()).not.toThrow()
      expect(mockWorker.postMessage).not.toHaveBeenCalled()
    })
  })

  describe('stopPhashBatch', () => {
    it('应发送 PHASH_STOP 命令', async () => {
      await readyWorker()
      bridge.stopPhashBatch()
      expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'PHASH_STOP' })
    })

    it('worker 为 null 时应静默返回', () => {
      expect(() => bridge.stopPhashBatch()).not.toThrow()
      expect(mockWorker.postMessage).not.toHaveBeenCalled()
    })
  })

  describe('stopDuplicateMark', () => {
    it('应发送 DUPLICATE_STOP 命令', async () => {
      await readyWorker()
      bridge.stopDuplicateMark()
      expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'DUPLICATE_STOP' })
    })

    it('worker 为 null 时应静默返回', () => {
      expect(() => bridge.stopDuplicateMark()).not.toThrow()
      expect(mockWorker.postMessage).not.toHaveBeenCalled()
    })
  })

  // ============ startSimilarFind ============
  describe('startSimilarFind', () => {
    it('应发送 SIMILAR_FIND_START 命令携带 dbPath 与 threshold', async () => {
      const p = bridge.startSimilarFind('/db/path', 5)
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        type: 'SIMILAR_FIND_START',
        payload: { dbPath: '/db/path', threshold: 5 }
      })
    })

    it('已有 worker 时应复用不重复 fork', async () => {
      const p1 = bridge.startThumbnailBatch('/db', '/cache', 'standard')
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p1

      mockFork.mockClear()
      await bridge.startSimilarFind('/db', 5)
      expect(mockFork).not.toHaveBeenCalled()
    })
  })

  // ============ stopSimilarFind ============
  describe('stopSimilarFind', () => {
    it('应发送 SIMILAR_STOP 命令', async () => {
      await readyWorker()
      bridge.stopSimilarFind()
      expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'SIMILAR_STOP' })
    })

    it('worker 为 null 时应静默返回', () => {
      expect(() => bridge.stopSimilarFind()).not.toThrow()
      expect(mockWorker.postMessage).not.toHaveBeenCalled()
    })
  })

  // ============ onEvent ============
  describe('onEvent', () => {
    it('注册的 handler 应收到 THUMBNAIL_PROGRESS 事件', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)
      await readyWorker()

      const evt = {
        type: 'THUMBNAIL_PROGRESS' as const,
        payload: { processed: 1, total: 10, currentFile: '/path/a.jpg' }
      }
      mockWorker.emit('message', evt)
      expect(handler).toHaveBeenCalledWith(evt)
    })

    it('注册的 handler 应收到 THUMBNAIL_COMPLETE 事件', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)
      await readyWorker()

      const evt = {
        type: 'THUMBNAIL_COMPLETE' as const,
        payload: { success: true, message: 'done', processed: 10, total: 10 }
      }
      mockWorker.emit('message', evt)
      expect(handler).toHaveBeenCalledWith(evt)
    })

    it('注册的 handler 应收到 PHASH_PROGRESS 事件', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)
      await readyWorker()

      const evt = {
        type: 'PHASH_PROGRESS' as const,
        payload: { processed: 2, total: 5, currentFile: '/path/b.jpg' }
      }
      mockWorker.emit('message', evt)
      expect(handler).toHaveBeenCalledWith(evt)
    })

    it('注册的 handler 应收到 PHASH_COMPLETE 事件', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)
      await readyWorker()

      const evt = {
        type: 'PHASH_COMPLETE' as const,
        payload: {
          success: true,
          message: 'done',
          processed: 5,
          total: 5,
          duplicatesResult: { markedDuplicates: 2, totalGroups: 1 }
        }
      }
      mockWorker.emit('message', evt)
      expect(handler).toHaveBeenCalledWith(evt)
    })

    it('注册的 handler 应收到 DUPLICATE_PROGRESS 事件', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)
      await readyWorker()

      const evt = {
        type: 'DUPLICATE_PROGRESS' as const,
        payload: { compared: 100, totalPairs: 1000 }
      }
      mockWorker.emit('message', evt)
      expect(handler).toHaveBeenCalledWith(evt)
    })

    it('注册的 handler 应收到 DUPLICATE_COMPLETE 事件', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)
      await readyWorker()

      const evt = {
        type: 'DUPLICATE_COMPLETE' as const,
        payload: { success: true, message: 'done', markedDuplicates: 3, totalGroups: 2 }
      }
      mockWorker.emit('message', evt)
      expect(handler).toHaveBeenCalledWith(evt)
    })

    it('取消订阅后 handler 不应再收到事件', async () => {
      const handler = vi.fn()
      const unsubscribe = bridge.onEvent(handler)
      await readyWorker()

      unsubscribe()
      mockWorker.emit('message', {
        type: 'THUMBNAIL_PROGRESS',
        payload: { processed: 1, total: 10, currentFile: '/path/a.jpg' }
      })
      expect(handler).not.toHaveBeenCalled()
    })

    it('多个 handler 应都被通知', async () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      bridge.onEvent(h1)
      bridge.onEvent(h2)
      await readyWorker()

      mockWorker.emit('message', {
        type: 'THUMBNAIL_PROGRESS',
        payload: { processed: 1, total: 10, currentFile: '/a.jpg' }
      })
      expect(h1).toHaveBeenCalledTimes(1)
      expect(h2).toHaveBeenCalledTimes(1)
    })

    it('THUMBNAIL_COMPLETE 后 isThumbnailRunning 应重置', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)
      await readyWorker()

      mockWorker.emit('message', {
        type: 'THUMBNAIL_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 1 }
      })
      expect(handler).toHaveBeenCalledTimes(1)

      // worker 异常退出不应再合成 fakeComplete
      mockWorker.emit('exit', 1)
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('PHASH_COMPLETE 后 isPhashRunning 应重置', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)

      const p = bridge.startPhashBatch('/db')
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p
      mockWorker.postMessage.mockClear()

      mockWorker.emit('message', {
        type: 'PHASH_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 1 }
      })
      expect(handler).toHaveBeenCalledTimes(1)

      mockWorker.emit('exit', 1)
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('DUPLICATE_COMPLETE 后 isDuplicateRunning 应重置', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)

      const p = bridge.startDuplicateMark('/db')
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p
      mockWorker.postMessage.mockClear()

      mockWorker.emit('message', {
        type: 'DUPLICATE_COMPLETE',
        payload: { success: true, message: 'done', markedDuplicates: 0, totalGroups: 0 }
      })
      expect(handler).toHaveBeenCalledTimes(1)

      mockWorker.emit('exit', 1)
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('注册的 handler 应收到 SIMILAR_PROGRESS 事件', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)
      await readyWorker()

      const evt = {
        type: 'SIMILAR_PROGRESS' as const,
        payload: { scanned: 100, total: 1000, candidates: 50 }
      }
      mockWorker.emit('message', evt)
      expect(handler).toHaveBeenCalledWith(evt)
    })

    it('注册的 handler 应收到 SIMILAR_CANDIDATES 事件', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)
      await readyWorker()

      const evt = {
        type: 'SIMILAR_CANDIDATES' as const,
        payload: { batch: [{ a: 1, b: 2, dist: 3 }] }
      }
      mockWorker.emit('message', evt)
      expect(handler).toHaveBeenCalledWith(evt)
    })

    it('SIMILAR_COMPLETE 后 isSimilarRunning 应重置', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)

      const p = bridge.startSimilarFind('/db', 5)
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p
      mockWorker.postMessage.mockClear()

      mockWorker.emit('message', {
        type: 'SIMILAR_COMPLETE',
        payload: {
          success: true,
          message: 'done',
          rows: [],
          totalCandidates: 0,
          totalRows: 0
        }
      })
      expect(handler).toHaveBeenCalledTimes(1)

      mockWorker.emit('exit', 1)
      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  // ============ MEDIA_WORKER_LOG 消息分发 ============
  describe('MEDIA_WORKER_LOG 消息分发', () => {
    it('error 级别应调用 logger.error', async () => {
      await readyWorker()
      mockWorker.emit('message', {
        type: 'MEDIA_WORKER_LOG',
        payload: { level: 'error', message: 'something broke', args: ['ctx'] }
      })
      expect(mockLoggerError).toHaveBeenCalledWith('[MediaWorker] something broke', 'ctx')
    })

    it('warn 级别应调用 logger.warn', async () => {
      await readyWorker()
      mockWorker.emit('message', {
        type: 'MEDIA_WORKER_LOG',
        payload: { level: 'warn', message: 'be careful' }
      })
      expect(mockLoggerWarn).toHaveBeenCalledWith('[MediaWorker] be careful')
    })

    it('warn 级别无 args 时不传额外参数', async () => {
      await readyWorker()
      mockWorker.emit('message', {
        type: 'MEDIA_WORKER_LOG',
        payload: { level: 'warn', message: 'no args' }
      })
      expect(mockLoggerWarn).toHaveBeenCalledWith('[MediaWorker] no args')
    })

    it('info 级别应被忽略', async () => {
      await readyWorker()
      mockWorker.emit('message', {
        type: 'MEDIA_WORKER_LOG',
        payload: { level: 'info', message: 'just info' }
      })
      expect(mockLoggerError).not.toHaveBeenCalled()
      expect(mockLoggerWarn).not.toHaveBeenCalled()
    })

    it('args 为 undefined 时应按空数组处理', async () => {
      await readyWorker()
      mockWorker.emit('message', {
        type: 'MEDIA_WORKER_LOG',
        payload: { level: 'error', message: 'err' }
      })
      expect(mockLoggerError).toHaveBeenCalledWith('[MediaWorker] err')
    })
  })

  // ============ WORKER_ERROR 消息 ============
  describe('WORKER_ERROR 消息', () => {
    it('应调用 logger.error 并附带 stack', async () => {
      await readyWorker()
      mockWorker.emit('message', {
        type: 'WORKER_ERROR',
        payload: { message: 'crashed', stack: 'Error: crashed\n  at ...' }
      })
      expect(mockLoggerError).toHaveBeenCalledWith(
        '[MediaWorker] 异常: crashed',
        'Error: crashed\n  at ...'
      )
    })

    it('stack 缺失时应传空字符串', async () => {
      await readyWorker()
      mockWorker.emit('message', {
        type: 'WORKER_ERROR',
        payload: { message: 'no stack' }
      })
      expect(mockLoggerError).toHaveBeenCalledWith('[MediaWorker] 异常: no stack', '')
    })
  })

  // ============ handleWorkerExit ============
  describe('handleWorkerExit', () => {
    it('正常退出 code=0 不应记录错误日志', async () => {
      await readyWorker()
      // 先完成所有任务（避免合成 fakeComplete）
      mockWorker.emit('message', {
        type: 'THUMBNAIL_COMPLETE',
        payload: { success: true, message: 'done', processed: 0, total: 0 }
      })
      mockWorker.emit('exit', 0)
      expect(mockLoggerError).not.toHaveBeenCalled()
    })

    it('异常退出 code!=0 应记录错误日志', async () => {
      await readyWorker()
      mockWorker.emit('message', {
        type: 'THUMBNAIL_COMPLETE',
        payload: { success: true, message: 'done', processed: 0, total: 0 }
      })
      mockWorker.emit('exit', 1)
      expect(mockLoggerError).toHaveBeenCalledWith('[MediaWorker] 异常退出，exit code=1')
    })

    it('缩略图任务运行中退出应合成失败的 THUMBNAIL_COMPLETE', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)
      await readyWorker()
      // 此时 isThumbnailRunning=true

      mockWorker.emit('exit', 1)
      expect(handler).toHaveBeenCalledWith({
        type: 'THUMBNAIL_COMPLETE',
        payload: {
          success: false,
          message: '缩略图批量生成进程异常退出',
          processed: 0,
          total: 0
        }
      })
    })

    it('pHash 任务运行中退出应合成失败的 PHASH_COMPLETE', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)

      const p = bridge.startPhashBatch('/db')
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      mockWorker.emit('exit', 1)
      expect(handler).toHaveBeenCalledWith({
        type: 'PHASH_COMPLETE',
        payload: {
          success: false,
          message: 'pHash 批量补算进程异常退出',
          processed: 0,
          total: 0
        }
      })
    })

    it('重复标记任务运行中退出应合成失败的 DUPLICATE_COMPLETE', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)

      const p = bridge.startDuplicateMark('/db')
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      mockWorker.emit('exit', 1)
      expect(handler).toHaveBeenCalledWith({
        type: 'DUPLICATE_COMPLETE',
        payload: {
          success: false,
          message: '重复标记进程异常退出',
          markedDuplicates: 0,
          totalGroups: 0
        }
      })
    })

    it('相似检测任务运行中退出应合成失败的 SIMILAR_COMPLETE', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)

      const p = bridge.startSimilarFind('/db', 5)
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      mockWorker.emit('exit', 1)
      expect(handler).toHaveBeenCalledWith({
        type: 'SIMILAR_COMPLETE',
        payload: {
          success: false,
          message: '相似检测进程异常退出',
          rows: [],
          totalCandidates: 0,
          totalRows: 0
        }
      })
    })

    it('三类任务同时运行中退出应合成三个 fakeComplete', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)

      // 依次启动三类任务（复用同一 worker）
      const p1 = bridge.startThumbnailBatch('/db', '/cache', 'standard')
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p1

      await bridge.startPhashBatch('/db')
      await bridge.startDuplicateMark('/db')

      mockWorker.emit('exit', 1)
      // 应收到 3 个 fakeComplete
      const calls = handler.mock.calls.map((c) => c[0].type)
      expect(calls).toContain('THUMBNAIL_COMPLETE')
      expect(calls).toContain('PHASH_COMPLETE')
      expect(calls).toContain('DUPLICATE_COMPLETE')
      expect(handler).toHaveBeenCalledTimes(3)
    })

    it('退出后再次 exit 不应重复合成 fakeComplete', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)
      await readyWorker()

      mockWorker.emit('exit', 1)
      expect(handler).toHaveBeenCalledTimes(1)

      mockWorker.emit('exit', 1)
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('退出后 worker 应置 null（stop 不再 postMessage）', async () => {
      await readyWorker()
      mockWorker.postMessage.mockClear()

      mockWorker.emit('exit', 0)
      bridge.stopThumbnailBatch()
      expect(mockWorker.postMessage).not.toHaveBeenCalled()
    })
  })

  // ============ dispose ============
  describe('dispose', () => {
    it('worker 为 null 时应直接返回', async () => {
      await bridge.dispose()
      expect(mockFork).not.toHaveBeenCalled()
    })

    it('应发送 MEDIA_WORKER_DISPOSE 命令', async () => {
      vi.useFakeTimers()
      await readyWorker()

      const disposePromise = bridge.dispose()
      expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'MEDIA_WORKER_DISPOSE' })
      vi.advanceTimersByTime(500)
      await disposePromise
    })

    it('应在发送 DISPOSE 后等待 500ms 再 kill', async () => {
      vi.useFakeTimers()
      await readyWorker()

      const disposePromise = bridge.dispose()
      expect(mockWorker.kill).not.toHaveBeenCalled()
      vi.advanceTimersByTime(499)
      expect(mockWorker.kill).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      await disposePromise
      expect(mockWorker.kill).toHaveBeenCalledTimes(1)
    })

    it('完成后 worker 应置 null', async () => {
      vi.useFakeTimers()
      await readyWorker()

      const disposePromise = bridge.dispose()
      vi.advanceTimersByTime(500)
      await disposePromise

      mockWorker.postMessage.mockClear()
      bridge.stopThumbnailBatch()
      expect(mockWorker.postMessage).not.toHaveBeenCalled()
    })

    it('完成后三类运行状态应重置', async () => {
      vi.useFakeTimers()
      const handler = vi.fn()
      bridge.onEvent(handler)

      // 启动三类任务
      const p1 = bridge.startThumbnailBatch('/db', '/cache', 'standard')
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p1
      await bridge.startPhashBatch('/db')
      await bridge.startDuplicateMark('/db')

      const disposePromise = bridge.dispose()
      vi.advanceTimersByTime(500)
      await disposePromise

      // worker 退出不应再合成任何 fakeComplete
      mockWorker.emit('exit', 1)
      expect(handler).not.toHaveBeenCalled()
    })

    it('postMessage 失败时应继续 kill 兜底', async () => {
      vi.useFakeTimers()
      await readyWorker()

      mockWorker.postMessage.mockImplementation(() => {
        throw new Error('postMessage failed')
      })

      const disposePromise = bridge.dispose()
      vi.advanceTimersByTime(500)
      await disposePromise
      expect(mockWorker.kill).toHaveBeenCalledTimes(1)
    })

    it('kill 失败时应静默忽略不抛错', async () => {
      vi.useFakeTimers()
      await readyWorker()

      mockWorker.kill.mockImplementation(() => {
        throw new Error('kill failed')
      })

      const disposePromise = bridge.dispose()
      vi.advanceTimersByTime(500)
      await expect(disposePromise).resolves.toBeUndefined()
    })

    it('完成后 readyResolve 应清空', async () => {
      vi.useFakeTimers()
      await readyWorker()

      const disposePromise = bridge.dispose()
      vi.advanceTimersByTime(500)
      await disposePromise

      // 再次 dispose 不应报错
      await bridge.dispose()
    })
  })

  // ============ WORKER_READY 握手失败路径（回归：崩溃时永久挂死）============
  // 任何提前终止路径都必须 settle readyPromise，只置 null 会让调用方永久挂起
  describe('WORKER_READY 握手失败路径', () => {
    it('worker 在就绪前退出时应 reject 而非永久挂起', async () => {
      const p = bridge.startThumbnailBatch('/db', '/cache', 'standard')
      // 未发送 WORKER_READY，直接崩溃退出
      mockWorker.emit('exit', 1)
      await expect(p).rejects.toThrow('worker exited before ready')
    })

    it('15s 内未收到 WORKER_READY 应 reject 并 kill worker', async () => {
      vi.useFakeTimers()
      const p = bridge.startPhashBatch('/db')
      const assertion = expect(p).rejects.toThrow('后台进程启动失败')
      vi.advanceTimersByTime(15_000)
      await assertion
      expect(mockWorker.kill).toHaveBeenCalledTimes(1)
    })

    it('握手超时应上报 startup-timeout 崩溃事件供 UI 提示', async () => {
      vi.useFakeTimers()
      const onCrash = vi.fn()
      bridge.onCrash(onCrash)

      const p = bridge.startPhashBatch('/db')
      const assertion = expect(p).rejects.toThrow('后台进程启动失败')
      vi.advanceTimersByTime(15_000)
      await assertion

      expect(onCrash).toHaveBeenCalledTimes(1)
      expect(onCrash.mock.calls[0][0]).toMatchObject({
        workerName: 'media-worker',
        stage: 'startup-timeout',
        restartScheduled: false
      })
    })

    it('超时后再次调用应可重新 fork（worker 已置空）', async () => {
      vi.useFakeTimers()
      const p = bridge.startPhashBatch('/db')
      const assertion = expect(p).rejects.toThrow('后台进程启动失败')
      vi.advanceTimersByTime(15_000)
      await assertion

      mockFork.mockClear()
      const p2 = bridge.startPhashBatch('/db')
      expect(mockFork).toHaveBeenCalledTimes(1)
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p2
    })

    it('dispose 时握手仍在等待应 reject，不留悬挂 Promise', async () => {
      vi.useFakeTimers()
      const p = bridge.startDuplicateMark('/db')
      const assertion = expect(p).rejects.toThrow('media-worker 已释放')

      const disposePromise = bridge.dispose()
      vi.advanceTimersByTime(500)
      await disposePromise
      await assertion
    })
  })

  // ============ FIX(组11-1): 崩溃恢复经注入的 restoreExecutor ============
  describe('崩溃恢复执行器（组11-1）', () => {
    it('缩略图任务运行中崩溃重启后，经 restoreExecutor 恢复而非直连 bridge.startXxx', async () => {
      vi.useFakeTimers()
      const restoreSpy = vi.fn().mockResolvedValue(undefined)
      bridge.setRestoreExecutor(restoreSpy)

      const p = bridge.startThumbnailBatch('/db', '/cache', 'high')
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      // 扫描中崩溃 → 合成失败 COMPLETE + 调度重启（2s）
      mockWorker.emit('exit', 1)
      mockFork.mockImplementation(() => {
        const w = createMockWorker()
        queueMicrotask(() => w.emit('message', { type: 'WORKER_READY' }))
        return w
      })
      vi.advanceTimersByTime(2_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(restoreSpy).toHaveBeenCalledTimes(1)
      expect(restoreSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          thumbnail: { cacheDir: '/cache', thumbnailQuality: 'high' },
          phash: false,
          duplicate: false,
          similar: null
        })
      )
      // 不再直连 bridge 层的 startThumbnailBatch（由 executor 的 Manager 层实现接管）
      const startCalls = mockWorker.postMessage.mock.calls.filter(
        (c) => (c[0] as { type?: string }).type === 'THUMBNAIL_BATCH_START'
      )
      expect(startCalls).toHaveLength(1) // 仅崩溃前用户发起的那一次
    })
  })
})

describe('MediaWorkerBridge stopWorkerForRestore（自恢复期间可逆停 worker）', () => {
  let bridge: MediaWorkerBridge
  let mockWorker: ReturnType<typeof createMockWorker>

  beforeEach(() => {
    vi.clearAllMocks()
    mockFork.mockReset()
    mockWorker = createMockWorker()
    mockFork.mockReturnValue(mockWorker)
    bridge = new MediaWorkerBridge()
    vi.useFakeTimers()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.useFakeTimers()
    const dp = bridge.dispose().catch(() => {})
    vi.advanceTimersByTime(500)
    await dp
    vi.useRealTimers()
  })

  it('发送 MEDIA_WORKER_DISPOSE 并 kill，kill 退出不自动重启', async () => {
    const p = bridge.startThumbnailBatch('/db', '/cache', 'high')
    mockWorker.emit('message', { type: 'WORKER_READY' })
    await p
    const forkBefore = mockFork.mock.calls.length

    const stopP = bridge.stopWorkerForRestore()
    await vi.advanceTimersByTimeAsync(500)
    await stopP

    expect(mockWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MEDIA_WORKER_DISPOSE' })
    )
    expect(mockWorker.kill).toHaveBeenCalled()
    // 模拟 kill 退出：被 terminatingForRestore 抑制，不应自动重启
    mockWorker.emit('exit', null, 'SIGTERM')
    expect(mockFork.mock.calls.length).toBe(forkBefore)
  })

  it('停止后不置 isDisposed，可重新 startThumbnailBatch 重建连接', async () => {
    const p = bridge.startThumbnailBatch('/db', '/cache', 'high')
    mockWorker.emit('message', { type: 'WORKER_READY' })
    await p

    const stopP = bridge.stopWorkerForRestore()
    await vi.advanceTimersByTimeAsync(500)
    await stopP
    mockWorker.emit('exit', null, 'SIGTERM')

    const mockWorker2 = createMockWorker()
    mockFork.mockReturnValue(mockWorker2)
    const p2 = bridge.startThumbnailBatch('/db', '/cache', 'high')
    mockWorker2.emit('message', { type: 'WORKER_READY' })
    await p2
    // 重新 fork 成功 → 证明 isDisposed 未置位、连接可重建
    expect(mockWorker2.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'THUMBNAIL_BATCH_START' })
    )
  })

  it('无 worker 时 stopWorkerForRestore 为安全 no-op（启动期常见情形）', async () => {
    await expect(bridge.stopWorkerForRestore()).resolves.toBeUndefined()
  })

  it('收到 MEDIA_WORKER_DISPOSED 后解除等待并立即 kill（不再盲等固定时长）', async () => {
    const p = bridge.startThumbnailBatch('/db', '/cache', 'high')
    mockWorker.emit('message', { type: 'WORKER_READY' })
    await p

    // 关闭 auto-ack，手动回发确认，验证确认消息驱动解除等待（而非等 2000ms 超时兜底）
    mockWorker.postMessage = vi.fn()
    const stopP = bridge.stopWorkerForRestore()
    mockWorker.emit('message', { type: 'MEDIA_WORKER_DISPOSED' })
    await stopP
    expect(mockWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MEDIA_WORKER_DISPOSE' })
    )
    expect(mockWorker.kill).toHaveBeenCalled()
  })

  it('worker 未回发确认时超时兜底仍会 kill（不永久阻塞）', async () => {
    // 关闭 auto-ack：覆盖 postMessage 使其不回发确认
    mockWorker.postMessage = vi.fn()
    const p = bridge.startThumbnailBatch('/db', '/cache', 'high')
    mockWorker.emit('message', { type: 'WORKER_READY' })
    await p

    const stopP = bridge.stopWorkerForRestore()
    // 不回发确认：推进到 DISPOSE_CONFIRM_TIMEOUT_MS(2000) 触发超时兜底
    await vi.advanceTimersByTimeAsync(2000)
    await stopP
    expect(mockWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MEDIA_WORKER_DISPOSE' })
    )
    expect(mockWorker.kill).toHaveBeenCalled()
  })
})

describe('MediaWorkerBridge hasLiveWorker（自恢复并发边界探针）', () => {
  let bridge: MediaWorkerBridge
  let mockWorker: ReturnType<typeof createMockWorker>

  beforeEach(() => {
    vi.clearAllMocks()
    mockFork.mockReset()
    mockWorker = createMockWorker()
    mockFork.mockReturnValue(mockWorker)
    bridge = new MediaWorkerBridge()
    vi.useFakeTimers()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.useFakeTimers()
    const dp = bridge.dispose().catch(() => {})
    vi.advanceTimersByTime(500)
    await dp
    vi.useRealTimers()
  })

  async function bootWorker(): Promise<void> {
    const p = bridge.startThumbnailBatch('/db', '/cache', 'high')
    mockWorker.emit('message', { type: 'WORKER_READY' })
    await p
  }

  it('未启动 worker 时返回 false', () => {
    expect(bridge.hasLiveWorker()).toBe(false)
  })

  it('worker 启动后返回 true', async () => {
    await bootWorker()
    expect(bridge.hasLiveWorker()).toBe(true)
  })

  it('stopWorkerForRestore 后（已收到 *_DISPOSED 或超时兜底 kill）返回 false', async () => {
    await bootWorker()
    expect(bridge.hasLiveWorker()).toBe(true)
    const stopP = bridge.stopWorkerForRestore()
    await vi.advanceTimersByTimeAsync(500)
    await stopP
    expect(bridge.hasLiveWorker()).toBe(false)
  })
})
