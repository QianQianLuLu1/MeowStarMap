/**
 * FIX(组16-1) 回归测试：VideoEditorBridge 并发互斥守卫。
 *
 * 原实现 editSingle/editBatch 共享实例状态（currentTaskId/pendingResolvers/节流器），
 * 且 editSingle 恒用 pendingResolvers[0]——并发调用时后到者覆盖前者状态，
 * 先到调用方的 Promise 永不 settle，EDIT_COMPLETE 按索引解析到错误的调用方。
 *
 * Mock 策略：electron.utilityProcess.fork → EventEmitter 模拟 worker + logger 桩。
 *
 * 运行：npx vitest run src/main/video-editor/bridge.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { UtilityProcess } from 'electron'

const { mockFork } = vi.hoisted(() => ({ mockFork: vi.fn() }))

vi.mock('electron', () => ({
  utilityProcess: {
    fork: (...args: unknown[]) => mockFork(...args)
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../utils/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    fault: vi.fn()
  }
}))

import { VideoEditorBridge } from './bridge'
import type { VideoEditTask } from './types'

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

function makeTask(outputPath: string): VideoEditTask {
  return {
    inputPath: '/in/a.mp4',
    outputPath,
    params: {}
  } as unknown as VideoEditTask
}

describe('VideoEditorBridge 并发互斥（组16-1）', () => {
  let bridge: VideoEditorBridge
  let mockWorker: ReturnType<typeof createMockWorker>

  beforeEach(() => {
    vi.clearAllMocks()
    mockFork.mockReset()
    mockWorker = createMockWorker()
    mockFork.mockReturnValue(mockWorker)
    bridge = new VideoEditorBridge()
  })

  afterEach(async () => {
    vi.useFakeTimers()
    const disposePromise = bridge.dispose().catch(() => {})
    vi.advanceTimersByTime(500)
    await disposePromise
    vi.useRealTimers()
  })

  /**
   * 启动单个编辑任务（握手完成、EDIT_START 已发出、Promise 悬挂等待 COMPLETE）。
   * FIX(组16-1): 必须以对象属性返回悬挂 Promise——async 函数直接 `return p`
   * 会让外层 Promise 采纳 p 的状态，调用方 `await startPendingEdit()` 就变成了
   * 等待编辑完成本身，与"启动后立即返回"的意图死锁（COMPLETE 在 await 之后才发出）。
   */
  async function startPendingEdit(outputPath: string): Promise<{ promise: Promise<string> }> {
    const promise = bridge.editSingle(makeTask(outputPath))
    // afterEach dispose 会兜底 reject 未完成任务；用例不消费该分支时避免 unhandled rejection
    promise.catch(() => {})
    mockWorker.emit('message', { type: 'WORKER_READY' })
    await new Promise((r) => setTimeout(r, 0))
    return { promise }
  }

  it('FIX(组16-1): 编辑进行中再次 editSingle 应立即抛错，不覆盖前者的任务状态', async () => {
    const { promise: first } = await startPendingEdit('/out/first.mp4')
    // 并发的第二个调用被互斥拒绝（原实现会覆盖 pendingResolvers[0]，first 永不 settle）
    await expect(bridge.editSingle(makeTask('/out/second.mp4'))).rejects.toThrow(
      '已有视频编辑任务正在进行'
    )

    // 前者的 resolver 仍然有效：worker 回发 index=0 的 COMPLETE 解析到 first
    mockWorker.emit('message', {
      type: 'EDIT_COMPLETE',
      payload: { success: true, message: 'ok', index: 0, outputPath: '/out/first.mp4' }
    })
    await expect(first).resolves.toBe('/out/first.mp4')
  })

  it('FIX(组16-1): 编辑进行中发起 editBatch 应立即抛错', async () => {
    await startPendingEdit('/out/single.mp4')
    await expect(
      bridge.editBatch([makeTask('/out/b1.mp4'), makeTask('/out/b2.mp4')])
    ).rejects.toThrow('已有视频编辑任务正在进行')
  })

  it('前一个任务完成后互斥解除，可再次编辑', async () => {
    const { promise: first } = await startPendingEdit('/out/first.mp4')
    mockWorker.emit('message', {
      type: 'EDIT_COMPLETE',
      payload: { success: true, message: 'ok', index: 0, outputPath: '/out/first.mp4' }
    })
    await expect(first).resolves.toBe('/out/first.mp4')

    // 互斥已解除：第二个编辑正常启动
    const { promise: second } = await startPendingEdit('/out/second.mp4')
    mockWorker.emit('message', {
      type: 'EDIT_COMPLETE',
      payload: { success: true, message: 'ok', index: 0, outputPath: '/out/second.mp4' }
    })
    await expect(second).resolves.toBe('/out/second.mp4')
  })
})
