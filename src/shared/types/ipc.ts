/**
 * IPC 通信相关共享类型定义
 *
 * 本文件作为 IPC 域类型的统一入口：
 * - 重新导出 ipc-types.ts 中的核心类型（IpcResponse/IpcError/IPC_ERROR_CODES 等）
 * - 补充分享、解密、UI 主题、数据导入等域特定的 IPC 类型
 *
 * 主进程 wrapHandler 自动将 handler 返回值 T 包装为 { success: true, data: T }；
 * handler 抛出 AppError 时包装为 { success: false, error: IpcError }；
 * 渲染进程通过 preload 暴露的 API 获取 IpcResponse<T>，自行检查 success 字段。
 */

// 核心类型从 ipc-types.ts 重新导出，保持单一类型来源
export type { IpcError, IpcResponse, IpcProgress, IpcErrorCode, LegacyIpcResult } from './ipc-types'

export { IPC_ERROR_CODES } from './ipc-types'

// ============================================================================
// 分享功能 IPC 类型
// ============================================================================

/**
 * 分享渠道枚举
 *
 * 对应 share:detectApp / share:launchApp 的目标应用。
 */
export type ShareChannel = 'wechat' | 'qq' | 'vivo-office' | 'wifi' | 'clipboard'

/**
 * 应用运行状态
 */
export type AppStatus = 'running' | 'installed' | 'not-installed'

/**
 * 分享应用检测结果
 */
export interface ShareDetectAppResult {
  /** 是否成功执行检测 */
  success: boolean
  /** 是否已安装 */
  installed: boolean
  /** 是否正在运行 */
  running: boolean
  /** 安装路径（未安装为 null） */
  installPath: string | null
}

/**
 * 分享应用启动结果
 */
export interface ShareLaunchAppResult {
  /** 是否成功启动 */
  success: boolean
  /** 启动的进程 ID */
  pid: number | null
  /** 错误信息（失败时） */
  error: string | null
}

/**
 * WiFi 分享会话
 */
export interface WifiShareSession {
  /** 会话 ID */
  sessionId: string
  /** 服务端口 */
  port: number
  /** 服务地址（如 'http://192.168.1.100:8080'） */
  url: string
  /** 二维码内容（用于扫码连接） */
  qrCode: string
  /** 已连接的客户端数 */
  clientCount: number
  /** 会话创建时间（ISO 字符串） */
  createdAt: string
  /** 会话过期时间（ISO 字符串） */
  expiresAt: string
}

/**
 * WiFi 分享启动结果
 */
export interface ShareStartWifiResult {
  /** 是否成功启动 */
  success: boolean
  /** 分享会话信息 */
  session: WifiShareSession | null
  /** 错误信息（失败时） */
  error: string | null
}

/**
 * 分享请求参数
 */
export interface ShareRequest {
  /** 分享渠道 */
  channel: ShareChannel
  /** 待分享的媒体文件 ID 列表 */
  mediaIds: number[]
  /** 是否附加水印 */
  withWatermark?: boolean
  /** 水印模板 ID（withWatermark=true 时生效） */
  watermarkTemplateId?: number | null
}

// ============================================================================
// 解密功能 IPC 类型
// ============================================================================

/**
 * 媒体参数类型枚举
 *
 * 对应游戏内拍摄照片的解密参数类型。
 */
export type MediaParamType = 'nikki' | 'dressing' | 'photography'

/**
 * 相机基础参数
 */
export interface CameraParams {
  /** 焦距 */
  focalLength: number
  /** 光圈 */
  aperture: number
  /** 快门速度 */
  shutterSpeed: number
  /** ISO */
  iso: number
  /** 曝光补偿 */
  exposureCompensation: number
}

/**
 * 富相机参数（含游戏特有字段）
 */
export interface RichCameraParams extends CameraParams {
  /** 镜头位置 X */
  positionX: number
  /** 镜头位置 Y */
  positionY: number
  /** 镜头位置 Z */
  positionZ: number
  /** 镜头旋转 X */
  rotationX: number
  /** 镜头旋转 Y */
  rotationY: number
  /** 镜头旋转 Z */
  rotationZ: number
  /** 视场角 */
  fov: number
}

/**
 * 摄影信息
 */
export interface PhotographyInfo {
  /** 拍摄时间（ISO 字符串） */
  captureTime: string
  /** 场景名称 */
  scene: string
  /** 时段 */
  timeOfDay: string
  /** 天气 */
  weather: string
  /** 相机参数 */
  camera: RichCameraParams
}

/**
 * Nikki 角色参数
 */
export interface NikkiParams {
  /** 角色姿势 */
  pose: string
  /** 表情 */
  expression: string
  /** 服装套装 */
  outfit: string
  /** 配饰列表 */
  accessories: string[]
}

/**
 * 换装参数
 */
export interface DressingParams {
  /** 头发 */
  hair: string
  /** 上衣 */
  top: string
  /** 下装 */
  bottom: string
  /** 鞋子 */
  shoes: string
  /** 配饰列表 */
  accessories: string[]
}

/**
 * 解密结果
 */
export interface DecryptResult {
  /** 是否成功 */
  success: boolean
  /** 参数类型 */
  paramType: MediaParamType
  /** 摄影信息（paramType='photography' 时存在） */
  photography?: PhotographyInfo
  /** Nikki 参数（paramType='nikki' 时存在） */
  nikki?: NikkiParams
  /** 换装参数（paramType='dressing' 时存在） */
  dressing?: DressingParams
  /** 错误信息（失败时） */
  error: string | null
}

// ============================================================================
// UI 主题与窗口控制 IPC 类型
// ============================================================================

/**
 * UI 主题模式
 */
export type UIThemeMode = 'light' | 'dark' | 'auto'

/**
 * 窗口状态
 */
export type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen'

/**
 * 窗口控制命令
 */
export type WindowCommand = 'minimize' | 'maximize' | 'restore' | 'close' | 'fullscreen-toggle'

/**
 * 窗口信息
 */
export interface WindowInfo {
  /** 是否最大化 */
  isMaximized: boolean
  /** 是否最小化 */
  isMinimized: boolean
  /** 是否全屏 */
  isFullScreen: boolean
  /** 是否可全屏 */
  isFullScreenable: boolean
  /** 窗口状态 */
  state: WindowState
  /** 窗口宽度 */
  width: number
  /** 窗口高度 */
  height: number
  /** X 坐标 */
  x: number
  /** Y 坐标 */
  y: number
}

/**
 * 对话框选项
 */
export interface DialogOptions {
  /** 标题 */
  title: string
  /** 消息内容 */
  message: string
  /** 详情（可选） */
  detail?: string
  /** 按钮文本列表 */
  buttons: string[]
  /** 默认选中按钮索引 */
  defaultId?: number
  /** 取消按钮索引 */
  cancelId?: number
  /** 图标类型 */
  type?: 'none' | 'info' | 'warning' | 'error' | 'question'
}

/**
 * 对话框结果
 */
export interface DialogResult {
  /** 是否被取消 */
  canceled: boolean
  /** 选中按钮的索引 */
  response: number
  /** 复选框状态（如果对话框包含复选框） */
  checkboxChecked?: boolean
}

// ============================================================================
// 数据导入导出 IPC 类型
// ============================================================================

/**
 * 数据导入格式
 */
export type ImportFormat = 'json' | 'csv' | 'zip'

/**
 * 数据导出格式
 */
export type ExportFormat = 'json' | 'csv' | 'zip'

/**
 * 数据导入选项
 */
export interface ImportOptions {
  /** 导入格式 */
  format: ImportFormat
  /** 源文件路径 */
  sourcePath: string
  /** 是否覆盖现有数据 */
  overwrite?: boolean
  /** 导入前是否自动备份 */
  backupBeforeImport?: boolean
}

/**
 * 数据导出选项
 */
export interface ExportOptions {
  /** 导出格式 */
  format: ExportFormat
  /** 输出目录 */
  outputDir: string
  /** 输出文件名（不含扩展名） */
  outputFileName?: string
  /** 是否包含缩略图 */
  includeThumbnails?: boolean
  /** 是否包含日志 */
  includeLogs?: boolean
  /** 导出的媒体 ID 列表，null 表示全部 */
  mediaIds?: number[] | null
}

/**
 * 数据导入结果
 */
export interface ImportResult {
  /** 是否成功 */
  success: boolean
  /** 导入的媒体数 */
  importedMediaCount: number
  /** 导入的分类数 */
  importedCategoryCount: number
  /** 导入的角色档案数 */
  importedProfileCount: number
  /** 跳过的条目数（重复或无效） */
  skippedCount: number
  /** 耗时（毫秒） */
  duration: number
  /** 错误信息（失败时） */
  error: string | null
}

/**
 * 数据导出结果
 */
export interface ExportResult {
  /** 是否成功 */
  success: boolean
  /** 输出文件路径 */
  outputPath: string | null
  /** 输出文件大小（字节） */
  outputSize: number | null
  /** 导出的媒体数 */
  exportedMediaCount: number
  /** 耗时（毫秒） */
  duration: number
  /** 错误信息（失败时） */
  error: string | null
}

// ============================================================================
// 应用信息 IPC 类型
// ============================================================================

/**
 * 应用信息
 */
export interface AppInfo {
  /** 应用名 */
  name: string
  /** 版本号 */
  version: string
  /** Electron 版本 */
  electronVersion: string
  /** Chrome 版本 */
  chromeVersion: string
  /** Node.js 版本 */
  nodeVersion: string
  /** V8 版本 */
  v8Version: string
  /** 应用架构（如 'x64'、'arm64'） */
  arch: string
  /** 操作系统平台 */
  platform: string
  /** 操作系统版本 */
  osVersion: string
  /** 用户数据目录 */
  userDataPath: string
  /** 应用资源目录 */
  resourcesPath: string
  /** 是否打包版本 */
  isPackaged: boolean
}

/**
 * 应用路径信息
 */
export interface AppPaths {
  /** 用户数据目录 */
  userData: string
  /** 应用资源目录 */
  resources: string
  /** 临时目录 */
  temp: string
  /** 桌面目录 */
  desktop: string
  /** 文档目录 */
  documents: string
  /** 下载目录 */
  downloads: string
  /** 图片目录 */
  pictures: string
  /** 视频目录 */
  videos: string
  /** 应用可执行文件路径 */
  exe: string
}

// ============================================================================
// IPC 通道名常量
// ============================================================================

/**
 * IPC 通道名命名规则：<domain>:<action>
 *
 * 渲染进程通过 preload 暴露的 API 调用对应通道，主进程在 handler 中处理。
 */
export const IPC_CHANNELS = {
  // 媒体域
  MEDIA_LIST: 'media:list',
  MEDIA_GET: 'media:get',
  MEDIA_UPDATE: 'media:update',
  MEDIA_DELETE: 'media:delete',
  MEDIA_RESTORE: 'media:restore',
  MEDIA_FAVORITE: 'media:favorite',
  MEDIA_RATE: 'media:rate',
  MEDIA_TAG: 'media:tag',
  MEDIA_DUPLICATES: 'media:duplicates',
  MEDIA_OUTFIT_STATS: 'media:outfitStats',

  // 扫描器域
  SCANNER_START: 'scanner:start',
  SCANNER_CANCEL: 'scanner:cancel',
  SCANNER_STATUS: 'scanner:status',
  SCANNER_COMPLETE: 'scanner:complete',

  // 分类域
  CATEGORY_LIST: 'category:list',
  CATEGORY_CREATE: 'category:create',
  CATEGORY_UPDATE: 'category:update',
  CATEGORY_DELETE: 'category:delete',

  // 角色档案域
  PROFILE_LIST: 'profile:list',
  PROFILE_GET: 'profile:get',
  PROFILE_CREATE: 'profile:create',
  PROFILE_UPDATE: 'profile:update',
  PROFILE_DELETE: 'profile:delete',
  PROFILE_STATS: 'profile:stats',

  // 编辑器域
  EDITOR_SAVE: 'editor:save',
  EDITOR_HISTORY: 'editor:history',
  EDITOR_RESTORE: 'editor:restore',

  // 滤镜预设域
  FILTER_PRESET_LIST: 'filterPreset:list',
  FILTER_PRESET_CREATE: 'filterPreset:create',
  FILTER_PRESET_DELETE: 'filterPreset:delete',

  // 水印域
  WATERMARK_APPLY: 'watermark:apply',
  WATERMARK_TEMPLATE_LIST: 'watermark:list',
  WATERMARK_TEMPLATE_CREATE: 'watermark:create',
  WATERMARK_TEMPLATE_UPDATE: 'watermark:update',
  WATERMARK_TEMPLATE_DELETE: 'watermark:delete',

  // 视频域
  VIDEO_PROBE: 'video:probe',
  VIDEO_EXPORT: 'video:export',
  VIDEO_LIVEPHOTO: 'video:livephoto',

  // 设置域
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_GET_ALL: 'settings:getAll',

  // 分享域
  SHARE_DETECT_APP: 'share:detectApp',
  SHARE_LAUNCH_APP: 'share:launchApp',
  SHARE_START_WIFI: 'share:startWifi',
  SHARE_STOP_WIFI: 'share:stopWifi',

  // 文件域
  FILE_OPEN: 'file:open',
  FILE_SHOW_IN_FOLDER: 'file:showInFolder',
  FILE_COPY: 'file:copy',
  FILE_MOVE: 'file:move',
  FILE_DELETE: 'file:delete',
  FILE_RENAME: 'file:rename',
  FILE_BATCH_OP: 'file:batchOp',

  // 缓存域
  CACHE_STATS: 'cache:stats',
  CACHE_CLEAN: 'cache:clean',
  CACHE_SET_LIMIT: 'cache:setLimit',

  // 备份域
  BACKUP_LIST: 'backup:list',
  BACKUP_CREATE: 'backup:create',
  BACKUP_RESTORE: 'backup:restore',
  BACKUP_DELETE: 'backup:delete',

  // 日志域
  LOG_STATS: 'log:stats',
  LOG_OPEN_DIR: 'log:openDir',
  LOG_CLEAN: 'log:clean',

  // 崩溃报告域
  CRASH_LIST: 'crash:list',
  CRASH_OPEN_DIR: 'crash:openDir',
  CRASH_CLEAN: 'crash:clean',

  // 解密域
  DECRYPT_MEDIA: 'decrypt:media',

  // 缩略图域
  THUMBNAIL_GENERATE: 'thumbnail:generate',

  // UI 主题域
  UI_THEME_GET: 'ui:theme:get',
  UI_THEME_SET: 'ui:theme:set',

  // Shell 域
  SHELL_OPEN_EXTERNAL: 'shell:openExternal',
  SHELL_OPEN_PATH: 'shell:openPath',

  // 对话框域
  DIALOG_SHOW: 'dialog:show',
  DIALOG_SHOW_OPEN: 'dialog:showOpen',
  DIALOG_SHOW_SAVE: 'dialog:showSave',

  // 数据导入导出域
  DATA_IMPORT: 'data:import',
  DATA_EXPORT: 'data:export',

  // 应用域
  APP_INFO: 'app:info',
  APP_PATHS: 'app:paths',
  APP_RELUNCH: 'app:relaunch',
  APP_QUIT: 'app:quit',
  // 自动更新域（复用 electron-updater）
  APP_UPDATE_CHECK: 'app:update:check',
  APP_UPDATE_DOWNLOAD: 'app:update:download',
  APP_UPDATE_INSTALL: 'app:update:install',
  // 主进程 → 渲染端 单向推送通道（webContents.send）
  APP_UPDATE_PUSH: 'app:update',

  // 操作历史域
  OPERATION_HISTORY_LIST: 'operationHistory:list',
  OPERATION_HISTORY_UNDO: 'operationHistory:undo',
  OPERATION_HISTORY_CLEAR: 'operationHistory:clear',

  // 全文搜索域（flexsearch 主引擎，运行在渲染进程；IPC 仅负责数据供给与持久化辅助）
  SEARCH_BUILD_DOCS: 'search:buildDocs', // 批量获取索引文档（启动重建用）
  SEARCH_GET_CAMERA_PARAMS: 'search:getCameraParams', // Phase 2 预留：批量获取拍摄参数
  SEARCH_EXPORT_INDEX: 'search:exportIndex', // 索引持久化到 userData（导出）
  SEARCH_IMPORT_INDEX: 'search:importIndex' // 从 userData 加载索引（导入）
} as const

/**
 * IPC 通道名类型
 */
export type IpcChannelName = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

// ============================================================================
// 全文搜索 IPC 类型
// ============================================================================

/**
 * 索引文档数据库行（仅含搜索所需字段，避免传输完整 MediaRow）
 * id 在 DB 层为 INTEGER，IPC 返回时保持 number；渲染进程按需转 string 与 MediaFile.id 对齐
 */
export interface SearchableDocRow {
  id: number
  file_name: string
  tags: string
  outfit: string
  scene_category: string | null
  notes: string
  indexed_at: string
}

/** search:buildDocs 请求参数 */
export interface SearchBuildDocsOptions {
  /** 仅返回 indexed_at > since 的记录（增量模式）；undefined 表示全量 */
  since?: string
  /** 限制返回数量（分页拉取，避免单次 IPC 传输过大） */
  limit?: number
  /** 分页偏移量 */
  offset?: number
}

/** search:buildDocs 返回结果 */
export interface SearchBuildDocsResult {
  docs: SearchableDocRow[]
  total: number
  hasMore: boolean
}

/** search:exportIndex 请求参数 */
export interface SearchExportIndexOptions {
  segments: Array<{ key: string; data: string }>
}

/** search:importIndex 返回结果 */
export interface SearchImportIndexResult {
  segments: Array<{ key: string; data: string }>
  fileSize: number
  exportedAt: string // ISO 字符串，用于判断是否需要重建
}
