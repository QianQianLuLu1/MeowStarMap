import type { AppContext } from './app-context'
import { sendToRenderer } from './renderer-bridge'
import { MediaRepository } from '../database/media-repository'
import { pathGuard } from '../ipc/validator'
import { refreshPathGuardRoots } from './media-update'
// IPC handler 注册函数（按域拆分后）
import { registerMediaMetadataHandlers } from '../ipc/handlers/media-handler'
import { registerMediaLifecycleHandlers } from '../ipc/handlers/media-lifecycle-handler'
import { registerMediaCleanupHandlers } from '../ipc/handlers/media-cleanup-handler'
import { registerDuplicateHandlers } from '../ipc/handlers/duplicate-handler'
import { registerSimilarHandlers } from '../ipc/handlers/similar-handler'
import { registerSearchIndexHandlers } from '../ipc/handlers/search-index-handler'
import { registerCategoryHandlers } from '../ipc/handlers/category-handler'
import { registerProfileHandlers } from '../ipc/handlers/profile-handler'
import { registerFileHandlers } from '../ipc/handlers/file'
import { registerFileRenameHandlers } from '../ipc/handlers/file-rename-handler'
import { registerFileExportHandlers } from '../ipc/handlers/file-export-handler'
import { registerExportPrefHandlers } from '../ipc/handlers/export-pref-handler'
import { registerVideoHandlers } from '../ipc/handlers/video'
import { registerWatermarkHandlers } from '../ipc/handlers/watermark'
import { registerEditorHandlers } from '../ipc/handlers/editor'
import { registerEditorPresetHandlers } from '../ipc/handlers/editor-preset-handler'
import { registerEditorMetadataHandlers } from '../ipc/handlers/editor-metadata-handler'
import { registerBackupHandlers } from '../ipc/handlers/backup'
import { registerCacheHandlers } from '../ipc/handlers/cache'
import { registerLogHandlers } from '../ipc/handlers/log'
import { registerCrashHandlers } from '../ipc/handlers/crash'
import { registerScannerHandlers } from '../ipc/handlers/scanner-handler'
import { registerScanLogHandlers } from '../ipc/handlers/scan-log-handler'
import { scanLogStore } from '../scanner/scan-log-store'
import { registerDecryptHandlers } from '../ipc/handlers/decrypt-handler'
import path from 'path'
import { registerThumbnailHandlers } from '../ipc/handlers/thumbnail-handler'
import { registerThemeHandlers } from '../ipc/handlers/theme-handler'
import { registerShellHandlers } from '../ipc/handlers/shell-handler'
import { registerSettingsHandlers } from '../ipc/handlers/settings-handler'
import { registerDialogHandlers } from '../ipc/handlers/dialog-handler'
import { registerDataHandlers } from '../ipc/handlers/data-handler'
import { registerImportHandlers } from '../ipc/handlers/import-handler'
import { registerImportRootHandlers } from '../ipc/handlers/import-root-handler'
import { registerAppHandlers } from '../ipc/handlers/app-handler'
import { registerOperationHistoryHandlers } from '../ipc/handlers/operation-history-handler'
import { registerTaskHandlers } from '../ipc/handlers/task-handler'
import { registerShareHandlers } from '../ipc/handlers/share'
import { registerPluginManagementHandlers } from '../ipc/handlers/plugin'
import { registerPluginBridgeHandlers } from '../ipc/handlers/plugin-bridge-handler'
import { logger } from '../utils/logger'

// C-G7：扫描进度监听器用具名函数引用，避免 removeAllListeners('progress')
// 误伤其他潜在监听者（副作用过大）；改用 removeListener 精准移除自己的监听器
// 模块级 WeakMap 保存每个 ctx 对应的 onScanProgress 引用，支持精准 removeListener
const scanProgressListeners = new WeakMap<AppContext, (progress: unknown) => void>()

/**
 * 注册 scanner:progress 监听器（具名函数引用，避免 removeAllListeners 误伤）。
 * 每次调用先 removeListener 自己的监听器再 on，避免重复累积且不误伤其他监听者。
 */
export function bindScanProgressListener(ctx: AppContext): void {
  // 复用已缓存的监听器引用，保证 removeListener 生效
  let onScanProgress = scanProgressListeners.get(ctx)
  if (!onScanProgress) {
    onScanProgress = (progress: unknown): void => {
      sendToRenderer(ctx, 'scanner:progress', progress)
    }
    scanProgressListeners.set(ctx, onScanProgress)
  }
  ctx.scannerManager.removeListener('progress', onScanProgress)
  ctx.scannerManager.on('progress', onScanProgress)
}

/**
 * 构造 ctx 并注册所有 IPC handler，初始化 pathGuard。
 * ctx 由 Application 构造并通过参数传入，setupIPC 不再负责构造 ctx。
 *
 * 注册顺序遵循原 index.ts 实现：
 * 1. 先绑定 scan:progress 监听器（避免被后续 removeAllListeners 误伤）
 * 2. 调用所有 registerXxxHandlers
 * 3. 初始化 pathGuard userData 目录白名单
 */
export function setupIPC(ctx: AppContext): void {
  // 扫描操作（进度监听只注册一次，避免重复累积）
  bindScanProgressListener(ctx)

  registerMediaMetadataHandlers(ctx)
  registerMediaLifecycleHandlers(ctx)
  registerMediaCleanupHandlers(ctx)
  registerDuplicateHandlers(ctx)
  registerSimilarHandlers(ctx)
  registerSearchIndexHandlers(ctx)
  registerCategoryHandlers(ctx)
  registerProfileHandlers(ctx)
  registerFileHandlers(ctx)
  registerFileRenameHandlers(ctx)
  registerFileExportHandlers(ctx)
  registerExportPrefHandlers(ctx)
  registerVideoHandlers(ctx)
  registerWatermarkHandlers(ctx)
  registerEditorHandlers(ctx)
  registerEditorPresetHandlers(ctx)
  registerEditorMetadataHandlers(ctx)
  registerBackupHandlers(ctx)
  registerCacheHandlers(ctx)
  registerLogHandlers(ctx)
  registerCrashHandlers(ctx)
  registerScannerHandlers(ctx)
  registerScanLogHandlers(ctx)
  registerDecryptHandlers(ctx)
  registerThumbnailHandlers(ctx)
  registerThemeHandlers(ctx)
  registerShellHandlers(ctx)
  registerSettingsHandlers(ctx)
  registerDialogHandlers(ctx)
  registerDataHandlers(ctx)
  registerImportHandlers(ctx)
  registerImportRootHandlers(ctx)
  registerAppHandlers(ctx)
  registerOperationHistoryHandlers(ctx)
  registerTaskHandlers(ctx)
  registerShareHandlers(ctx)
  // 插件系统：注册插件管理 + 能力桥 IPC handler（不修改任何现有通道）
  registerPluginManagementHandlers(ctx)
  registerPluginBridgeHandlers(ctx)

  // IPC 安全加固：初始化 pathGuard 的 userData 目录白名单
  // 必须在 app.whenReady() 之后调用，app.getPath('userData') 才可用
  // userHome 已在 PathGuard 构造时初始化，此处补充 userDataDir
  // 覆盖场景：用户主目录下的所有路径默认允许（Documents\InfinityNikki 等）
  // 系统敏感目录（C:\Windows\System32 等）作为黑名单兜底始终拒绝
  pathGuard.initUserDataDir()

  // 全链路诊断：注入落盘路径（userData/scan-log.jsonl），使诊断日志持久化可回放
  // 惰性 require electron（主进程运行时可用；node 测试环境无 electron 时静默降级为仅内存）
  try {
    const electron = require('electron')
    const userDataPath = electron.app?.getPath?.('userData')
    if (typeof userDataPath === 'string') {
      scanLogStore.setLogFilePath(path.join(userDataPath, 'scan-log.jsonl'))
    }
  } catch {
    // userData 不可用时退化为仅内存（诊断日志不影响主流程）
  }

  // 补接线：把已扫描的媒体根目录注册进 pathGuard，避免媒体在非主目录盘时被默认拒绝
  refreshPathGuardRoots(ctx)
}

/**
 * 损坏文件容错：注入 markCorrupted / clearCorrupted 回调。
 *
 * ThumbnailGenerator 在 sharp/ffmpeg 解码失败时调用 markCorrupted，
 * 解码成功后调用 clearCorrupted（用于已修复文件重扫场景）。
 * VideoService 仅注入 markCorrupted（输出文件失败不算源文件损坏）。
 *
 * 回调内通过 file_path 查询 mediaId，再调用 MediaRepository 写库。
 * 文件不在库中（如未扫描完成）时静默返回，不抛错。
 * 回调本身抛错时由调用方内部 catch，不影响主流程。
 *
 * 必须在 setupIPC 之后调用：依赖 dbManager.getDatabase() 与 workerBridge 已就绪。
 */
export function injectCorruptedMarkers(ctx: AppContext): void {
  const dbManager = ctx.dbManager
  const workerBridge = dbManager.getWorkerBridge()
  const dbPath = dbManager.getDbPath()

  /**
   * 根据 file_path 查询 mediaId 并执行 markCorrupted。
   * 失败仅记录日志，不抛错（确保单个损坏文件不影响其他文件加载）。
   */
  const markCorruptedFn: (filePath: string, reason: string) => Promise<void> = async (
    filePath,
    reason
  ) => {
    const db = dbManager.getDatabase()
    if (!db) return
    try {
      const repo = new MediaRepository(db, workerBridge, dbPath)
      const mediaId = repo.getMediaIdByPath(filePath)
      if (mediaId === undefined) return
      await repo.markCorrupted(mediaId, reason)
    } catch (err) {
      logger.error(`[App] markCorrupted 回调失败: ${filePath}`, err)
    }
  }

  /**
   * 根据 file_path 查询 mediaId 并执行 clearCorrupted。
   * 失败仅记录日志，不抛错（清除标记失败不影响缩略图正常返回）。
   */
  const clearCorruptedFn: (filePath: string) => Promise<void> = async (filePath) => {
    const db = dbManager.getDatabase()
    if (!db) return
    try {
      const repo = new MediaRepository(db, workerBridge, dbPath)
      const mediaId = repo.getMediaIdByPath(filePath)
      if (mediaId === undefined) return
      await repo.clearCorrupted(mediaId)
    } catch (err) {
      logger.warn(`[App] clearCorrupted 回调失败: ${filePath}`, err)
    }
  }

  ctx.thumbnailGen.setCorruptedMarker(markCorruptedFn, clearCorruptedFn)
  ctx.videoService.setCorruptedMarker(markCorruptedFn)
}
