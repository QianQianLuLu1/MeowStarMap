import { BrowserWindow } from 'electron'
import { DatabaseManager } from '../database/connection'
import { ScannerManager } from '../scanner'
// 全盘扫描模块进程拆分：ScannerManager 改为薄壳，通过 ScannerWorkerBridge 与 utilityProcess 通信
import { ScannerWorkerBridge } from '../scanner/scanner-worker-bridge'
// 数据库写操作进程拆分：better-sqlite3 同步写通过 DatabaseWorkerBridge 走独立 utilityProcess
import { DatabaseWorkerBridge } from '../database/worker/database-worker-bridge'
// 缩略图 / pHash / 重复检测进程拆分：MediaWorkerManager 改为薄壳，通过 MediaWorkerBridge 与 utilityProcess 通信
import { MediaWorkerBridge } from '../media-worker/bridge'
import { MediaWorkerManager } from '../media-worker/manager'
// 视频编辑进程拆分：调色/水印走独立 utilityProcess，由 VideoEditorBridge 持有生命周期
import { VideoEditorBridge } from '../video-editor/bridge'
// FIX(组17-1)：解密网络解码进程拆分——同步网络 FFI 下沉到独立 utilityProcess，
// 避免网络慢时冻结主进程并拖垮照片参数解密
import { DecryptionWorkerBridge } from '../decryption-worker/bridge'
import { setDecryptionWorkerBridge } from '../services/decryption-service'
// 分级任务调度队列：用户主动触发=高优先级，后台自动触发=低优先级串行
import { TaskScheduler } from '../scheduler/task-scheduler'
import { ThumbnailGenerator } from '../thumbnail/generator'
// 缩略图单文件 worker 化：ThumbnailGenerator 通过 ThumbnailWorkerBridge 委托 sharp 调用到独立 utilityProcess
import { ThumbnailWorkerBridge } from '../thumbnail/worker-bridge'
import { FileService } from '../services/file-service'
import { VideoService } from '../services/video-service'
import { WatermarkService } from '../services/watermark-service'
import type { AppContext, PendingRecoveryEvent } from './app-context'
import { notifyMediaUpdated as notifyMediaUpdatedFn } from './media-update'
import { sendToRenderer } from './renderer-bridge'
import { applyUITheme as applyUIThemeFn } from './theme'
import { invalidateMediaPathCache as invalidateMediaPathCacheFn } from './media-protocol'
import { bootstrapApplication } from './lifecycle'

/**
 * Application 类仅作为协调者：构造函数实例化所有服务，buildAppContext 构造共享上下文，
 * initialize() 委托给 app/lifecycle.ts 的 bootstrapApplication。
 *
 * 阶段 2.5：所有启动逻辑、IPC 注册、窗口管理、清理流程均已迁移到 app/* 模块。
 */
export class Application {
  private mainWindow: BrowserWindow | null = null
  private dbManager: DatabaseManager
  private scannerWorkerBridge: ScannerWorkerBridge
  private scannerManager: ScannerManager
  private databaseWorkerBridge: DatabaseWorkerBridge
  private mediaWorkerBridge: MediaWorkerBridge
  private mediaWorkerManager: MediaWorkerManager
  private videoEditorBridge: VideoEditorBridge
  private decryptionWorkerBridge: DecryptionWorkerBridge
  private taskScheduler: TaskScheduler
  private thumbnailGen: ThumbnailGenerator
  private thumbnailWorkerBridge: ThumbnailWorkerBridge
  private fileService: FileService
  private videoService: VideoService
  private watermarkService: WatermarkService

  // A-7：缩略图批量生成运行标志，防止启动自动扫描与手动触发并发重复执行
  private thumbnailsGenerating = false
  // P1-A1：IPC handler 依赖注入上下文缓存，setupIPC 中赋值，performStartupScan 等启动路径复用
  private ctx: AppContext | null = null
  // 修复：保存启动延迟定时器引用，退出时清理，避免回调访问已关闭资源或启动新子进程
  private startupTimers: NodeJS.Timeout[] = []
  // 修复：退出清理标志，防止 before-quit 重复触发清理逻辑
  private isCleaningUp = false
  // 数据库恢复 / worker 崩溃事件暂存队列
  // 监听器在 initialize 早期注册，但此时 mainWindow 未创建，dialog 无法弹出
  // 事件先暂存到队列，createMainWindow 完成后统一弹窗告知用户
  private pendingRecoveryEvents: PendingRecoveryEvent[] = []
  // 待确认#6：media:updated 广播节流定时器
  private mediaUpdateTimer: NodeJS.Timeout | null = null

  constructor() {
    this.dbManager = new DatabaseManager()
    // 全盘扫描模块进程拆分：bridge 先于 ScannerManager 实例化，由其持有 utilityProcess 生命周期
    this.scannerWorkerBridge = new ScannerWorkerBridge()
    this.scannerManager = new ScannerManager(this.scannerWorkerBridge)
    // 数据库写操作进程拆分：bridge 在 dbManager.initialize() 完成后注入到 dbManager
    this.databaseWorkerBridge = new DatabaseWorkerBridge()
    // 缩略图 / pHash / 重复检测进程拆分：bridge 先于 MediaWorkerManager 实例化
    this.mediaWorkerBridge = new MediaWorkerBridge()
    this.mediaWorkerManager = new MediaWorkerManager(this.mediaWorkerBridge)
    // 视频编辑进程拆分：bridge 惰性启动 worker，构造时不 fork，首次调用 edit/editBatch 时才启动
    this.videoEditorBridge = new VideoEditorBridge()
    // FIX(组17-1)：解密 worker 惰性 fork（首次分享码网络解码时启动）；
    // 构造期立即注入到 decryption-service 模块，保证任何 IPC 解码调用前桥已就位
    this.decryptionWorkerBridge = new DecryptionWorkerBridge()
    setDecryptionWorkerBridge(this.decryptionWorkerBridge)
    // 分级任务调度队列：启动期 pause，主窗口 ready-to-show 后 resume
    this.taskScheduler = new TaskScheduler()
    this.taskScheduler.pause()
    this.thumbnailGen = new ThumbnailGenerator()
    // 缩略图 worker 化：实例化 bridge 并注入到 ThumbnailGenerator
    // worker 在首次 processImage 调用时惰性 fork，构造阶段不启动 worker
    this.thumbnailWorkerBridge = new ThumbnailWorkerBridge()
    this.thumbnailGen.setWorkerBridge(this.thumbnailWorkerBridge)
    // N2 批量让位（fix-thumbnail-skeleton-reveal）：主进程有按需生成在途时，
    // 通知 media-worker 后台批量在条目间插入延迟，把 CPU 优先让给可视区生成
    this.thumbnailGen.setOnDemandActivityListener((active) =>
      this.mediaWorkerManager.setBatchYield(active)
    )

    this.fileService = new FileService()
    this.videoService = new VideoService()
    this.watermarkService = new WatermarkService()
  }

  /**
   * 启动应用：构造 ctx 并委托给 app/lifecycle.ts 的 bootstrapApplication。
   * 阶段 2.5：所有启动流程已迁移到 app/* 模块，本方法仅作为入口。
   */
  async initialize(): Promise<void> {
    const ctx = this.buildAppContext()
    this.ctx = ctx
    await bootstrapApplication(ctx)
  }

  /**
   * 构造 AppContext，供 app/* 模块函数访问 Application 内部状态。
   * 阶段 2.2：在 initialize 早期调用，使 recovery 监听器等可在 setupIPC 之前使用 ctx。
   * 阶段 2.4/2.5：所有包装器方法已删除，回调直接调用模块函数（通过闭包自引用 ctx）。
   */
  private buildAppContext(): AppContext {
    // 使用闭包变量 ctx 实现回调自引用，避免 Application 类暴露不必要的包装器方法
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getter 内 this 指向 ctx，需用 self 委托读取 Application 实例字段
    const self = this
    const ctx: AppContext = {
      dbManager: this.dbManager,
      scannerManager: this.scannerManager,
      mediaWorkerManager: this.mediaWorkerManager,
      taskScheduler: this.taskScheduler,
      thumbnailGen: this.thumbnailGen,
      fileService: this.fileService,
      videoService: this.videoService,
      watermarkService: this.watermarkService,
      videoEditorBridge: this.videoEditorBridge,
      decryptionWorkerBridge: this.decryptionWorkerBridge,
      scannerWorkerBridge: this.scannerWorkerBridge,
      databaseWorkerBridge: this.databaseWorkerBridge,
      mediaWorkerBridge: this.mediaWorkerBridge,
      thumbnailWorkerBridge: this.thumbnailWorkerBridge,
      get mainWindow() {
        return self.mainWindow
      },
      get startupTimers() {
        return self.startupTimers
      },
      get isCleaningUp() {
        return self.isCleaningUp
      },
      get pendingRecoveryEvents() {
        return self.pendingRecoveryEvents
      },
      // window-manager.ts 的 getMainWindow 抛错版本仅在 lifecycle 内显式调用，
      // ctx.getMainWindow 返回 nullable，符合 HandlerContext 类型定义
      getMainWindow: () => this.mainWindow,
      // 阶段 2.2：实现迁移到 app/media-update.ts / theme.ts，直接调用模块函数
      notifyMediaUpdated: () => notifyMediaUpdatedFn(ctx),
      // 直接引用模块函数而非零参箭头：包装器会静默丢掉 paths 实参
      // （TS 允许少参函数赋值给多参签名，故编译期抓不到），使 handler 侧的
      // 「仅定向失效新增缩略图路径」退化成整表全清。签名要求见 handler-context.ts。
      invalidateMediaPathCache: invalidateMediaPathCacheFn,
      applyUITheme: (theme) => applyUIThemeFn(ctx, theme),
      isThumbnailsGenerating: () => this.thumbnailsGenerating,
      setThumbnailsGenerating: (v) => {
        this.thumbnailsGenerating = v
      },
      setMainWindow: (win) => {
        this.mainWindow = win
      },
      setCleaningUp: (v) => {
        this.isCleaningUp = v
      },
      getMediaUpdateTimer: () => this.mediaUpdateTimer,
      setMediaUpdateTimer: (t) => {
        this.mediaUpdateTimer = t
      }
    }
    // 缩略图批量进度的渲染层节流广播（THUMBNAIL_OPTIMIZATION_PLAN 节点1）：
    // 批量进行中周期性推送 media:updated，使新落盘缩略图随生成进度逐步可见，
    // 不再等整批完成才有一次刷新（可视项「模糊数十秒才清晰」的主因）。
    this.mediaWorkerManager.setThumbnailProgressNotifier(() => {
      sendToRenderer(ctx, 'media:updated')
    })
    return ctx
  }
}
