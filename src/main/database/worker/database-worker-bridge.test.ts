/**
 * FIX(组9-2) 回归测试：DatabaseWorkerBridge 写请求超时兜底。
 *
 * 原实现 pendingRequests 无任何超时机制：worker 进程存活但卡死（超大事务/
 * busy_timeout 反复等锁/native 死锁）时，写请求 Promise 永久 pending，
 * 调用方无限等待且无诊断信号（enqueuedAt 已采集但无人消费）。
 *
 * Mock 策略：electron.utilityProcess.fork → EventEmitter 模拟 worker（不回复 DB_RESULT）。
 *
 * 运行：npx vitest run src/main/database/worker/database-worker-bridge.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { UtilityProcess } from 'electron'

const { mockFork, loggerFaultMock } = vi.hoisted(() => ({
  mockFork: vi.fn(),
  loggerFaultMock: vi.fn()
}))

vi.mock('electron', () => ({
  utilityProcess: {
    fork: (...args: unknown[]) => mockFork(...args)
  }
}))

vi.mock('../../utils/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    fault: (...args: unknown[]) => loggerFaultMock(...args)
  }
}))

import { DatabaseWorkerBridge } from './database-worker-bridge'

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

describe('DatabaseWorkerBridge 写请求超时（组9-2）', () => {
  let bridge: DatabaseWorkerBridge
  let mockWorker: ReturnType<typeof createMockWorker>

  beforeEach(() => {
    vi.clearAllMocks()
    mockFork.mockReset()
    mockWorker = createMockWorker()
    mockFork.mockReturnValue(mockWorker)
    bridge = new DatabaseWorkerBridge()
  })

  afterEach(async () => {
    vi.useFakeTimers()
    const disposePromise = bridge.dispose().catch(() => {})
    vi.advanceTimersByTime(500)
    await disposePromise
    vi.useRealTimers()
  })

  it('worker 就绪但永不回复时，写请求在 60s 超时后被 reject 并记录 fault', async () => {
    vi.useFakeTimers()
    const promise = bridge.execute('/mock/db', 'UPDATE media_files SET rating = 5 WHERE id = 1')
    // 完成 DB_READY 握手（execute 的后续入队在微任务恢复后执行，需先排空）
    mockWorker.emit('message', { type: 'DB_READY' })
    await vi.advanceTimersByTimeAsync(0)
    // DB_EXECUTE 已发出
    expect(mockWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DB_EXECUTE' })
    )

    const assertion = expect(promise).rejects.toThrow('写请求超时')
    // 推进超过 60s 超时上限（巡检间隔 15s）
    await vi.advanceTimersByTimeAsync(75_000)
    await assertion

    // 诊断信号：fault 日志携带 requestId 与 SQL
    expect(loggerFaultMock).toHaveBeenCalledWith(
      'workerCrash',
      expect.objectContaining({ message: expect.stringContaining('写请求超时') }),
      expect.objectContaining({ workerName: 'database-worker', stage: 'request-timeout' })
    )
  })

  it('超时后迟到的 DB_RESULT 被忽略（不再影响已 reject 的请求）', async () => {
    vi.useFakeTimers()
    const promise = bridge.execute('/mock/db', 'UPDATE t SET a = 1')
    mockWorker.emit('message', { type: 'DB_READY' })
    await vi.advanceTimersByTimeAsync(0)
    const assertion = expect(promise).rejects.toThrow('写请求超时')
    await vi.advanceTimersByTimeAsync(75_000)
    await assertion

    // 迟到响应：requestId=1 的 DB_RESULT 不应抛错（handleWorkerMessage 忽略未知 requestId）
    expect(() =>
      mockWorker.emit('message', {
        type: 'DB_RESULT',
        payload: { requestId: 1, success: true, result: { changes: 1, lastInsertRowid: 1 } }
      })
    ).not.toThrow()
  })

  it('正常回复的请求不受巡检影响（超时前 resolve）', async () => {
    const promise = bridge.execute('/mock/db', 'UPDATE t SET a = 2')
    mockWorker.emit('message', { type: 'DB_READY' })
    // 排空微任务：让 execute 完成入队（requestId=1）后再回复
    await new Promise((r) => setTimeout(r, 0))
    mockWorker.emit('message', {
      type: 'DB_RESULT',
      payload: { requestId: 1, success: true, result: { changes: 1, lastInsertRowid: 1 } }
    })
    await expect(promise).resolves.toEqual({ changes: 1, lastInsertRowid: 1 })
  })
})
