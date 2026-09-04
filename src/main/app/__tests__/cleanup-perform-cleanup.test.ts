/**
 * @layer L3
 * @module src/main/app/cleanup (performCleanup only)
 * @coverage performCleanup 7 步资源清理 + 超时保护 + 动态 import + 同步 fault 日志
 * @dependencies electron (app)、fs (appendFileSync)、utils/process-registry、utils/startup-diagnostic、
 *               services/share-wifi-service、services/backup-service、services/decryption-service（动态 import）
 *
 * 难点：
 * 1. performCleanup 调用 collectExitDiagnosis 两次（before/after），需 mock getProcessRegistryStats + process._getActiveHandles
 * 2. 4 个 worker bridge dispose 含 1s 超时保护（Promise.race），需 fakeTimers 验证超时分支
 * 3. 动态 import decryption-service 用 vi.mock 提前注册
 * 4. fs.appendFileSync 同步写入验证（fault 日志）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeAppCtx } from '../../ipc/handlers/_test-helpers'

// 共享 mock
const {
  appGetPathMock,
  appReleaseSingleInstanceLockMock,
  fsAppendFileSyncMock,
  killAllProcessesMock,
  getProcessRegistryStatsMock,
  logStartupErrorMock,
  wifiShareStopMock,
  backupDisposeMock,
  disposeDecryptionServiceMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(() => '/mock/userData'),
  appReleaseSingleInstanceLockMock: vi.fn(),
  fsAppendFileSyncMock: vi.fn(),
  killAllProcessesMock: vi.fn(),
  getProcessRegistryStatsMock: vi.fn(() => ({ childProcessCount: 0, ffmpegCommandCount: 0 })),
  logStartupErrorMock: vi.fn(),
  wifiShareStopMock: vi.fn(),
  backupDisposeMock: vi.fn(),
  disposeDecryptionServiceMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: appGetPathMock,
    releaseSingleInstanceLock: appReleaseSingleInstanceLockMock
  }
}))

vi.mock('fs', () => ({
  default: {
    appendFileSync: fsAppendFileSyncMock
  },
  appendFileSync: fsAppendFileSyncMock
}))

vi.mock('../../utils/process-registry', () => ({
  killAllProcesses: killAllProcessesMock,
  getProcessRegistryStats: getProcessRegistryStatsMock
}))

vi.mock('../../utils/startup-diagnostic', () => ({
  logStartupError: logStartupErrorMock
}))

vi.mock('../../services/share-wifi-service', () => ({
  wifiShareService: { stop: wifiShareStopMock }
}))

vi.mock('../../services/backup-service', () => ({
  backupService: { dispose: backupDisposeMock }
}))

// 动态 import 的 decryption-service：vi.mock 提前注册，await import() 返回此 mock
vi.mock('../../services/decryption-service', () => ({
  disposeDecryptionService: disposeDecryptionServiceMock
}))

import { performCleanup } from '../cleanup'

// 构造可控的 worker bridge：dispose 返回可控制的 promise
function makeDisposableBridge(name: string) {
  return {
    onCrash: vi.fn(() => () => {}),
    dispose: vi.fn(() => Promise.resolve()),
    _name: name
  }
}

// 默认 scannerManager stub：stopScan 返回 resolved promise
function makeScannerManagerStub() {
  return {
    startScan: vi.fn(),
    stopScan: vi.fn(() => Promise.resolve({ success: true })),
    getStatus: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    setDbPath: vi.fn()
  }
}

let originalGetActiveHandles: (() => unknown[]) | undefined
let originalGetActiveRequests: (() => unknown[]) | undefined

beforeEach(() => {
  appGetPathMock.mockReset()
  appReleaseSingleInstanceLockMock.mockReset()
  fsAppendFileSyncMock.mockReset()
  killAllProcessesMock.mockReset()
  getProcessRegistryStatsMock.mockReset()
  logStartupErrorMock.mockReset()
  wifiShareStopMock.mockReset()
  backupDisposeMock.mockReset()
  disposeDecryptionServiceMock.mockReset()

  appGetPathMock.mockReturnValue('/mock/userData')
  getProcessRegistryStatsMock.mockReturnValue({ childProcessCount: 0, ffmpegCommandCount: 0 })

  const p = process as unknown as {
    _getActiveHandles?: () => unknown[]
    _getActiveRequests?: () => unknown[]
  }
  originalGetActiveHandles = p._getActiveHandles
  originalGetActiveRequests = p._getActiveRequests
  p._getActiveHandles = () => []
  p._getActiveRequests = () => []
})

afterEach(() => {
  const p = process as unknown as {
    _getActiveHandles?: () => unknown[]
    _getActiveRequests?: () => unknown[]
  }
  if (originalGetActiveHandles === undefined) {
    delete p._getActiveHandles
  } else {
    p._getActiveHandles = originalGetActiveHandles
  }
  if (originalGetActiveRequests === undefined) {
    delete p._getActiveRequests
  } else {
    p._getActiveRequests = originalGetActiveRequests
  }
})

describe('performCleanup', () => {
  it('1. 清理 startupTimers 中所有定时器（clearTimeout 调用 2 次，数组归 0）', async () => {
    const t1 = setTimeout(() => {}, 10000)
    const t2 = setTimeout(() => {}, 20000)
    const ctx = makeAppCtx({
      startupTimers: [t1, t2],
      scannerManager: makeScannerManagerStub()
    })
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')

    await performCleanup(ctx)

    expect(clearTimeoutSpy).toHaveBeenCalledWith(t1)
    expect(clearTimeoutSpy).toHaveBeenCalledWith(t2)
    expect(ctx.startupTimers).toHaveLength(0)
    clearTimeoutSpy.mockRestore()
  })

  it('2. mediaUpdateTimer 非 null 时清理（setMediaUpdateTimer(null) 被调用）', async () => {
    const timer = setTimeout(() => {}, 1000)
    const ctx = makeAppCtx({
      mediaUpdateTimer: timer,
      scannerManager: makeScannerManagerStub()
    })
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')

    await performCleanup(ctx)

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer)
    expect(ctx.setMediaUpdateTimer).toHaveBeenCalledWith(null)
    clearTimeoutSpy.mockRestore()
  })

  it('3. mediaUpdateTimer 为 null 时跳过清理（不抛错）', async () => {
    const ctx = makeAppCtx({
      mediaUpdateTimer: null,
      scannerManager: makeScannerManagerStub()
    })

    await expect(performCleanup(ctx)).resolves.toBeUndefined()
    expect(ctx.setMediaUpdateTimer).not.toHaveBeenCalled()
  })

  it('4. 调用 killAllProcesses("SIGKILL")', async () => {
    const ctx = makeAppCtx({ scannerManager: makeScannerManagerStub() })

    await performCleanup(ctx)

    expect(killAllProcessesMock).toHaveBeenCalledWith('SIGKILL')
  })

  it('5. 调用 taskScheduler.pause + cancelAllLow', async () => {
    const ctx = makeAppCtx({ scannerManager: makeScannerManagerStub() })

    await performCleanup(ctx)

    expect(ctx.taskScheduler.pause).toHaveBeenCalledTimes(1)
    expect(ctx.taskScheduler.cancelAllLow).toHaveBeenCalledTimes(1)
  })

  it('6. 调用 scannerManager.stopScan（含 catch）', async () => {
    const scannerManager = makeScannerManagerStub()
    const ctx = makeAppCtx({ scannerManager })

    await performCleanup(ctx)

    expect(scannerManager.stopScan).toHaveBeenCalledTimes(1)
  })

  it('7. scannerManager.stopScan reject 时不影响后续（scannerWorkerBridge.dispose 仍被调用）', async () => {
    const scannerManager = makeScannerManagerStub()
    scannerManager.stopScan.mockRejectedValueOnce(new Error('stop failed'))
    const scannerBridge = makeDisposableBridge('scanner')
    const ctx = makeAppCtx({
      scannerManager,
      scannerWorkerBridge: scannerBridge
    })

    await performCleanup(ctx)

    expect(scannerBridge.dispose).toHaveBeenCalledTimes(1)
  })

  it('8. 4 个 worker bridge dispose 均被调用', async () => {
    const scannerBridge = makeDisposableBridge('scanner')
    const databaseBridge = makeDisposableBridge('database')
    const mediaBridge = makeDisposableBridge('media')
    const thumbnailBridge = { dispose: vi.fn(() => Promise.resolve()) }
    const ctx = makeAppCtx({
      scannerManager: makeScannerManagerStub(),
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge,
      thumbnailWorkerBridge: thumbnailBridge
    })

    await performCleanup(ctx)

    expect(scannerBridge.dispose).toHaveBeenCalledTimes(1)
    expect(databaseBridge.dispose).toHaveBeenCalledTimes(1)
    expect(mediaBridge.dispose).toHaveBeenCalledTimes(1)
    expect(thumbnailBridge.dispose).toHaveBeenCalledTimes(1)
  })

  it('9. scannerWorkerBridge.dispose 超时（hang）时 1s 后继续（fakeTimers 验证）', async () => {
    vi.useFakeTimers()
    const scannerBridge = makeDisposableBridge('scanner')
    // dispose 永不 resolve，触发 1s 超时分支
    scannerBridge.dispose.mockImplementation(() => new Promise<void>(() => {}))
    const databaseBridge = makeDisposableBridge('database')
    const ctx = makeAppCtx({
      scannerManager: makeScannerManagerStub(),
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge
    })

    const cleanupPromise = performCleanup(ctx)
    // 推进 1s 触发 Promise.race 超时
    await vi.advanceTimersByTimeAsync(1000)
    await cleanupPromise

    expect(databaseBridge.dispose).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('10. wifiShareService.stop 被调用', async () => {
    const ctx = makeAppCtx({ scannerManager: makeScannerManagerStub() })

    await performCleanup(ctx)

    expect(wifiShareStopMock).toHaveBeenCalledTimes(1)
  })

  it('11. backupService.dispose 被调用', async () => {
    const ctx = makeAppCtx({ scannerManager: makeScannerManagerStub() })

    await performCleanup(ctx)

    expect(backupDisposeMock).toHaveBeenCalledTimes(1)
  })

  it('12. thumbnailGen.stopLruBackgroundTask + flushAccessTimes 被调用', async () => {
    const stopLruSpy = vi.fn()
    const flushAccessSpy = vi.fn(() => Promise.resolve())
    const ctx = makeAppCtx({
      scannerManager: makeScannerManagerStub(),
      thumbnailGenExt: {
        stopLruBackgroundTask: stopLruSpy,
        flushAccessTimes: flushAccessSpy
      }
    })

    await performCleanup(ctx)

    expect(stopLruSpy).toHaveBeenCalledTimes(1)
    expect(flushAccessSpy).toHaveBeenCalledTimes(1)
  })

  it('13. dbManager.close 抛错时记录 logStartupError，且不写干净退出标志', async () => {
    const ctx = makeAppCtx({ scannerManager: makeScannerManagerStub() })
    const closeErr = new Error('close failed')
    ctx.dbManager.close.mockImplementationOnce(() => {
      throw closeErr
    })

    await performCleanup(ctx)

    expect(logStartupErrorMock).toHaveBeenCalledWith('before-quit-db-close', closeErr)
    // 启动性能优化：close 失败（WAL checkpoint 未完成）→ 不标记干净退出，下次启动后台全量复核
    expect(ctx.dbManager.markCleanExit).not.toHaveBeenCalled()
  })

  it('13.5 dbManager.close 成功后写入干净退出标志（markCleanExit 被调用）', async () => {
    const ctx = makeAppCtx({ scannerManager: makeScannerManagerStub() })

    await performCleanup(ctx)

    expect(ctx.dbManager.close).toHaveBeenCalledTimes(1)
    // 启动性能优化：close 成功返回后（未进入 catch）才写标志
    expect(ctx.dbManager.markCleanExit).toHaveBeenCalledTimes(1)
  })

  it('14. app.releaseSingleInstanceLock 被调用', async () => {
    const ctx = makeAppCtx({ scannerManager: makeScannerManagerStub() })

    await performCleanup(ctx)

    expect(appReleaseSingleInstanceLockMock).toHaveBeenCalledTimes(1)
  })

  it('15. 动态 import disposeDecryptionService 被调用', async () => {
    const ctx = makeAppCtx({ scannerManager: makeScannerManagerStub() })

    await performCleanup(ctx)

    expect(disposeDecryptionServiceMock).toHaveBeenCalledTimes(1)
  })

  it('16. fault 日志同步写入 fs.appendFileSync（含 before:/after:）', async () => {
    const ctx = makeAppCtx({ scannerManager: makeScannerManagerStub() })

    await performCleanup(ctx)

    expect(fsAppendFileSyncMock).toHaveBeenCalledTimes(1)
    const writeArgs = fsAppendFileSyncMock.mock.calls[0]
    // 第二参数是日志内容字符串
    const content = writeArgs[1] as string
    expect(content).toContain('before:')
    expect(content).toContain('after:')
    expect(content).toContain('exitDiagnosis')
    // 第三参数是 utf-8 编码
    expect(writeArgs[2]).toBe('utf-8')
  })

  it('17. collectExitDiagnosis 在清理前后各调用 1 次（getProcessRegistryStats 被调用 2 次）', async () => {
    const ctx = makeAppCtx({ scannerManager: makeScannerManagerStub() })

    await performCleanup(ctx)

    expect(getProcessRegistryStatsMock).toHaveBeenCalledTimes(2)
  })

  it('18. 任一清理步骤抛错时不影响后续步骤（多个 mock 同时抛错，函数仍 resolve）', async () => {
    const scannerManager = makeScannerManagerStub()
    scannerManager.stopScan.mockRejectedValueOnce(new Error('scan stop failed'))
    const scannerBridge = makeDisposableBridge('scanner')
    scannerBridge.dispose.mockRejectedValueOnce(new Error('scanner dispose failed'))
    const ctx = makeAppCtx({
      scannerManager,
      scannerWorkerBridge: scannerBridge
    })
    // dbManager.close 也抛错
    ctx.dbManager.close.mockImplementationOnce(() => {
      throw new Error('close failed')
    })
    // taskScheduler.pause 抛错
    ctx.taskScheduler.pause.mockImplementationOnce(() => {
      throw new Error('pause failed')
    })

    // 不抛错，函数 resolve
    await expect(performCleanup(ctx)).resolves.toBeUndefined()
    // 后续步骤仍执行
    expect(killAllProcessesMock).toHaveBeenCalled()
    expect(wifiShareStopMock).toHaveBeenCalled()
    expect(appReleaseSingleInstanceLockMock).toHaveBeenCalled()
  })
})
