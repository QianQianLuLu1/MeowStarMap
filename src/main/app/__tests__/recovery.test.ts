/**
 * @layer L2
 * @module src/main/app/recovery
 * @coverage registerRecoveryListeners / checkPendingDatabaseRecovery / flushPendingRecoveryEvents
 * @dependencies electron (dialog)、utils/logger、3 个 worker bridge.onCrash、dbManager.addRecoveryListener/getLastRecovery
 *
 * 难点：
 * 1. worker onCrash 注册的监听器需通过 mock.calls 间接捕获并触发
 * 2. flushPendingRecoveryEvents 内部 void showDialogs() 是 fire-and-forget，
 *    测试需 await microtask + setTimeout(0) 让 promise 链跑完
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WorkerCrashInfo } from '../../utils/worker-restart-policy'
import { makeAppCtx } from '../../ipc/handlers/_test-helpers'

// 共享 mock
const { showMessageBoxMock, loggerErrorMock, cleanupInterruptedScanHistoryMock } = vi.hoisted(
  () => ({
    showMessageBoxMock: vi.fn(),
    loggerErrorMock: vi.fn(),
    cleanupInterruptedScanHistoryMock: vi.fn()
  })
)

vi.mock('electron', () => ({
  dialog: {
    showMessageBox: showMessageBoxMock
  }
}))

vi.mock('../../utils/logger', () => ({
  logger: { error: loggerErrorMock, warn: vi.fn(), info: vi.fn() }
}))

// R18：mock cleanupInterruptedScanHistory，避免真实 DB 操作
vi.mock('../startup-tasks', () => ({
  cleanupInterruptedScanHistory: cleanupInterruptedScanHistoryMock
}))

import {
  registerRecoveryListeners,
  checkPendingDatabaseRecovery,
  flushPendingRecoveryEvents
} from '../recovery'

// 构造可控的 worker bridge：onCrash 捕获监听器，dispose 返回 resolved promise
function makeCapturableBridge() {
  const onCrash = vi.fn((cb: (info: WorkerCrashInfo) => void) => () => {})
  return {
    onCrash,
    dispose: vi.fn(() => Promise.resolve())
  }
}

// 默认 WorkerCrashInfo
function makeCrashInfo(overrides: Partial<WorkerCrashInfo> = {}): WorkerCrashInfo {
  return {
    workerName: 'scanner',
    exitCode: 1,
    restartAttempted: false,
    restartScheduled: false,
    restartCount: 0,
    restartExhausted: false,
    crashedAt: '2026-07-27T10:00:00Z',
    ...overrides
  }
}

// 默认 DB recovery info
function makeDbRecoveryInfo(overrides: Record<string, unknown> = {}): {
  success: boolean
  reason: string
  sourceBackup: { filename: string } | null
  corruptedBackupPath: string | null
} {
  return {
    success: true,
    reason: '数据库文件损坏，已从备份恢复',
    sourceBackup: { filename: 'wxnn_photo_manager_20260727.db.bak' },
    corruptedBackupPath: 'C:/userData/corrupted_20260727.db',
    ...overrides
  } as ReturnType<typeof makeDbRecoveryInfo>
}

// 等待 fire-and-forget 的 showDialogs 异步链跑完
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

let scannerBridge: ReturnType<typeof makeCapturableBridge>
let databaseBridge: ReturnType<typeof makeCapturableBridge>
let mediaBridge: ReturnType<typeof makeCapturableBridge>
let decryptionBridge: ReturnType<typeof makeCapturableBridge>
let dbRecoveryListener: ((info: ReturnType<typeof makeDbRecoveryInfo>) => void) | null = null

beforeEach(() => {
  showMessageBoxMock.mockReset()
  loggerErrorMock.mockReset()
  cleanupInterruptedScanHistoryMock.mockReset()
  showMessageBoxMock.mockResolvedValue({ response: 0 })

  scannerBridge = makeCapturableBridge()
  databaseBridge = makeCapturableBridge()
  mediaBridge = makeCapturableBridge()
  decryptionBridge = makeCapturableBridge()
  dbRecoveryListener = null
})

describe('registerRecoveryListeners', () => {
  it('1. 注册 1 个 DB 恢复监听器 + 4 个 worker 崩溃监听器', () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge,
      decryptionWorkerBridge: decryptionBridge
    })
    // 用 spy 包装 addRecoveryListener 以捕获监听器
    const addRecoverySpy = vi.spyOn(ctx.dbManager, 'addRecoveryListener')
    addRecoverySpy.mockImplementation((cb) => {
      dbRecoveryListener = cb
    })

    registerRecoveryListeners(ctx)

    expect(addRecoverySpy).toHaveBeenCalledTimes(1)
    expect(scannerBridge.onCrash).toHaveBeenCalledTimes(1)
    expect(databaseBridge.onCrash).toHaveBeenCalledTimes(1)
    expect(mediaBridge.onCrash).toHaveBeenCalledTimes(1)
    // FIX(组17-1)：解密网络解码进程也有崩溃监听
    expect(decryptionBridge.onCrash).toHaveBeenCalledTimes(1)
  })

  it('2. DB 恢复成功事件 push 到 pendingRecoveryEvents，title 为"数据库已自动恢复"', () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    vi.spyOn(ctx.dbManager, 'addRecoveryListener').mockImplementation((cb) => {
      dbRecoveryListener = cb
    })
    registerRecoveryListeners(ctx)

    dbRecoveryListener!(makeDbRecoveryInfo({ success: true }))

    expect(ctx.pendingRecoveryEvents).toHaveLength(1)
    expect(ctx.pendingRecoveryEvents[0]).toMatchObject({
      kind: 'database',
      title: '数据库已自动恢复'
    })
  })

  it('3. DB 恢复失败事件 title 为"数据库恢复失败"', () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    vi.spyOn(ctx.dbManager, 'addRecoveryListener').mockImplementation((cb) => {
      dbRecoveryListener = cb
    })
    registerRecoveryListeners(ctx)

    dbRecoveryListener!(makeDbRecoveryInfo({ success: false, reason: '备份文件不存在' }))

    expect(ctx.pendingRecoveryEvents[0]).toMatchObject({
      kind: 'database',
      title: '数据库恢复失败'
    })
  })

  it('4. DB 恢复事件 body 含 reason + sourceBackup.filename + corruptedBackupPath', () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    vi.spyOn(ctx.dbManager, 'addRecoveryListener').mockImplementation((cb) => {
      dbRecoveryListener = cb
    })
    registerRecoveryListeners(ctx)

    dbRecoveryListener!(
      makeDbRecoveryInfo({
        reason: '完整性校验失败',
        sourceBackup: { filename: 'backup_001.db' },
        corruptedBackupPath: 'C:/corrupted.db'
      })
    )

    const body = ctx.pendingRecoveryEvents[0].body
    expect(body).toContain('完整性校验失败')
    expect(body).toContain('backup_001.db')
    expect(body).toContain('C:/corrupted.db')
  })

  it('5. worker restartScheduled=true 时 title 含"已自动重启"', () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    registerRecoveryListeners(ctx)
    const listener = scannerBridge.onCrash.mock.calls[0][0] as (info: WorkerCrashInfo) => void

    listener(makeCrashInfo({ restartScheduled: true, restartCount: 1 }))

    expect(ctx.pendingRecoveryEvents[0]).toMatchObject({
      kind: 'worker',
      title: '扫描进程 已自动重启'
    })
  })

  it('6. worker restartExhausted=true 时 title 含"重启次数耗尽"', () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    registerRecoveryListeners(ctx)
    const listener = databaseBridge.onCrash.mock.calls[0][0] as (info: WorkerCrashInfo) => void

    listener(makeCrashInfo({ restartExhausted: true, restartCount: 3 }))

    expect(ctx.pendingRecoveryEvents[0].title).toBe('数据库写进程 重启次数耗尽')
  })

  it('7. worker 既未 scheduled 也未 exhausted 时 title 为"异常退出"', () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    registerRecoveryListeners(ctx)
    const listener = mediaBridge.onCrash.mock.calls[0][0] as (info: WorkerCrashInfo) => void

    listener(makeCrashInfo({ restartScheduled: false, restartExhausted: false }))

    expect(ctx.pendingRecoveryEvents[0].title).toBe('媒体处理进程 异常退出')
  })

  it('8. worker body 含 exitCode / crashedAt / restartCount', () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    registerRecoveryListeners(ctx)
    const listener = scannerBridge.onCrash.mock.calls[0][0] as (info: WorkerCrashInfo) => void

    listener(
      makeCrashInfo({
        exitCode: 137,
        crashedAt: '2026-07-27T12:34:56Z',
        restartCount: 2,
        restartExhausted: false
      })
    )

    const body = ctx.pendingRecoveryEvents[0].body
    expect(body).toContain('退出码：137')
    expect(body).toContain('崩溃时间：2026-07-27T12:34:56Z')
    expect(body).toContain('重启次数：2')
  })
})

// ==========================================================================
// R18：worker 崩溃后主动修复脏状态
// ==========================================================================
describe('R18 worker 崩溃主动修复', () => {
  it('R18-1. 扫描进程崩溃时调用 cleanupInterruptedScanHistory', () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    registerRecoveryListeners(ctx)
    const listener = scannerBridge.onCrash.mock.calls[0][0] as (info: WorkerCrashInfo) => void

    listener(makeCrashInfo({ restartScheduled: true }))

    expect(cleanupInterruptedScanHistoryMock).toHaveBeenCalledTimes(1)
    expect(cleanupInterruptedScanHistoryMock).toHaveBeenCalledWith(ctx)
  })

  it('R18-2. 数据库写进程崩溃时调用 ctx.notifyMediaUpdated', () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    registerRecoveryListeners(ctx)
    const listener = databaseBridge.onCrash.mock.calls[0][0] as (info: WorkerCrashInfo) => void

    listener(makeCrashInfo({ restartScheduled: true }))

    expect(ctx.notifyMediaUpdated).toHaveBeenCalledTimes(1)
  })

  it('R18-3. 媒体处理进程崩溃时不触发任何修复', () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    registerRecoveryListeners(ctx)
    const listener = mediaBridge.onCrash.mock.calls[0][0] as (info: WorkerCrashInfo) => void

    listener(makeCrashInfo({ restartScheduled: true }))

    expect(cleanupInterruptedScanHistoryMock).not.toHaveBeenCalled()
    expect(ctx.notifyMediaUpdated).not.toHaveBeenCalled()
  })

  it('FIX(组17-1). 解密网络解码进程崩溃时 push 事件但不触发修复（一次性请求语义）', () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge,
      decryptionWorkerBridge: decryptionBridge
    })
    registerRecoveryListeners(ctx)
    const listener = decryptionBridge.onCrash.mock.calls[0][0] as (info: WorkerCrashInfo) => void

    listener(makeCrashInfo({ restartScheduled: false }))

    expect(ctx.pendingRecoveryEvents).toHaveLength(1)
    expect(ctx.pendingRecoveryEvents[0]).toMatchObject({
      kind: 'worker',
      title: '解密网络解码进程 异常退出'
    })
    expect(cleanupInterruptedScanHistoryMock).not.toHaveBeenCalled()
    expect(ctx.notifyMediaUpdated).not.toHaveBeenCalled()
  })

  it('R18-4. 修复动作抛错时不影响事件 push 且记录 logger.error', () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    registerRecoveryListeners(ctx)
    const listener = scannerBridge.onCrash.mock.calls[0][0] as (info: WorkerCrashInfo) => void

    cleanupInterruptedScanHistoryMock.mockImplementation(() => {
      throw new Error('修复失败')
    })

    listener(makeCrashInfo({ restartScheduled: false }))

    // 事件仍然被 push
    expect(ctx.pendingRecoveryEvents).toHaveLength(1)
    // 错误被记录
    expect(loggerErrorMock).toHaveBeenCalledTimes(1)
    expect(loggerErrorMock.mock.calls[0][0]).toContain('扫描进程')
    expect(loggerErrorMock.mock.calls[0][0]).toContain('主动修复失败')
  })

  it('R18-5. restartExhausted 时仍触发修复（脏状态不因不重启而忽略）', () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    registerRecoveryListeners(ctx)
    const listener = scannerBridge.onCrash.mock.calls[0][0] as (info: WorkerCrashInfo) => void

    listener(makeCrashInfo({ restartExhausted: true, restartCount: 3 }))

    expect(cleanupInterruptedScanHistoryMock).toHaveBeenCalledTimes(1)
  })
})

describe('checkPendingDatabaseRecovery', () => {
  it('9. getLastRecovery() 返回 null 时直接返回，不修改队列', () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    vi.spyOn(ctx.dbManager, 'getLastRecovery').mockReturnValue(null)

    checkPendingDatabaseRecovery(ctx)

    expect(ctx.pendingRecoveryEvents).toHaveLength(0)
  })

  it('10. 已有 DB 事件时跳过（去重）', () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    // 预置一条 DB 事件
    ctx.pendingRecoveryEvents.push({
      kind: 'database',
      title: '数据库已自动恢复',
      body: '已有事件'
    })
    vi.spyOn(ctx.dbManager, 'getLastRecovery').mockReturnValue(
      makeDbRecoveryInfo({ reason: '新的恢复' })
    )

    checkPendingDatabaseRecovery(ctx)

    expect(ctx.pendingRecoveryEvents).toHaveLength(1)
    expect(ctx.pendingRecoveryEvents[0].body).toBe('已有事件')
  })

  it('11. 无 DB 事件但有 lastRecovery 时补入新事件', () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    vi.spyOn(ctx.dbManager, 'getLastRecovery').mockReturnValue(
      makeDbRecoveryInfo({
        success: true,
        reason: 'checkPending 补入',
        sourceBackup: { filename: 'auto.db.bak' },
        corruptedBackupPath: null
      })
    )

    checkPendingDatabaseRecovery(ctx)

    expect(ctx.pendingRecoveryEvents).toHaveLength(1)
    expect(ctx.pendingRecoveryEvents[0]).toMatchObject({
      kind: 'database',
      title: '数据库已自动恢复'
    })
    expect(ctx.pendingRecoveryEvents[0].body).toContain('checkPending 补入')
    expect(ctx.pendingRecoveryEvents[0].body).toContain('auto.db.bak')
  })
})

describe('flushPendingRecoveryEvents', () => {
  it('12. 空队列时直接返回，不调用 dialog.showMessageBox', async () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })

    flushPendingRecoveryEvents(ctx)
    await flushMicrotasks()

    expect(showMessageBoxMock).not.toHaveBeenCalled()
  })

  it('13. 串行弹窗：DB 事件 type=warning，worker 事件 type=info', async () => {
    const mainWindow = { id: 1, isDestroyed: () => false }
    const ctx = makeAppCtx({
      mainWindow,
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    ctx.pendingRecoveryEvents.push(
      { kind: 'database', title: 'DB 事件', body: 'body1' },
      { kind: 'worker', title: 'Worker 事件', body: 'body2' }
    )

    flushPendingRecoveryEvents(ctx)
    await flushMicrotasks()

    expect(showMessageBoxMock).toHaveBeenCalledTimes(2)
    // 提供 mainWindow 时 showMessageBox(parent, options) 第二参数为 options
    const call1 = showMessageBoxMock.mock.calls[0][1] as { type: string }
    expect(call1.type).toBe('warning')
    const call2 = showMessageBoxMock.mock.calls[1][1] as { type: string }
    expect(call2.type).toBe('info')
    // 队列被 splice 清空
    expect(ctx.pendingRecoveryEvents).toHaveLength(0)
  })

  it('14. 优先用 mainWindow 作为父级（showMessageBox 第一参数为 mainWindow）', async () => {
    const mainWindow = { id: 1, isDestroyed: () => false }
    const ctx = makeAppCtx({
      mainWindow,
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    ctx.pendingRecoveryEvents.push({
      kind: 'database',
      title: 'DB',
      body: 'body'
    })

    flushPendingRecoveryEvents(ctx)
    await flushMicrotasks()

    expect(showMessageBoxMock).toHaveBeenCalledTimes(1)
    // 第一参数为 parent (mainWindow)
    expect(showMessageBoxMock.mock.calls[0][0]).toBe(mainWindow)
  })

  it('15. mainWindow 为 null 时退化为无父级（仅传 options 一个参数）', async () => {
    const ctx = makeAppCtx({
      mainWindow: null,
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    ctx.pendingRecoveryEvents.push({
      kind: 'worker',
      title: 'Worker',
      body: 'body'
    })

    flushPendingRecoveryEvents(ctx)
    await flushMicrotasks()

    expect(showMessageBoxMock).toHaveBeenCalledTimes(1)
    // 仅 1 个参数（options 对象），无 parent
    expect(showMessageBoxMock.mock.calls[0]).toHaveLength(1)
  })

  it('16. 单次 dialog 抛错时记录 logger.error 并继续后续弹窗', async () => {
    const ctx = makeAppCtx({
      scannerWorkerBridge: scannerBridge,
      databaseWorkerBridge: databaseBridge,
      mediaWorkerBridge: mediaBridge
    })
    ctx.pendingRecoveryEvents.push(
      { kind: 'database', title: '事件1', body: 'b1' },
      { kind: 'worker', title: '事件2', body: 'b2' }
    )
    // 第一次抛错，第二次正常
    showMessageBoxMock
      .mockRejectedValueOnce(new Error('dialog error'))
      .mockResolvedValueOnce({ response: 0 })

    flushPendingRecoveryEvents(ctx)
    await flushMicrotasks()

    expect(showMessageBoxMock).toHaveBeenCalledTimes(2)
    expect(loggerErrorMock).toHaveBeenCalledTimes(1)
  })
})
