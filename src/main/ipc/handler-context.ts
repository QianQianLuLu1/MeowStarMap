import type { BrowserWindow } from 'electron'
import type { DatabaseManager } from '../database/connection'
import type { ScannerManager } from '../scanner'
import type { MediaWorkerManager } from '../media-worker/manager'
import type { TaskScheduler } from '../scheduler/task-scheduler'
import type { ThumbnailGenerator } from '../thumbnail/generator'
import type { FileService } from '../services/file-service'
import type { VideoService } from '../services/video-service'
import type { WatermarkService } from '../services/watermark-service'
import type { VideoEditorBridge } from '../video-editor/bridge'
import type { SyncEventSink, SyncServerHandle } from '../sync/server/types'

/**
 * P0-A1：IPC handler 依赖注入上下文
 * Application.setupIPC() 构造此对象传入各域 register 函数，避免 handler 直接访问 Application 实例
 */
export interface HandlerContext {
  dbManager: DatabaseManager
  scannerManager: ScannerManager
  // 缩略图 / pHash / 重复检测批量任务管理器（utilityProcess 薄壳）
  mediaWorkerManager: MediaWorkerManager
  // 分级任务调度队列（用户主动触发=高优先级，后台自动触发=低优先级）
  taskScheduler: TaskScheduler
  thumbnailGen: ThumbnailGenerator
  fileService: FileService
  videoService: VideoService
  watermarkService: WatermarkService
  // 视频编辑 worker 进程桥接（调色/水印走 utilityProcess，trim/speed/export 保留在 videoService）
  videoEditorBridge: VideoEditorBridge
  /** 获取主窗口（可能为 null） */
  getMainWindow: () => BrowserWindow | null
  /** 媒体数据变更通知（节流广播 + 缓存失效） */
  notifyMediaUpdated: () => void
  /** 失效 media:// 协议白名单缓存；传 paths 时仅失效对应路径，缺省时全清 */
  invalidateMediaPathCache: (paths?: string[]) => void
  /** 应用 UI 主题 */
  applyUITheme: (theme: 'default' | 'soft-pink-luxury') => void
  /** 缩略图批量生成标志（防止并发） */
  isThumbnailsGenerating: () => boolean
  setThumbnailsGenerating: (v: boolean) => void
  /**
   * NikkiSync 同步事件汇（阶段4 initSyncServer 注入；未注入时为 undefined，
   * 写路径用可选链跳过——journal 永远写，服务器未运行也写，见 sync/server/types.ts）
   */
  syncEvents?: SyncEventSink
  /** NikkiSync 同步服务器句柄（阶段4 initSyncServer 注入；未组装时为 undefined） */
  syncServer?: SyncServerHandle
}
