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
  'nikkisync.metadataResolverEnabled',
  // K5：多 host 配对开关（布尔，默认 false，消费点 nikkisync-runtime-setup.ts）。
  // 默认关以保第三方旧客户端只认 NS1 七段串；开启后配对串/服务响应附带备选地址
  // （上游 listLanIpv4，≤8），需手机端 NikkiSync App 支持新格式。
  'nikkisync.multiHostPairing',
  // K8：整理队列（批量删除）开关（布尔，默认 false，消费点 nikkisync-handler.ts 三通道开关门）。
  // 开启后手机端发起的删除意图才可经电脑批准执行（移入 Windows 回收站，可恢复）；
  // 默认关属破坏性能力的双保险之一，关闭时三条通道一律 PRECONDITION_FAILED。
  'nikkisync.organizerEnabled',
  // 软件启动时是否自动启用 LAN 同步服务（默认关，消费点 nikkisync-runtime-setup.ts resolveSyncEnabled）
  'nikkisync.autoStartSyncServer',
  // Windows 外壳能力的 6 个 opt-in 开关（全部默认 false；关闭时零网络、零子进程、零托盘）。
  // 消费点：src/main/app/shell/shell-capabilities.ts 与 nikkisync:shell-* 通道。
  'nikkisync.shellIconUpdateEnabled',
  'nikkisync.shellProgramUpdateEnabled',
  'nikkisync.shellTrayEnabled',
  'nikkisync.shellSupportEnabled',
  'nikkisync.shellNetworkRepairEnabled',
  'nikkisync.shellHotspotEnabled',
  // 开机自启动（默认开，消费点 login-item.ts / settings-handler.ts / lifecycle.ts）
  'launchAtLogin',
  // 外部参考数据镜像站点（总计划阶段 1；空串 = 上游官方站点 nikki.ranaxro.com）。
  // 消费点 reference-data-handler.ts 的 refdata:refresh 读出后转发 reference-data-service；
  // settings:set 内联校验（http/https + 拒绝环回/私网/保留地址）
  'referenceData.manifestBaseUrl',
  // 参考图片加速/镜像入口（阶段 5；空串 = 未配置，走原始地址）。
  // 与上面的 manifest 镜像键**语义不同、不可复用**：本键只替换已授权图片资源
  // （cdn.nikkialbums.com）的取图 host，path/query 原样保留。
  // 消费点 reference-data-handler.ts 的 refdata:resolve-image 读出后转发 reference-image-service，
  // 最终由 services/reference-data/image-url.ts 套用并过 SSRF 守卫。
  // 应用不内置、不代建加速节点——本键是用户自配入口的唯一落点。
  'referenceData.imageMirrorBaseUrl',
  // 外部图片总开关（布尔，默认开启以保持既有行为；关闭后两条链路零网络）。
  // 消费点：src/renderer/utils/resonance/remote-images-enabled.ts（渲染层 flag，
  // 启动时由 main.tsx 读本键同步）+ reference-data-handler.ts（主进程短路）。
  // gongeo #218 授权条件「保持可回滚」的运行时落点。
  'referenceData.remoteImagesEnabled',
  // 参考数据开机自动检查开关（布尔，默认开启；消费点 lifecycle.ts）。
  'referenceData.autoUpdate'
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
  'export.namingPattern': 'export:setNamingPattern',
  // 同步图库照片根目录（空 = 上游自动发现）；读取端 buildSessionOptions，写入只走专用通道
  'nikkisync.gameRoot': 'nikkisync:set-game-root'
} as const
