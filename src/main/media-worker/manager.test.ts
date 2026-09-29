/**
 * MediaWorkerManager 单元测试
 *
 * 测试目标：src/main/media-worker/manager.ts
 * 测试层级：L2（依赖 mock，无真实 worker 进程）
 *
 * Mock 策略：
 * - 不使用 vi.mock 替换 MediaWorkerBridge 类，直接构造 mock bridge 实例传入构造函数
 * - electron.BrowserWindow → mock getAllWindows
 *
 * 测试覆盖：
 * - startThumbnailBatch / startPhashBatch / startDuplicateMark：互斥拦截、dbPath 校验、Promise 完成
 * - stopThumbnailBatch / stopPhashBatch / stopDuplicateMark：转发到 bridge
 * - isXxxBatchRunning：状态查询
 * - setDbPath：注入路径
 * - subscribeBridgeEvents：PROGRESS / COMPLETE 事件转发为 EventEmitter
 * - bridge.startXxxBatch 失败时的错误处理
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- Mock electron BrowserWindow ----
const mockGetAllWindows = vi.fn()
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => mockGetAllWindows()
  }
}))

import { MediaWorkerManager } from './manager'
import type { MediaWorkerBridge } from './bridge'

// 模拟 bridge 事件类型
type BridgeEvent =
  | { type: 'WORKER_READY' }
  | {
      type: 'THUMBNAIL_PROGRESS'
      payload: { processed: number; total: number; currentFile: string }
    }
  | {
      type: 'THUMBNAIL_COMPLETE'
      payload: { success: boolean; message: string; processed: number; total: number }
    }
  | { type: 'PHASH_PROGRESS'; payload: { processed: number; total: number; currentFile: string } }
  | {
      type: 'PHASH_COMPLETE'
      payload: {
        success: boolean
        message: string
        processed: number
        total: number
        duplicatesResult?: { markedDuplicates: number; totalGroups: number }
      }
    }
  | { type: 'DUPLICATE_PROGRESS'; payload: { compared: number; totalPairs: number } }
  | {
      type: 'DUPLICATE_COMPLETE'
      payload: { success: boolean; message: string; markedDuplicates: number; totalGroups: number }
    }
  | {
      type: 'MEDIA_WORKER_LOG'
      payload: { level: 'info' | 'warn' | 'error'; message: string; args?: unknown[] }
    }
  | { type: 'WORKER_ERROR'; payload: { message: string; stack?: string } }

/**
 * 创建 mock bridge 对象
 * - 所有方法为 vi.fn()
 * - onEvent 注册的 handler 保存到 handlers 数组，便于测试触发
 */
function createMockBridge() {
  const handlers: Array<(event: BridgeEvent) => void> = []
  const bridge = {
    startThumbnailBatch:
      vi.fn<(dbPath: string, cacheDir: string, q: 'low' | 'standard' | 'high') => Promise<void>>(),
    startPhashBatch: vi.fn<(dbPath: string) => Promise<void>>(),
    startDuplicateMark: vi.fn<(dbPath: string) => Promise<void>>(),
    stopThumbnailBatch: vi.fn(),
    stopPhashBatch: vi.fn(),
    stopDuplicateMark: vi.fn(),
    // FIX(组11-1): Manager 构造时会注入恢复执行器（构造函数调用 setRestoreExecutor）
    setRestoreExecutor: vi.fn(),
    onEvent: vi
      .fn<(handler: (event: BridgeEvent) => void) => () => void>()
      .mockImplementation((handler: (event: BridgeEvent) => void) => {
        handlers.push(handler)
        return () => {
          const idx = handlers.indexOf(handler)
          if (idx >= 0) handlers.splice(idx, 1)
        }
      }),
    // 暴露 handlers 便于测试触发事件
    _handlers: handlers
  }
  return bridge
}

describe('MediaWorkerManager', () => {
  let manager: MediaWorkerManager
  let bridge: ReturnType<typeof createMockBridge>

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAllWindows.mockReturnValue([])
    bridge = createMockBridge()
    // 默认 startXxxBatch 立即 resolve
    bridge.startThumbnailBatch.mockResolvedValue(undefined)
    bridge.startPhashBatch.mockResolvedValue(undefined)
    bridge.startDuplicateMark.mockResolvedValue(undefined)
    manager = new MediaWorkerManager(bridge as unknown as MediaWorkerBridge)
  })

  // 辅助：模拟 bridge 向 manager 推送事件
  function emitBridgeEvent(event: BridgeEvent) {
    bridge._handlers.forEach((h) => h(event))
  }

  // ============ setDbPath ============
  describe('setDbPath', () => {
    it('应注入数据库路径，使后续任务可启动', async () => {
      manager.setDbPath('/db/path')
      const p = manager.startThumbnailBatch({ cacheDir: '/cache' })
      expect(bridge.startThumbnailBatch).toHaveBeenCalledWith('/db/path', '/cache', 'standard')
      emitBridgeEvent({
        type: 'THUMBNAIL_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 1 }
      })
      const result = await p
      expect(result.success).toBe(true)
    })
  })

  // ============ startThumbnailBatch ============
  describe('startThumbnailBatch', () => {
    it('未设置 dbPath 时应返回失败', async () => {
      const result = await manager.startThumbnailBatch({ cacheDir: '/cache' })
      expect(result).toEqual({
        success: false,
        message: '数据库路径未初始化',
        processed: 0,
        total: 0
      })
      expect(bridge.startThumbnailBatch).not.toHaveBeenCalled()
    })

    it('任务进行中再次启动应返回失败', async () => {
      manager.setDbPath('/db')
      // 不触发 COMPLETE，让任务保持运行
      const p = manager.startThumbnailBatch({ cacheDir: '/cache' })
      const result = await manager.startThumbnailBatch({ cacheDir: '/cache2' })
      expect(result).toEqual({
        success: false,
        message: '缩略图批量生成已在进行中',
        processed: 0,
        total: 0
      })
      // 完成第一个任务，避免悬挂 promise
      emitBridgeEvent({
        type: 'THUMBNAIL_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 1 }
      })
      await p
    })

    it('应使用默认 thumbnailQuality=standard', async () => {
      manager.setDbPath('/db')
      const p = manager.startThumbnailBatch({ cacheDir: '/cache' })
      expect(bridge.startThumbnailBatch).toHaveBeenCalledWith('/db', '/cache', 'standard')
      emitBridgeEvent({
        type: 'THUMBNAIL_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 1 }
      })
      await p
    })

    it('应支持自定义 thumbnailQuality=high', async () => {
      manager.setDbPath('/db')
      const p = manager.startThumbnailBatch({ cacheDir: '/cache', thumbnailQuality: 'high' })
      expect(bridge.startThumbnailBatch).toHaveBeenCalledWith('/db', '/cache', 'high')
      emitBridgeEvent({
        type: 'THUMBNAIL_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 1 }
      })
      await p
    })

    it('应支持自定义 thumbnailQuality=low', async () => {
      manager.setDbPath('/db')
      const p = manager.startThumbnailBatch({ cacheDir: '/cache', thumbnailQuality: 'low' })
      expect(bridge.startThumbnailBatch).toHaveBeenCalledWith('/db', '/cache', 'low')
      emitBridgeEvent({
        type: 'THUMBNAIL_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 1 }
      })
      await p
    })

    it('收到 THUMBNAIL_COMPLETE 后 Promise 应 resolve', async () => {
      manager.setDbPath('/db')
      const p = manager.startThumbnailBatch({ cacheDir: '/cache' })

      const payload = { success: true, message: 'done', processed: 5, total: 10 }
      emitBridgeEvent({ type: 'THUMBNAIL_COMPLETE', payload })

      await expect(p).resolves.toEqual(payload)
    })

    it('bridge.startThumbnailBatch 抛错时 Promise 应 resolve 失败结果', async () => {
      manager.setDbPath('/db')
      bridge.startThumbnailBatch.mockRejectedValueOnce(new Error('worker start failed'))

      const result = await manager.startThumbnailBatch({ cacheDir: '/cache' })
      expect(result).toEqual({
        success: false,
        message: '缩略图批量生成启动失败: worker start failed',
        processed: 0,
        total: 0
      })
    })

    it('bridge.startThumbnailBatch 抛非 Error 时应转为字符串', async () => {
      manager.setDbPath('/db')
      bridge.startThumbnailBatch.mockRejectedValueOnce('string error')

      const result = await manager.startThumbnailBatch({ cacheDir: '/cache' })
      expect(result).toEqual({
        success: false,
        message: '缩略图批量生成启动失败: string error',
        processed: 0,
        total: 0
      })
    })

    it('任务完成后 isThumbnailBatchRunning 应返回 false', async () => {
      manager.setDbPath('/db')
      const p = manager.startThumbnailBatch({ cacheDir: '/cache' })
      expect(manager.isThumbnailBatchRunning()).toBe(true)
      emitBridgeEvent({
        type: 'THUMBNAIL_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 1 }
      })
      await p
      expect(manager.isThumbnailBatchRunning()).toBe(false)
    })
  })

  // ============ startPhashBatch ============
  describe('startPhashBatch', () => {
    it('未设置 dbPath 时应返回失败', async () => {
      const result = await manager.startPhashBatch()
      expect(result).toEqual({
        success: false,
        message: '数据库路径未初始化',
        processed: 0,
        total: 0
      })
      expect(bridge.startPhashBatch).not.toHaveBeenCalled()
    })

    it('任务进行中再次启动应返回失败', async () => {
      manager.setDbPath('/db')
      const p = manager.startPhashBatch()
      const result = await manager.startPhashBatch()
      expect(result).toEqual({
        success: false,
        message: 'pHash 批量补算已在进行中',
        processed: 0,
        total: 0
      })
      emitBridgeEvent({
        type: 'PHASH_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 1 }
      })
      await p
    })

    it('收到 PHASH_COMPLETE 后 Promise 应 resolve', async () => {
      manager.setDbPath('/db')
      const p = manager.startPhashBatch()

      const payload = {
        success: true,
        message: 'done',
        processed: 5,
        total: 10,
        duplicatesResult: { markedDuplicates: 2, totalGroups: 1 }
      }
      emitBridgeEvent({ type: 'PHASH_COMPLETE', payload })

      await expect(p).resolves.toEqual(payload)
    })

    it('bridge.startPhashBatch 抛错时 Promise 应 resolve 失败结果', async () => {
      manager.setDbPath('/db')
      bridge.startPhashBatch.mockRejectedValueOnce(new Error('phash start failed'))

      const result = await manager.startPhashBatch()
      expect(result).toEqual({
        success: false,
        message: 'pHash 批量补算启动失败: phash start failed',
        processed: 0,
        total: 0
      })
    })

    it('任务完成后 isPhashBatchRunning 应返回 false', async () => {
      manager.setDbPath('/db')
      const p = manager.startPhashBatch()
      expect(manager.isPhashBatchRunning()).toBe(true)
      emitBridgeEvent({
        type: 'PHASH_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 1 }
      })
      await p
      expect(manager.isPhashBatchRunning()).toBe(false)
    })
  })

  // ============ startDuplicateMark ============
  describe('startDuplicateMark', () => {
    it('未设置 dbPath 时应返回失败', async () => {
      const result = await manager.startDuplicateMark()
      expect(result).toEqual({
        success: false,
        message: '数据库路径未初始化',
        markedDuplicates: 0,
        totalGroups: 0
      })
      expect(bridge.startDuplicateMark).not.toHaveBeenCalled()
    })

    it('任务进行中再次启动应返回失败', async () => {
      manager.setDbPath('/db')
      const p = manager.startDuplicateMark()
      const result = await manager.startDuplicateMark()
      expect(result).toEqual({
        success: false,
        message: '重复标记已在进行中',
        markedDuplicates: 0,
        totalGroups: 0
      })
      emitBridgeEvent({
        type: 'DUPLICATE_COMPLETE',
        payload: { success: true, message: 'done', markedDuplicates: 0, totalGroups: 0 }
      })
      await p
    })

    it('收到 DUPLICATE_COMPLETE 后 Promise 应 resolve', async () => {
      manager.setDbPath('/db')
      const p = manager.startDuplicateMark()

      const payload = { success: true, message: 'done', markedDuplicates: 3, totalGroups: 2 }
      emitBridgeEvent({ type: 'DUPLICATE_COMPLETE', payload })

      await expect(p).resolves.toEqual(payload)
    })

    it('bridge.startDuplicateMark 抛错时 Promise 应 resolve 失败结果', async () => {
      manager.setDbPath('/db')
      bridge.startDuplicateMark.mockRejectedValueOnce(new Error('dup start failed'))

      const result = await manager.startDuplicateMark()
      expect(result).toEqual({
        success: false,
        message: '重复标记启动失败: dup start failed',
        markedDuplicates: 0,
        totalGroups: 0
      })
    })

    it('任务完成后 isDuplicateMarkRunning 应返回 false', async () => {
      manager.setDbPath('/db')
      const p = manager.startDuplicateMark()
      expect(manager.isDuplicateMarkRunning()).toBe(true)
      emitBridgeEvent({
        type: 'DUPLICATE_COMPLETE',
        payload: { success: true, message: 'done', markedDuplicates: 0, totalGroups: 0 }
      })
      await p
      expect(manager.isDuplicateMarkRunning()).toBe(false)
    })
  })

  // ============ stop 方法 ============
  describe('stopThumbnailBatch', () => {
    it('应转发到 bridge.stopThumbnailBatch', () => {
      manager.stopThumbnailBatch()
      expect(bridge.stopThumbnailBatch).toHaveBeenCalledTimes(1)
    })
  })

  describe('stopPhashBatch', () => {
    it('应转发到 bridge.stopPhashBatch', () => {
      manager.stopPhashBatch()
      expect(bridge.stopPhashBatch).toHaveBeenCalledTimes(1)
    })
  })

  describe('stopDuplicateMark', () => {
    it('应转发到 bridge.stopDuplicateMark', () => {
      manager.stopDuplicateMark()
      expect(bridge.stopDuplicateMark).toHaveBeenCalledTimes(1)
    })
  })

  // ============ 状态查询 ============
  describe('isThumbnailBatchRunning', () => {
    it('未启动任务时应返回 false', () => {
      expect(manager.isThumbnailBatchRunning()).toBe(false)
    })

    it('任务运行中应返回 true', async () => {
      manager.setDbPath('/db')
      const p = manager.startThumbnailBatch({ cacheDir: '/cache' })
      expect(manager.isThumbnailBatchRunning()).toBe(true)
      emitBridgeEvent({
        type: 'THUMBNAIL_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 1 }
      })
      await p
    })
  })

  describe('isPhashBatchRunning', () => {
    it('未启动任务时应返回 false', () => {
      expect(manager.isPhashBatchRunning()).toBe(false)
    })

    it('任务运行中应返回 true', async () => {
      manager.setDbPath('/db')
      const p = manager.startPhashBatch()
      expect(manager.isPhashBatchRunning()).toBe(true)
      emitBridgeEvent({
        type: 'PHASH_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 1 }
      })
      await p
    })
  })

  describe('isDuplicateMarkRunning', () => {
    it('未启动任务时应返回 false', () => {
      expect(manager.isDuplicateMarkRunning()).toBe(false)
    })

    it('任务运行中应返回 true', async () => {
      manager.setDbPath('/db')
      const p = manager.startDuplicateMark()
      expect(manager.isDuplicateMarkRunning()).toBe(true)
      emitBridgeEvent({
        type: 'DUPLICATE_COMPLETE',
        payload: { success: true, message: 'done', markedDuplicates: 0, totalGroups: 0 }
      })
      await p
    })
  })

  // ============ EventEmitter 转发 ============
  describe('subscribeBridgeEvents 事件转发', () => {
    it('THUMBNAIL_PROGRESS 应转发为 thumbnail:progress 事件', async () => {
      manager.setDbPath('/db')
      const listener = vi.fn()
      manager.on('thumbnail:progress', listener)

      const p = manager.startThumbnailBatch({ cacheDir: '/cache' })
      const payload = { processed: 1, total: 10, currentFile: '/a.jpg' }
      emitBridgeEvent({ type: 'THUMBNAIL_PROGRESS', payload })
      expect(listener).toHaveBeenCalledWith(payload)

      emitBridgeEvent({
        type: 'THUMBNAIL_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 10 }
      })
      await p
    })

    it('THUMBNAIL_COMPLETE 应转发为 thumbnail:complete 事件', async () => {
      manager.setDbPath('/db')
      const listener = vi.fn()
      manager.on('thumbnail:complete', listener)

      const p = manager.startThumbnailBatch({ cacheDir: '/cache' })
      const payload = { success: true, message: 'done', processed: 5, total: 10 }
      emitBridgeEvent({ type: 'THUMBNAIL_COMPLETE', payload })
      expect(listener).toHaveBeenCalledWith(payload)
      await p
    })

    it('PHASH_PROGRESS 应转发为 phash:progress 事件', async () => {
      manager.setDbPath('/db')
      const listener = vi.fn()
      manager.on('phash:progress', listener)

      const p = manager.startPhashBatch()
      const payload = { processed: 1, total: 5, currentFile: '/b.jpg' }
      emitBridgeEvent({ type: 'PHASH_PROGRESS', payload })
      expect(listener).toHaveBeenCalledWith(payload)

      emitBridgeEvent({
        type: 'PHASH_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 5 }
      })
      await p
    })

    it('PHASH_COMPLETE 应转发为 phash:complete 事件', async () => {
      manager.setDbPath('/db')
      const listener = vi.fn()
      manager.on('phash:complete', listener)

      const p = manager.startPhashBatch()
      const payload = {
        success: true,
        message: 'done',
        processed: 5,
        total: 5,
        duplicatesResult: { markedDuplicates: 2, totalGroups: 1 }
      }
      emitBridgeEvent({ type: 'PHASH_COMPLETE', payload })
      expect(listener).toHaveBeenCalledWith(payload)
      await p
    })

    it('DUPLICATE_PROGRESS 应转发为 duplicate:progress 事件', async () => {
      manager.setDbPath('/db')
      const listener = vi.fn()
      manager.on('duplicate:progress', listener)

      const p = manager.startDuplicateMark()
      const payload = { compared: 100, totalPairs: 1000 }
      emitBridgeEvent({ type: 'DUPLICATE_PROGRESS', payload })
      expect(listener).toHaveBeenCalledWith(payload)

      emitBridgeEvent({
        type: 'DUPLICATE_COMPLETE',
        payload: { success: true, message: 'done', markedDuplicates: 0, totalGroups: 0 }
      })
      await p
    })

    it('DUPLICATE_COMPLETE 应转发为 duplicate:complete 事件', async () => {
      manager.setDbPath('/db')
      const listener = vi.fn()
      manager.on('duplicate:complete', listener)

      const p = manager.startDuplicateMark()
      const payload = { success: true, message: 'done', markedDuplicates: 3, totalGroups: 2 }
      emitBridgeEvent({ type: 'DUPLICATE_COMPLETE', payload })
      expect(listener).toHaveBeenCalledWith(payload)
      await p
    })

    it('PROGRESS 事件应转发 payload 副本（不引用原对象）', async () => {
      manager.setDbPath('/db')
      const listener = vi.fn()
      manager.on('thumbnail:progress', listener)

      const p = manager.startThumbnailBatch({ cacheDir: '/cache' })
      const payload = { processed: 1, total: 10, currentFile: '/a.jpg' }
      emitBridgeEvent({ type: 'THUMBNAIL_PROGRESS', payload })
      const forwarded = listener.mock.calls[0][0]
      expect(forwarded).not.toBe(payload)
      expect(forwarded).toEqual(payload)

      emitBridgeEvent({
        type: 'THUMBNAIL_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 10 }
      })
      await p
    })

    it('MEDIA_WORKER_LOG 不应被转发为 EventEmitter 事件', async () => {
      manager.setDbPath('/db')
      const progressListener = vi.fn()
      const completeListener = vi.fn()
      manager.on('thumbnail:progress', progressListener)
      manager.on('thumbnail:complete', completeListener)

      const p = manager.startThumbnailBatch({ cacheDir: '/cache' })
      emitBridgeEvent({
        type: 'MEDIA_WORKER_LOG',
        payload: { level: 'error', message: 'log msg' }
      })
      expect(progressListener).not.toHaveBeenCalled()
      expect(completeListener).not.toHaveBeenCalled()

      emitBridgeEvent({
        type: 'THUMBNAIL_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 10 }
      })
      await p
    })

    it('WORKER_READY 不应被转发为 EventEmitter 事件', async () => {
      manager.setDbPath('/db')
      const progressListener = vi.fn()
      manager.on('thumbnail:progress', progressListener)

      const p = manager.startThumbnailBatch({ cacheDir: '/cache' })
      emitBridgeEvent({ type: 'WORKER_READY' })
      expect(progressListener).not.toHaveBeenCalled()

      emitBridgeEvent({
        type: 'THUMBNAIL_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 10 }
      })
      await p
    })

    it('WORKER_ERROR 不应被转发为 EventEmitter 事件', async () => {
      manager.setDbPath('/db')
      const progressListener = vi.fn()
      manager.on('thumbnail:progress', progressListener)

      const p = manager.startThumbnailBatch({ cacheDir: '/cache' })
      emitBridgeEvent({
        type: 'WORKER_ERROR',
        payload: { message: 'crashed', stack: 'stack' }
      })
      expect(progressListener).not.toHaveBeenCalled()

      emitBridgeEvent({
        type: 'THUMBNAIL_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 10 }
      })
      await p
    })
  })

  // ============ 多任务并行 ============
  describe('多任务并行', () => {
    it('三类任务可并行运行', async () => {
      manager.setDbPath('/db')
      const pThumb = manager.startThumbnailBatch({ cacheDir: '/cache' })
      const pPhash = manager.startPhashBatch()
      const pDup = manager.startDuplicateMark()

      expect(manager.isThumbnailBatchRunning()).toBe(true)
      expect(manager.isPhashBatchRunning()).toBe(true)
      expect(manager.isDuplicateMarkRunning()).toBe(true)

      emitBridgeEvent({
        type: 'THUMBNAIL_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 1 }
      })
      emitBridgeEvent({
        type: 'PHASH_COMPLETE',
        payload: { success: true, message: 'done', processed: 1, total: 1 }
      })
      emitBridgeEvent({
        type: 'DUPLICATE_COMPLETE',
        payload: { success: true, message: 'done', markedDuplicates: 0, totalGroups: 0 }
      })

      await Promise.all([pThumb, pPhash, pDup])
      expect(manager.isThumbnailBatchRunning()).toBe(false)
      expect(manager.isPhashBatchRunning()).toBe(false)
      expect(manager.isDuplicateMarkRunning()).toBe(false)
    })
  })

  // ============ FIX(组11-1): 崩溃恢复执行器 ============
  describe('restoreExecutor（组11-1）', () => {
    it('构造时向 bridge 注入恢复执行器', () => {
      expect(bridge.setRestoreExecutor).toHaveBeenCalledTimes(1)
    })

    it('恢复执行器经 Manager.startThumbnailBatch 走互斥与任务注册路径', async () => {
      manager.setDbPath('/db')
      const executor = bridge.setRestoreExecutor.mock.calls[0][0] as (tasks: {
        thumbnail: { cacheDir: string; thumbnailQuality: 'low' | 'standard' | 'high' } | null
        phash: boolean
        duplicate: boolean
        similar: { threshold: number } | null
      }) => Promise<void>

      const restored = executor({
        thumbnail: { cacheDir: '/cache', thumbnailQuality: 'high' },
        phash: false,
        duplicate: false,
        similar: null
      })
      // 经 Manager 层：bridge.startThumbnailBatch 以 Manager 的 dbPath 调用
      expect(bridge.startThumbnailBatch).toHaveBeenCalledWith('/db', '/cache', 'high')

      // 恢复期间用户手动启动同类型任务 → Manager 互斥拒绝（不再绕过互斥并发直连 worker）
      const concurrent = await manager.startThumbnailBatch({ cacheDir: '/other' })
      expect(concurrent.success).toBe(false)
      expect(concurrent.message).toContain('已在进行中')

      emitBridgeEvent({
        type: 'THUMBNAIL_COMPLETE',
        payload: { success: true, message: 'restored', processed: 1, total: 1 }
      })
      await restored
    })
  })

  // ============ 缩略图进度节流广播（THUMBNAIL_OPTIMIZATION_PLAN 节点1） ============
  // 批量进行中周期性通知渲染层刷新（media:updated），使新落盘缩略图逐步可见，
  // 不再等整批完成才有一次刷新（可视项「模糊数十秒才清晰」的主因）。
  describe('thumbnailProgressNotifier（进度节流广播）', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    function emitProgress(processed: number) {
      emitBridgeEvent({
        type: 'THUMBNAIL_PROGRESS',
        payload: { processed, total: 10, currentFile: '/a.jpg' }
      })
    }

    function emitComplete(processed: number) {
      emitBridgeEvent({
        type: 'THUMBNAIL_COMPLETE',
        payload: { success: true, message: 'done', processed, total: 10 }
      })
    }

    it('注入 notifier 后，首个 THUMBNAIL_PROGRESS 应立即通知', () => {
      manager.setDbPath('/db')
      const notifier = vi.fn()
      manager.setThumbnailProgressNotifier(notifier)
      const p = manager.startThumbnailBatch({ cacheDir: '/cache' })
      emitProgress(1)
      expect(notifier).toHaveBeenCalledTimes(1)
      emitComplete(1)
      return p
    })

    it('节流窗口（2s）内连续进度只通知一次', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
      manager.setDbPath('/db')
      const notifier = vi.fn()
      manager.setThumbnailProgressNotifier(notifier)
      const p = manager.startThumbnailBatch({ cacheDir: '/cache' })
      emitProgress(1)
      emitProgress(2)
      emitProgress(3)
      expect(notifier).toHaveBeenCalledTimes(1)
      emitComplete(3)
      return p
    })

    it('窗口过期（≥2s）后的新进度应再次通知', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
      manager.setDbPath('/db')
      const notifier = vi.fn()
      manager.setThumbnailProgressNotifier(notifier)
      const p = manager.startThumbnailBatch({ cacheDir: '/cache' })
      emitProgress(1)
      expect(notifier).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(2000)
      emitProgress(4)
      expect(notifier).toHaveBeenCalledTimes(2)
      emitComplete(4)
      return p
    })

    it('未注入 notifier 时收到进度不应调用、不应抛错', () => {
      manager.setDbPath('/db')
      const p = manager.startThumbnailBatch({ cacheDir: '/cache' })
      expect(() => emitProgress(1)).not.toThrow()
      emitComplete(1)
      return p
    })

    it('THUMBNAIL_COMPLETE 应立即补一次通知并重置节流窗口', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
      manager.setDbPath('/db')
      const notifier = vi.fn()
      manager.setThumbnailProgressNotifier(notifier)
      const p = manager.startThumbnailBatch({ cacheDir: '/cache' })
      emitProgress(1)
      expect(notifier).toHaveBeenCalledTimes(1)
      emitComplete(10)
      // 完成立即补发，批量尾部数据不因节流丢失（覆盖 worker 崩溃恢复等无外层广播的路径）
      expect(notifier).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(1)
      // 下一批任务的进度不被上一批的节流窗口压制
      const p2 = manager.startThumbnailBatch({ cacheDir: '/cache' })
      emitProgress(1)
      expect(notifier).toHaveBeenCalledTimes(3)
      emitComplete(1)
      return Promise.all([p, p2])
    })
  })
})
