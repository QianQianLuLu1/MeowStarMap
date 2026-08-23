import { EventEmitter } from 'events'
import { ScannerWorkerBridge } from './scanner-worker-bridge'
import type { ScanOptions, ScanProgress } from './worker-protocol'
import { logger } from '../utils/logger'
import { t } from '../i18n'
// 统一 scanner:status 契约（与 preload / 渲染进程共享，避免三端各写一份）
import type { ScannerStatus } from '../../shared/types/progress'

// re-export 公开类型，保持外部 import 路径不变
// （ScanOptions / ScanProgress / MediaFile 已迁移到 worker-protocol.ts）
export type { ScanOptions, ScanProgress, MediaFile } from './worker-protocol'

/**
 * 扫描管理器（薄壳）
 *
 * 拆分到 utilityProcess 后，本类仅保留接口外壳：
 * - 通过 ScannerWorkerBridge 转发 start/stop 指令到 worker 进程
 * - 接收 worker 推送的 SCAN_PROGRESS / SCAN_COMPLETE 事件，通过 EventEmitter 通知外部
 * - 维护 currentStatus 供 getStatus() 查询
 *
 * 所有扫描核心逻辑（findMediaDirectories / scanDirectory / saveBatchToDatabase /
 * checkMissingFiles / repairLegacyData 等）已迁移到 worker-entry.ts。
 *
 * 兼容性：startScan / stopScan / getStatus 签名与拆分前完全一致，
 * misc.ts / index.ts 的调用方式不变。
 */
export class ScannerManager extends EventEmitter {
  private bridge: ScannerWorkerBridge
  private currentStatus: ScanProgress = {
    scanned: 0,
    found: 0,
    currentPath: '',
    status: 'idle'
  }
  private dbPath = ''
  private pendingComplete:
    ((result: { success: boolean; message: string; filesFound?: number }) => void) | null = null
  private unsubscribe: (() => void) | null = null

  constructor(bridge: ScannerWorkerBridge) {
    super()
    this.bridge = bridge
    this.subscribeBridgeEvents()
    // FIX(组2-2/组2-3): 崩溃自动重启的恢复扫描改走本类 startScan（注入 bridge）：
    // 1) 复用 running 去重——用户在重启定时器触发前手动重扫时放弃恢复，
    //    避免恢复路径绕过管理层造成双 SCAN_START 与 taskId 泄漏；
    // 2) 完成结果经 restoredComplete 事件透出——原 IPC await 路径的 Promise 已在
    //    崩溃合成事件时以失败 resolve，恢复完成若无此事件将无人广播 scanner:complete。
    bridge.setRestoreExecutor(async (options) => {
      if (this.currentStatus.status === 'running') {
        logger.info(t('main.scanner.log.skipRestoreReplay'))
        return
      }
      const result = await this.startScan(options)
      this.emit('restoredComplete', result, options)
    })
  }

  /** 订阅 worker 事件，转发为 EventEmitter */
  private subscribeBridgeEvents(): void {
    this.unsubscribe = this.bridge.onEvent((event) => {
      switch (event.type) {
        case 'SCAN_PROGRESS':
          this.currentStatus = event.payload
          this.emit('progress', { ...event.payload })
          break
        case 'SCAN_COMPLETE':
          this.currentStatus.status = event.payload.success ? 'completed' : 'failed'
          this.emit('complete', event.payload)
          // startScan 的 Promise 在收到 SCAN_COMPLETE 时 resolve
          if (this.pendingComplete) {
            const resolve = this.pendingComplete
            this.pendingComplete = null
            resolve(event.payload)
          }
          break
        // SCAN_LOG / WORKER_READY / WORKER_ERROR 由 bridge 直接处理（写日志），无需此处转发
      }
    })
  }

  /**
   * 启动扫描。
   * 调用方式与拆分前完全一致：options.fullScan / options.incremental / options.path / options.customKnownPaths
   * 返回值结构与拆分前一致：{ success, message, filesFound? }
   */
  async startScan(
    options?: ScanOptions
  ): Promise<{ success: boolean; message: string; filesFound?: number }> {
    if (this.currentStatus.status === 'running') {
      return { success: false, message: t('main.scanner.error.scanInProgress') }
    }
    if (!this.dbPath) {
      return { success: false, message: t('main.scanner.error.dbPathNotInitialized') }
    }

    this.currentStatus = { scanned: 0, found: 0, currentPath: '', status: 'running' }

    // 发送 SCAN_START，等待 SCAN_COMPLETE（由 subscribeBridgeEvents 中的 pendingComplete resolve）
    return new Promise((resolve) => {
      this.pendingComplete = resolve
      this.bridge.startScan(this.dbPath, options ?? {}).catch((err) => {
        // worker 启动失败或 postMessage 失败
        if (this.pendingComplete) {
          const r = this.pendingComplete
          this.pendingComplete = null
          r({
            success: false,
            message: t('main.scanner.error.scanStartFailed', {
              reason: err instanceof Error ? err.message : String(err)
            })
          })
        }
      })
    })
  }

  /** 停止扫描（发送 SCAN_STOP，worker 内部设置 shouldStop 标志） */
  async stopScan(): Promise<{ success: boolean }> {
    this.bridge.stopScan()
    return { success: true }
  }

  /**
   * 针对单个导入根做增量扫描入库。
   * 复用 startScan 现有入口（options.path + incremental），不新增扫描逻辑。
   */
  async scanRoot(
    targetBaseDir: string
  ): Promise<{ success: boolean; message: string; filesFound?: number }> {
    return this.startScan({ path: targetBaseDir, incremental: true })
  }

  /** 获取当前扫描状态（返回结构即 scanner:status 的统一契约 ScannerStatus） */
  getStatus(): ScannerStatus {
    return { ...this.currentStatus }
  }

  /**
   * 注入数据库路径。
   * worker 进程通过此路径独立打开 better-sqlite3 连接（与主进程 DatabaseManager 共享同一 db 文件）。
   * 由 Application 在 dbManager.initialize 之后调用。
   */
  setDbPath(dbPath: string): void {
    this.dbPath = dbPath
  }
}
