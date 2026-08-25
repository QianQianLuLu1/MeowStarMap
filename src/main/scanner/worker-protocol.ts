/**
 * 扫描 worker 进程通信协议
 *
 * 主进程 ↔ worker 之间的消息类型定义。
 * - 主进程 → worker：WorkerCommand（SCAN_START / SCAN_STOP / SCAN_DISPOSE）
 * - worker → 主进程：WorkerEvent（SCAN_PROGRESS / SCAN_COMPLETE / SCAN_LOG / WORKER_READY / WORKER_ERROR / WORKER_DISPOSED）
 *
 * ScanOptions / ScanProgress / MediaFile 接口从原 scanner/index.ts 迁移至此，
 * 由 scanner/index.ts re-export，确保外部 import 路径不变。
 */
import type { SceneCategory, SceneTime } from '../../shared/scene-category'

export interface ScanOptions {
  path?: string
  incremental?: boolean
  // P0-01：用户自定义游戏路径已移除（改为纯文件名签名全盘搜索）
  // 保留字段以向后兼容旧 IPC 调用，但内部不再使用
  customKnownPaths?: string[]
  // 全盘扫描模式：纯文件名签名全盘深度搜索，无预设路径依赖
  fullScan?: boolean
}

export interface ScanProgress {
  scanned: number
  found: number
  currentPath: string
  status: 'idle' | 'running' | 'completed' | 'failed'
  // 性能重构 v3 改造项三：ETA 与吞吐量（可选字段，旧监听者忽略）
  // 由 ScannerWorkerBridge 在收到 SCAN_PROGRESS 后计算并补充
  // total：扫描总文件数（全盘扫描时为预估值；增量扫描时为已发现数）
  total?: number
  /** 吞吐量（条目/秒） */
  perSec?: number
  /** 剩余时间（毫秒），扫描中实时估算 */
  etaMs?: number
  /** 任务 ID（用于取消） */
  taskId?: string
  // 性能重构：文件完整性校验（checkMissingFiles）逐页进度，可选字段旧监听者忽略
  /** 完整性校验待检查总数（首屏 COUNT 一次） */
  integrityTotal?: number
  /** 完整性校验已检查条目数（逐页累加） */
  integrityScanned?: number
  /** 完整性校验当前累计缺失条目数 */
  integrityMissing?: number
}

export interface MediaFile {
  file_path: string
  file_name: string
  file_type: 'image' | 'video'
  file_ext: string
  file_size: number
  width?: number
  height?: number
  duration?: number
  created_at: string
  modified_at: string
  source_path: string
  indexed_at: string
  scene_category: SceneCategory
  // F-O1：基于图像亮度的场景时段
  scene_time?: SceneTime
  // F-O1：手动套装标注（扫描时默认空）
  outfit?: string
  // P0-02：角色档案 UID（扫描时根据路径识别）
  account_uid: string
  // P0-03：游戏相册类型（扫描时根据父文件夹名映射填充）
  album_type: string
  // 媒体来源：'game'（游戏内拍摄）/ 'launcher'（启动器缓存）/ 'cloud'（用户云相册，CloudPhotos 非 Temp 子目录）/ 'local_screenshot'（系统/启动器截图，X6Game/ScreenShot 无Saved段）
  media_source: 'game' | 'launcher' | 'cloud' | 'local_screenshot'
  // 游戏原生缩略图路径（NikkiPhotos_LowQuality 同名文件）：扫描时直接关联，
  // 仅当该文件存在且可读时填充；未填充时走常规缩略图生成流程
  thumbnail?: string
}

// ============ 主进程 → worker ============
export type WorkerCommand =
  | { type: 'SCAN_START'; payload: { dbPath: string; options: ScanOptions } }
  | { type: 'SCAN_STOP' }
  | { type: 'SCAN_DISPOSE' } // 主进程退出前调用，worker 主动清理并退出
  | { type: 'WORKER_PING' } // R14：主进程心跳，worker 据此判断主进程是否存活

// ============ worker → 主进程 ============
export type WorkerEvent =
  | { type: 'SCAN_PROGRESS'; payload: ScanProgress }
  | { type: 'SCAN_COMPLETE'; payload: { success: boolean; message: string; filesFound?: number } }
  | {
      type: 'SCAN_LOG'
      payload: { level: 'info' | 'warn' | 'error'; message: string; args?: unknown[] }
    }
  | { type: 'WORKER_READY' } // worker 启动完成，可用于扫描
  | { type: 'WORKER_ERROR'; payload: { message: string; stack?: string } }
  // 新增：worker 处理完 SCAN_DISPOSE 并关闭 DB 句柄后回发，主进程据此确认可安全 rename 还原（不再盲等固定时长）
  | { type: 'WORKER_DISPOSED' }
