/**
 * @layer L2
 * @module src/main/scanner/index（ScannerManager）
 * @coverage startScan（dbPath 缺失/running 去重/等待 SCAN_COMPLETE/bridge 启动失败）、
 *           stopScan、scanRoot、getStatus、setDbPath、
 *           SCAN_PROGRESS / SCAN_COMPLETE 事件转发、
 *           setRestoreExecutor 崩溃恢复重放（复用 running 去重 + restoredComplete 事件）
 *
 * Mock 策略：
 * - ./scanner-worker-bridge → 假桥（捕获事件订阅与恢复执行器，测试侧注入 worker 事件）；
 *   ScannerManager 是薄壳，只消费 onEvent / setRestoreExecutor / startScan / stopScan 四个面
 * - ../utils/logger → vi.fn()（真实实现依赖 electron app 与 electron-log，测试环境不可用）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** worker 事件最小形状（仅本测试用到的字段） */
interface WorkerEventLike {
  type: 'SCAN_PROGRESS' | 'SCAN_COMPLETE'
  payload: Record<string, unknown>
}

/** 假桥对外暴露的可控面（ScannerManager 实际消费的接口子集 + 测试注入口） */
interface FakeBridgeHandle {
  handlers: Array<(event: WorkerEventLike) => void>
  restoreExecutor: ((options: Record<string, unknown>) => Promise<void>) | null
  startScan: ReturnType<typeof vi.fn>
  stopScan: ReturnType<typeof vi.fn>
  onEvent: (handler: (event: WorkerEventLike) => void) => () => void
  setRestoreExecutor: (exec: (options: Record<string, unknown>) => Promise<void>) => void
  /** 测试侧注入 worker 事件（模拟 worker → 主进程推送） */
  emitEvent: (event: WorkerEventLike) => void
}

const mockState = vi.hoisted(() => ({
  /** 最近构造的假桥实例（供用例取得控制权） */
  lastInstance: null as FakeBridgeHandle | null
}))

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fault: vi.fn() }
}))

vi.mock('./scanner-worker-bridge', () => {
  class FakeScannerWorkerBridge {
    handlers: Array<(event: WorkerEventLike) => void> = []
    restoreExecutor: ((options: Record<string, unknown>) => Promise<void>) | null = null
    startScan = vi.fn(async () => {})
    stopScan = vi.fn()

    onEvent(handler: (event: WorkerEventLike) => void): () => void {
      this.handlers.push(handler)
      return () => {
        this.handlers = this.handlers.filter((h) => h !== handler)
      }
    }

    setRestoreExecutor(exec: (options: Record<string, unknown>) => Promise<void>): void {
      this.restoreExecutor = exec
    }

    /** 测试辅助：向已订阅的 handler 广播事件 */
    emitEvent(event: WorkerEventLike): void {
      for (const h of [...this.handlers]) h(event)
    }

    constructor() {
      mockState.lastInstance = this as unknown as FakeBridgeHandle
    }
  }
  return { ScannerWorkerBridge: FakeScannerWorkerBridge }
})

import { ScannerManager } from './index'
import { ScannerWorkerBridge } from './scanner-worker-bridge'

/** 构造 Manager 并取回其持有的假桥句柄 */
function createManager(): { manager: ScannerManager; bridge: FakeBridgeHandle } {
  const manager = new ScannerManager(new ScannerWorkerBridge())
  const bridge = mockState.lastInstance
  if (!bridge) throw new Error('假桥实例未被构造')
  return { manager, bridge }
}

describe('ScannerManager（薄壳，经假桥注入事件）', () => {
  beforeEach(() => {
    mockState.lastInstance = null
    vi.clearAllMocks()
  })

  describe('getStatus / setDbPath', () => {
    it('初始状态为 idle 且计数归零', () => {
      const { manager } = createManager()
      expect(manager.getStatus()).toEqual({ scanned: 0, found: 0, currentPath: '', status: 'idle' })
    })

    it('getStatus 返回副本：外部篡改不影响内部状态', () => {
      const { manager } = createManager()
      const status = manager.getStatus()
      status.status = 'running'
      expect(manager.getStatus().status).toBe('idle')
    })
  })

  describe('startScan', () => {
    it('未设置 dbPath → 直接失败，不触达桥', async () => {
      const { manager, bridge } = createManager()
      await expect(manager.startScan()).resolves.toEqual({
        success: false,
        message: '数据库路径未初始化'
      })
      expect(bridge.startScan).not.toHaveBeenCalled()
    })

    it('发送 SCAN_START 后进入 running，收到 SCAN_COMPLETE 时 resolve 并落终态', async () => {
      const { manager, bridge } = createManager()
      manager.setDbPath('/db/app.db')

      const p = manager.startScan({ fullScan: true })
      expect(bridge.startScan).toHaveBeenCalledWith('/db/app.db', { fullScan: true })
      expect(manager.getStatus().status).toBe('running')

      bridge.emitEvent({
        type: 'SCAN_COMPLETE',
        payload: { success: true, message: '扫描完成', filesFound: 7 }
      })
      await expect(p).resolves.toEqual({ success: true, message: '扫描完成', filesFound: 7 })
      expect(manager.getStatus().status).toBe('completed')
    })

    it('SCAN_COMPLETE success=false → 状态落 failed', async () => {
      const { manager, bridge } = createManager()
      manager.setDbPath('/db/app.db')

      const p = manager.startScan()
      bridge.emitEvent({ type: 'SCAN_COMPLETE', payload: { success: false, message: 'boom' } })
      await expect(p).resolves.toEqual({ success: false, message: 'boom' })
      expect(manager.getStatus().status).toBe('failed')
    })

    it('未传 options 时桥收到空对象', async () => {
      const { manager, bridge } = createManager()
      manager.setDbPath('/db/app.db')

      const p = manager.startScan()
      expect(bridge.startScan).toHaveBeenCalledWith('/db/app.db', {})
      bridge.emitEvent({ type: 'SCAN_COMPLETE', payload: { success: true, message: 'ok' } })
      await p
    })

    it('running 去重：扫描进行中再次 startScan 直接拒绝，不重复下发指令', async () => {
      const { manager, bridge } = createManager()
      manager.setDbPath('/db/app.db')

      const first = manager.startScan()
      await expect(manager.startScan()).resolves.toEqual({
        success: false,
        message: '扫描正在进行中'
      })
      expect(bridge.startScan).toHaveBeenCalledTimes(1)

      bridge.emitEvent({ type: 'SCAN_COMPLETE', payload: { success: true, message: 'ok' } })
      await first
    })

    it('桥启动失败（reject）→ resolve 失败结果且释放 pendingComplete', async () => {
      const { manager, bridge } = createManager()
      manager.setDbPath('/db/app.db')
      bridge.startScan.mockRejectedValueOnce(new Error('fork 失败'))

      await expect(manager.startScan()).resolves.toEqual({
        success: false,
        message: '扫描启动失败: fork 失败'
      })
    })
  })

  describe('事件转发', () => {
    it('SCAN_PROGRESS → emit progress（载荷副本）并同步 getStatus', async () => {
      const { manager, bridge } = createManager()
      manager.setDbPath('/db/app.db')
      const progressSpy = vi.fn()
      manager.on('progress', progressSpy)

      const p = manager.startScan()
      bridge.emitEvent({
        type: 'SCAN_PROGRESS',
        payload: { scanned: 5, found: 9, currentPath: 'D:/game', status: 'running' }
      })

      expect(progressSpy).toHaveBeenCalledTimes(1)
      expect(progressSpy.mock.calls[0][0]).toEqual({
        scanned: 5,
        found: 9,
        currentPath: 'D:/game',
        status: 'running'
      })
      // 副本语义：监听者篡改不影响内部状态
      progressSpy.mock.calls[0][0].scanned = 999
      expect(manager.getStatus().scanned).toBe(5)

      bridge.emitEvent({ type: 'SCAN_COMPLETE', payload: { success: true, message: 'ok' } })
      await p
    })

    it('SCAN_COMPLETE → emit complete 透出原始载荷', async () => {
      const { manager, bridge } = createManager()
      manager.setDbPath('/db/app.db')
      const completeSpy = vi.fn()
      manager.on('complete', completeSpy)

      const p = manager.startScan()
      const payload = { success: true, message: '完成', filesFound: 3 }
      bridge.emitEvent({ type: 'SCAN_COMPLETE', payload })
      await p
      expect(completeSpy).toHaveBeenCalledWith(payload)
    })
  })

  describe('stopScan / scanRoot', () => {
    it('stopScan 转发停止指令并恒返回 success', () => {
      const { manager, bridge } = createManager()
      return expect(manager.stopScan())
        .resolves.toEqual({ success: true })
        .then(() => {
          expect(bridge.stopScan).toHaveBeenCalledTimes(1)
        })
    })

    it('scanRoot 复用 startScan：path + incremental 下发并等待完成', async () => {
      const { manager, bridge } = createManager()
      manager.setDbPath('/db/app.db')

      const p = manager.scanRoot('D:/import-root')
      expect(bridge.startScan).toHaveBeenCalledWith('/db/app.db', {
        path: 'D:/import-root',
        incremental: true
      })
      bridge.emitEvent({
        type: 'SCAN_COMPLETE',
        payload: { success: true, message: '增量完成', filesFound: 2 }
      })
      await expect(p).resolves.toEqual({ success: true, message: '增量完成', filesFound: 2 })
    })
  })

  describe('崩溃恢复重放（setRestoreExecutor）', () => {
    it('构造时向桥注入恢复执行器', () => {
      const { bridge } = createManager()
      expect(typeof bridge.restoreExecutor).toBe('function')
    })

    it('恢复时已有扫描在跑 → 跳过重放（不重复下发，不透出完成事件）', async () => {
      const { manager, bridge } = createManager()
      manager.setDbPath('/db/app.db')
      const restoredSpy = vi.fn()
      manager.on('restoredComplete', restoredSpy)

      const manual = manager.startScan()
      const executor = bridge.restoreExecutor
      if (!executor) throw new Error('恢复执行器未注入')
      await executor({ fullScan: true })

      // 仅用户手动扫描那一次下发
      expect(bridge.startScan).toHaveBeenCalledTimes(1)
      expect(restoredSpy).not.toHaveBeenCalled()

      bridge.emitEvent({ type: 'SCAN_COMPLETE', payload: { success: true, message: 'ok' } })
      await manual
    })

    it('空闲时恢复 → 走 startScan 完整链路并以 restoredComplete 透出结果与原参数', async () => {
      const { manager, bridge } = createManager()
      manager.setDbPath('/db/app.db')
      const restoredSpy = vi.fn()
      manager.on('restoredComplete', restoredSpy)

      const options: Record<string, unknown> = { fullScan: true }
      const executor = bridge.restoreExecutor
      if (!executor) throw new Error('恢复执行器未注入')
      const p = executor(options)
      expect(bridge.startScan).toHaveBeenCalledWith('/db/app.db', options)

      const result = { success: true, message: '恢复完成', filesFound: 4 }
      bridge.emitEvent({ type: 'SCAN_COMPLETE', payload: result })
      await p

      expect(restoredSpy).toHaveBeenCalledWith(result, options)
      expect(manager.getStatus().status).toBe('completed')
    })
  })
})
