import type { BrowserWindow } from 'electron'
import type { HandlerContext } from '../ipc/handler-context'
import type { ScannerWorkerBridge } from '../scanner/scanner-worker-bridge'
import type { DatabaseWorkerBridge } from '../database/worker/database-worker-bridge'
import type { MediaWorkerBridge } from '../media-worker/bridge'
import type { ThumbnailWorkerBridge } from '../thumbnail/worker-bridge'
import type { DecryptionWorkerBridge } from '../decryption-worker/bridge'

/**
 * 数据库恢复 / worker 崩溃事件暂存项
 * 监听器在 initialize 早期注册，此时 mainWindow 尚未创建，事件先暂存，主窗口就绪后统一弹窗
 */
export interface PendingRecoveryEvent {
  kind: 'database' | 'worker'
  title: string
  body: string
  /** H1：非破坏性故障，仅提示排查且未覆盖在线库 */
  nonDestructive?: boolean
}

/**
 * 主进程内部上下文，扩展 HandlerContext，包含 worker bridges 与可变共享状态。
 * 由 Application 实例构造，传入 app/ 下各模块函数，避免模块反向依赖 Application。
 */
export interface AppContext extends HandlerContext {
  // worker bridges（HandlerContext 未暴露的）
  scannerWorkerBridge: ScannerWorkerBridge
  databaseWorkerBridge: DatabaseWorkerBridge
  mediaWorkerBridge: MediaWorkerBridge
  thumbnailWorkerBridge: ThumbnailWorkerBridge
  decryptionWorkerBridge: DecryptionWorkerBridge

  // 可变共享状态
  mainWindow: BrowserWindow | null
  startupTimers: NodeJS.Timeout[]
  isCleaningUp: boolean
  pendingRecoveryEvents: PendingRecoveryEvent[]

  // 状态访问器
  setMainWindow(win: BrowserWindow | null): void
  setCleaningUp(v: boolean): void
  getMediaUpdateTimer(): NodeJS.Timeout | null
  setMediaUpdateTimer(t: NodeJS.Timeout | null): void
}
