/**
 * 重复/相似检测域共享类型
 *
 * 前后端共用，避免 IPC 契约不一致。
 * - 主进程 handler 返回值须符合这些类型
 * - preload 泛型标注使用这些类型
 * - 渲染进程 DuplicatesPage 消费这些类型
 */

/**
 * 重复/相似检测中的单条媒体项
 *
 * 由 handler 从数据库行映射后返回，前端直接消费。
 */
export interface DuplicateItem {
  id: number
  file_path: string
  file_name: string
  file_type: string
  file_size: number
  modified_at: string
  width: number | null
  height: number | null
  is_favorite: boolean
  rating: number
  /** 缩略图路径（视频为 ffmpeg 抽帧 jpg）；null/undefined 表示尚未生成，前端据此降级占位图标 */
  thumbnail?: string | null
}

/**
 * findDuplicates / findSimilar 的扫描结果
 *
 * handler 返回值经 wrapHandler 包装为 IpcResponse<ScanResult>，
 * preload call() 解包后渲染层拿到此类型（含 success 字段）。
 */
export interface ScanResult {
  /** 业务成功标记（与 IpcResponse 外层 success 不同，此字段在内层 data 中） */
  success: boolean
  message?: string
  /** 重复分组，每组是一个媒体项数组 */
  duplicates: DuplicateItem[][]
  /** P1-01：每组推荐保留的文件 id（基于评分：分辨率+文件大小+拍摄时间+收藏） */
  bestItemIds?: (number | null)[]
  totalGroups: number
  totalFiles: number
  wastedBytes: number
  scannedFiles: number
  /** T05：相似检测特有字段 */
  threshold?: number
  hashedFiles?: number
  /** 性能重构 v3：用户取消时为 true，UI 显示「已取消」而非「失败」 */
  cancelled?: boolean
}

/**
 * generatePhash 的返回类型
 */
export interface PhashResult {
  success: boolean
  message: string
  processed: number
  total: number
}

/**
 * markDuplicates 的返回类型
 */
export interface MarkDuplicatesResult {
  success: boolean
  message: string
  markedDuplicates: number
  totalGroups: number
}
