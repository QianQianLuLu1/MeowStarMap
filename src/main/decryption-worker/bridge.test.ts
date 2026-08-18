/**
 * DecryptionWorkerBridge 单元测试
 *
 * 测试目标：src/main/decryption-worker/bridge.ts
 * 测试层级：L2（依赖 mock，无真实 worker 进程）
 *
 * Mock 策略：
 * - electron.utilityProcess.fork → 返回 EventEmitter 模拟 worker
 * - ./dll-path → 固定返回假 DLL 路径（fork 前置依赖）
 * - ../utils/logger → vi.fn() 捕获调用
 *
 * 测试覆盖（FIX 组17-1 验收点）：
 * - READY 握手 + INIT 下发 + requestId 请求/响应匹配
 * - 8s 硬超时：优雅失败 + kill 冻结 worker + 重启策略恢复
 * - worker 崩溃：pending 降级 + 自动重启 + 崩溃通知
 * - READY 15s 超时：not-ready + startup-timeout 通知
 * - 超时后迟到结果忽略、并发调用只 fork 一次、DLL 缺失、dispose
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { UtilityProcess } from 'electron'
import type { DecryptionWorkerCommand, DecryptionWorkerEvent } from './worker-protocol'

// ---- Mock electron ----
const mockFork = vi.fn()
vi.mock('electron', () => ({
  utilityProcess: {
    fork: (...args: unknown[]) => mockFork(...args)
  }
}))

// ---- Mock dll-path ----
const mockFindDllPath = vi.fn(() => '/fake/nuan5_decryption.dll')
vi.mock('./dll-path', () => ({
  findDllPath: (...args: unknown[]) => mockFindDllPath(...args)
}))

// ---- Mock logger ----
vi.mock('../utils/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    fault: vi.fn()
  }
}))

import { DecryptionWorkerBridge } from './bridge'

type MockWorker = UtilityProcess & {
  postMessage: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
}

function createMockWorker(): MockWorker {
  const emitter = new EventEmitter() as unknown as MockWorker
  emitter.postMessage = vi.fn()
  emitter.kill = vi.fn()
  return emitter
}

/** 从 worker 的 postMessage 调用中取最新一条指定类型命令 */
function sentCommand(worker: MockWorker, type: DecryptionWorkerCommand['type']): any {
  const calls = worker.postMessage.mock.calls.filter(
    (c) => (c[0] as DecryptionWorkerCommand).type === type
  )
  return calls.length ? calls[calls.length - 1][0] : undefined
}

describe('DecryptionWorkerBridge', () => {
  let bridge: DecryptionWorkerBridge
  let workers: MockWorker[]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockFindDllPath.mockReset()
    mockFindDllPath.mockReturnValue('/fake/nuan5_decryption.dll')
    workers = []
    mockFork.mockReset()
    mockFork.mockImplementation(() => {
      const w = createMockWorker()
      workers.push(w)
      return w
    })
    bridge = new DecryptionWorkerBridge()
  })

  afterEach(async () => {
    // 清理可能残留的握手 / 请求定时器，避免跨用例泄漏（推进 dispose 500ms 宽限）
    const disposePromise = bridge.dispose().catch(() => {})
    await vi.advanceTimersByTimeAsync(500)
    await disposePromise
    vi.useRealTimers()
  })

  /** 启动 worker 并完成 READY 握手，返回当前 worker */
  async function readyWorker(): Promise<MockWorker> {
    const worker = workers[workers.length - 1]
    await vi.advanceTimersByTimeAsync(0)
    worker.emit('message', { type: 'WORKER_READY' } satisfies DecryptionWorkerEvent)
    await vi.advanceTimersByTimeAsync(0)
    return worker
  }

  // ============ 握手 + 请求/响应 ============

  it('decodeNetwork 应 fork worker、下发 INIT(dllPath) 并在 READY 后发送 NETWORK_DECODE', async () => {
    const p = bridge.decodeNetwork('clothDiy', 'CODE123')
    const worker = await readyWorker()

    expect(mockFork).toHaveBeenCalledWith(expect.stringContaining('decryption-worker.js'), [], {
      serviceName: 'decryption-worker',
      stdio: 'pipe'
    })
    expect(sentCommand(worker, 'DECRYPT_WORKER_INIT')).toEqual({
      type: 'DECRYPT_WORKER_INIT',
      payload: { dllPath: '/fake/nuan5_decryption.dll' }
    })
    const cmd = sentCommand(worker, 'NETWORK_DECODE')
    expect(cmd.type).toBe('NETWORK_DECODE')
    expect(cmd.payload.kind).toBe('clothDiy')
    expect(cmd.payload.codeStr).toBe('CODE123')
    expect(typeof cmd.payload.requestId).toBe('string')

    worker.emit('message', {
      type: 'NETWORK_DECODE_RESULT',
      payload: { requestId: cmd.payload.requestId, status: 0, networkData: '{"color":"red"}' }
    } satisfies DecryptionWorkerEvent)
    const r = await p
    expect(r).toMatchObject({ ok: true, status: 0, networkData: '{"color":"red"}' })
  })

  it('worker 已启动时应复用，不重复 fork', async () => {
    const p1 = bridge.decodeNetwork('clothDiy', 'A')
    const worker = await readyWorker()
    worker.emit('message', {
      type: 'NETWORK_DECODE_RESULT',
      payload: { requestId: sentCommand(worker, 'NETWORK_DECODE').payload.requestId, status: 0 }
    } satisfies DecryptionWorkerEvent)
    await p1

    const p2 = bridge.decodeNetwork('homeBuild', 'B')
    await vi.advanceTimersByTimeAsync(0)
    expect(mockFork).toHaveBeenCalledTimes(1)
    worker.emit('message', {
      type: 'NETWORK_DECODE_RESULT',
      payload: { requestId: sentCommand(worker, 'NETWORK_DECODE').payload.requestId, status: 0 }
    } satisfies DecryptionWorkerEvent)
    await p2
  })

  it('worker 未启动时并发调用只 fork 一次', async () => {
    const p1 = bridge.decodeNetwork('clothDiy', 'A')
    const p2 = bridge.decodeNetwork('homeBuild', 'B')
    await vi.advanceTimersByTimeAsync(0)
    expect(mockFork).toHaveBeenCalledTimes(1)
    const worker = workers[0]
    worker.emit('message', { type: 'WORKER_READY' } satisfies DecryptionWorkerEvent)
    await vi.advanceTimersByTimeAsync(0)

    // 两个请求都已入队。发送顺序不保证与调用顺序一致（p2 无需等 READY 即入队），
    // 逐条回传各自的 requestId 后统一结算
    const cmds = worker.postMessage.mock.calls
      .map((c) => c[0] as DecryptionWorkerCommand)
      .filter((c) => c.type === 'NETWORK_DECODE')
    expect(cmds).toHaveLength(2)
    for (const cmd of cmds) {
      worker.emit('message', {
        type: 'NETWORK_DECODE_RESULT',
        payload: { requestId: cmd.payload.requestId, status: 0 }
      } satisfies DecryptionWorkerEvent)
    }
    await Promise.all([p1, p2])
  })

  // ============ 8s 硬超时（核心） ============

  it('8s 超时应优雅失败并 kill 冻结的 worker', async () => {
    const p = bridge.decodeNetwork('clothDiy', 'CODE')
    const worker = await readyWorker()

    await vi.advanceTimersByTimeAsync(8000)
    const r = await p
    expect(r).toEqual({ ok: false, reason: 'timeout' })
    expect(worker.kill).toHaveBeenCalled()
  })

  it('超时后迟到的 RESULT 应被忽略且不抛错', async () => {
    const p = bridge.decodeNetwork('clothDiy', 'CODE')
    const worker = await readyWorker()
    await vi.advanceTimersByTimeAsync(8000)
    await p

    const requestId = sentCommand(worker, 'NETWORK_DECODE').payload.requestId
    expect(() =>
      worker.emit('message', {
        type: 'NETWORK_DECODE_RESULT',
        payload: { requestId, status: 0, networkData: 'late' }
      } satisfies DecryptionWorkerEvent)
    ).not.toThrow()
  })

  it('超时 kill 触发 exit 后应按重启策略重新 fork，且后续请求可用', async () => {
    const p1 = bridge.decodeNetwork('clothDiy', 'CODE')
    const worker1 = await readyWorker()
    await vi.advanceTimersByTimeAsync(8000)
    await p1

    // kill 后 worker 以非零码退出 → 触发自动重启
    worker1.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(2000) // 重启冷却 2s
    expect(mockFork).toHaveBeenCalledTimes(2)

    const worker2 = await readyWorker()
    const p2 = bridge.decodeNetwork('homeBuild', 'CODE2')
    await vi.advanceTimersByTimeAsync(0)
    worker2.emit('message', {
      type: 'NETWORK_DECODE_RESULT',
      payload: { requestId: sentCommand(worker2, 'NETWORK_DECODE').payload.requestId, status: 0 }
    } satisfies DecryptionWorkerEvent)
    const r2 = await p2
    expect(r2).toMatchObject({ ok: true, status: 0 })
  })

  // ============ 崩溃路径 ============

  it('请求进行中 worker 崩溃：pending 按降级结算并自动重启', async () => {
    const crashListener = vi.fn()
    bridge.onCrash(crashListener)

    const p = bridge.decodeNetwork('clothDiy', 'CODE')
    const worker = await readyWorker()
    worker.emit('exit', 1)

    const r = await p
    expect(r).toEqual({ ok: false, reason: 'worker-crashed' })
    expect(crashListener).toHaveBeenCalledTimes(1)
    expect(crashListener).toHaveBeenCalledWith(
      expect.objectContaining({
        workerName: 'decryption-worker',
        exitCode: 1,
        restartScheduled: true
      })
    )

    await vi.advanceTimersByTimeAsync(2000)
    expect(mockFork).toHaveBeenCalledTimes(2)
  })

  it('READY 15s 超时：返回 not-ready 并通知 startup-timeout', async () => {
    const crashListener = vi.fn()
    bridge.onCrash(crashListener)

    const p = bridge.decodeNetwork('clothDiy', 'CODE')
    await vi.advanceTimersByTimeAsync(0)
    expect(mockFork).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(15000)
    const r = await p
    expect(r).toEqual({ ok: false, reason: 'not-ready' })
    expect(workers[0].kill).toHaveBeenCalled()
    expect(crashListener).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'startup-timeout' })
    )
  })

  it('DLL 路径解析失败：不 fork，直接返回 not-ready', async () => {
    mockFindDllPath.mockReset()
    mockFindDllPath.mockImplementation(() => {
      throw new Error('nuan5_decryption.dll not found')
    })
    const r = await bridge.decodeNetwork('clothDiy', 'CODE')
    expect(r).toEqual({ ok: false, reason: 'not-ready' })
    expect(mockFork).not.toHaveBeenCalled()
  })

  // ============ onCrash 订阅 ============

  it('onCrash 取消订阅后不再收到崩溃通知', async () => {
    const l1 = vi.fn()
    const l2 = vi.fn()
    const off1 = bridge.onCrash(l1)
    bridge.onCrash(l2)
    off1()

    const p = bridge.decodeNetwork('clothDiy', 'CODE')
    const worker = await readyWorker()
    worker.emit('exit', 1)
    await p

    expect(l1).not.toHaveBeenCalled()
    expect(l2).toHaveBeenCalledTimes(1)
  })

  // ============ dispose ============

  it('dispose：pending 按 disposed 降级、发送 DISPOSE、kill worker', async () => {
    const p = bridge.decodeNetwork('clothDiy', 'CODE')
    const worker = await readyWorker()

    const disposePromise = bridge.dispose()
    await vi.advanceTimersByTimeAsync(500)
    await disposePromise

    const r = await p
    expect(r).toEqual({ ok: false, reason: 'disposed' })
    expect(sentCommand(worker, 'DECRYPT_WORKER_DISPOSE')).toEqual({
      type: 'DECRYPT_WORKER_DISPOSE'
    })
    expect(worker.kill).toHaveBeenCalled()

    // dispose 后新请求立即降级
    const r2 = await bridge.decodeNetwork('clothDiy', 'CODE')
    expect(r2).toEqual({ ok: false, reason: 'disposed' })
  })
})
