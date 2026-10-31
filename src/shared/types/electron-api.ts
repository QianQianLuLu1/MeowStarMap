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
import type {
  AssetDetailResponse,
  AssetSummary,
  ChangesResponse,
  ClothingSearchResponse,
  MediaResource,
  ProfileStatsResponse,
  SuitSearchResponse
} from '../sync/protocol'

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

// ============ GPU 状态（app:gpu-status 只读探针，2026-10-24 硬件加速优化） ============

/** 硬件加速启动决策原因 */
export type GpuBootDecisionReason =
  | 'default' // 默认开启
  | 'user-disabled' // 用户在设置页显式关闭
  | 'crash-fallback' // 崩溃自愈回退（本版本内生效）
  | 'retry-after-update' // 历史回退 + 应用版本升级 → 本版本自动重试硬件加速

/** 单块显卡摘要（防御式解析 Chromium GPUInfo.gpuDevice，缺字段为 null） */
export interface GpuDeviceSummary {
  vendorId: string | null
  deviceId: string | null
  vendor: string | null
  device: string | null
  active: boolean | null
}

/** GPU 状态总览（app:gpu-status 返回值；GPU 信息不可得时 gpus/activeGpu/featureStatus 为 null） */
export interface GpuStatusSummary {
  hardwareAcceleration: { enabled: boolean; reason: GpuBootDecisionReason }
  fallback: { active: boolean; consecutiveFailures: number; fallbackVersion: string | null }
  discretePreference: { mode: 'auto' | 'high-performance'; registry: string | null }
  /** Chromium GPU Feature Status（chrome://gpu 同源），如 { canvas:'enabled', webgl:'enabled' } */
  featureStatus: Record<string, string> | null
  gpus: GpuDeviceSummary[] | null
  /** 当前活动显卡描述（取 GPUInfo.auxAttributes.glRenderer，独显验证的关键信号） */
  activeGpu: string | null
  electronVersion: string
  platform: string
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
    /**
     * 结构化解析结果（阶段 1）：解析成功为投影对象，解析失败为 null，networkData 缺省时缺省。
     * 结构真相源 src/main/types/decryption.ts（ClothDiyStructuredOutfit）
     */
    structured?: {
      /** 动作 ID；缺省/0/负数/非整数时省略 */
      poseId?: number
      /** 身着服饰投影，保持 wearingClothes 原顺序 */
      clothes: Array<{
        /** 服装完整 ID */
        id: number
        /** 部位类型（从 ID 拆解） */
        clothType: number
        /** 状态（从 ID 拆解） */
        state: number
        /** 服装系列（从 ID 拆解） */
        species: number
        /** 款型（从 ID 拆解） */
        outfitFeature: number
      }>
    } | null
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

/** 服饰可读信息（decrypt:lookupCloth data 条目；数据源为 gongeo.us，见 docs/plans/cloth-outfit-data-contract.md §6） */
export interface ClothDataInfo {
  /** 显示名（gongeo locale JSON；name map 不可用时缺省） */
  name?: string
  /** 图标 CDN URL（gongeo CDN，由 ID 直接构造，无需网络） */
  iconUrl?: string
  /** 属性/类型标签（data API category/subcategory/metadata 值，英文原样） */
  tags?: string[]
  /** 风格分数（数据源暂无此数据，恒缺省；保留字段） */
  styleScore?: number
  /** 目录 API 原始响应体（供后续阶段扩展消费） */
  raw?: unknown
}
export interface LookupClothDataResponse {
  ok: boolean
  /** 键为服饰 ID 十进制字符串；查询失败/未收录的 ID 对应空对象 */
  data: Record<string, ClothDataInfo>
  message?: string
}

/** decrypt:clearClothCache 返回（阶段 3 搭配码网络结果缓存清理） */
export interface ClearClothCacheResponse {
  ok: boolean
  data: {
    /** 清理的缓存文件数 */
    clearedCount: number
    /** 清理的总字节数 */
    clearedSize: number
  }
  message?: string
}

// ============ 任务 ============

export interface TaskCancelResult {
  cancelled: boolean
  taskId: string
}

// ============ 收藏夹（示例） ============

export interface FavoriteItem {
  id: number
  media_id: number
  created_at: string
}

// ============ NikkiSync 同步服务（sync-integration 阶段5） ============
// 形状快照自 src/main/sync/server/types.ts（SyncServerStatusInfo/PairingQrInfo/SyncDeviceInfo）；
// 该文件是主进程「理想契约」，此处为 preload 通道的运行时快照，随阶段推进保持同步。

export interface SyncServerStatusInfo {
  available: boolean
  running: boolean
  host: string
  port: number
  connections: number
  serverId: string | null
  serverName: string | null
  pairedDeviceCount: number
  tlsFingerprintSha256: string | null
  lanHost: string
}

export interface PairingQrInfo {
  /** NS1|... 七段二维码内容（渲染层经 qrcode 生成 SVG 图像） */
  content: string
  expiresAt: string
  serverId: string
  host: string
  port: number
  tlsFingerprintSha256: string
}

export interface SyncDeviceInfo {
  deviceId: string
  deviceName: string
  platform: 'ios' | 'android'
  appVersion: string | null
  pairedAt: string
  lastSeenAt: string | null
  lastAckRevision: number
}

// ============ NikkiSync 内嵌运行时（sync-integration 阶段2） ============
// 形状快照自 src/main/nikkisync/runtime-types.ts（NikkiSyncRuntimeStatus 等）。
// shared 不得 import src/main（分层约束），因此沿用上方 sync 域的快照口径同步维护。
// 查询结果为 NikkiSync 协议 DTO：内嵌层零转换，故本文件**不重建字段名**，
// 而是直接以阶段 9 定下的协议唯一真相源 `src/shared/sync/protocol.ts` 为类型出处
// （`import type` 为纯类型引入，不进 preload 运行时依赖白名单的对立面）。
// 同形关系由 src/renderer/stores/nikkisyncContractTypes.test.ts 在编译期钉死。

/** 内嵌 Runtime 状态机取值（未建链 / 未启动 / 启动中 / 运行 / 扫描中 / 降级 / 停止中 / 错误）。 */
export type NikkiSyncRuntimeStateInfo =
  'unavailable' | 'idle' | 'starting' | 'running' | 'scanning' | 'degraded' | 'stopping' | 'error'

export interface NikkiSyncRuntimeStatusInfo {
  state: NikkiSyncRuntimeStateInfo
  /** NikkiSync 库文件绝对路径（{userData}/nikkisync/nikkisync.db）。 */
  dbPath: string
  linkReady: boolean
  /** 上游 `scanner.getStatus().status`（stopped/discovering/scanning/reconciling/running/error）。 */
  scannerStatus?: string
  /** 上游发现的安装结果 `InfinityNikkiInstallation`（installRoot / x6GameRoot / photoRoots / motionRoots / source）。 */
  installation?: unknown
  /** 上游最近一次 `ScanResult` 原样透传。 */
  lastScan?: unknown
  tables?: string[]
  /** 阶段 3：同步服务状态随会话一并给出（UI 只轮询一个通道）。 */
  sync?: NikkiSyncServerStatusInfo
  /**
   * K1：本会话真实发生的启动阶段（scanner / runtime-ready / lan-listen / cached-metadata）。
   * 缺省 = 尚无已完成的启动阶段（未启动，或启动中断在首个阶段完成之前）。
   */
  startupStages?: Array<{ stage: string; at: string }>
  /**
   * K7：最近一次扫描的诊断快照（仅计数，不含路径/UID/错误原文；未扫描时缺省）。
   * 形状随上游 `scanDiagnosticSummary`：`{lastScan?: {filesObserved, resourcesAccepted,
   * resourcesIgnored, assetsCreated, assetsUpdated, assetsDeleted, errorCount},
   * timestamp, status, installationFound, scanRootCount, automaticRootCount, extraRootCount}`。
   */
  scanDiagnostics?: unknown
  error?: string
  hint?: string
}

/** `nikkisync:get-assets` 响应：与上游 `GET /v1/assets` 同形。 */
export interface NikkiSyncAssetPageInfo {
  items: AssetSummary[]
  nextCursor?: string
  libraryRevision: number
}

/** K2：`nikkisync:get-metadata-consent` 响应（endpoint 由上游脱敏后透出）。 */
export interface NikkiSyncMetadataConsentInfo {
  enabled: boolean
  policyVersion: string
  recipients: Array<{ name: string; endpoint: string; fields: string[] }>
}

/** K2：`nikkisync:set-metadata-consent` 入参（policyVersion 取展示值原串带回）。 */
export interface NikkiSyncMetadataConsentSetInput {
  enabled: boolean
  policyVersion: string
}

/** K3：`nikkisync:resolve-game-version` 入参（ISO 8601 外输入由上游判缺省）。 */
export interface NikkiSyncGameVersionQueryInfo {
  capturedAt?: string
}

/** K3：`nikkisync:resolve-game-version` 响应（两键缺省 = 无法推断）。 */
export interface NikkiSyncGameVersionInfo {
  version?: string
  effectiveAt?: string
}

/** K6：`nikkisync:get-extra-directories` 响应（上游中文 message 已剔除）。 */
export interface NikkiSyncExtraDirectoriesInfo {
  directories: Array<{
    id: string
    path: string
    mode: 'native' | 'images'
    /** 1.0.27：目录来源标注（仅 images 目录可标；缺省 = 未标注，服务端仍按路径自动识别 SpinningMomo）。 */
    source?: 'spinning_momo' | 'other'
  }>
  automaticRoots: string[]
  busy: boolean
  scannerStatus?: unknown
}

/** K6：`nikkisync:inspect-extra-directory` 响应（上游中文 hint 已剔除）。 */
export interface NikkiSyncExtraDirectoryProposalInfo {
  id: string
  roots: unknown[]
  images: number
  videos: number
  limited: boolean
}

/** K8：整理队列行（上游 `DeletionQueue.list()` 行剔除中文 message 后的形状）。 */
export interface NikkiSyncOrganizerItemInfo {
  id: string
  assetId: string
  /** 上游 11 态：preparing/pending/confirming/queued/checking/executing/recycled/failed/changed/cancelled/rejected。 */
  state: string
  /** 手机端 45s 租约是否有效（online=false 时批准会被上游以 phone_offline 拒绝）。 */
  online: boolean
  /** 关联文件清单（仅文件名/大小/所在文件夹名，不含绝对路径）。 */
  files: Array<{ name: string; size: number; folder?: string }>
  count: number
}

/** K8：`nikkisync:get-organizer-queue` 响应（队列视图 + activity 计数）。 */
export interface NikkiSyncOrganizerViewInfo {
  items: NikkiSyncOrganizerItemInfo[]
  /** 上游 `DeletionQueue.activity()`：metrics + queued + active 原样透传。 */
  activity: unknown
}

/** K8：`nikkisync:decide-organizer-item` 入参。 */
export interface NikkiSyncOrganizerDecideInput {
  id: string
  approve: boolean
}

/** K8：`nikkisync:approve-organizer-items` 入参（1..500；重复 id 由上游 invalid_ids 拒绝）。 */
export interface NikkiSyncOrganizerApproveInput {
  ids: string[]
}

/** K8：`nikkisync:approve-organizer-items` 响应（items 剔除 message + 批准/跳过计数）。 */
export interface NikkiSyncOrganizerApproveResultInfo {
  items: NikkiSyncOrganizerItemInfo[]
  approved: number
  skipped: number
}

/**
 * K9：账号分组（上游 `AccountSyncSettings.state().accounts` 剔除中文 `label` 后的形状）。
 * 渲染层按 `uid` 出 i18n 文案：`''` = 未识别，`'source:spinning_momo'` = 旋转吧大喵，其余 = UID。
 */
export interface NikkiSyncSyncAccountInfo {
  uid: string
  count: number
  selected: boolean
  /** 最多 3 个 assetId，供 `preview-sync-account` 取样例缩略图。 */
  samples: string[]
}

/** K9：`nikkisync:get-sync-accounts` 与 `set-sync-account-selection` 的响应。 */
export interface NikkiSyncSyncAccountsInfo {
  all: boolean
  accounts: NikkiSyncSyncAccountInfo[]
}

/** K9：`nikkisync:preview-sync-account` 响应（上游资源行只投影 UI 所需三键）。 */
export interface NikkiSyncSyncAccountPreviewInfo {
  resourceId: string
  mimeType: string
  sourcePath?: string
}

/** K9：`nikkisync:set-sync-account-selection` 入参（`null` = 全部；`[]` = 不同步任何账号）。 */
export interface NikkiSyncSyncAccountSelectionInput {
  uids: string[] | null
}

/** K9：`nikkisync:set-extra-directory-source` 入参。 */
export interface NikkiSyncExtraDirectorySourceInput {
  id: string
  source: 'spinning_momo' | 'other'
}

export interface NikkiSyncScanInputInfo {
  gameRoot?: string
  path?: string
}

export interface NikkiSyncAssetQueryInfo {
  limit?: number
  cursor?: string
  type?: string
  afterRevision?: number
  includeDeleted?: boolean
}

export interface NikkiSyncResourceQueryInfo {
  assetId: string
  resourceId: string
  mode?: 'meta' | 'path'
}

/**
 * `nikkisync:get-resource` 响应：`meta` → `MediaResource`；`path` → 上游落库的绝对路径原值。
 * 二者由入参 `mode` 决定，这里保持联合而非 `unknown`，让调用方必须显式判别。
 */
export type NikkiSyncResourceInfo = MediaResource | string

// ============ NikkiSync 资产查询面扩容（sync-integration 阶段4 · UI Bridge） ============
// 响应侧一律用**类型别名**指向协议真相源，不在本仓重列字段：内嵌层零转换，
// 别名即「handler 原样返回上游对象」这一事实的编译期表达。

/** `nikkisync:get-asset-detail` 响应：与上游 `GET /v1/assets/:id` 同形。 */
export type NikkiSyncAssetDetailInfo = AssetDetailResponse

/** `nikkisync:get-changes` 响应：与上游 `GET /v1/changes` 同形（含 fullResyncRequired 判据）。 */
export type NikkiSyncChangesInfo = ChangesResponse

/** `nikkisync:search-suits` 响应：与上游 `GET /v1/search/suits` 同形。 */
export type NikkiSyncSuitSearchInfo = SuitSearchResponse

/** `nikkisync:search-clothing` 响应：与上游 `GET /v1/search/clothing` 同形。 */
export type NikkiSyncClothingSearchInfo = ClothingSearchResponse

/** `nikkisync:profile-stats` 响应：与上游 `GET /v1/profile/stats` 同形。 */
export type NikkiSyncProfileStatsInfo = ProfileStatsResponse

/** 批量资源元信息：`byAsset` 键为 assetId，值为上游 `listResources` 逐行映射结果。 */
export interface NikkiSyncResourceRecordsInfo {
  byAsset: Record<string, MediaResource[]>
}

/** 批量资源绝对路径：值为 `resourceId -> resources.source_path` 原值（上游落库口径，不改写）。 */
export interface NikkiSyncResourcePathsInfo {
  byAsset: Record<string, Record<string, string>>
}

/** `nikkisync:get-resource-records` 的返回按 `mode` 分流（避免调用侧再判联合）。 */
export type NikkiSyncResourceRecordsFor<M extends 'meta' | 'path'> = M extends 'meta'
  ? NikkiSyncResourceRecordsInfo
  : NikkiSyncResourcePathsInfo

/** `nikkisync:get-resource-records` 入参（assetIds 上限与 `get-assets` 的 limit 上界同界）。 */
export interface NikkiSyncResourceRecordsQueryInfo {
  assetIds: string[]
  mode?: 'meta' | 'path'
}

/** `nikkisync:get-changes` 入参：`after` 为已消费到的 libraryRevision。 */
export interface NikkiSyncChangesQueryInfo {
  after: number
  limit?: number
}

/** 套装 / 服装搜索入参。 */
export interface NikkiSyncSearchQueryInfo {
  query: string
}

// ============ 资产编辑叠加层（sync-integration 阶段4） ============
// 本 App 专有的用户编辑（收藏/评分/标签/备注/分类/套装/场景/隐藏），按 NikkiSync
// `asset_id` 归键存 `asset_edits` 表。它**不是** NikkiSync 协议 DTO，因此这里塑形
// （boolean / string[]），但字段语义与 `MediaFile` 同名项保持一致。

/** `asset-edits:list` 与 `asset-edits:set` 的单条编辑形态。 */
export interface AssetEditsInfo {
  assetId: string
  isFavorite: boolean
  rating: number
  tags: string[]
  notes: string
  categoryId: number | null
  outfit: string | null
  sceneCategory: string | null
  sceneTime: string | null
  isHidden: boolean
  deletedAt: string | null
  updatedAt: string
}

/** `asset-edits:set` 的补丁：全部可选，未给的字段按列默认值落库。 */
export interface AssetEditsPatchInfo {
  isFavorite?: boolean
  rating?: number
  tags?: string[]
  notes?: string
  categoryId?: number | null
  outfit?: string | null
  sceneCategory?: string | null
  sceneTime?: string | null
  isHidden?: boolean
}

// ============ NikkiSync 局域网同步服务（sync-integration 阶段3） ============
// 形状快照自 src/main/nikkisync/runtime-types.ts（NikkiSyncSyncServerStatus 等）；
// 服务本体是上游 NikkiSync 的 LocalSyncServer，本仓只做启停控制与状态展示。

/** `nikkisync:server-status` 响应；`available:false` 表示运行时句柄尚未装配（不抛错）。 */
export interface NikkiSyncServerStatusInfo {
  available: boolean
  running: boolean
  /** 运行中为上游回显地址；未运行时为配置值。 */
  host: string
  port: number
  /** 仅在真实监听时给出。 */
  secure?: boolean
  serverId?: string
  /** 配置意图（上游 mDNS 失败被静默吞掉，因此它不代表广播已生效）。 */
  mdnsEnabled: boolean
  tlsFingerprintSha256?: string
  /** 自签证书 PEM（公开材料，不含私钥）：客户端 pin 指纹之外的第二重核对手段。 */
  serverCertificatePem?: string
  /** 已配对（未撤销）设备数。 */
  pairedDeviceCount?: number
  /** 配对二维码写出的局域网地址；解析不到时为回环。 */
  lanHost?: string
  /** 启停失败原因，端口占用归一化为 `PORT_IN_USE`。 */
  error?: string
  /** K4：连接诊断段（观测面；纯聚合既有状态，不做主动探测）。 */
  diagnostics?: NikkiSyncDiagnosticsInfo
}

/** K4：`server-status.diagnostics` 的形状（主进程 `buildSyncDiagnosticsSnapshot` 产出）。 */
export interface NikkiSyncDiagnosticsInfo {
  running: boolean
  host: string
  port: number
  secure?: boolean
  mdnsEnabled: boolean
  pairedDeviceCount?: number
  /** 完整指纹的尾 8 位摘要。 */
  tlsFingerprintTail8?: string
  /** 备选连接地址（≤8；K5 接线后给出）。 */
  connectionHosts?: string[]
  /** 最近一次启停失败原因（PORT_IN_USE 等）。 */
  lastError?: string
  /** 快照采集时刻（ISO 8601）。 */
  updatedAt: string
}

export interface NikkiSyncSyncStartInputInfo {
  /** 1..65535；上游配置冻结在构造期 ⇒ 改端口会重建会话 */
  port?: number
  mdnsEnabled?: boolean
}

/** 已配对设备的管理视图（不含公钥与凭据哈希）。 */
export interface NikkiSyncPairedDeviceInfo {
  deviceId: string
  deviceName: string
  platform: 'ios' | 'android'
  appVersion?: string
  pairedAt: string
  lastSeenAt: string | null
}

/** `nikkisync:get-pairing-code` 响应：与移植面 `PairingQrInfo` 同形（复用同一 UI 组件）。 */
export interface NikkiSyncPairingCodeInfo {
  /** NS1|serverId|host|port|token|expiresEpochSeconds|tlsFingerprintSha256（多 host 时为 nikki-sync://pair? 查询串） */
  content: string
  expiresAt: string
  serverId: string
  host: string
  port: number
  tlsFingerprintSha256: string
  /** K5：多 host 配对时的备选地址（≤8；单 host NS1 形态缺省）。 */
  hosts?: string[]
}
