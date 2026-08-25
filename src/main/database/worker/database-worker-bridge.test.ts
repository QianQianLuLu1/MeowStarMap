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
  emitter.postMessage = vi.fn((cmd: unknown) => {
    // 模拟 worker 处理完 DB_DISPOSE 后关闭 DB 句柄并回发确认（用微任务确保 disposeResolve 已就绪）
    if (cmd && typeof cmd === 'object' && (cmd as { type?: string }).type === 'DB_DISPOSE') {
      queueMicrotask(() => emitter.emit('message', { type: 'DB_WORKER_DISPOSED' }))
    }
  })
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

describe('DatabaseWorkerBridge stopWorkerForRestore（自恢复期间可逆停 worker）', () => {
  let bridge: DatabaseWorkerBridge
  let mockWorker: ReturnType<typeof createMockWorker>
  const dbPath = '/mock/userdata/database/app.db'

  beforeEach(() => {
    vi.clearAllMocks()
    mockFork.mockReset()
    mockWorker = createMockWorker()
    mockFork.mockReturnValue(mockWorker)
    bridge = new DatabaseWorkerBridge()
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
    const promise = bridge.execute(dbPath, 'UPDATE t SET a = 1')
    mockWorker.emit('message', { type: 'DB_READY' })
    await vi.advanceTimersByTimeAsync(0)
    mockWorker.emit('message', {
      type: 'DB_RESULT',
      payload: { requestId: 1, success: true, result: { changes: 1, lastInsertRowid: 1 } }
    })
    await promise
  }

  it('发送 DB_DISPOSE 并 kill worker，且 kill 触发的 exit 不会自动重启', async () => {
    await bootWorker()
    const forkBefore = mockFork.mock.calls.length
    expect(mockWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DB_OPEN' })
    )

    const p = bridge.stopWorkerForRestore()
    await vi.advanceTimersByTimeAsync(500)
    await p

    expect(mockWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DB_DISPOSE' })
    )
    expect(mockWorker.kill).toHaveBeenCalled()
    // 模拟 kill 产生的非零码退出（被 terminatingForRestore 抑制，不应自动重启）
    mockWorker.emit('exit', null, 'SIGTERM')
    expect(mockFork.mock.calls.length).toBe(forkBefore)
  })

  it('停止后不置 isDisposed，可经 execute 重新 fork 实现连接重建', async () => {
    await bootWorker()

    const p = bridge.stopWorkerForRestore()
    await vi.advanceTimersByTimeAsync(500)
    await p
    mockWorker.emit('exit', null, 'SIGTERM')

    // 新 worker：验证 isDisposed 未阻断后续启动（否则 ensureWorker 会抛错）
    const mockWorker2 = createMockWorker()
    mockFork.mockReturnValue(mockWorker2)
    const p2 = bridge.execute(dbPath, 'UPDATE t SET a = 2')
    mockWorker2.emit('message', { type: 'DB_READY' })
    await vi.advanceTimersByTimeAsync(0)
    mockWorker2.emit('message', {
      type: 'DB_RESULT',
      payload: { requestId: 2, success: true, result: { changes: 1, lastInsertRowid: 1 } }
    })
    await expect(p2).resolves.toEqual({ changes: 1, lastInsertRowid: 1 })
  })

  it('无 worker 时 stopWorkerForRestore 为安全 no-op（启动期常见情形）', async () => {
    await expect(bridge.stopWorkerForRestore()).resolves.toBeUndefined()
  })

  it('收到 DB_WORKER_DISPOSED 后解除等待并立即 kill（不再盲等固定时长）', async () => {
    await bootWorker()
    // 关闭 auto-ack，手动回发确认，验证确认消息驱动解除等待（而非等 2000ms 超时兜底）
    mockWorker.postMessage = vi.fn()
    const p = bridge.stopWorkerForRestore()
    mockWorker.emit('message', { type: 'DB_WORKER_DISPOSED' })
    await p
    expect(mockWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DB_DISPOSE' })
    )
    expect(mockWorker.kill).toHaveBeenCalled()
  })

  it('worker 未回发确认时超时兜底仍会 kill（不永久阻塞）', async () => {
    await bootWorker()
    // 关闭 auto-ack：覆盖 postMessage 使其不回发确认
    mockWorker.postMessage = vi.fn()
    const p = bridge.stopWorkerForRestore()
    // 不回发确认：推进到 DISPOSE_CONFIRM_TIMEOUT_MS(2000) 触发超时兜底
    await vi.advanceTimersByTimeAsync(2000)
    await p
    expect(mockWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DB_DISPOSE' })
    )
    expect(mockWorker.kill).toHaveBeenCalled()
  })
})

describe('DatabaseWorkerBridge hasLiveWorker（自恢复并发边界探针）', () => {
  let bridge: DatabaseWorkerBridge
  let mockWorker: ReturnType<typeof createMockWorker>
  const dbPath = '/mock/userdata/database/app.db'

  beforeEach(() => {
    vi.clearAllMocks()
    mockFork.mockReset()
    mockWorker = createMockWorker()
    mockFork.mockReturnValue(mockWorker)
    bridge = new DatabaseWorkerBridge()
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
    const promise = bridge.execute(dbPath, 'UPDATE t SET a = 1')
    mockWorker.emit('message', { type: 'DB_READY' })
    await vi.advanceTimersByTimeAsync(0)
    mockWorker.emit('message', {
      type: 'DB_RESULT',
      payload: { requestId: 1, success: true, result: { changes: 1, lastInsertRowid: 1 } }
    })
    await promise
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
    const p = bridge.stopWorkerForRestore()
    await vi.advanceTimersByTimeAsync(500)
    await p
    expect(bridge.hasLiveWorker()).toBe(false)
  })
})
