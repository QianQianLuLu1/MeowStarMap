/**
 * electronAPI 桥接层 DTO 类型快照（主进程 / preload / 渲染进程共享）
 *
 * 性质说明：
 * - 本文件是 preload 暴露的 electronAPI 各方法「当前实际返回 / 接收形状」的快照，
 *   由 src/main/preload.ts 内联类型外提而来（2026-08 重构），形状一字未改。
 * - 与 media.ts / settings.ts / ipc.ts 等域文件中的同名类型（如 ScannerStartResult、
 *   FileOpResult、CacheStats）存在历史形状漂移——那些是「理想契约」，本文件是
 *   「运行时现状」。统一工作另见 docs/技术债清单.md，统一完成前两边都不要改。
 * - 因此本文件刻意不加入 index.ts barrel（避免同名导出冲突），
 *   沿用 ipc-types.ts / plugin.ts / progress.ts 不进 barrel 的先例，按直接路径引用。
 * - 仅允许纯类型定义，禁止引入任何运行时依赖（会被打进 preload bundle）。
 */
import type { FilterParams } from './editor'
import type { WatermarkConfig } from './watermark'

// ============ 扫描器 ============

export interface ScannerStartResult {
  success: boolean
  filesFound?: number
  message?: string
}
export interface ScannerProgress {
  scanned: number
  found: number
  currentPath: string
}
export interface ScannerComplete {
  success: boolean
  message: string
  filesFound?: number
}

// ============ 文件操作 ============

export interface FileOpResult {
  success: boolean
  message?: string
  processed?: number
  failed?: number
  skipped?: number
  renamed?: Array<{ oldPath: string; newPath: string; newFileName: string }>
  errors?: Array<{ path: string; message: string }>
  exported?: Array<{ source: string; target: string; success: boolean; message?: string }>
  imported?: Array<{ source: string; target: string }>
}

export type ExportFormat = 'jpg' | 'jpeg' | 'png' | 'webp' | 'original'

export interface ExportOptions {
  quality?: number
  format?: ExportFormat
  // P1-02：导出命名规则（支持变量 {date}/{album_type}/{uid}/{original_name}/{sequence}）
  namingPattern?: string
  // P0-F2：useDefaultDir=true 时从 settings 读取默认导出路径（file:export handler 使用）
  useDefaultDir?: boolean
}

// ============ 编辑器 ============

export interface EditorSaveResult {
  success: boolean
  backupPath?: string
  message?: string
}
export interface EditorSaveAsResult {
  success: boolean
  filePath?: string
  message?: string
}
export interface FilterPreset {
  id: string
  name: string
  category: string
  params: unknown
  isBuiltin: boolean
  createdAt: string
}
export interface EditorLoadPresetsResult {
  presets: FilterPreset[]
}

// XMP 元数据：导出含参数副本 + 读取已写入参数
export interface EditorMetadataFilter {
  name: string
  category: string
  params: string
}
export interface EditorMetadata {
  schemaVersion: number
  appVersion: string
  exportTimestamp: string
  params: Record<string, unknown>
  filter: EditorMetadataFilter | null
  filterIntensity: number
  watermark: Record<string, unknown> | null
}
export interface EditorMetadataInput {
  params: Record<string, unknown>
  filter: { name: string; category: string; params: unknown } | null
  filterIntensity: number
  watermark: Record<string, unknown> | null
}
export interface EditorExportWithMetadataResult {
  success: boolean
  message: string
  outputPath?: string
}
export interface EditorBatchExportWithMetadataResult {
  success: boolean
  successCount: number
  failedCount: number
  outputPaths: string[]
  failures: Array<{ sourcePath: string; error: string }>
  message: string
}

// ============ 水印 ============

export interface WatermarkApplyResult {
  success: boolean
  processed: number
  failed?: number
  message?: string
}
export interface WatermarkTemplateRow {
  id: number
  name: string
  config: string
  is_builtin: number
  created_at: string
}

// ============ 视频 ============

export interface VideoThumbnailResult {
  thumbnail: string | null
  hasThumbnail: boolean
}
export interface VideoMetadata {
  path: string
  size: number
  duration: number
  width: number
  height: number
  codec: string
  frameRate: number
}

/**
 * 单条视频编辑任务
 * - 调色（params）必填；水印/裁剪/调速/格式可选
 * - 各可选字段为空时，跳过对应滤镜，保留原视频对应属性
 *
 * 单一来源：原定义于 src/main/video-editor/types.ts，preload 曾维护
 * params/watermark 为 unknown 的宽松副本，现已统一为本严格版本。
 */
export interface VideoEditTask {
  /** 输入视频绝对路径 */
  inputPath: string
  /** 输出视频绝对路径（由调用方确保目录存在） */
  outputPath: string
  /** 基础调色参数（全 0 时跳过滤镜） */
  params: FilterParams
  /** 可选水印配置（不提供则不应用水印） */
  watermark?: WatermarkConfig | null
  /** 可选裁剪区间（秒），未提供时整段保留 */
  trim?: { start: number; end: number } | null
  /** 可选调速倍率（0.25-4.0），未提供时保持原速 */
  speed?: number | null
  /** 输出格式（如 mp4/mov/webm/gif），未提供时沿用 outputPath 后缀 */
  format?: string | null
}

/** 单视频编辑请求（IPC: video:edit） */
export interface VideoEditRequest {
  task: VideoEditTask
}

/** 单视频编辑响应 */
export interface VideoEditResponse {
  success: boolean
  taskId: string
  message?: string
  outputPath?: string
}

/** 批量编辑请求（IPC: video:editBatch） */
export interface VideoEditBatchRequest {
  tasks: VideoEditTask[]
  /** 并发数（默认 2，上限受 MAX_VIDEO_EDIT_CONCURRENCY 限制） */
  concurrency?: number
}

/** 批量编辑响应 */
export interface VideoEditBatchResponse {
  success: boolean
  taskId: string
  failedIndexes: number[]
  message?: string
}

// ============ 备份 / 目录 ============

export interface BackupListResult {
  backups: Array<{ name: string; size: number; createdAt: string }>
  backupDir: string
}
export interface DirOpResult {
  success: boolean
  needRestart: boolean
  message: string
}

// ============ 缓存 ============

export interface CacheStats {
  totalSize: number
  fileCount: number
  limit: number
  cacheDir: string
}
export interface CacheCleanResult {
  clearedSize: number
  clearedCount: number
}
export interface CacheSetLimitResult {
  applied: boolean
  evicted: number
}
export interface CacheEnforceResult {
  evicted: number
  totalSize: number
  fileCount: number
}

// ============ 日志 ============

export interface LogFaultListResult {
  faults: Array<Record<string, unknown>>
}
export interface LogFaultDetailResult {
  fault: Record<string, unknown> | null
}
export interface LogDirectoryPathResult {
  path: string
}
export interface LogStats {
  totalSize: number
  fileCount: number
  oldestTime?: string
  newestTime?: string
}
export interface LogExportZipResult {
  success: boolean
  filePath: string
  message?: string
}
export interface LogClearResult {
  success: boolean
  cleared: number
  message?: string
}

// ============ 崩溃报告 ============

export interface CrashListResult {
  crashes: Array<Record<string, unknown>>
}
export interface CrashStats {
  total: number
  oldestTime?: string
  newestTime?: string
}
export interface CrashClearResult {
  success: boolean
  cleared: number
  message?: string
}

// ============ 分享 ============

export interface ShareStartWifiResult {
  url: string
  port: number
  pin: string
  fileCount: number
  timeoutMs: number
}
export interface ShareCopyFilesResult {
  success: boolean
  count: number
  skipped: number
  message?: string
}
export interface ShareDetectAppResult {
  installed: boolean
  running: boolean
  installPath: string | null
}

// ============ 媒体 ============

export interface MediaListResult {
  items: Array<Record<string, unknown>>
  total: number
  page: number
  pageSize: number
  /** keyset 下一页游标（深分页优先），无更多页时为 null */
  nextCursor?: { sortValue: string | number | null; id: number } | null
}
export interface GroupCountsResult {
  groups: Array<{ key: string; count: number; label?: string }>
}
export interface MediaSearchResult {
  results: Array<{ id: number; file_path: string; file_name: string }>
  total: number
  usedFts5: boolean
}
export interface MediaSearchDocRow {
  id: number
  file_name: string
  tags: string
  outfit: string
  scene_category: string | null
  notes: string
  indexed_at: string
}
export interface MediaSearchBuildDocsResult {
  docs: MediaSearchDocRow[]
  /** 本页实际返回条数（恒等于 docs.length，零成本），用于表达"本页大小"语义 */
  returned: number
  /**
   * 全量总数（COUNT(*) 一次性结果）。
   * 仅当请求含 `includeTotal: true` 时填充，否则为 `undefined`。
   * ⚠️ 切勿将其当作"本页条数"读取——未显式请求时它不会回退到 docs.length。
   * 需要本页条数请改用 `returned`。
   */
  total?: number
  /** 是否还有更多页（docs.length === limit 判定） */
  hasMore: boolean
}
export interface MediaSearchExportIndexResult {
  saved: boolean
  path: string
}
export interface MediaSearchImportIndexResult {
  segments: Array<{ key: string; data: string }>
  fileSize: number
  exportedAt: string
  schemaHash: string
}
export interface OutfitStat {
  outfit: string
  count: number
  firstCreatedAt: string
  lastCreatedAt: string
}
export interface OutfitStatsResult {
  stats: OutfitStat[]
}

// ============ 角色档案 ============

export interface ProfileRow {
  uid: string
  nickname: string
  avatar?: string
  is_default: number
  created_at: string
}
export interface ProfileStats {
  totalFiles: number
  totalSize: number
  albums: Array<{ album_type: string; count: number }>
}

// ============ 界面主题 ============

export interface UiThemeGetResult {
  theme: 'default' | 'soft-pink-luxury'
}

// ============ 自动更新 ============

/** 推送给渲染端的更新事件阶段（单一来源：原定义于 src/main/app/auto-update.ts） */
export type UpdateStage =
  | 'checking' // 正在检查（手动/启动触发）
  | 'available' // 发现新版本，待用户确认下载
  | 'not-available' // 已是最新
  | 'downloading' // 下载中
  | 'downloaded' // 下载完成，待用户确认安装并重启
  | 'error' // 出错

/** 主进程 → 渲染端 的更新事件载荷（app:update 通道） */
export interface UpdatePayload {
  stage: UpdateStage
  /** 目标版本号（available/downloaded 时存在） */
  version?: string
  /** 下载进度百分比 0-100（downloading 时存在） */
  percent?: number
  /** 发布说明：electron-updater 可能是字符串或对象数组，归一成字符串展示 */
  releaseNotes?: string
  /** 发布标题（releaseName） */
  releaseName?: string
  /** 错误信息（error 时存在） */
  errorMessage?: string
  /** 下载完成后为 true，渲染端据此展示「安装并重启」按钮 */
  readyToInstall?: boolean
}

// ============ 操作历史 ============

export interface OperationHistoryRecord {
  id: number
  operationType: string
  mediaId: number | null
  payload: string
  description: string
  createdAt: string
  snapshotUpdatedAt: string | null
}
export interface OperationHistoryListResult {
  records: OperationHistoryRecord[]
}

// ============ 文件导入 ============

export interface ImportPreviewResult {
  files: Array<{ path: string; size: number; mtime: string }>
}
export interface ImportRunResult {
  imported: Array<{ source: string; target: string }>
  failed: Array<{ source: string; message: string }>
  skipped: Array<{ source: string; reason: string }>
  /** 登记导入根或触发扫描失败的警告信息（非致命，已复制文件不受影响） */
  warnings?: string[]
}

// ============ 游戏参数解密 ============

export interface DecodeFileResult {
  error?: string
  [key: string]: unknown
}
export interface DecodeFileResponse {
  ok: boolean
  data: DecodeFileResult
  message?: string
}
export interface EncodeCameraParamsResponse {
  ok: boolean
  data?: string
  message?: string
}
export interface DecodeClothDiyResponse {
  ok: boolean
  data: {
    timestamp?: number
    uidBytes?: string
    networkData?: unknown
  }
  message?: string
}
export interface DecodeHomeBuildResponse {
  ok: boolean
  data: {
    server?: string
    networkData?: unknown
  }
  message?: string
}

// ============ 任务 ============

export interface TaskCancelResult {
  cancelled: boolean
  taskId: string
}
