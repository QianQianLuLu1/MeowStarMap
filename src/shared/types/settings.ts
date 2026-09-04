/**
 * 应用设置相关共享类型定义
 *
 * 字段与数据库表 app_settings 一一对应。
 * 采用 key-value 结构，value 列存储 JSON 字符串。
 */

import type { ScanOptions } from './media'

// ============================================================================
// 应用设置基础类型（对应 app_settings 表）
// ============================================================================

/**
 * 应用设置数据库行（与 app_settings 表字段一一对应）
 */
export interface AppSettingRow {
  /** 设置项键名（主键） */
  key: string
  /** 设置项值（JSON 字符串） */
  value: string
}

/**
 * 设置项键名枚举
 *
 * 集中管理所有设置项的 key，避免硬编码字符串。
 * 新增设置项时在此枚举中添加。
 */
export type SettingKey =
  | 'theme'
  | 'language'
  | 'thumbnailCacheLimit'
  | 'thumbnailDir'
  | 'databaseDir'
  | 'logDir'
  | 'crashDir'
  | 'backupDir'
  | 'exportDir'
  | 'scanOptions'
  | 'customScanPaths'
  | 'startupAutoScan'
  | 'minimizeToTray'
  | 'closeToTray'
  | 'hardwareAcceleration'
  | 'defaultProfileUid'
  | 'defaultExportFormat'
  | 'defaultExportQuality'
  | 'defaultExportDir'
  | 'defaultWatermarkTemplateId'
  | 'defaultFilterPresetId'
  | 'uiLanguage'
  | 'uiScale'
  | 'sidebarCollapsed'
  | 'gridSize'
  | 'recentFolders'
  | 'lastBackupTime'
  | 'autoBackup'
  | 'autoBackupInterval'
  | 'maxLogSize'
  | 'maxCrashFiles'

/**
 * 主题枚举
 */
export type AppTheme = 'light' | 'dark' | 'auto'

/**
 * 语言枚举
 */
export type AppLanguage = 'zh-CN' | 'en-US'

/**
 * UI 缩放等级
 */
export type UIScale = 'small' | 'medium' | 'large' | 'extra-large'

/**
 * 网格密度
 */
export type GridSize = 'compact' | 'comfortable' | 'spacious'

// ============================================================================
// 设置值类型映射
// ============================================================================

/**
 * 设置项键值类型映射表
 *
 * 用于 getSetting<T> 的类型推断，确保读取的值类型与 key 对应。
 */
export interface SettingKeyMap {
  theme: AppTheme
  language: AppLanguage
  uiLanguage: AppLanguage
  thumbnailCacheLimit: number
  thumbnailDir: string
  databaseDir: string
  logDir: string
  crashDir: string
  backupDir: string
  exportDir: string
  scanOptions: ScanOptions
  customScanPaths: string[]
  startupAutoScan: boolean
  minimizeToTray: boolean
  closeToTray: boolean
  hardwareAcceleration: boolean
  defaultProfileUid: string
  defaultExportFormat: string
  defaultExportQuality: number
  defaultExportDir: string
  defaultWatermarkTemplateId: number | null
  defaultFilterPresetId: string | null
  uiScale: UIScale
  sidebarCollapsed: boolean
  gridSize: GridSize
  recentFolders: string[]
  lastBackupTime: string | null
  autoBackup: boolean
  autoBackupInterval: number
  maxLogSize: number
  maxCrashFiles: number
}

/**
 * 设置项查询结果
 */
export interface SettingEntry<K extends SettingKey = SettingKey> {
  /** 设置项键名 */
  key: K
  /** 设置项值（已解析） */
  value: SettingKeyMap[K]
}

/**
 * 批量设置更新请求
 */
export interface BatchSettingsUpdate {
  /** 待更新的设置项 */
  updates: Array<SettingEntry>
  /** 是否持久化到磁盘 */
  persist?: boolean
}

// ============================================================================
// 备份相关类型
// ============================================================================

/**
 * 备份记录
 */
export interface BackupRecord {
  /** 备份文件路径 */
  path: string
  /** 备份文件名 */
  fileName: string
  /** 备份文件大小（字节） */
  size: number
  /** 备份创建时间（ISO 字符串） */
  createdAt: string
  /** 是否包含缩略图缓存 */
  includesThumbnails: boolean
  /** 是否包含日志 */
  includesLogs: boolean
  /** 数据库行数（备份时的快照） */
  mediaCount: number
}

/**
 * 备份列表结果
 */
export interface BackupListResult {
  /** 备份列表（按创建时间降序） */
  items: BackupRecord[]
  /** 总数 */
  total: number
}

/**
 * 备份创建选项
 */
export interface BackupCreateOptions {
  /** 备份文件名（不含扩展名），默认自动生成 */
  fileName?: string
  /** 输出目录，默认使用 backupDir 设置 */
  outputDir?: string
  /** 是否包含缩略图缓存 */
  includeThumbnails?: boolean
  /** 是否包含日志 */
  includeLogs?: boolean
}

/**
 * 备份恢复选项
 */
export interface BackupRestoreOptions {
  /** 备份文件路径 */
  backupPath: string
  /** 是否覆盖现有数据 */
  overwrite?: boolean
  /** 恢复前是否自动备份当前数据 */
  backupBeforeRestore?: boolean
}

/**
 * 备份恢复结果
 */
export interface BackupRestoreResult {
  /** 是否成功 */
  success: boolean
  /** 恢复的媒体数 */
  restoredMediaCount: number
  /** 恢复的分类数 */
  restoredCategoryCount: number
  /** 恢复的角色档案数 */
  restoredProfileCount: number
  /** 耗时（毫秒） */
  duration: number
  /** 错误信息（失败时） */
  error: string | null
}

// ============================================================================
// 缓存与日志统计
// ============================================================================

/**
 * 缓存统计信息
 */
export interface CacheStats {
  /** 缓存总大小（字节） */
  totalSize: number
  /** 缓存文件数 */
  fileCount: number
  /** 缓存上限（字节） */
  limit: number
  /** 缓存目录 */
  cacheDir: string
}

/**
 * 日志统计信息
 */
export interface LogStats {
  /** 日志文件总大小（字节） */
  totalSize: number
  /** 日志文件数 */
  fileCount: number
  /** 日志目录 */
  logDir: string
  /** 最旧日志时间（ISO 字符串） */
  oldestLogTime: string | null
  /** 最新日志时间（ISO 字符串） */
  newestLogTime: string | null
}

/**
 * 崩溃报告统计信息
 */
export interface CrashStats {
  /** 崩溃报告文件数 */
  fileCount: number
  /** 崩溃报告目录 */
  crashDir: string
  /** 最旧崩溃报告时间 */
  oldestCrashTime: string | null
  /** 最新崩溃报告时间 */
  newestCrashTime: string | null
}

/**
 * 崩溃报告记录
 */
export interface CrashRecord {
  /** 崩溃报告文件路径 */
  path: string
  /** 崩溃报告文件名 */
  fileName: string
  /** 崩溃时间（ISO 字符串） */
  crashTime: string
  /** 崩溃类型（如 'render-process-gone'、'uncaughtException'） */
  crashType: string
  /** 文件大小（字节） */
  size: number
}

// ============================================================================
// 故障诊断类型
// ============================================================================

/**
 * 故障类型枚举
 */
export type FaultType =
  'database' | 'scanner' | 'thumbnail' | 'video' | 'ipc' | 'file' | 'memory' | 'network' | 'unknown'

/**
 * 故障记录
 */
export interface FaultRecord {
  /** 故障类型 */
  type: FaultType
  /** 故障消息 */
  message: string
  /** 发生时间（ISO 字符串） */
  timestamp: string
  /** 故障上下文（不含敏感信息） */
  context: Record<string, string | number | boolean | null>
  /** 堆栈信息（可选） */
  stack?: string
}
