/**
 * @layer L3
 * @module src/main/app/lifecycle
 * @coverage bootstrapApplication 8 阶段启动 + before-quit + 启动失败兜底
 * @dependencies electron (app/BrowserWindow/dialog/shell/crashReporter)、child_process (execFile/exec/execFileSync)、
 *               app/ 内部 10 个模块、services 3 个、utils 3 个、plugins/plugin-host
 *
 * 测试策略：
 * 1. 所有内部模块用 vi.mock 替换为 stub，每个返回 resolved promise
 * 2. 按阶段拆分 describe 块，每个用例只验证 1-2 个调用点
 * 3. 单实例锁重试用 vi.useFakeTimers + advanceTimersByTimeAsync
 * 4. before-quit 处理器通过 app.on mock 调用记录提取回调，手动 emit
 * 5. fatal catch 用 dbManager.initialize 抛错触发
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeAppCtx } from '../../ipc/handlers/_test-helpers'
import type { AppContext } from '../app-context'

// ============================================================================
// vi.hoisted：所有共享 mock 在此定义
// ============================================================================
const m = vi.hoisted(() => {
  return {
    // electron app
    requestSingleInstanceLockMock: vi.fn(() => true),
    whenReadyMock: vi.fn(() => Promise.resolve()),
    appOnMock: vi.fn(),
    appQuitMock: vi.fn(),
    appExitMock: vi.fn(),
    appRelaunchMock: vi.fn(),
    appReleaseSingleInstanceLockMock: vi.fn(),
    appGetPathMock: vi.fn((p: string) => `/mock/${p}`),
    appIsReadyMock: vi.fn(() => true),
    // BrowserWindow
    bwGetAllWindowsMock: vi.fn(() => []),
    // dialog
    dialogShowMessageBoxMock: vi.fn(() => Promise.resolve({ response: 0 })),
    // shell
    shellOpenPathMock: vi.fn(() => Promise.resolve('')),
    // crashReporter
    crashReporterStartMock: vi.fn(),
    // child_process
    execFileMock: vi.fn(),
    execFileSyncMock: vi.fn(() => ''),
    execMock: vi.fn(),
    // 启动日志路径（诊断目录单一真相源）
    getStartupLogPathValueMock: vi.fn(() => '/mock/喵星图/Diagnostics/startup-errors.log'),

    // app 内部模块
    registerGlobalErrorHandlersMock: vi.fn(),
    registerRecoveryListenersMock: vi.fn(),
    checkPendingDatabaseRecoveryMock: vi.fn(),
    flushPendingRecoveryEventsMock: vi.fn(),
    performCleanupMock: vi.fn(() => Promise.resolve()),
    applyCustomDirectoriesMock: vi.fn(() => Promise.resolve()),
    ensureDesktopShortcutMock: vi.fn(() => Promise.resolve()),
    registerMediaProtocolMock: vi.fn(),
    createMainWindowMock: vi.fn(() => Promise.resolve()),
    getMainWindowMock: vi.fn(() => ({})),
    setupIPCMock: vi.fn(),
    injectCorruptedMarkersMock: vi.fn(),
    applyUIThemeMock: vi.fn(),
    setupThemeListenerMock: vi.fn(),
    performStartupScanMock: vi.fn(() => Promise.resolve()),
    cleanupAndRepairDatabaseMock: vi.fn(() => Promise.resolve()),

    // services
    backupServiceInitMock: vi.fn(),
    backupServiceSetSchedulerMock: vi.fn(),
    backupServiceScheduleStartupBackupMock: vi.fn(),
    editorServiceInitMock: vi.fn(),
    editorServiceSetSchedulerMock: vi.fn(),
    initCrashDirMock: vi.fn(),
    enforceCrashLimitMock: vi.fn(),
    getCrashDirectoryMock: vi.fn(() => '/mock/crash'),

    // logger
    initLoggerMock: vi.fn(),
    loggerInfoMock: vi.fn(),
    loggerErrorMock: vi.fn(),
    loggerWarnMock: vi.fn(),

    // diagnostic
    logStartupErrorMock: vi.fn(),

    // process-registry
    getProcessRegistryStatsMock: vi.fn(() => ({
      childProcessCount: 0,
      ffmpegCommandCount: 0
    })),

    // plugin-host
    pluginHostInitMock: vi.fn(() => Promise.resolve()),
    pluginHostSetMainWindowMock: vi.fn()
  }
})

// ============================================================================
// vi.mock：所有外部依赖
// ============================================================================
vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: m.requestSingleInstanceLockMock,
    whenReady: m.whenReadyMock,
    on: m.appOnMock,
    quit: m.appQuitMock,
    exit: m.appExitMock,
    relaunch: m.appRelaunchMock,
    releaseSingleInstanceLock: m.appReleaseSingleInstanceLockMock,
    getPath: m.appGetPathMock,
    isReady: m.appIsReadyMock
  },
  BrowserWindow: {
    getAllWindows: m.bwGetAllWindowsMock
  },
  dialog: {
    showMessageBox: m.dialogShowMessageBoxMock
  },
  shell: {
    openPath: m.shellOpenPathMock
  },
  crashReporter: {
    start: m.crashReporterStartMock
  }
}))

vi.mock('child_process', () => ({
  execFile: m.execFileMock,
  execFileSync: m.execFileSyncMock,
  exec: m.execMock
}))

vi.mock('../error-handlers', () => ({
  registerGlobalErrorHandlers: m.registerGlobalErrorHandlersMock
}))
vi.mock('../recovery', () => ({
  registerRecoveryListeners: m.registerRecoveryListenersMock,
  checkPendingDatabaseRecovery: m.checkPendingDatabaseRecoveryMock,
  flushPendingRecoveryEvents: m.flushPendingRecoveryEventsMock
}))
vi.mock('../cleanup', () => ({
  performCleanup: m.performCleanupMock
}))
vi.mock('../custom-dirs', () => ({
  applyCustomDirectories: m.applyCustomDirectoriesMock
}))
vi.mock('../desktop-shortcut', () => ({
  ensureDesktopShortcut: m.ensureDesktopShortcutMock
}))
vi.mock('../media-protocol', () => ({
  registerMediaProtocol: m.registerMediaProtocolMock
}))
vi.mock('../window-manager', () => ({
  createMainWindow: m.createMainWindowMock,
  getMainWindow: m.getMainWindowMock
}))
vi.mock('../ipc-setup', () => ({
  setupIPC: m.setupIPCMock,
  injectCorruptedMarkers: m.injectCorruptedMarkersMock
}))
vi.mock('../theme', () => ({
  applyUITheme: m.applyUIThemeMock,
  setupThemeListener: m.setupThemeListenerMock
}))
vi.mock('../startup-tasks', () => ({
  performStartupScan: m.performStartupScanMock,
  cleanupAndRepairDatabase: m.cleanupAndRepairDatabaseMock
}))

vi.mock('../../services/backup-service', () => ({
  backupService: {
    init: m.backupServiceInitMock,
    setScheduler: m.backupServiceSetSchedulerMock,
    scheduleStartupBackup: m.backupServiceScheduleStartupBackupMock
  }
}))
vi.mock('../../services/editor-service', () => ({
  editorService: {
    init: m.editorServiceInitMock,
    setScheduler: m.editorServiceSetSchedulerMock
  }
}))
vi.mock('../../services/crash-service', () => ({
  initCrashDir: m.initCrashDirMock,
  enforceCrashLimit: m.enforceCrashLimitMock,
  getCrashDirectory: m.getCrashDirectoryMock
}))
vi.mock('../../utils/logger', () => ({
  initLogger: m.initLoggerMock,
  logger: {
    info: m.loggerInfoMock,
    error: m.loggerErrorMock,
    warn: m.loggerWarnMock
  }
}))
vi.mock('../../utils/startup-diagnostic', () => ({
  logStartupError: m.logStartupErrorMock,
  diagLog: vi.fn(),
  getStartupLogPathValue: m.getStartupLogPathValueMock
}))
vi.mock('../../utils/process-registry', () => ({
  getProcessRegistryStats: m.getProcessRegistryStatsMock
}))
vi.mock('../../plugins/plugin-host', () => ({
  pluginHost: {
    init: m.pluginHostInitMock,
    setMainWindow: m.pluginHostSetMainWindowMock
  }
}))

import { bootstrapApplication } from '../lifecycle'
import { STARTUP_SCAN_DELAY_MS } from '../../utils/constants'

// ============================================================================
// 测试辅助：scannerManager stub（含 setDbPath / on / removeListener）
// ============================================================================
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

// thumbnailGen 扩展：含 enforceLimitNow / startLruBackgroundTask
function makeThumbnailGenExtStub() {
  return {
    generate: vi.fn(),
    getCacheDir: vi.fn(() => '/mock/cache'),
    setDir: vi.fn(),
    setCacheLimitBytes: vi.fn(),
    enforceLimitNow: vi.fn(() => Promise.resolve()),
    startLruBackgroundTask: vi.fn(),
    stopLruBackgroundTask: vi.fn(),
    flushAccessTimes: vi.fn(() => Promise.resolve()),
    setCorruptedMarker: vi.fn()
  }
}

// 构造带完整服务的 ctx（dbManager 由 makeAppCtx 默认提供，含 setWorkerBridge + getWalFileSize）
function makeLifecycleCtx(
  overrides: {
    scannerManager?: ReturnType<typeof makeScannerManagerStub>
    thumbnailGen?: ReturnType<typeof makeThumbnailGenExtStub>
    mediaWorkerManager?: { dispose: ReturnType<typeof vi.fn>; setDbPath: ReturnType<typeof vi.fn> }
    isCleaningUp?: boolean
  } = {}
): AppContext {
  return makeAppCtx({
    scannerManager: overrides.scannerManager ?? makeScannerManagerStub(),
    thumbnailGen: overrides.thumbnailGen ?? makeThumbnailGenExtStub(),
    mediaWorkerManager: overrides.mediaWorkerManager,
    isCleaningUp: overrides.isCleaningUp
  })
}

// 从 app.on(event, cb) 调用记录中提取指定事件的回调
function getEventCallback(eventName: string): (...args: unknown[]) => void {
  const call = m.appOnMock.mock.calls.find((c) => c[0] === eventName)
  if (!call) throw new Error(`app.on("${eventName}") 未被调用`)
  return call[1] as (...args: unknown[]) => void
}

// 重置所有 mock 调用记录（不重置实现）
function resetMockCalls() {
  Object.values(m).forEach((mock) => {
    if (typeof mock === 'function' && 'mock' in mock) {
      mock.mockClear()
    }
  })
}

// ============================================================================
// 测试用例
// ============================================================================

describe('lifecycle - bootstrapApplication', () => {
  beforeEach(() => {
    resetMockCalls()
    // 默认实现
    m.requestSingleInstanceLockMock.mockReturnValue(true)
    m.whenReadyMock.mockResolvedValue(undefined)
    m.appGetPathMock.mockImplementation((p: string) => `/mock/${p}`)
    m.dialogShowMessageBoxMock.mockResolvedValue({ response: 0 })
    m.getProcessRegistryStatsMock.mockReturnValue({
      childProcessCount: 0,
      ffmpegCommandCount: 0
    })
    m.getCrashDirectoryMock.mockReturnValue('/mock/crash')
    m.execFileSyncMock.mockReturnValue('')
    m.performCleanupMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ==========================================================================
  // 单实例锁阶段
  // ==========================================================================
  describe('单实例锁阶段', () => {
    it('1. requestSingleInstanceLock 首次返回 true，直接进入 whenReady', async () => {
      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      expect(m.whenReadyMock).toHaveBeenCalled()
      // 没有弹出"已有实例运行"对话框（fatal catch 的 dialog 不应触发）
      expect(m.dialogShowMessageBoxMock).not.toHaveBeenCalled()
    })

    it('2. 首次返回 false，1s 后重试，3 次内拿到锁', async () => {
      vi.useFakeTimers()
      // 第 1 次 false，第 2 次 true
      m.requestSingleInstanceLockMock.mockReturnValueOnce(false).mockReturnValueOnce(true)

      const ctx = makeLifecycleCtx()

      const promise = bootstrapApplication(ctx)
      await vi.advanceTimersByTimeAsync(1000)
      await promise

      // 应该被调用 2 次（首次 + 1 次重试）
      expect(m.requestSingleInstanceLockMock).toHaveBeenCalledTimes(2)
      // 没弹"已有实例运行"对话框
      expect(m.dialogShowMessageBoxMock).not.toHaveBeenCalled()
    })

    it('3. 3 次重试均失败时弹出"已有实例运行"对话框，3 个按钮', async () => {
      vi.useFakeTimers()
      m.requestSingleInstanceLockMock.mockReturnValue(false)
      // 用户选"退出"
      m.dialogShowMessageBoxMock.mockResolvedValue({ response: 2 })

      const ctx = makeLifecycleCtx()

      const promise = bootstrapApplication(ctx)
      await vi.advanceTimersByTimeAsync(3000)
      await promise

      // 4 次调用（首次 + 3 次重试）
      expect(m.requestSingleInstanceLockMock).toHaveBeenCalledTimes(4)
      // 第一次 dialog 是"已有实例运行"
      const firstDialog = m.dialogShowMessageBoxMock.mock.calls[0][0]
      expect(firstDialog.buttons).toHaveLength(3)
      expect(firstDialog.buttons).toEqual(['清理并重启', '手动处理', '退出'])
    })

    it('4. 用户选"清理并重启"，PowerShell 杀死其他进程后 relaunch + exit(0)', async () => {
      vi.useFakeTimers()
      m.requestSingleInstanceLockMock.mockReturnValue(false)
      // 用户选"清理并重启"
      m.dialogShowMessageBoxMock.mockResolvedValue({ response: 0 })
      // execFileSync 返回 PID 列表
      m.execFileSyncMock.mockImplementation((cmd: unknown) => {
        if (cmd === 'powershell') return '12345\n'
        return ''
      })

      const ctx = makeLifecycleCtx()

      const promise = bootstrapApplication(ctx)
      // 推进重试循环（3s）+ 微任务（whenReady + dialog）+ relaunch 定时器（2s）
      await vi.advanceTimersByTimeAsync(3000)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(2000)
      await promise

      expect(m.appRelaunchMock).toHaveBeenCalledTimes(1)
      expect(m.appExitMock).toHaveBeenCalledWith(0)
    })

    it('5. PowerShell 杀进程全部失败（killedAny=false）时弹"清理失败"对话框，不重启', async () => {
      vi.useFakeTimers()
      m.requestSingleInstanceLockMock.mockReturnValue(false)
      // 用户选"清理并重启"，第二次选"退出"
      m.dialogShowMessageBoxMock
        .mockResolvedValueOnce({ response: 0 })
        .mockResolvedValueOnce({ response: 1 })
      // execFileSync 全部抛错
      m.execFileSyncMock.mockImplementation(() => {
        throw new Error('powershell failed')
      })

      const ctx = makeLifecycleCtx()

      const promise = bootstrapApplication(ctx)
      await vi.advanceTimersByTimeAsync(3000)
      await vi.advanceTimersByTimeAsync(0)
      await promise

      // 弹了 2 次对话框
      expect(m.dialogShowMessageBoxMock).toHaveBeenCalledTimes(2)
      // 第二次是"清理失败"对话框
      const secondCall = m.dialogShowMessageBoxMock.mock.calls[1][0]
      expect(secondCall.title).toBe('清理失败')
      // 未重启
      expect(m.appRelaunchMock).not.toHaveBeenCalled()
      // 调用了 app.quit
      expect(m.appQuitMock).toHaveBeenCalledTimes(1)
    })

    it('6. 用户选"手动处理"，打开任务管理器', async () => {
      vi.useFakeTimers()
      m.requestSingleInstanceLockMock.mockReturnValue(false)
      // 用户选"手动处理"
      m.dialogShowMessageBoxMock.mockResolvedValue({ response: 1 })

      const ctx = makeLifecycleCtx()

      const promise = bootstrapApplication(ctx)
      await vi.advanceTimersByTimeAsync(3000)
      await vi.advanceTimersByTimeAsync(0)
      await promise

      // exec('taskmgr') 被调用
      expect(m.execMock).toHaveBeenCalledWith('taskmgr', { windowsHide: false })
      // 之后 app.quit
      expect(m.appQuitMock).toHaveBeenCalledTimes(1)
    })

    it('6b. exec("taskmgr") 启动失败时错误被 error 监听记录，不冒泡为未捕获异常', async () => {
      vi.useFakeTimers()
      m.requestSingleInstanceLockMock.mockReturnValue(false)
      m.dialogShowMessageBoxMock.mockResolvedValue({ response: 1 })
      // exec 返回带 on() 的子进程句柄
      const onMock = vi.fn()
      m.execMock.mockReturnValueOnce({ on: onMock })

      const ctx = makeLifecycleCtx()

      const promise = bootstrapApplication(ctx)
      await vi.advanceTimersByTimeAsync(3000)
      await vi.advanceTimersByTimeAsync(0)
      await promise

      expect(m.execMock).toHaveBeenCalledWith('taskmgr', { windowsHide: false })
      // 必须挂载 error 监听：否则 spawn 失败（如 taskmgr 被禁用）会冒泡成
      // uncaughtException → reportEarlyFatal → 假「启动失败 / 程序已退出」
      const errorCall = onMock.mock.calls.find((c) => c[0] === 'error')
      expect(errorCall).toBeDefined()

      const spawnErr = Object.assign(new Error('spawn EFTYPE'), {
        code: 'EFTYPE',
        syscall: 'spawn EFTYPE'
      })
      const handler = errorCall![1] as (e: unknown) => void
      expect(() => handler(spawnErr)).not.toThrow()
      expect(m.logStartupErrorMock).toHaveBeenCalledWith('exec-taskmgr', spawnErr)
    })

    it('7. 用户选"退出"，调用 app.quit()', async () => {
      vi.useFakeTimers()
      m.requestSingleInstanceLockMock.mockReturnValue(false)
      m.dialogShowMessageBoxMock.mockResolvedValue({ response: 2 })

      const ctx = makeLifecycleCtx()

      const promise = bootstrapApplication(ctx)
      await vi.advanceTimersByTimeAsync(3000)
      await vi.advanceTimersByTimeAsync(0)
      await promise

      expect(m.appQuitMock).toHaveBeenCalledTimes(1)
      expect(m.appRelaunchMock).not.toHaveBeenCalled()
    })

    it('8. 第二实例启动时聚焦已有窗口', async () => {
      const focusMock = vi.fn()
      const restoreMock = vi.fn()
      const fakeWin = {
        isMinimized: vi.fn(() => true),
        restore: restoreMock,
        focus: focusMock
      }
      m.bwGetAllWindowsMock.mockReturnValue([fakeWin])

      const ctx = makeLifecycleCtx()
      await bootstrapApplication(ctx)

      // 触发 second-instance 事件
      const cb = getEventCallback('second-instance')
      cb()
      expect(focusMock).toHaveBeenCalledTimes(1)
      expect(restoreMock).toHaveBeenCalledTimes(1)
    })
  })

  // ==========================================================================
  // 阶段 1-5
  // ==========================================================================
  describe('阶段 1-5（DB / 目录 / 日志 / 崩溃 / 备份）', () => {
    it('9. registerGlobalErrorHandlers 在 dbManager.initialize 之前调用', async () => {
      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      // 调用顺序：registerGlobalErrorHandlers 在 initialize 之前
      const globalIdx = m.registerGlobalErrorHandlersMock.mock.invocationCallOrder[0]
      const initIdx = (ctx.dbManager.initialize as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]
      expect(globalIdx).toBeLessThan(initIdx)
    })

    it('10. registerRecoveryListeners 在 dbManager.initialize 之前调用', async () => {
      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      const recoveryIdx = m.registerRecoveryListenersMock.mock.invocationCallOrder[0]
      const initIdx = (ctx.dbManager.initialize as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]
      expect(recoveryIdx).toBeLessThan(initIdx)
    })

    it('11. dbManager.initialize 成功后调用 setWorkerBridge', async () => {
      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      expect(ctx.dbManager.initialize).toHaveBeenCalledTimes(1)
      expect(ctx.dbManager.setWorkerBridge).toHaveBeenCalledTimes(1)
      // 注入的是 ctx.databaseWorkerBridge
      expect(ctx.dbManager.setWorkerBridge).toHaveBeenCalledWith(ctx.databaseWorkerBridge)
    })

    it('12. dbManager.initialize 抛错时进入 fatal catch', async () => {
      const initErr = new Error('db init failed')
      const ctx = makeLifecycleCtx()
      ;(ctx.dbManager.initialize as ReturnType<typeof vi.fn>).mockRejectedValueOnce(initErr)

      await bootstrapApplication(ctx)

      // fatal catch 被触发
      expect(m.logStartupErrorMock).toHaveBeenCalledWith('initialize-fatal', initErr)
      // 因为 lockAcquired=true，应该调用 app.exit(1)
      expect(m.appExitMock).toHaveBeenCalledWith(1)
    })

    it('13. applyCustomDirectories 抛错时不阻塞后续 initLogger', async () => {
      m.applyCustomDirectoriesMock.mockRejectedValueOnce(new Error('dir failed'))
      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      expect(m.applyCustomDirectoriesMock).toHaveBeenCalledTimes(1)
      expect(m.initLoggerMock).toHaveBeenCalledTimes(1)
      expect(m.logStartupErrorMock).toHaveBeenCalledWith(
        'applyCustomDirectories',
        expect.any(Error)
      )
    })

    it('14. initLogger 抛错时不阻塞 crashReporter', async () => {
      m.initLoggerMock.mockImplementationOnce(() => {
        throw new Error('logger init failed')
      })
      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      expect(m.crashReporterStartMock).toHaveBeenCalledTimes(1)
      expect(m.logStartupErrorMock).toHaveBeenCalledWith('initLogger', expect.any(Error))
    })

    it('15. crashReporter.start 抛错时记录 logStartupError 不阻塞', async () => {
      m.crashReporterStartMock.mockImplementationOnce(() => {
        throw new Error('crashReporter failed')
      })
      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      expect(m.backupServiceInitMock).toHaveBeenCalledTimes(1)
      expect(m.logStartupErrorMock).toHaveBeenCalledWith('crashReporter.start', expect.any(Error))
    })

    it('16. backupService.init + scheduleStartupBackup + editorService.init 均被调用', async () => {
      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      expect(m.backupServiceInitMock).toHaveBeenCalledTimes(1)
      expect(m.backupServiceSetSchedulerMock).toHaveBeenCalledTimes(1)
      expect(m.backupServiceScheduleStartupBackupMock).toHaveBeenCalledTimes(1)
      expect(m.editorServiceInitMock).toHaveBeenCalledTimes(1)
      expect(m.editorServiceSetSchedulerMock).toHaveBeenCalledTimes(1)
    })
  })

  // ==========================================================================
  // 阶段 6
  // ==========================================================================
  describe('阶段 6（协议/IPC/窗口）', () => {
    it('17. registerMediaProtocol / setupIPC / injectCorruptedMarkers / pluginHost.init / createMainWindow / setMainWindow / flushPendingRecoveryEvents 按顺序调用', async () => {
      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      expect(m.registerMediaProtocolMock).toHaveBeenCalledTimes(1)
      expect(m.setupIPCMock).toHaveBeenCalledTimes(1)
      expect(m.injectCorruptedMarkersMock).toHaveBeenCalledTimes(1)
      expect(m.pluginHostInitMock).toHaveBeenCalledTimes(1)
      expect(m.createMainWindowMock).toHaveBeenCalledTimes(1)
      expect(m.pluginHostSetMainWindowMock).toHaveBeenCalledTimes(1)
      expect(m.flushPendingRecoveryEventsMock).toHaveBeenCalledTimes(1)

      // 顺序验证
      const mediaProtoIdx = m.registerMediaProtocolMock.mock.invocationCallOrder[0]
      const setupIPCIdx = m.setupIPCMock.mock.invocationCallOrder[0]
      const injectIdx = m.injectCorruptedMarkersMock.mock.invocationCallOrder[0]
      const pluginInitIdx = m.pluginHostInitMock.mock.invocationCallOrder[0]
      const createWinIdx = m.createMainWindowMock.mock.invocationCallOrder[0]
      const setMainWinIdx = m.pluginHostSetMainWindowMock.mock.invocationCallOrder[0]
      const flushIdx = m.flushPendingRecoveryEventsMock.mock.invocationCallOrder[0]

      expect(mediaProtoIdx).toBeLessThan(setupIPCIdx)
      expect(setupIPCIdx).toBeLessThan(injectIdx)
      expect(injectIdx).toBeLessThan(pluginInitIdx)
      expect(pluginInitIdx).toBeLessThan(createWinIdx)
      expect(createWinIdx).toBeLessThan(setMainWinIdx)
      expect(setMainWinIdx).toBeLessThan(flushIdx)
    })

    it('18. scannerManager.setDbPath 与 mediaWorkerManager.setDbPath 路径含 database/meow_star_map.db', async () => {
      m.appGetPathMock.mockImplementation((p: string) => `/mock/${p}`)
      const scannerManager = makeScannerManagerStub()
      const mediaWorkerManager = { dispose: vi.fn(), setDbPath: vi.fn() }
      const ctx = makeLifecycleCtx({ scannerManager, mediaWorkerManager })

      await bootstrapApplication(ctx)

      const expectedPath = expect.stringContaining('database')
      expect(scannerManager.setDbPath).toHaveBeenCalledWith(expectedPath)
      expect(mediaWorkerManager.setDbPath).toHaveBeenCalledWith(expectedPath)

      const scannerCallArg = scannerManager.setDbPath.mock.calls[0][0] as string
      const mediaCallArg = mediaWorkerManager.setDbPath.mock.calls[0][0] as string
      expect(scannerCallArg).toContain('meow_star_map.db')
      expect(mediaCallArg).toContain('meow_star_map.db')
    })
  })

  // ==========================================================================
  // 阶段 7-8
  // ==========================================================================
  describe('阶段 7-8（主题/修复/快捷方式/定时器）', () => {
    it('19. applyUITheme + cleanupAndRepairDatabase + setupThemeListener 被调用', async () => {
      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      expect(m.applyUIThemeMock).toHaveBeenCalledTimes(1)
      expect(m.cleanupAndRepairDatabaseMock).toHaveBeenCalledTimes(1)
      expect(m.setupThemeListenerMock).toHaveBeenCalledTimes(1)
    })

    it('20. 阶段 7 抛错时记录 logStartupError 不阻塞', async () => {
      m.cleanupAndRepairDatabaseMock.mockRejectedValueOnce(new Error('repair failed'))
      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      expect(m.logStartupErrorMock).toHaveBeenCalledWith('cleanup', expect.any(Error))
      // ensureDesktopShortcut 仍被调用（阶段 7.5）
      expect(m.ensureDesktopShortcutMock).toHaveBeenCalledTimes(1)
    })

    it('21. ensureDesktopShortcut 为 fire-and-forget（不 await）', async () => {
      let shortcutResolved = false
      m.ensureDesktopShortcutMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              shortcutResolved = true
              resolve()
            }, 100)
          })
      )
      const ctx = makeLifecycleCtx()

      // bootstrapApplication 应该不等 ensureDesktopShortcut 完成就 resolve
      await bootstrapApplication(ctx)

      // 此时 shortcutResolved 应为 false（因为没 await 100ms 定时器）
      expect(shortcutResolved).toBe(false)
    })

    it('22. autoScanOnStartup=true 时 push 启动定时器到 startupTimers', async () => {
      const ctx = makeLifecycleCtx()
      // 覆盖 getSetting：autoScanOnStartup 返回 true，uiTheme 返回 default，其余返回 dflt
      ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string, dflt: unknown) => {
          if (key === 'autoScanOnStartup') return true
          if (key === 'uiTheme') return 'default'
          return dflt
        }
      )

      const initialLen = ctx.startupTimers.length
      await bootstrapApplication(ctx)

      // 应该 push 了 3 个定时器：autoScan + LRU + crash cleanup
      // （自动更新不再 push 定时器——阶段 6.5 仅注册监听器，更新由用户手动触发；
      //   后台完整性自检默认不触发）
      expect(ctx.startupTimers.length).toBe(initialLen + 3)
    })

    it('23. autoScanOnStartup=false 时不 push 扫描定时器', async () => {
      const ctx = makeLifecycleCtx()
      // 覆盖 getSetting：autoScanOnStartup 返回 false
      ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string, dflt: unknown) => {
          if (key === 'autoScanOnStartup') return false
          if (key === 'uiTheme') return 'default'
          return dflt
        }
      )

      const initialLen = ctx.startupTimers.length
      await bootstrapApplication(ctx)

      // 应该 push 了 2 个定时器：LRU + crash cleanup（无 autoScan，无 update 定时器）
      expect(ctx.startupTimers.length).toBe(initialLen + 2)
    })

    it('24. LRU 后台任务 + 崩溃清理定时器均被 push', async () => {
      const ctx = makeLifecycleCtx()

      const initialLen = ctx.startupTimers.length
      await bootstrapApplication(ctx)

      // 至少 2 个定时器（LRU 强制校准 + 崩溃清理）
      expect(ctx.startupTimers.length).toBeGreaterThanOrEqual(initialLen + 2)
      // startLruBackgroundTask 也被调用
      expect(ctx.thumbnailGen.startLruBackgroundTask).toHaveBeenCalledTimes(1)
    })

    it('25. 上次非干净退出时后台全量自检入低优先级队列（startup-integrity-check）', async () => {
      vi.useFakeTimers()
      const ctx = makeLifecycleCtx()
      // autoScanOnStartup=false，避免扫描任务干扰 enqueueLow 断言
      ;(ctx.dbManager.getSetting as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string, dflt: unknown) => {
          if (key === 'autoScanOnStartup') return false
          if (key === 'uiTheme') return 'default'
          return dflt
        }
      )
      // 上次非干净退出（clean-exit 标志缺失）→ 触发后台自检
      ;(
        ctx.dbManager.shouldRunFullIntegrityCheck as unknown as ReturnType<typeof vi.fn>
      ).mockReturnValue(true)

      const initialLen = ctx.startupTimers.length
      const promise = bootstrapApplication(ctx)
      // 推进到 STARTUP_SCAN_DELAY_MS 触发 integrity-check 定时器
      await vi.advanceTimersByTimeAsync(STARTUP_SCAN_DELAY_MS)
      await promise

      // autoScan=false：integrity-check + LRU + crash cleanup = 3 个定时器（无 update 定时器）
      expect(ctx.startupTimers.length).toBe(initialLen + 3)
      expect(ctx.taskScheduler.enqueueLow).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ id: 'startup-integrity-check' })
      )
    })
  })

  // ==========================================================================
  // before-quit 流程
  // ==========================================================================
  describe('before-quit 流程', () => {
    it('25. ctx.isCleaningUp=true 时 before-quit 短路返回', async () => {
      const ctx = makeLifecycleCtx({ isCleaningUp: true })

      await bootstrapApplication(ctx)

      // 触发 before-quit 事件
      const event = { preventDefault: vi.fn() }
      const cb = getEventCallback('before-quit')
      cb(event)

      // 因为 isCleaningUp=true，应该短路，不调用 preventDefault
      expect(event.preventDefault).not.toHaveBeenCalled()
      // performCleanup 也不应该被调用
      expect(m.performCleanupMock).not.toHaveBeenCalled()
    })

    it('26. 首次 before-quit 调用 event.preventDefault() + 设置 isCleaningUp=true', async () => {
      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      const event = { preventDefault: vi.fn() }
      const cb = getEventCallback('before-quit')
      cb(event)

      expect(event.preventDefault).toHaveBeenCalledTimes(1)
      expect(ctx.setCleaningUp).toHaveBeenCalledWith(true)
      expect(ctx.isCleaningUp).toBe(true)
    })

    it('27. WAL 文件 >10MB 时超时延长到 5s', async () => {
      vi.useFakeTimers()
      const ctx = makeLifecycleCtx()
      ;(ctx.dbManager.getWalFileSize as ReturnType<typeof vi.fn>).mockReturnValue(
        11 * 1024 * 1024 // 11MB
      )
      // performCleanup 永不 resolve（模拟卡死），验证 5s 超时分支
      m.performCleanupMock.mockImplementation(() => new Promise<void>(() => {}))

      await bootstrapApplication(ctx)

      const event = { preventDefault: vi.fn() }
      const cb = getEventCallback('before-quit')
      cb(event)

      // performCleanup 应该被调用
      expect(m.performCleanupMock).toHaveBeenCalledTimes(1)

      // 推进 2s，验证此时还未强制退出（因为超时延长到 5s）
      await vi.advanceTimersByTimeAsync(2000)
      expect(m.appExitMock).not.toHaveBeenCalled()

      // 推进到 5s，应该触发强制退出
      await vi.advanceTimersByTimeAsync(3000)
      expect(m.appExitMock).toHaveBeenCalledWith(1)
      expect(m.logStartupErrorMock).toHaveBeenCalledWith('force-exit-timeout', expect.any(Error))
    })

    it('28. performCleanup 完成后 clearTimeout(forceExitTimer) + releaseSingleInstanceLock + app.exit(0)', async () => {
      vi.useFakeTimers()
      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      const event = { preventDefault: vi.fn() }
      const cb = getEventCallback('before-quit')
      // before-quit 回调返回 undefined，但内部 performCleanup().finally() 是异步
      cb(event)
      // 等微任务 + performCleanup resolve
      await vi.advanceTimersByTimeAsync(0)

      // 验证关键调用
      expect(m.performCleanupMock).toHaveBeenCalledTimes(1)
      expect(m.appReleaseSingleInstanceLockMock).toHaveBeenCalled()
      expect(m.appExitMock).toHaveBeenCalledWith(0)
    })

    it('29. performCleanup 超时后 app.exit(1) + releaseSingleInstanceLock', async () => {
      vi.useFakeTimers()
      // performCleanup 永不 resolve（模拟卡死）
      m.performCleanupMock.mockImplementation(() => new Promise<void>(() => {}))
      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      const event = { preventDefault: vi.fn() }
      const cb = getEventCallback('before-quit')
      cb(event)

      // 默认超时 2s
      await vi.advanceTimersByTimeAsync(2000)

      // 强制退出
      expect(m.appExitMock).toHaveBeenCalledWith(1)
      expect(m.appReleaseSingleInstanceLockMock).toHaveBeenCalled()
      expect(m.logStartupErrorMock).toHaveBeenCalledWith('force-exit-timeout', expect.any(Error))
    })
  })

  // ==========================================================================
  // 其他生命周期事件
  // ==========================================================================
  describe('其他生命周期事件', () => {
    it('30. window-all-closed 在非 macOS 下调用 app.quit()', async () => {
      const originalPlatform = process.platform
      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      // 触发 window-all-closed 事件
      const cb = getEventCallback('window-all-closed')

      // process.platform !== 'darwin' 应该走 app.quit()
      if (originalPlatform !== 'darwin') {
        cb()
        expect(m.appQuitMock).toHaveBeenCalled()
      } else {
        // macOS 上不调用 quit
        cb()
        expect(m.appQuitMock).not.toHaveBeenCalled()
      }
    })

    it('31. activate 在无窗口时调用 createMainWindow', async () => {
      m.bwGetAllWindowsMock.mockReturnValue([])
      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      // 触发 activate 事件
      const cb = getEventCallback('activate')
      await cb()

      // createMainWindow 应该再被调用一次（启动时 1 次 + activate 1 次）
      expect(m.createMainWindowMock).toHaveBeenCalledTimes(2)
    })
  })

  // ==========================================================================
  // fatal catch
  // ==========================================================================
  describe('fatal catch', () => {
    it('32. fatal 时 logStartupError("initialize-fatal", err) 被调用', async () => {
      const initErr = new Error('fatal init')
      // registerMediaProtocol 不在 try/catch 内，抛错会进 fatal catch
      m.registerMediaProtocolMock.mockImplementationOnce(() => {
        throw initErr
      })

      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      expect(m.logStartupErrorMock).toHaveBeenCalledWith('initialize-fatal', initErr)
    })

    it('33. fatal 时弹出"启动失败"对话框，2 个按钮', async () => {
      const fatalErr = new Error('fatal')
      m.registerMediaProtocolMock.mockImplementationOnce(() => {
        throw fatalErr
      })

      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      // 最后一次 dialog 是"启动失败"
      const lastDialog =
        m.dialogShowMessageBoxMock.mock.calls[m.dialogShowMessageBoxMock.mock.calls.length - 1][0]
      expect(lastDialog.type).toBe('error')
      expect(lastDialog.buttons).toHaveLength(2)
      expect(lastDialog.buttons).toEqual(['打开日志目录', '退出'])
    })

    it('34. 用户选"打开日志目录"时 shell.openPath 被调用', async () => {
      const fatalErr = new Error('fatal')
      m.registerMediaProtocolMock.mockImplementationOnce(() => {
        throw fatalErr
      })
      // 用户选"打开日志目录"
      m.dialogShowMessageBoxMock.mockResolvedValueOnce({ response: 0 })

      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      expect(m.shellOpenPathMock).toHaveBeenCalledTimes(1)
      // 日志路径统一到诊断目录单一真相源 getStartupLogPathValue()（此前指向 userData，
      // 与 logStartupError 真实落盘路径不一致，用户在弹窗目录下找不到日志）
      const openPathArg = m.shellOpenPathMock.mock.calls[0][0]
      expect(openPathArg).toBe('/mock/喵星图/Diagnostics')
    })

    it('35. lockAcquired=true 时 dbManager.close + releaseSingleInstanceLock + app.exit(1) 被调用', async () => {
      // 单实例锁获取成功后，阶段 6 抛错 → lockAcquired=true → fatal catch
      const fatalErr = new Error('fatal after lock')
      m.registerMediaProtocolMock.mockImplementationOnce(() => {
        throw fatalErr
      })

      const ctx = makeLifecycleCtx()

      await bootstrapApplication(ctx)

      expect(ctx.dbManager.close).toHaveBeenCalledTimes(1)
      expect(m.appReleaseSingleInstanceLockMock).toHaveBeenCalledTimes(1)
      expect(m.appExitMock).toHaveBeenCalledWith(1)
    })

    it('36. lockAcquired=false 时调用 app.quit()', async () => {
      // 单实例锁获取失败 + 用户选"退出" → lockAcquired=false
      vi.useFakeTimers()
      m.requestSingleInstanceLockMock.mockReturnValue(false)
      m.dialogShowMessageBoxMock.mockResolvedValue({ response: 2 }) // 退出

      const ctx = makeLifecycleCtx()

      const promise = bootstrapApplication(ctx)
      await vi.advanceTimersByTimeAsync(3000)
      await vi.advanceTimersByTimeAsync(0)
      await promise

      // lockAcquired=false → app.quit()
      expect(m.appQuitMock).toHaveBeenCalledTimes(1)
      // 不应该调用 app.exit
      expect(m.appExitMock).not.toHaveBeenCalled()
    })
  })
})
