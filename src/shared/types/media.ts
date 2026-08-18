/**
 * 媒体文件、扫描器、视频相关共享类型定义
 *
 * 字段与数据库表 media_files / scan_history 一一对应。
 * 主进程 Repository、IPC Handler、渲染进程 Store、Preload API 共享使用。
 */

// ============================================================================
// 媒体文件类型（对应 media_files 表）
// ============================================================================

/**
 * 媒体文件类型枚举
 *
 * 对应 media_files.file_type 列，仅两种取值。
 */
export type MediaType = 'image' | 'video'

/**
 * 媒体来源枚举
 *
 * 对应 media_files.media_source 列。
 * - game：游戏内拍摄
 * - launcher：启动器缓存
 * - cloud：用户云相册（CloudPhotos 非 Temp 子目录）
 */
export type MediaSource = 'game' | 'launcher' | 'cloud'

/**
 * 场景时段枚举
 *
 * 对应 media_files.scene_time 列，基于图像亮度直方图分类。
 */
export type SceneTime = 'day' | 'night' | 'dawn' | 'dusk' | 'unknown'

/**
 * 媒体文件数据库行（与 media_files 表字段一一对应）
 *
 * 所有 INTEGER 类型字段在 TypeScript 中统一为 number；
 * SQLite 中布尔语义的 INTEGER（0/1）保持 number，便于直接透传。
 */
export interface MediaRow {
  /** 主键 ID（AUTOINCREMENT） */
  id: number
  /** 文件绝对路径（唯一约束） */
  file_path: string
  /** 文件名（含扩展名） */
  file_name: string
  /** 媒体类型：image | video */
  file_type: MediaType
  /** 扩展名（含点号，小写） */
  file_ext: string
  /** 文件大小（字节） */
  file_size: number
  /** 图像/视频宽度（像素），未知为 null */
  width: number | null
  /** 图像/视频高度（像素），未知为 null */
  height: number | null
  /** 视频时长（秒），图片为 null */
  duration: number | null
  /** 文件创建时间（ISO 字符串） */
  created_at: string
  /** 文件修改时间（ISO 字符串） */
  modified_at: string
  /** 源路径（扫描时记录的根目录） */
  source_path: string
  /** 缩略图路径（缓存目录下），未生成为 null */
  thumbnail: string | null
  /** 标签 JSON 字符串（默认 '[]'） */
  tags: string
  /** 所属分类 ID，未分类为 null */
  category_id: number | null
  /** 评分（0-5） */
  rating: number
  /** 是否收藏（0/1） */
  is_favorite: number
  /** 备注（默认空串） */
  notes: string
  /** 索引时间（ISO 字符串） */
  indexed_at: string
  /** 场景分类（如 'miracle-plains'），未检测为 null */
  scene_category: string | null
  /** 场景时段（day/night/dawn/dusk/unknown） */
  scene_time: SceneTime
  /** 套装标注（默认空串） */
  outfit: string
  /** 是否已软删除（0/1） */
  is_deleted: number
  /** 软删除时间（ISO 字符串），未删除为 null */
  deleted_at: string | null
  /** 文件是否缺失（0/1，连续两次扫描缺失才置 1） */
  is_missing: number
  /** 连续缺失次数（≥2 时标记 is_missing=1） */
  missing_count: number
  /** 感知哈希（64 字符 0/1 串），未计算为 null */
  phash: string | null
  /** 所属角色档案 UID（默认 'default'） */
  account_uid: string
  /** 游戏相册类型（如 '游戏截图'，默认 '其他'） */
  album_type: string
  /** 是否为重复组的非推荐保留项（0/1） */
  is_duplicate: number
  /** 同组推荐保留项的 ID，独立文件或推荐项本身为 null */
  original_id: number | null
  /** 媒体来源（game | launcher） */
  media_source: MediaSource
}

/**
 * 渲染进程使用的媒体文件模型
 *
 * 与 MediaRow 区别：
 * - tags：JSON 字符串 → 已解析的 string[]
 * - is_favorite/is_deleted/is_missing/is_duplicate：number → boolean
 * - 部分可选字段保持原类型
 */
export interface MediaFile {
  id: number
  filePath: string
  fileName: string
  fileType: MediaType
  fileExt: string
  fileSize: number
  width: number | null
  height: number | null
  duration: number | null
  createdAt: string
  modifiedAt: string
  sourcePath: string
  thumbnail: string | null
  tags: string[]
  categoryId: number | null
  rating: number
  isFavorite: boolean
  notes: string
  indexedAt: string
  sceneCategory: string | null
  sceneTime: SceneTime
  outfit: string
  isDeleted: boolean
  deletedAt: string | null
  isMissing: boolean
  missingCount: number
  phash: string | null
  accountUid: string
  albumType: string
  isDuplicate: boolean
  originalId: number | null
  mediaSource: MediaSource
}

// ============================================================================
// 媒体列表查询类型
// ============================================================================

/**
 * 媒体列表排序字段
 */
export type MediaSortField =
  'modified_at' | 'created_at' | 'file_name' | 'file_size' | 'rating' | 'indexed_at'

/**
 * 排序方向
 */
export type SortDirection = 'asc' | 'desc'

/**
 * 媒体来源筛选
 *
 * - 'all'：全部
 * - 'game'：仅游戏内拍摄
 * - 'launcher'：仅启动器缓存
 * - undefined：默认视图，包含 game + cloud（排除 launcher）
 */
export type MediaSourceFilter = 'all' | MediaSource | undefined

/**
 * 媒体列表查询选项
 */
export interface MediaListOptions {
  /** 账号 UID 筛选，null 表示全部 */
  accountUid?: string | null
  /** 相册类型筛选，null 表示全部 */
  albumType?: string | null
  /** 文件类型筛选，null 表示全部 */
  fileType?: MediaType | null
  /** 媒体来源筛选，默认 'all' */
  mediaSource?: MediaSourceFilter
  /** 是否包含已软删除项 */
  includeDeleted?: boolean
  /** 是否包含重复项 */
  includeDuplicates?: boolean
  /** 关键字（按文件名模糊匹配） */
  keyword?: string
  /** 排序字段，默认 'modified_at' */
  sortField?: MediaSortField
  /** 排序方向，默认 'desc' */
  sortOrder?: SortDirection
  /** 分页偏移量，0-based */
  offset?: number
  /** 每页数量，null 表示不分页 */
  limit?: number | null
  /** 图库板块目录限制：true 时仅返回 ...\GamePlayPhotos\{uid}\NikkiPhotos_HighQuality 下的图片 */
  galleryHighQualityOnly?: boolean
}

/**
 * 媒体列表查询结果
 */
export interface MediaListResult {
  /** 当前页数据 */
  items: MediaFile[]
  /** 总条数（用于分页计算） */
  total: number
  /** 当前页偏移量 */
  offset: number
  /** 当前页数量 */
  limit: number
}

// ============================================================================
// 去重分组类型
// ============================================================================

/**
 * 重复分组维度
 */
export type DuplicateGroupDimension = 'phash' | 'outfit' | 'scene' | 'album'

/**
 * 重复分组项
 */
export interface DuplicateGroup {
  /** 分组键（phash 前 N 位 / 套装名 / 场景 / 相册类型） */
  groupKey: string
  /** 分组维度 */
  dimension: DuplicateGroupDimension
  /** 组内文件列表 */
  items: MediaFile[]
  /** 组内文件总数 */
  count: number
  /** 推荐保留项的 ID */
  originalId: number | null
}

/**
 * 重复候选行（用于 phash 相似度计算前的轻量查询）
 */
export interface DuplicateCandidateRow {
  id: number
  file_path: string
  phash: string | null
  file_size: number
  width: number | null
  height: number | null
  modified_at: string
}

/**
 * pHash 行（仅包含 phash 计算所需字段）
 */
export interface PhashRow {
  id: number
  file_path: string
  phash: string | null
}

// ============================================================================
// 套装聚合统计类型
// ============================================================================

/**
 * 套装聚合行（按 outfit 分组统计）
 */
export interface OutfitAggRow {
  outfit: string
  total: number
  latest_modified: string
}

/**
 * 套装最新项行
 */
export interface OutfitLatestRow {
  id: number
  file_path: string
  thumbnail: string | null
  modified_at: string
}

/**
 * 套装统计结果
 */
export interface OutfitStat {
  /** 套装名 */
  outfit: string
  /** 该套装下的媒体总数 */
  total: number
  /** 最新修改时间 */
  latestModified: string
  /** 最新一张缩略图 */
  latestThumbnail: string | null
}

// ============================================================================
// 扫描器类型（对应 scan_history 表 + 扫描协议）
// ============================================================================

/**
 * 扫描类型
 *
 * 对应 scan_history.scan_type 列。
 */
export type ScanType = 'full' | 'incremental' | 'signature'

/**
 * 扫描状态
 *
 * 对应 scan_history.status 列。
 */
export type ScanStatus = 'running' | 'completed' | 'failed' | 'canceled'

/**
 * 扫描历史记录（与 scan_history 表字段一一对应）
 */
export interface ScanHistoryRow {
  /** 主键 ID */
  id: number
  /** 扫描类型（full/incremental/signature） */
  scan_type: ScanType
  /** 开始时间（ISO 字符串） */
  start_time: string
  /** 结束时间（ISO 字符串），运行中为 null */
  end_time: string | null
  /** 发现的文件总数 */
  files_found: number
  /** 新增文件数 */
  files_new: number
  /** 扫描状态 */
  status: ScanStatus
}

/**
 * 扫描选项（IPC scanner:start 参数）
 */
export interface ScanOptions {
  /** 自定义扫描路径列表，null 表示使用默认路径 */
  paths?: string[] | null
  /** 是否全盘扫描 */
  fullScan?: boolean
  /** 是否增量扫描（仅扫描上次后变化的文件） */
  incremental?: boolean
  /** 是否启用签名搜索（深度 15） */
  signatureSearch?: boolean
  /** 最大签名搜索深度，默认 15 */
  maxDepth?: number
}

/**
 * 扫描进度通知
 */
export interface ScanProgress {
  /** 当前已处理文件数 */
  current: number
  /** 总文件数（估算值，可能动态调整） */
  total: number
  /** 当前正在扫描的目录 */
  currentPath?: string
  /** 新发现文件数 */
  newFiles: number
  /** 已扫描完成阶段 */
  stage?: 'searching' | 'indexing' | 'thumbnailing' | 'phashing' | 'done'
}

/**
 * 扫描启动结果
 */
export interface ScannerStartResult {
  /** 是否成功启动 */
  started: boolean
  /** 扫描任务 ID（用于取消） */
  taskId: string
  /** 估算的总文件数 */
  estimatedTotal: number
}

/**
 * 扫描器状态
 */
export interface ScannerStatus {
  /** 是否正在扫描 */
  isScanning: boolean
  /** 当前扫描任务 ID */
  taskId: string | null
  /** 当前阶段 */
  stage: ScanProgress['stage'] | null
  /** 当前进度 */
  current: number
  /** 总数 */
  total: number
  /** 新增文件数 */
  newFiles: number
}

/**
 * 扫描器 Worker 命令（主进程 → Worker）
 */
export type WorkerCommand =
  | { type: 'start'; options: ScanOptions }
  | { type: 'cancel'; taskId: string }
  | { type: 'pause' }
  | { type: 'resume' }

/**
 * 扫描器 Worker 事件（Worker → 主进程）
 */
export type WorkerEvent =
  | { type: 'progress'; taskId: string; progress: ScanProgress }
  | { type: 'complete'; taskId: string; result: ScanCompleteResult }
  | { type: 'error'; taskId: string; error: { message: string; code?: string } }
  | { type: 'media-found'; media: MediaRow[] }

/**
 * 扫描完成结果
 */
export interface ScanCompleteResult {
  /** 任务 ID */
  taskId: string
  /** 发现的文件总数 */
  filesFound: number
  /** 新增文件数 */
  filesNew: number
  /** 扫描耗时（毫秒） */
  duration: number
  /** 扫描的根路径列表 */
  scannedPaths: string[]
  /** 是否被用户取消 */
  canceled: boolean
}

// ============================================================================
// 视频处理类型
// ============================================================================

/**
 * 视频导出格式（白名单）
 *
 * 注意：导出支持 gif（动图），但不支持 mkv/wmv（编码器限制）。
 */
export type VideoExportFormat = 'mp4' | 'webm' | 'gif' | 'avi' | 'mov'

/**
 * 视频元数据
 */
export interface VideoMetadata {
  /** 容器格式（如 'mp4'、'mov'） */
  format: string
  /** 时长（秒） */
  duration: number
  /** 宽度（像素） */
  width: number
  /** 高度（像素） */
  height: number
  /** 视频编码（如 'h264'、'hevc'） */
  videoCodec: string
  /** 音频编码（如 'aac'），无音轨为 null */
  audioCodec: string | null
  /** 帧率（fps） */
  fps: number
  /** 比特率（bps），未知为 null */
  bitrate: number | null
  /** 文件大小（字节） */
  fileSize: number
}

/**
 * 视频导出选项
 */
export interface VideoExportOptions {
  /** 输出格式 */
  format: VideoExportFormat
  /** 输出目录（绝对路径） */
  outputDir: string
  /** 输出文件名（不含扩展名） */
  outputFileName: string
  /** 起始时间（秒），默认 0 */
  startTime?: number
  /** 结束时间（秒），null 表示到结尾 */
  endTime?: number | null
  /** 是否保留音轨 */
  keepAudio?: boolean
  /** 质量参数（CRF 值，0-51，越小质量越高） */
  crf?: number
  /** 最大宽度（保持比例缩放），null 表示原尺寸 */
  maxWidth?: number | null
  /** 最大高度（保持比例缩放），null 表示原尺寸 */
  maxHeight?: number | null
  /** 帧率，null 表示原帧率 */
  fps?: number | null
}

/**
 * 视频导出进度
 */
export interface VideoExportProgress {
  /** 当前时间戳（秒） */
  currentTime: number
  /** 总时长（秒） */
  duration: number
  /** 进度百分比（0-100） */
  percent: number
  /** 已处理帧数 */
  frame: number
  /** 处理速度（fps） */
  fps: number
  /** 预计剩余时间（秒） */
  remainingTime: number
}

/**
 * 视频导出结果
 */
export interface VideoExportResult {
  /** 是否成功 */
  success: boolean
  /** 输出文件路径 */
  outputPath: string | null
  /** 输出文件大小（字节） */
  outputSize: number | null
  /** 耗时（毫秒） */
  duration: number
  /** 错误信息（失败时） */
  error: string | null
}

/**
 * LivePhoto 生成结果
 */
export interface LivePhotoResult {
  /** 是否成功 */
  success: boolean
  /** 输出文件路径 */
  outputPath: string | null
  /** 输出文件大小（字节） */
  outputSize: number | null
  /** 错误信息（失败时） */
  error: string | null
}

// ============================================================================
// 文件操作类型
// ============================================================================

/**
 * 文件操作结果
 */
export interface FileOpResult {
  /** 是否成功 */
  success: boolean
  /** 操作的文件路径 */
  path: string
  /** 新路径（移动/重命名时） */
  newPath?: string
  /** 错误信息（失败时） */
  error?: string
}

/**
 * 文件操作类型
 */
export type FileOperationType = 'copy' | 'move' | 'delete' | 'rename' | 'trash'

/**
 * 批量文件操作请求
 */
export interface BatchFileOpRequest {
  /** 操作类型 */
  operation: FileOperationType
  /** 源文件路径列表 */
  sourcePaths: string[]
  /** 目标目录（copy/move 时必填） */
  targetDir?: string
  /** 是否覆盖已存在文件 */
  overwrite?: boolean
}
