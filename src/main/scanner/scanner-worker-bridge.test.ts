/**
 * ScannerWorkerBridge 单元测试
 *
 * 测试目标：src/main/scanner/scanner-worker-bridge.ts
 * 测试层级：L2（依赖 mock，无真实 worker 进程）
 *
 * Mock 策略：
 * - electron.utilityProcess.fork → 返回 EventEmitter 模拟 worker
 * - ../utils/logger → vi.fn() 捕获调用
 *
 * 测试覆盖：
 * - startScan：惰性启动、复用 worker、发送 SCAN_START
 * - stopScan：发送 SCAN_STOP、worker 为 null 时静默返回
 * - onEvent：订阅 / 取消订阅
 * - handleWorkerMessage：WORKER_READY / SCAN_LOG / SCAN_PROGRESS / SCAN_COMPLETE / WORKER_ERROR
 * - handleWorkerExit：正常退出、异常退出、扫描中退出合成 fakeComplete
 * - dispose：发送 DISPOSE、等待 500ms、kill、异常容错
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { UtilityProcess } from 'electron'

// ---- Mock electron ----
const mockFork = vi.fn()
vi.mock('electron', () => ({
  utilityProcess: {
    fork: (...args: unknown[]) => mockFork(...args)
  },
  // ProgressThrottle 内部调用 BrowserWindow.getAllWindows 推送进度
  BrowserWindow: { getAllWindows: () => [] }
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

import { ScannerWorkerBridge } from './scanner-worker-bridge'

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
  emitter.postMessage = vi.fn()
  emitter.kill = vi.fn()
  return emitter
}

describe('ScannerWorkerBridge', () => {
  let bridge: ScannerWorkerBridge
  let mockWorker: ReturnType<typeof createMockWorker>

  beforeEach(() => {
    vi.clearAllMocks()
    mockFork.mockReset()
    mockWorker = createMockWorker()
    mockFork.mockReturnValue(mockWorker)
    bridge = new ScannerWorkerBridge()
  })

  afterEach(async () => {
    // R14：清理可能运行的心跳定时器，避免跨用例泄漏
    vi.useFakeTimers()
    const disposePromise = bridge.dispose().catch(() => {})
    vi.advanceTimersByTime(500)
    await disposePromise
    vi.useRealTimers()
  })

  // ============ startScan ============
  describe('startScan', () => {
    it('首次调用应通过 utilityProcess.fork 惰性启动 worker', async () => {
      // 触发 fork 但先不让 ready 完成
      const startPromise = bridge.startScan('/db/path', { incremental: true })
      // fork 已被调用
      expect(mockFork).toHaveBeenCalledTimes(1)
      // 释放 await
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await startPromise
    })

    it('fork 时应使用 serviceName=scanner-worker 与 stdio=pipe', async () => {
      const startPromise = bridge.startScan('/db/path', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await startPromise

      expect(mockFork).toHaveBeenCalledWith(expect.stringContaining('scanner-worker.js'), [], {
        serviceName: 'scanner-worker',
        stdio: 'pipe'
      })
    })

    it('已有 worker 时应复用，不重复 fork', async () => {
      const p1 = bridge.startScan('/db/path', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p1
      // 结束首次扫描（组2-2 后扫描中重复 startScan 会被拒绝）
      mockWorker.emit('message', {
        type: 'SCAN_COMPLETE',
        payload: { success: true, message: 'done' }
      })

      // 第二次调用不应再次 fork
      const p2 = bridge.startScan('/db/path', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p2
      expect(mockFork).toHaveBeenCalledTimes(1)
    })

    it('FIX(组2-2): 扫描进行中重复 startScan 应抛错且不覆盖任务状态', async () => {
      const p = bridge.startScan('/db/path', { incremental: true })
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      await expect(bridge.startScan('/db/path', {})).rejects.toThrow('扫描正在进行中')
      // 不应向 worker 发送第二个 SCAN_START
      const scanStarts = mockWorker.postMessage.mock.calls.filter(
        (c) => (c[0] as { type?: string }).type === 'SCAN_START'
      )
      expect(scanStarts).toHaveLength(1)
    })

    it('FIX(组2-1): 正常 SCAN_COMPLETE 后崩溃重启不再重放旧扫描参数', async () => {
      vi.useFakeTimers()
      const restoreSpy = vi.fn()
      bridge.setRestoreExecutor(restoreSpy)

      const p = bridge.startScan('/db/path', { incremental: true })
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p
      // 扫描正常完成后（真实 SCAN_COMPLETE）恢复参数应被清空
      mockWorker.emit('message', {
        type: 'SCAN_COMPLETE',
        payload: { success: true, message: 'done' }
      })
      // 非扫描期 worker 崩溃 → 自动重启，但不应重放扫描
      mockWorker.emit('exit', 1)
      vi.advanceTimersByTime(2_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockFork).toHaveBeenCalledTimes(2) // worker 会重启
      expect(restoreSpy).not.toHaveBeenCalled() // 但不会按旧参数恢复扫描
    })

    it('FIX(组2-3): 扫描中崩溃重启后应经 restoreExecutor 恢复扫描', async () => {
      vi.useFakeTimers()
      const restoreSpy = vi.fn().mockResolvedValue(undefined)
      bridge.setRestoreExecutor(restoreSpy)

      const p = bridge.startScan('/db/path', { incremental: true })
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      // 扫描中崩溃 → 合成失败 SCAN_COMPLETE + 调度重启
      mockWorker.emit('exit', 1)
      // 重启延迟 2s：新 worker fork 后经注入的 executor 恢复（而非 bridge 直连 startScan）
      mockFork.mockImplementation(() => {
        // scheduleRestart 回调先 ensureWorker（fork）再恢复扫描，为新一轮握手准备 worker
        const w = createMockWorker()
        queueMicrotask(() => w.emit('message', { type: 'WORKER_READY' }))
        return w
      })
      vi.advanceTimersByTime(2_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(restoreSpy).toHaveBeenCalledTimes(1)
      expect(restoreSpy).toHaveBeenCalledWith({ incremental: true })
    })

    it('应发送 SCAN_START 命令并携带 dbPath 与 options', async () => {
      const p = bridge.startScan('/db/path', { incremental: true, fullScan: false })
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      expect(mockWorker.postMessage).toHaveBeenCalledWith({
        type: 'SCAN_START',
        payload: { dbPath: '/db/path', options: { incremental: true, fullScan: false } }
      })
    })

    it('WORKER_READY 后应清空 readyResolve', async () => {
      const p = bridge.startScan('/db/path', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p
      // 重复 WORKER_READY 不应报错（readyResolve 已 null）
      expect(() => mockWorker.emit('message', { type: 'WORKER_READY' })).not.toThrow()
    })
  })

  // ============ stopScan ============
  describe('stopScan', () => {
    it('应向 worker 发送 SCAN_STOP 命令', async () => {
      const p = bridge.startScan('/db/path', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      bridge.stopScan()
      expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'SCAN_STOP' })
    })

    it('worker 为 null 时应静默返回不抛错', () => {
      expect(() => bridge.stopScan()).not.toThrow()
      expect(mockWorker.postMessage).not.toHaveBeenCalled()
    })
  })

  // ============ onEvent ============
  describe('onEvent', () => {
    it('注册的 handler 应收到 SCAN_PROGRESS 事件', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)

      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      const progressEvent = {
        type: 'SCAN_PROGRESS' as const,
        payload: { scanned: 10, found: 5, status: 'running' as const }
      }
      mockWorker.emit('message', progressEvent)
      // 源码会对 SCAN_PROGRESS 做增强：补充 total/etaMs/perSec/taskId 字段（向后兼容）
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SCAN_PROGRESS',
          payload: expect.objectContaining({
            scanned: 10,
            found: 5,
            status: 'running'
          })
        })
      )
    })

    it('注册的 handler 应收到 SCAN_COMPLETE 事件', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)

      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      const completeEvent = {
        type: 'SCAN_COMPLETE' as const,
        payload: { success: true, message: 'done', filesFound: 5 }
      }
      mockWorker.emit('message', completeEvent)
      expect(handler).toHaveBeenCalledWith(completeEvent)
    })

    it('SCAN_COMPLETE 后应重置 isScanning 状态（不再合成 fakeComplete）', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)

      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      // 正常 COMPLETE
      mockWorker.emit('message', {
        type: 'SCAN_COMPLETE',
        payload: { success: true, message: 'done' }
      })
      expect(handler).toHaveBeenCalledTimes(1)

      // 此后 worker 异常退出不应再合成 fakeComplete
      mockWorker.emit('exit', 1)
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('取消订阅后 handler 不应再收到事件', async () => {
      const handler = vi.fn()
      const unsubscribe = bridge.onEvent(handler)

      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      unsubscribe()
      mockWorker.emit('message', {
        type: 'SCAN_PROGRESS',
        payload: { scanned: 1, found: 0, status: 'running' }
      })
      expect(handler).not.toHaveBeenCalled()
    })

    it('多个 handler 应都被通知', async () => {
      const h1 = vi.fn()
      const h2 = vi.fn()
      bridge.onEvent(h1)
      bridge.onEvent(h2)

      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      mockWorker.emit('message', {
        type: 'SCAN_PROGRESS',
        payload: { scanned: 1, found: 0, status: 'running' }
      })
      expect(h1).toHaveBeenCalledTimes(1)
      expect(h2).toHaveBeenCalledTimes(1)
    })
  })

  // ============ SCAN_LOG 消息分发 ============
  describe('SCAN_LOG 消息分发', () => {
    it('error 级别应调用 logger.error', async () => {
      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      mockWorker.emit('message', {
        type: 'SCAN_LOG',
        payload: { level: 'error', message: 'something broke', args: ['ctx'] }
      })
      expect(mockLoggerError).toHaveBeenCalledWith('[ScannerWorker] something broke', 'ctx')
    })

    it('warn 级别应调用 logger.warn', async () => {
      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      mockWorker.emit('message', {
        type: 'SCAN_LOG',
        payload: { level: 'warn', message: 'be careful' }
      })
      expect(mockLoggerWarn).toHaveBeenCalledWith('[ScannerWorker] be careful')
    })

    it('warn 级别无 args 时不传额外参数', async () => {
      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      mockWorker.emit('message', {
        type: 'SCAN_LOG',
        payload: { level: 'warn', message: 'no args' }
      })
      expect(mockLoggerWarn).toHaveBeenCalledWith('[ScannerWorker] no args')
    })

    it('info 级别应被忽略（不调用 logger.error/warn）', async () => {
      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      mockWorker.emit('message', {
        type: 'SCAN_LOG',
        payload: { level: 'info', message: 'just info' }
      })
      expect(mockLoggerError).not.toHaveBeenCalled()
      expect(mockLoggerWarn).not.toHaveBeenCalled()
    })

    it('args 为 undefined 时应按空数组处理', async () => {
      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      mockWorker.emit('message', {
        type: 'SCAN_LOG',
        payload: { level: 'error', message: 'err' }
      })
      expect(mockLoggerError).toHaveBeenCalledWith('[ScannerWorker] err')
    })
  })

  // ============ WORKER_ERROR 消息 ============
  describe('WORKER_ERROR 消息', () => {
    it('应调用 logger.error 并附带 stack', async () => {
      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      mockWorker.emit('message', {
        type: 'WORKER_ERROR',
        payload: { message: 'crashed', stack: 'Error: crashed\n  at ...' }
      })
      expect(mockLoggerError).toHaveBeenCalledWith(
        '[ScannerWorker] 异常: crashed',
        'Error: crashed\n  at ...'
      )
    })

    it('stack 缺失时应传空字符串', async () => {
      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      mockWorker.emit('message', {
        type: 'WORKER_ERROR',
        payload: { message: 'no stack' }
      })
      expect(mockLoggerError).toHaveBeenCalledWith('[ScannerWorker] 异常: no stack', '')
    })
  })

  // ============ handleWorkerExit ============
  describe('handleWorkerExit', () => {
    it('正常退出 code=0 不应记录错误日志', async () => {
      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      // 先完成扫描，避免合成 fakeComplete
      mockWorker.emit('message', {
        type: 'SCAN_COMPLETE',
        payload: { success: true, message: 'done' }
      })

      mockWorker.emit('exit', 0)
      expect(mockLoggerError).not.toHaveBeenCalled()
    })

    it('异常退出 code!=0 应记录错误日志', async () => {
      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      mockWorker.emit('message', {
        type: 'SCAN_COMPLETE',
        payload: { success: true, message: 'done' }
      })

      mockWorker.emit('exit', 1)
      expect(mockLoggerError).toHaveBeenCalledWith('[ScannerWorker] 异常退出，exit code=1')
    })

    it('扫描中异常退出应合成失败的 SCAN_COMPLETE 事件', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)

      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p
      // 此时 isScanning=true，未发送 SCAN_COMPLETE

      mockWorker.emit('exit', 1)
      expect(handler).toHaveBeenCalledWith({
        type: 'SCAN_COMPLETE',
        payload: { success: false, message: '扫描进程异常退出' }
      })
    })

    it('扫描中异常退出后 isScanning 应重置（再次退出不重复合成）', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)

      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      mockWorker.emit('exit', 1)
      expect(handler).toHaveBeenCalledTimes(1)

      // 再次 exit 不应重复合成
      mockWorker.emit('exit', 1)
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('未启动扫描时 worker 退出不应合成 fakeComplete', async () => {
      const handler = vi.fn()
      bridge.onEvent(handler)

      // 直接构造一个 worker 但不调用 startScan
      // 通过反射调用 ensureWorker 不现实，改用：startScan 后立即 COMPLETE，再 exit
      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      // 正常 COMPLETE 会让 handler 被调用一次
      mockWorker.emit('message', {
        type: 'SCAN_COMPLETE',
        payload: { success: true, message: 'done' }
      })
      expect(handler).toHaveBeenCalledTimes(1)
      // isScanning 已重置为 false，exit 不应再合成 fakeComplete
      mockWorker.emit('exit', 1)
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('退出后 worker 应被置 null（stopScan 不再 postMessage）', async () => {
      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      mockWorker.postMessage.mockClear()
      mockWorker.emit('exit', 0)
      bridge.stopScan()
      expect(mockWorker.postMessage).not.toHaveBeenCalled()
    })
  })

  // ============ dispose ============
  describe('dispose', () => {
    it('worker 为 null 时应直接返回', async () => {
      await bridge.dispose()
      expect(mockFork).not.toHaveBeenCalled()
    })

    it('应发送 SCAN_DISPOSE 命令', async () => {
      vi.useFakeTimers()
      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      const disposePromise = bridge.dispose()
      expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'SCAN_DISPOSE' })
      vi.advanceTimersByTime(500)
      await disposePromise
    })

    it('应在发送 DISPOSE 后等待 500ms 再 kill', async () => {
      vi.useFakeTimers()
      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      const disposePromise = bridge.dispose()
      // 此时还未 kill
      expect(mockWorker.kill).not.toHaveBeenCalled()
      vi.advanceTimersByTime(499)
      expect(mockWorker.kill).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      await disposePromise
      expect(mockWorker.kill).toHaveBeenCalledTimes(1)
    })

    it('完成后 worker 应置 null', async () => {
      vi.useFakeTimers()
      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      const disposePromise = bridge.dispose()
      vi.advanceTimersByTime(500)
      await disposePromise

      // 验证 worker 已置 null：stopScan 不应调用 postMessage
      mockWorker.postMessage.mockClear()
      bridge.stopScan()
      expect(mockWorker.postMessage).not.toHaveBeenCalled()
    })

    it('完成后 isScanning 应重置（exit 不再合成 fakeComplete）', async () => {
      vi.useFakeTimers()
      const handler = vi.fn()
      bridge.onEvent(handler)

      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      const disposePromise = bridge.dispose()
      vi.advanceTimersByTime(500)
      await disposePromise

      mockWorker.emit('exit', 1)
      expect(handler).not.toHaveBeenCalled()
    })

    it('postMessage 失败时应继续 kill 兜底', async () => {
      vi.useFakeTimers()
      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

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
      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      mockWorker.kill.mockImplementation(() => {
        throw new Error('kill failed')
      })

      const disposePromise = bridge.dispose()
      vi.advanceTimersByTime(500)
      await expect(disposePromise).resolves.toBeUndefined()
    })

    it('完成后 readyResolve 应清空', async () => {
      vi.useFakeTimers()
      const p = bridge.startScan('/db', {})
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p

      const disposePromise = bridge.dispose()
      vi.advanceTimersByTime(500)
      await disposePromise

      // 再次 dispose 不应报错
      await bridge.dispose()
    })
  })

  // ============ WORKER_READY 握手失败路径（回归：崩溃时永久挂死）============
  // 任何提前终止路径都必须 settle readyPromise，只置 null 会让 startScan 永久挂起
  describe('WORKER_READY 握手失败路径', () => {
    it('worker 在就绪前退出时应 reject 而非永久挂起', async () => {
      const p = bridge.startScan('/db', {})
      // 未发送 WORKER_READY，直接崩溃退出
      mockWorker.emit('exit', 1)
      await expect(p).rejects.toThrow('worker exited before ready')
    })

    it('15s 内未收到 WORKER_READY 应 reject 并 kill worker', async () => {
      vi.useFakeTimers()
      const p = bridge.startScan('/db', {})
      const assertion = expect(p).rejects.toThrow('后台进程启动失败')
      vi.advanceTimersByTime(15_000)
      await assertion
      expect(mockWorker.kill).toHaveBeenCalledTimes(1)
    })

    it('握手超时应上报 startup-timeout 崩溃事件供 UI 提示', async () => {
      vi.useFakeTimers()
      const onCrash = vi.fn()
      bridge.onCrash(onCrash)

      const p = bridge.startScan('/db', {})
      const assertion = expect(p).rejects.toThrow('后台进程启动失败')
      vi.advanceTimersByTime(15_000)
      await assertion

      expect(onCrash).toHaveBeenCalledTimes(1)
      expect(onCrash.mock.calls[0][0]).toMatchObject({
        workerName: 'scanner-worker',
        stage: 'startup-timeout',
        restartScheduled: false
      })
    })

    it('超时后再次调用应可重新 fork（worker 已置空）', async () => {
      vi.useFakeTimers()
      const p = bridge.startScan('/db', {})
      const assertion = expect(p).rejects.toThrow('后台进程启动失败')
      vi.advanceTimersByTime(15_000)
      await assertion

      mockFork.mockClear()
      const p2 = bridge.startScan('/db', {})
      expect(mockFork).toHaveBeenCalledTimes(1)
      mockWorker.emit('message', { type: 'WORKER_READY' })
      await p2
    })

    it('FIX(组2-4): 超时 kill 触发的 exit 事件不再二次崩溃通知、不触发自动重启', async () => {
      vi.useFakeTimers()
      const onCrash = vi.fn()
      bridge.onCrash(onCrash)

      const p = bridge.startScan('/db', {})
      const assertion = expect(p).rejects.toThrow('后台进程启动失败')
      vi.advanceTimersByTime(15_000)
      // 超时回调 kill worker → kill 触发 exit 事件（非零退出码）
      mockWorker.emit('exit', 1)
      // 越过自动重启延迟窗口，确认无计划外重启
      vi.advanceTimersByTime(5_000)
      await assertion

      // 仅超时路径的一次崩溃通知（restartScheduled:false），exit 不再叠加第二次
      expect(onCrash).toHaveBeenCalledTimes(1)
      expect(onCrash.mock.calls[0][0]).toMatchObject({
        stage: 'startup-timeout',
        restartScheduled: false
      })
      // 不触发自动重启（fork 仍只有最初的 1 次）
      expect(mockFork).toHaveBeenCalledTimes(1)
    })

    it('dispose 时握手仍在等待应 reject，不留悬挂 Promise', async () => {
      vi.useFakeTimers()
      const p = bridge.startScan('/db', {})
      const assertion = expect(p).rejects.toThrow('scanner-worker 已释放')

      const disposePromise = bridge.dispose()
      vi.advanceTimersByTime(500)
      await disposePromise
      await assertion
    })
  })
})
