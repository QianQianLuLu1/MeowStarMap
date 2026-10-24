/** 渲染进程可经 settings:set 自由写入的普通偏好 key（安全敏感项不在此列，见 SECURITY 注释） */
export const RENDERER_PREF_KEYS = [
  'uiTheme',
  'autoScanOnStartup',
  'incrementalScan',
  'currentProfileUid',
  'display.fontSize',
  'display.compactMode',
  'display.reduceMotion',
  'display.glassEffect',
  'display.ambientGrain',
  'display.ambientShapes',
  'fileOps.deleteConfirm',
  'fileOps.permanentDoubleConfirm',
  'fileOps.batchThreshold',
  'fileOps.batchThresholdEnabled',
  'fileOps.preferSoftDelete',
  'hardwareAcceleration',
  // 独显优先偏好（'auto' | 'high-performance'，默认 high-performance）：
  // 消费点 src/main/index.ts 启动早期经 gpu-preference.ts 写 Windows GpuPreference 注册表，
  // settings:set 内联值域校验 + gpu-pref.json 镜像双写（启动期同步读取）
  'gpu.discretePreference',
  // sync-integration 阶段4：图库数据源开关（'local' | 'nikkisync'，默认 local）
  // 消费点 src/renderer/pages/GalleryPage.tsx（启动读取）与
  // pages/sync-gallery/SyncServicePage.tsx（写入）
  'gallery.dataSource',
  // sync-integration 阶段5：同步服务自启开关（布尔偏好，消费点 sync-server-setup.ts initSyncServer）
  'sync.serverEnabled',
  // sync-integration 阶段3：真实 NikkiSync LocalSyncServer 的两个开关。
  // syncServerEnabled 隐含 runtimeEnabled（没有会话就没有可 start() 的上游服务器），
  // 因此两者必须一并可写，否则设置页开了服务、下次启动又回到关闭态。
  // 端口不在此列：它是绑定面而非展示偏好，本期只由主进程按默认值/设置表读取，不开放给渲染层写。
  'nikkisync.syncServerEnabled',
  'nikkisync.runtimeEnabled',
  // sync-integration 阶段6：上游远端元数据解析开关（布尔，消费点 nikkisync-runtime-setup.ts）。
  // 只开放布尔键本身：实际请求的端点由主进程侧常量决定，渲染层无法注入任意 URL。
  'nikkisync.metadataResolverEnabled'
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
