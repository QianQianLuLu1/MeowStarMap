/**
 * @layer L3
 * @module src/main/app/ipc-setup
 * @coverage setupIPC / bindScanProgressListener / injectCorruptedMarkers
 * @dependencies 37 个 registerXxxHandlers、pathGuard.initUserDataDir、database/media-repository、utils/logger
 *
 * 难点：
 * 1. 37 个 registerXxxHandlers 全部 mock 为 vi.fn()，需 vi.mock 批量 stub
 * 2. bindScanProgressListener 用 WeakMap 缓存监听器引用，第二次调用应 removeListener 旧的再 on
 * 3. injectCorruptedMarkers 内部 new MediaRepository(db, workerBridge, dbPath) 后调用 getMediaIdByPath / markCorrupted / clearCorrupted
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeAppCtx } from '../../ipc/handlers/_test-helpers'

// 共享 mock：37 个 registerXxxHandlers
const handlerMocks = vi.hoisted(() => ({
  registerMediaMetadataHandlers: vi.fn(),
  registerMediaLifecycleHandlers: vi.fn(),
  registerMediaCleanupHandlers: vi.fn(),
  registerDuplicateHandlers: vi.fn(),
  registerSimilarHandlers: vi.fn(),
  registerSearchIndexHandlers: vi.fn(),
  registerCategoryHandlers: vi.fn(),
  registerProfileHandlers: vi.fn(),
  registerFileHandlers: vi.fn(),
  registerFileRenameHandlers: vi.fn(),
  registerFileExportHandlers: vi.fn(),
  registerVideoHandlers: vi.fn(),
  registerWatermarkHandlers: vi.fn(),
  registerEditorHandlers: vi.fn(),
  registerEditorPresetHandlers: vi.fn(),
  registerEditorMetadataHandlers: vi.fn(),
  registerBackupHandlers: vi.fn(),
  registerCacheHandlers: vi.fn(),
  registerLogHandlers: vi.fn(),
  registerCrashHandlers: vi.fn(),
  registerScannerHandlers: vi.fn(),
  registerDecryptHandlers: vi.fn(),
  registerThumbnailHandlers: vi.fn(),
  registerThemeHandlers: vi.fn(),
  registerShellHandlers: vi.fn(),
  registerSettingsHandlers: vi.fn(),
  registerDialogHandlers: vi.fn(),
  registerDataHandlers: vi.fn(),
  registerImportHandlers: vi.fn(),
  registerAppHandlers: vi.fn(),
  registerOperationHistoryHandlers: vi.fn(),
  registerTaskHandlers: vi.fn(),
  registerShareHandlers: vi.fn(),
  registerPluginManagementHandlers: vi.fn(),
  registerPluginBridgeHandlers: vi.fn(),
  registerExportPrefHandlers: vi.fn(),
  registerImportRootHandlers: vi.fn(),
  registerScanLogHandlers: vi.fn(),
  initUserDataDir: vi.fn(),
  refreshPathGuardRoots: vi.fn(),
  MediaRepositoryMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn()
}))

vi.mock('../../ipc/handlers/media-handler', () => ({
  registerMediaMetadataHandlers: handlerMocks.registerMediaMetadataHandlers
}))
vi.mock('../../ipc/handlers/media-lifecycle-handler', () => ({
  registerMediaLifecycleHandlers: handlerMocks.registerMediaLifecycleHandlers
}))
vi.mock('../../ipc/handlers/media-cleanup-handler', () => ({
  registerMediaCleanupHandlers: handlerMocks.registerMediaCleanupHandlers
}))
vi.mock('../../ipc/handlers/duplicate-handler', () => ({
  registerDuplicateHandlers: handlerMocks.registerDuplicateHandlers
}))
vi.mock('../../ipc/handlers/similar-handler', () => ({
  registerSimilarHandlers: handlerMocks.registerSimilarHandlers
}))
vi.mock('../../ipc/handlers/search-index-handler', () => ({
  registerSearchIndexHandlers: handlerMocks.registerSearchIndexHandlers
}))
vi.mock('../../ipc/handlers/category-handler', () => ({
  registerCategoryHandlers: handlerMocks.registerCategoryHandlers
}))
vi.mock('../../ipc/handlers/profile-handler', () => ({
  registerProfileHandlers: handlerMocks.registerProfileHandlers
}))
vi.mock('../../ipc/handlers/file', () => ({
  registerFileHandlers: handlerMocks.registerFileHandlers
}))
vi.mock('../../ipc/handlers/file-rename-handler', () => ({
  registerFileRenameHandlers: handlerMocks.registerFileRenameHandlers
}))
vi.mock('../../ipc/handlers/file-export-handler', () => ({
  registerFileExportHandlers: handlerMocks.registerFileExportHandlers
}))
vi.mock('../../ipc/handlers/video', () => ({
  registerVideoHandlers: handlerMocks.registerVideoHandlers
}))
vi.mock('../../ipc/handlers/watermark', () => ({
  registerWatermarkHandlers: handlerMocks.registerWatermarkHandlers
}))
vi.mock('../../ipc/handlers/editor', () => ({
  registerEditorHandlers: handlerMocks.registerEditorHandlers
}))
vi.mock('../../ipc/handlers/editor-preset-handler', () => ({
  registerEditorPresetHandlers: handlerMocks.registerEditorPresetHandlers
}))
vi.mock('../../ipc/handlers/editor-metadata-handler', () => ({
  registerEditorMetadataHandlers: handlerMocks.registerEditorMetadataHandlers
}))
vi.mock('../../ipc/handlers/backup', () => ({
  registerBackupHandlers: handlerMocks.registerBackupHandlers
}))
vi.mock('../../ipc/handlers/cache', () => ({
  registerCacheHandlers: handlerMocks.registerCacheHandlers
}))
vi.mock('../../ipc/handlers/log', () => ({
  registerLogHandlers: handlerMocks.registerLogHandlers
}))
vi.mock('../../ipc/handlers/crash', () => ({
  registerCrashHandlers: handlerMocks.registerCrashHandlers
}))
vi.mock('../../ipc/handlers/scanner-handler', () => ({
  registerScannerHandlers: handlerMocks.registerScannerHandlers
}))
vi.mock('../../ipc/handlers/decrypt-handler', () => ({
  registerDecryptHandlers: handlerMocks.registerDecryptHandlers
}))
vi.mock('../../ipc/handlers/thumbnail-handler', () => ({
  registerThumbnailHandlers: handlerMocks.registerThumbnailHandlers
}))
vi.mock('../../ipc/handlers/theme-handler', () => ({
  registerThemeHandlers: handlerMocks.registerThemeHandlers
}))
vi.mock('../../ipc/handlers/shell-handler', () => ({
  registerShellHandlers: handlerMocks.registerShellHandlers
}))
vi.mock('../../ipc/handlers/settings-handler', () => ({
  registerSettingsHandlers: handlerMocks.registerSettingsHandlers
}))
vi.mock('../../ipc/handlers/dialog-handler', () => ({
  registerDialogHandlers: handlerMocks.registerDialogHandlers
}))
vi.mock('../../ipc/handlers/data-handler', () => ({
  registerDataHandlers: handlerMocks.registerDataHandlers
}))
vi.mock('../../ipc/handlers/import-handler', () => ({
  registerImportHandlers: handlerMocks.registerImportHandlers
}))
vi.mock('../../ipc/handlers/app-handler', () => ({
  registerAppHandlers: handlerMocks.registerAppHandlers
}))
vi.mock('../../ipc/handlers/operation-history-handler', () => ({
  registerOperationHistoryHandlers: handlerMocks.registerOperationHistoryHandlers
}))
vi.mock('../../ipc/handlers/task-handler', () => ({
  registerTaskHandlers: handlerMocks.registerTaskHandlers
}))
vi.mock('../../ipc/handlers/share', () => ({
  registerShareHandlers: handlerMocks.registerShareHandlers
}))
vi.mock('../../ipc/handlers/plugin', () => ({
  registerPluginManagementHandlers: handlerMocks.registerPluginManagementHandlers
}))
vi.mock('../../ipc/handlers/plugin-bridge-handler', () => ({
  registerPluginBridgeHandlers: handlerMocks.registerPluginBridgeHandlers
}))
vi.mock('../../ipc/handlers/export-pref-handler', () => ({
  registerExportPrefHandlers: handlerMocks.registerExportPrefHandlers
}))
vi.mock('../../ipc/handlers/import-root-handler', () => ({
  registerImportRootHandlers: handlerMocks.registerImportRootHandlers
}))
vi.mock('../../ipc/handlers/scan-log-handler', () => ({
  registerScanLogHandlers: handlerMocks.registerScanLogHandlers
}))
vi.mock('../../ipc/validator', () => ({
  pathGuard: { initUserDataDir: handlerMocks.initUserDataDir }
}))
vi.mock('../media-update', () => ({
  refreshPathGuardRoots: handlerMocks.refreshPathGuardRoots
}))
vi.mock('../../database/media-repository', () => ({
  MediaRepository: handlerMocks.MediaRepositoryMock
}))
vi.mock('../../utils/logger', () => ({
  logger: {
    error: handlerMocks.loggerErrorMock,
    warn: handlerMocks.loggerWarnMock
  }
}))

import { setupIPC, bindScanProgressListener, injectCorruptedMarkers } from '../ipc-setup'

// 重置所有 handler mock
function resetAllHandlerMocks(): void {
  for (const key of Object.keys(handlerMocks) as Array<keyof typeof handlerMocks>) {
    handlerMocks[key].mockReset()
  }
}

// 构造可控的 scannerManager：on/removeListener 捕获监听器
function makeScannerManagerWithProgress() {
  return {
    startScan: vi.fn(),
    stopScan: vi.fn(() => Promise.resolve()),
    getStatus: vi.fn(),
    setDbPath: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  }
}

// 构造可控的 mainWindow
function makeMainWindow() {
  return {
    webContents: { isDestroyed: () => false, send: vi.fn() },
    isDestroyed: vi.fn(() => false)
  }
}

beforeEach(() => {
  resetAllHandlerMocks()
  // MediaRepository 构造默认返回带 getMediaIdByPath/markCorrupted/clearCorrupted 的实例
  handlerMocks.MediaRepositoryMock.mockImplementation(() => ({
    getMediaIdByPath: vi.fn(),
    markCorrupted: vi.fn().mockResolvedValue(undefined),
    clearCorrupted: vi.fn().mockResolvedValue(undefined)
  }))
})

// ============================================================================
// bindScanProgressListener
// ============================================================================
describe('bindScanProgressListener', () => {
  it('1. 首次调用注册 scannerManager.on("progress", fn)', () => {
    const scannerManager = makeScannerManagerWithProgress()
    const ctx = makeAppCtx({ scannerManager })

    bindScanProgressListener(ctx)

    expect(scannerManager.on).toHaveBeenCalledTimes(1)
    expect(scannerManager.on).toHaveBeenCalledWith('progress', expect.any(Function))
    // 首次调用也会 removeListener（WeakMap 中没缓存，但 removeListener 仍被调用）
    expect(scannerManager.removeListener).toHaveBeenCalledTimes(1)
  })

  it('2. 第二次调用先 removeListener 旧的监听再 on', () => {
    const scannerManager = makeScannerManagerWithProgress()
    const ctx = makeAppCtx({ scannerManager })

    bindScanProgressListener(ctx)
    bindScanProgressListener(ctx)

    // 两次都各 removeListener + on 一次
    expect(scannerManager.removeListener).toHaveBeenCalledTimes(2)
    expect(scannerManager.on).toHaveBeenCalledTimes(2)
    // 两次传入的监听器引用应相同（WeakMap 缓存）
    const firstListener = scannerManager.on.mock.calls[0][1]
    const secondListener = scannerManager.on.mock.calls[1][1]
    expect(firstListener).toBe(secondListener)
  })

  it('3. progress 事件触发时向 mainWindow.webContents 广播 scanner:progress', () => {
    const scannerManager = makeScannerManagerWithProgress()
    const mainWindow = makeMainWindow()
    const ctx = makeAppCtx({ scannerManager, mainWindow })

    bindScanProgressListener(ctx)
    // 捕获注册的 progress 监听器
    const progressListener = scannerManager.on.mock.calls[0][1] as (p: unknown) => void
    progressListener({ scanned: 50, total: 100 })

    expect(mainWindow.webContents.send).toHaveBeenCalledWith('scanner:progress', {
      scanned: 50,
      total: 100
    })
  })

  it('4. mainWindow 为 null 时不抛错', () => {
    const scannerManager = makeScannerManagerWithProgress()
    const ctx = makeAppCtx({ scannerManager, mainWindow: null })

    bindScanProgressListener(ctx)
    const progressListener = scannerManager.on.mock.calls[0][1] as (p: unknown) => void
    // 不抛错
    expect(() => progressListener({ scanned: 1 })).not.toThrow()
  })
})

// ============================================================================
// setupIPC
// ============================================================================
describe('setupIPC', () => {
  it('5. 调用所有 30 个 registerXxxHandlers', () => {
    const ctx = makeAppCtx({ scannerManager: makeScannerManagerWithProgress() })

    setupIPC(ctx)

    // 38 个 registerXxxHandlers
    expect(handlerMocks.registerMediaMetadataHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerMediaLifecycleHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerScanLogHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerMediaCleanupHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerDuplicateHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerSimilarHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerSearchIndexHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerCategoryHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerProfileHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerFileHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerFileRenameHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerFileExportHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerVideoHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerWatermarkHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerEditorHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerEditorPresetHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerEditorMetadataHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerBackupHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerCacheHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerLogHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerCrashHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerScannerHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerDecryptHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerThumbnailHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerThemeHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerShellHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerSettingsHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerDialogHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerDataHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerImportHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerAppHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerOperationHistoryHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerTaskHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerShareHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerPluginManagementHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerPluginBridgeHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerExportPrefHandlers).toHaveBeenCalledWith(ctx)
    expect(handlerMocks.registerImportRootHandlers).toHaveBeenCalledWith(ctx)
  })

  it('6. 调用 pathGuard.initUserDataDir', () => {
    const ctx = makeAppCtx({ scannerManager: makeScannerManagerWithProgress() })

    setupIPC(ctx)

    expect(handlerMocks.initUserDataDir).toHaveBeenCalledTimes(1)
  })

  it('7. 调用 bindScanProgressListener（scannerManager.on 被调用）', () => {
    const scannerManager = makeScannerManagerWithProgress()
    const ctx = makeAppCtx({ scannerManager })

    setupIPC(ctx)

    expect(scannerManager.on).toHaveBeenCalledWith('progress', expect.any(Function))
  })

  it('8. 调用 refreshPathGuardRoots（补接线 pathGuard 媒体根目录注册）', () => {
    const ctx = makeAppCtx({ scannerManager: makeScannerManagerWithProgress() })

    setupIPC(ctx)

    expect(handlerMocks.refreshPathGuardRoots).toHaveBeenCalledWith(ctx)
  })
})

// ============================================================================
// injectCorruptedMarkers
// ============================================================================
describe('injectCorruptedMarkers', () => {
  it('8. thumbnailGen.setCorruptedMarker 被调用，注入两个回调', () => {
    const setCorruptedMarker = vi.fn()
    const ctx = makeAppCtx({
      thumbnailGenExt: { setCorruptedMarker }
    })

    injectCorruptedMarkers(ctx)

    expect(setCorruptedMarker).toHaveBeenCalledTimes(1)
    const args = setCorruptedMarker.mock.calls[0]
    expect(args[0]).toBeInstanceOf(Function)
    expect(args[1]).toBeInstanceOf(Function)
  })

  it('9. videoService.setCorruptedMarker 被调用，注入 1 个回调', () => {
    const setCorruptedMarker = vi.fn()
    const ctx = makeAppCtx({ thumbnailGenExt: { setCorruptedMarker } })

    injectCorruptedMarkers(ctx)

    expect(setCorruptedMarker).toHaveBeenCalledTimes(1)
    expect(ctx.videoService.setCorruptedMarker).toHaveBeenCalledTimes(1)
    expect(ctx.videoService.setCorruptedMarker.mock.calls[0][0]).toBeInstanceOf(Function)
  })

  it('10. markCorruptedFn 调用时查询 mediaId，未找到时静默返回（markCorrupted 未调用）', async () => {
    const setCorruptedMarker = vi.fn()
    const ctx = makeAppCtx({ thumbnailGenExt: { setCorruptedMarker } })
    const db = { prepare: vi.fn() }
    ctx.dbManager.getDatabase.mockReturnValue(db)
    const getMediaIdByPath = vi.fn(() => undefined)
    const markCorrupted = vi.fn().mockResolvedValue(undefined)
    handlerMocks.MediaRepositoryMock.mockImplementationOnce(() => ({
      getMediaIdByPath,
      markCorrupted,
      clearCorrupted: vi.fn()
    }))

    injectCorruptedMarkers(ctx)
    const markFn = setCorruptedMarker.mock.calls[0][0] as (
      filePath: string,
      reason: string
    ) => Promise<void>

    await markFn('/img/missing.jpg', 'decode failed')

    expect(getMediaIdByPath).toHaveBeenCalledWith('/img/missing.jpg')
    expect(markCorrupted).not.toHaveBeenCalled()
  })

  it('11. markCorruptedFn 调用时查询到 mediaId，调用 repo.markCorrupted', async () => {
    const setCorruptedMarker = vi.fn()
    const ctx = makeAppCtx({ thumbnailGenExt: { setCorruptedMarker } })
    const db = { prepare: vi.fn() }
    ctx.dbManager.getDatabase.mockReturnValue(db)
    const getMediaIdByPath = vi.fn(() => 42)
    const markCorrupted = vi.fn().mockResolvedValue(undefined)
    handlerMocks.MediaRepositoryMock.mockImplementationOnce(() => ({
      getMediaIdByPath,
      markCorrupted,
      clearCorrupted: vi.fn()
    }))

    injectCorruptedMarkers(ctx)
    const markFn = setCorruptedMarker.mock.calls[0][0] as (
      filePath: string,
      reason: string
    ) => Promise<void>

    await markFn('/img/found.jpg', 'corrupted')

    expect(getMediaIdByPath).toHaveBeenCalledWith('/img/found.jpg')
    expect(markCorrupted).toHaveBeenCalledWith(42, 'corrupted')
  })

  it('12. markCorruptedFn 内部抛错时仅 logger.error 不向上传播', async () => {
    const setCorruptedMarker = vi.fn()
    const ctx = makeAppCtx({ thumbnailGenExt: { setCorruptedMarker } })
    const db = { prepare: vi.fn() }
    ctx.dbManager.getDatabase.mockReturnValue(db)
    // getMediaIdByPath 抛错
    handlerMocks.MediaRepositoryMock.mockImplementationOnce(() => ({
      getMediaIdByPath: vi.fn(() => {
        throw new Error('db error')
      }),
      markCorrupted: vi.fn(),
      clearCorrupted: vi.fn()
    }))

    injectCorruptedMarkers(ctx)
    const markFn = setCorruptedMarker.mock.calls[0][0] as (
      filePath: string,
      reason: string
    ) => Promise<void>

    await expect(markFn('/img.jpg', 'reason')).resolves.toBeUndefined()
    expect(handlerMocks.loggerErrorMock).toHaveBeenCalled()
  })

  it('13. clearCorruptedFn 调用 repo.clearCorrupted', async () => {
    const setCorruptedMarker = vi.fn()
    const ctx = makeAppCtx({ thumbnailGenExt: { setCorruptedMarker } })
    const db = { prepare: vi.fn() }
    ctx.dbManager.getDatabase.mockReturnValue(db)
    const getMediaIdByPath = vi.fn(() => 99)
    const clearCorrupted = vi.fn().mockResolvedValue(undefined)
    handlerMocks.MediaRepositoryMock.mockImplementationOnce(() => ({
      getMediaIdByPath,
      markCorrupted: vi.fn(),
      clearCorrupted
    }))

    injectCorruptedMarkers(ctx)
    const clearFn = setCorruptedMarker.mock.calls[0][1] as (filePath: string) => Promise<void>

    await clearFn('/img/ok.jpg')

    expect(getMediaIdByPath).toHaveBeenCalledWith('/img/ok.jpg')
    expect(clearCorrupted).toHaveBeenCalledWith(99)
  })

  it('14. db 为 null 时 markCorruptedFn 直接返回', async () => {
    const setCorruptedMarker = vi.fn()
    const ctx = makeAppCtx({ thumbnailGenExt: { setCorruptedMarker } })
    ctx.dbManager.getDatabase.mockReturnValue(null)

    injectCorruptedMarkers(ctx)
    const markFn = setCorruptedMarker.mock.calls[0][0] as (
      filePath: string,
      reason: string
    ) => Promise<void>

    await expect(markFn('/img.jpg', 'reason')).resolves.toBeUndefined()
    // MediaRepository 未被构造
    expect(handlerMocks.MediaRepositoryMock).not.toHaveBeenCalled()
  })
})
