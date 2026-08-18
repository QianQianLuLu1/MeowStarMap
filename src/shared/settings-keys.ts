/** 渲染进程可经 settings:set 自由写入的普通偏好 key（安全敏感项不在此列，见 SECURITY 注释） */
export const RENDERER_PREF_KEYS = [
  'uiTheme',
  'autoScanOnStartup',
  'incrementalScan',
  'currentProfileUid',
  'display.fontSize',
  'display.compactMode',
  'display.reduceMotion',
  'fileOps.deleteConfirm',
  'fileOps.permanentDoubleConfirm',
  'fileOps.batchThreshold',
  'fileOps.batchThresholdEnabled',
  'fileOps.preferSoftDelete'
] as const

export type RendererPrefKey = (typeof RENDERER_PREF_KEYS)[number]

/**
 * 安全敏感 key：值会影响主进程的路径信任判断或被拼接成文件系统路径。
 * 这些 key 只能由各自的专用通道写入，settings:set 必须拒绝。
 * 列在这里是为了让「拒绝」能给出精确的错误提示（指引调用方改用哪个通道）。
 *
 * 不在此表的特例：
 * - customScanPaths：属安全敏感（写设置即扩权 pathGuard 白名单），但走 settings:set
 *   内联 assertCustomScanPaths 校验，无独立通道，故不列此表（settings-handler 特判放行）。
 * - thumbnailCacheLimitBytes：数值型，不参与路径信任/拼接，不属路径敏感；已有专用通道
 *   cache:setLimit，settings:set 因不在 RENDERER_PREF_KEYS 白名单内直接拒绝。
 */
export const SECURITY_SENSITIVE_KEYS = {
  backupDir: 'backup:setDir',
  thumbnailCacheDir: 'cache:setDir',
  logDir: 'log:setDir',
  crashDir: 'crash:setDir',
  'export.defaultDir': 'export:setDefaultDir',
  'export.namingPattern': 'export:setNamingPattern'
} as const
