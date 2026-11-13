import { app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { diagLog } from '../utils/startup-diagnostic'
import { electronLogger } from '../utils/logger'
import { buildPackagingContext } from '../nikkisync/embedding-paths'
import {
  createManagerDependencies,
  loadLanAddressLister,
  setActiveRuntimeSession
} from '../nikkisync/runtime-facade'
import { startPcCompanionServices } from '../nikkisync/pc-companion-services'
import { createRuntimeManager } from '../nikkisync/runtime-manager'
import { resolveMetadataResolverEnabled as resolveMetadataResolverEnabledFlag } from '../nikkisync/metadata-resolver-driver'
import {
  SYNC_SERVER_DEFAULT_HOST,
  SYNC_SERVER_DEFAULT_MDNS,
  SYNC_SERVER_DEFAULT_NAME,
  SYNC_SERVER_DEFAULT_PORT,
  normalizeSyncPort
} from '../nikkisync/sync-server-view'
import { resolveLanHost } from './sync-server-setup'
import { writeAggregateDiagnostic } from './shell/diagnostic-files'
import { disposeTray, syncTray } from './shell/tray-lifecycle'
import { createTray, type TrayElectronApi } from './shell/tray-service'
import type {
  NikkiSyncPcCompanionSwitches,
  NikkiSyncRuntimeHandle,
  NikkiSyncSessionOptions,
  PcCompanionServicesLike
} from '../nikkisync/runtime-types'
import type { AppContext } from './app-context'

/**
 * NikkiSync 内嵌运行时装配点（整合阶段 2）。
 *
 * 遵守 `src/main/nikkisync/AGENTS.md` 的分工：装载缝只碰 `@nikkisync/*`，
 * 本文件只碰 Electron（userData 路径、设置项、日志、生命周期挂载），
 * 扫描 / 建库 / DTO 一律由上游组件完成。
 *
 * 启动策略（对齐上游 PC 端干净安装：**默认全部开启**）：
 * - 环境变量 `NIKKI_NIKKISYNC_RUNTIME=1` 强开（dev / 验证用），`=0` 强关（一键回到旧形态，
 *   同时关掉 LAN 服务与全部 PC 端能力），优先级高于设置；
 * - 否则读设置项 `nikkisync.runtimeEnabled`（缺省 true）；
 * - 关闭时仍然注册句柄，使 `nikkisync:runtime-status` 始终能给出可读状态，
 *   `nikkisync:start-scan` 也能惰性启动。
 * 默认开启会产生扫描 IO、0.0.0.0 监听、mDNS 组播与第三方出站请求；
 * 六个 `NIKKI_NIKKISYNC_*=0` 逃生阀与两个 `enabled:false` 离线 JSON 是回退手段。
 *
 * B6 风险口径（不得因恢复 K2 同意门 fail-closed 而撤销下面五个 `true` 默认值）：
 * 干净安装（无设置 / 无 env）默认全开 ⇒ ① LAN 同步服务监听 `0.0.0.0`；② 发起 mDNS
 * 组播广播；③ 元数据解析能力位开启后，须经 K2 同意门才对第三方端点出站。回退手段：
 * `NIKKI_NIKKISYNC_RUNTIME=0` 全局关、六个 `NIKKI_NIKKISYNC_*=0` 分项关
 * （`PC_COMPANION_ENV_FLAGS` / `METADATA_ENV_FLAG`），以及两份 `enabled:false` 离线 JSON。
 * K2 同意门只约束「用户同意前不得出站」，不改变上述默认开启口径。
 *
 * 库文件落在 `{userData}/nikkisync/nikkisync.db`，**不使用**上游默认的
 * `%LOCALAPPDATA%/NikkiSync`（嵌入态必须与宿主数据目录同源，见计划 §3）。
 */

/** 设置项：内嵌 Runtime 自启开关（缺省关闭）。 */
export const SETTING_RUNTIME_ENABLED = 'nikkisync.runtimeEnabled'
/** 设置项：手工指定游戏安装根（空 = 交给上游 game-directory-discovery）。 */
export const SETTING_GAME_ROOT = 'nikkisync.gameRoot'
/** 设置项：是否启用上游 fs.watch 增量监听（缺省关闭，避免与原扫描器双份 watcher）。 */
export const SETTING_WATCHER = 'nikkisync.watcherEnabled'
/** 设置项：局域网同步服务自启开关（阶段 3，缺省关闭——绑 0.0.0.0 属敏感暴露）。 */
export const SETTING_SYNC_ENABLED = 'nikkisync.syncServerEnabled'
/** 设置项：同步服务端口（阶段 3，缺省取上游桌面版默认 28080）。 */
export const SETTING_SYNC_PORT = 'nikkisync.syncServerPort'
/** 设置项：是否广播 mDNS 服务（阶段 3，缺省跟随上游 `NIKKISYNC_MDNS` 口径=开）。 */
export const SETTING_SYNC_MDNS = 'nikkisync.syncMdnsEnabled'
/**
 * 设置项：是否启用上游远端元数据解析（阶段 6，缺省关）。
 * 一旦为真即产生对第三方端点的出站请求（UID + 照片内嵌参数信封），
 * 因此默认关闭、需用户显式开启；端点值不来自渲染层，由主进程侧常量决定。
 */
export const SETTING_METADATA_RESOLVER = 'nikkisync.metadataResolverEnabled'
/**
 * K5：多 host 配对开关（缺省关）。关闭时配对串逐字节保持 `NS1|` 七段——第三方旧版
 * Android 客户端只认该格式；开启后走 `nikki-sync://pair?` 新格式并附设备可达的备选地址。
 */
export const SETTING_MULTI_HOST_PAIRING = 'nikkisync.multiHostPairing'
/** 上游 PC 端干净安装默认开启；逃生阀为 `NIKKI_NIKKISYNC_RUNTIME=0`。 */
export const RUNTIME_ENABLED_DEFAULT = true
export const WATCHER_ENABLED_DEFAULT = true
export const METADATA_RESOLVER_ENABLED_DEFAULT = true
export const MULTI_HOST_PAIRING_DEFAULT = true
export const SYNC_ENABLED_DEFAULT = true

/** 设置项：软件启动时是否自动启用 LAN 同步服务（必须显式开启，缺省关闭）。 */
export const SETTING_SYNC_AUTOSTART = 'nikkisync.autoStartSyncServer'
export const SYNC_AUTOSTART_DEFAULT = false

/** 设置项：图库数据源（'local' | 'nikkisync'，渲染层 GalleryPage 持久化，缺省 local）。 */
export const SETTING_GALLERY_SOURCE = 'gallery.dataSource'

/** PC 端六个能力的 env 逃生阀（'=0' 单独关闭一项，其他值视为未设置）。 */
export const PC_COMPANION_ENV_FLAGS = {
  remoteBridge: 'NIKKI_NIKKISYNC_REMOTE_BRIDGE',
  metadataDictionary: 'NIKKI_NIKKISYNC_DICTIONARY',
  gameVersionUpdates: 'NIKKI_NIKKISYNC_VERSION_UPDATES',
  runtimeMemoryMaintenance: 'NIKKI_NIKKISYNC_MEMORY_MAINTENANCE',
  wechatGallery: 'NIKKI_NIKKISYNC_WECHAT',
  desktopControl: 'NIKKI_NIKKISYNC_DESKTOP'
} as const

/**
 * 纯函数：把 env 收敛成六个能力位。默认全开；`RUNTIME=0` 一键全关（旧形态）。
 * 只认精确字符串 '0'，脏值不误关也不误开，行为可判定。
 */
export function resolvePcCompanionSwitches(
  env: Record<string, string | undefined>
): NikkiSyncPcCompanionSwitches {
  const runtimeOff = (env[RUNTIME_ENV_FLAG] ?? '').trim() === '0'
  const flagOff = (name: string): boolean => runtimeOff || (env[name] ?? '').trim() === '0'
  return {
    remoteBridge: !flagOff(PC_COMPANION_ENV_FLAGS.remoteBridge),
    metadataDictionary: !flagOff(PC_COMPANION_ENV_FLAGS.metadataDictionary),
    gameVersionUpdates: !flagOff(PC_COMPANION_ENV_FLAGS.gameVersionUpdates),
    runtimeMemoryMaintenance: !flagOff(PC_COMPANION_ENV_FLAGS.runtimeMemoryMaintenance),
    wechatGallery: !flagOff(PC_COMPANION_ENV_FLAGS.wechatGallery),
    desktopControl: !flagOff(PC_COMPANION_ENV_FLAGS.desktopControl)
  }
}
/** 环境变量名（dev / 验证强启）。 */
export const RUNTIME_ENV_FLAG = 'NIKKI_NIKKISYNC_RUNTIME'
/** 环境变量名（dev / 验证强指游戏根，与上游 `NIKKISYNC_GAME_ROOT` 区分：这里归宿主管）。 */
export const GAME_ROOT_ENV_FLAG = 'NIKKI_NIKKISYNC_GAME_ROOT'
/** 环境变量名（阶段 6：元数据解析的强启 / 强关逃生阀，取值同 `RUNTIME_ENV_FLAG` 的 '1' / '0'）。 */
export const METADATA_ENV_FLAG = 'NIKKI_NIKKISYNC_METADATA'
/**
 * K8-a：回收 helper 的环境变量名（与上游 `DeletionQueue.recycleFile` 执行期读取名逐字一致）。
 * 未设置时上游抛 `recycle_unavailable`——删除任务标 failed、绝不退化为永久删除（fail-safe）。
 */
export const RECYCLE_HELPER_ENV = 'NIKKISYNC_RECYCLE_HELPER'
/** K8-a：helper 产物文件名（构建脚本 extraResources filter 与此保持一致）。 */
export const RECYCLE_HELPER_BASENAME = 'nikkisync-recycle-helper.exe'
/** N7：PC 端资源目录（dev 在仓内，打包态在 resourcesPath 下，由 extraResources 搬运）。 */
export function resolvePcAssetsDir(input: {
  isPackaged: boolean
  resourcesPath: string
  projectRoot: string
}): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, 'nikkisync', 'pc')
    : path.join(input.projectRoot, 'resources', 'nikkisync', 'pc')
}

/** 库文件相对 userData 的路径段。 */
export const NIKKISYNC_DB_SEGMENTS = ['nikkisync', 'nikkisync.db'] as const
/** K2：在线解析同意文件相对 userData 的路径段（上游 0600 JSON，读写全在上游）。 */
export const NIKKISYNC_CONSENT_SEGMENTS = ['nikkisync', 'metadata-online-consent.json'] as const
/** K6：额外照片目录清单相对 userData 的路径段（上游 0600 JSON 即单一真相源，不落设置键）。 */
export const NIKKISYNC_EXTRA_DIRECTORIES_SEGMENTS = [
  'nikkisync',
  'extra-scan-directories.json'
] as const
/** N2：上游 PC 端在线解析 / 字典配置与缩略图缓存，全部与库同目录（宿主数据同源）。 */
export const NIKKISYNC_METADATA_RESOLVER_SEGMENTS = ['nikkisync', 'metadata-resolver.json'] as const
export const NIKKISYNC_METADATA_DICTIONARY_REMOTE_SEGMENTS = [
  'nikkisync',
  'metadata-dictionary-remote.json'
] as const
/** G4：本地字典 manifest 与服装名补充（与库同目录，缺省文件即不下传）。 */
export const NIKKISYNC_METADATA_DICTIONARY_SEGMENTS = [
  'nikkisync',
  'metadata-dictionary.json'
] as const
export const NIKKISYNC_METADATA_DICTIONARY_SUPPLEMENT_SEGMENTS = [
  'nikkisync',
  'metadata-dictionary-supplement.json'
] as const
export const NIKKISYNC_METADATA_THUMBNAIL_DIR_SEGMENTS = [
  'nikkisync',
  'metadata-thumbnails'
] as const
/** G3：上游 game-install-root.txt 的本仓等价缓存文件（仅存安装根）。 */
export const NIKKISYNC_GAME_ROOT_CACHE_SEGMENTS = ['nikkisync', 'game-install-root.txt'] as const
/** G6：5 个聚合诊断文件与库同目录。 */
export const NIKKISYNC_DIAGNOSTICS_DIR_SEGMENTS = ['nikkisync'] as const
/** Windows 外壳托盘开关（默认关；关闭时零 Electron Tray 对象）。 */
export const SETTING_SHELL_TRAY = 'nikkisync.shellTrayEnabled'

/** 设置读取端口（与 `DatabaseManager.getSetting<T>` 对齐，便于注入与单测）。 */
export interface NikkiSyncSettingsPort {
  getBoolean(key: string, fallback: boolean): boolean
  getString(key: string, fallback: string): string
  getNumber(key: string, fallback: number): number
}

export function nikkisyncDatabaseFile(userDataDir: string): string {
  return path.join(userDataDir, ...NIKKISYNC_DB_SEGMENTS)
}

/** K2：同意文件路径（仅解析开启时由 facade 消费；未开启时连文件都不创建）。 */
export function nikkisyncMetadataConsentFile(userDataDir: string): string {
  return path.join(userDataDir, ...NIKKISYNC_CONSENT_SEGMENTS)
}

/**
 * K8-a：回收 helper 产物路径（dev=仓内 `resources/nikkisync/`，由
 * `npm run build:recycle-helper` 产出；打包=`{resourcesPath}/nikkisync/`，
 * 由 package.json extraResources 收进安装目录）。
 */
export function resolveRecycleHelperPath(input: {
  isPackaged: boolean
  resourcesPath: string
  projectRoot: string
}): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, 'nikkisync', RECYCLE_HELPER_BASENAME)
    : path.join(input.projectRoot, 'resources', 'nikkisync', RECYCLE_HELPER_BASENAME)
}

/** 自启判定：env 显式取值优先，其余交给设置项。 */
export function resolveRuntimeEnabled(
  env: Record<string, string | undefined>,
  settings: NikkiSyncSettingsPort
): boolean {
  const flag = (env[RUNTIME_ENV_FLAG] ?? '').trim()
  if (flag === '1') return true
  if (flag === '0') return false
  return settings.getBoolean(SETTING_RUNTIME_ENABLED, RUNTIME_ENABLED_DEFAULT)
}

/**
 * 图库数据源漂移兜底：`gallery.dataSource='nikkisync'` 时 Runtime 必须随启动运行——
 * 否则图库取数恒报 "runtime is not ready"，且 `resource-allowlist` 授权表为空导致
 * 导出恒 IPC_PATH_FORBIDDEN（2026-11-10 故障机诊断包实锤的状态漂移）。
 * 与「开了同步服务就必须开 Runtime」同形的 forcing 条件；`RUNTIME=0` 逃生阀优先级不变。
 */
export function shouldForceRuntimeForGallerySource(
  env: Record<string, string | undefined>,
  settings: NikkiSyncSettingsPort
): boolean {
  if ((env[RUNTIME_ENV_FLAG] ?? '').trim() === '0') return false
  return settings.getString(SETTING_GALLERY_SOURCE, 'local') === 'nikkisync'
}

/** 组装会话参数（纯函数：不碰 Electron API，路径与开关全部显式入参）。 */
export function buildSessionOptions(input: {
  userDataDir: string
  projectRoot: string
  isPackaged: boolean
  resourcesPath: string
  env: Record<string, string | undefined>
  settings: NikkiSyncSettingsPort
}): NikkiSyncSessionOptions {
  const gameRoot =
    (input.env[GAME_ROOT_ENV_FLAG] ?? '').trim() ||
    input.settings.getString(SETTING_GAME_ROOT, '').trim()
  // a49764bb：两个本地图标包目录与上游资源同根；打包态由 extraResources 搬到 nikkisync/pc。
  const pcAssetsDir = resolvePcAssetsDir({
    isPackaged: input.isPackaged,
    resourcesPath: input.resourcesPath,
    projectRoot: input.projectRoot
  })
  return {
    databaseFile: nikkisyncDatabaseFile(input.userDataDir),
    ...(gameRoot ? { gameRoot } : {}),
    watcher: input.settings.getBoolean(SETTING_WATCHER, WATCHER_ENABLED_DEFAULT),
    // 阶段 6：元数据解析开关。关闭时下游 `createRuntimeSession` 连配置键都不下发，
    // 上游因此不构造 MetadataResolverService ⇒ 零出站请求、零定时器。
    metadataResolverEnabled: resolveMetadataResolverEnabled(input.env, input.settings),
    // 上游 PC 端能力位：默认全开，env=0 可逐项或整体关闭（对齐 windows-app.ts 干净安装）
    pcCompanion: resolvePcCompanionSwitches(input.env),
    // K2：同意文件路径（与库同目录；仅解析开启时被消费，放行/拒绝由上游构造器按文件状态判定）
    consentFile: nikkisyncMetadataConsentFile(input.userDataDir),
    // K6：额外目录清单文件（上游 0600 JSON 即单一真相源；未给出时 facade 不挂目录面）
    extraDirectoriesFile: path.join(input.userDataDir, ...NIKKISYNC_EXTRA_DIRECTORIES_SEGMENTS),
    // N2：与上游 windows-app.ts 同款的三份配置/缓存落点；`enabled:false` 即离线开关
    metadataResolverFile: path.join(input.userDataDir, ...NIKKISYNC_METADATA_RESOLVER_SEGMENTS),
    metadataDictionaryRemoteFile: path.join(
      input.userDataDir,
      ...NIKKISYNC_METADATA_DICTIONARY_REMOTE_SEGMENTS
    ),
    // G4：只有真实存在本地字典文件时才下传，干净安装不产生无谓 warning。
    ...(existsSync(path.join(input.userDataDir, ...NIKKISYNC_METADATA_DICTIONARY_SEGMENTS))
      ? {
          metadataDictionaryFile: path.join(
            input.userDataDir,
            ...NIKKISYNC_METADATA_DICTIONARY_SEGMENTS
          )
        }
      : {}),
    ...(existsSync(
      path.join(input.userDataDir, ...NIKKISYNC_METADATA_DICTIONARY_SUPPLEMENT_SEGMENTS)
    )
      ? {
          metadataDictionarySupplementFile: path.join(
            input.userDataDir,
            ...NIKKISYNC_METADATA_DICTIONARY_SUPPLEMENT_SEGMENTS
          )
        }
      : {}),
    metadataThumbnailCacheDir: path.join(
      input.userDataDir,
      ...NIKKISYNC_METADATA_THUMBNAIL_DIR_SEGMENTS
    ),
    clothingIconsDir: path.join(pcAssetsDir, 'clothing-icons'),
    photoFilterIconsDir: path.join(pcAssetsDir, 'photo-filter-icons'),
    // 「电脑端优先本地解析照片」：惰性动态 import，构造期不加载 koffi/DLL，
    // 也不把 services 层牵进装载缝的静态依赖图。
    decodeLocalPhotoRawTexts: async (filePath: string, uid: string, sha256: string) =>
      (await import('../services/decryption-service')).decodeLocalPhotoRawTexts(
        filePath,
        uid,
        sha256
      ),
    // G3/G6：聚合诊断落盘缝。失败只 warn，不中断启动/扫描；不含路径/UID/原始异常。
    diagnosticsDir: path.join(input.userDataDir, ...NIKKISYNC_DIAGNOSTICS_DIR_SEGMENTS),
    gameRootCacheFile: path.join(input.userDataDir, ...NIKKISYNC_GAME_ROOT_CACHE_SEGMENTS),
    onDiagnostic: (name: string, payload: unknown) => {
      const result = writeAggregateDiagnostic(
        path.join(input.userDataDir, ...NIKKISYNC_DIAGNOSTICS_DIR_SEGMENTS),
        name,
        payload
      )
      if (!result.ok) {
        runtimeLog('warn', `diagnostic write failed: ${result.reason ?? 'unknown'}`)
      }
    },
    onMetadataWorkSettled: () => {
      const result = writeAggregateDiagnostic(
        path.join(input.userDataDir, ...NIKKISYNC_DIAGNOSTICS_DIR_SEGMENTS),
        'metadata-status.json',
        { settled: true }
      )
      if (!result.ok) {
        runtimeLog('warn', `metadata diagnostic write failed: ${result.reason ?? 'unknown'}`)
      }
    },
    projectRoot: input.projectRoot,
    packagingContext: buildPackagingContext({
      isPackaged: input.isPackaged,
      resourcesPath: input.resourcesPath,
      projectRoot: input.projectRoot
    }),
    // 阶段 3：LAN 配置在构造期就传进去（上游把它冻结在 LocalSyncServer 构造函数里）。
    // 传 mdns:true 不代表会组播——`mdns.start()` 只在 `server.start()` 内被调。
    syncServer: {
      host: SYNC_SERVER_DEFAULT_HOST,
      port: normalizeSyncPort(
        input.settings.getNumber(SETTING_SYNC_PORT, SYNC_SERVER_DEFAULT_PORT),
        SYNC_SERVER_DEFAULT_PORT
      ),
      mdns: input.settings.getBoolean(SETTING_SYNC_MDNS, SYNC_SERVER_DEFAULT_MDNS),
      name: SYNC_SERVER_DEFAULT_NAME
    }
  }
}

/**
 * LAN 同步服务自启判定：读 `nikkisync.autoStartSyncServer`（缺省 false）。
 * `RUNTIME=0` 是全局逃生阀，必须连 LAN 服务一起关掉，否则「回到旧形态」名不副实。
 * `nikkisync.syncServerEnabled` 只表示运行期主开关，不再参与启动期决策。
 */
export function resolveSyncEnabled(
  settings: NikkiSyncSettingsPort,
  env: Record<string, string | undefined> = {}
): boolean {
  if ((env[RUNTIME_ENV_FLAG] ?? '').trim() === '0') return false
  return settings.getBoolean(SETTING_SYNC_AUTOSTART, SYNC_AUTOSTART_DEFAULT)
}

/**
 * 阶段 6：元数据解析开关判定。判据本体在 `metadata-resolver-driver` 的纯函数里
 * （env 只认 '1' / '0'，其余视为未设置；设置值必须是布尔 true），这里只负责取数。
 * `getBoolean` 的类型收敛已经把脏值回落到 fallback，因此非布尔历史值必然判关——
 * 这一条是刻意的：开启即出站请求，绝不能被一条 `'true'` 字符串静默打开。
 */
export function resolveMetadataResolverEnabled(
  env: Record<string, string | undefined>,
  settings: NikkiSyncSettingsPort
): boolean {
  return resolveMetadataResolverEnabledFlag(
    env[METADATA_ENV_FLAG],
    settings.getBoolean(SETTING_METADATA_RESOLVER, METADATA_RESOLVER_ENABLED_DEFAULT)
  )
}

/**
 * 从主进程数据库读设置。得做形态收敛：`app_settings` 历史值可能是别的类型
 * （早期版本写过字符串），而 `getSetting<T>` 的类型守卫只以 defaultValue 作参考，
 * 不可用时必须回退到 fallback，不能把 undefined 直递给调用方（.trim() 即崩）。
 */
function settingsFrom(ctx: AppContext): NikkiSyncSettingsPort {
  return {
    getBoolean: (key, fallback) => {
      const value = ctx.dbManager.getSetting<boolean>(key, fallback)
      return typeof value === 'boolean' ? value : fallback
    },
    getString: (key, fallback) => {
      const value = ctx.dbManager.getSetting<string>(key, fallback)
      return typeof value === 'string' ? value : fallback
    },
    getNumber: (key, fallback) => {
      const value = ctx.dbManager.getSetting<number>(key, fallback)
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }
  }
}

/** N7：本进程装配出的 PC 端服务（供 stopNikkiSyncRuntime 收尾；未装配时为 undefined）。 */
let pcCompanionServices: PcCompanionServicesLike | undefined

/** 双通道日志：diag.log 本机存在静默失败历史，因此同步走 electron-log（阶段 1 既有口径）。 */
function runtimeLog(level: 'info' | 'warn' | 'error', message: string): void {
  diagLog('NIKKISYNC', message)
  try {
    electronLogger[level](`[NIKKISYNC] ${message}`)
  } catch {
    // 日志通道不可用时仅依赖 diagLog，绝不影响启动链
  }
}

/** F2：安静停掉本进程装配出的 PC 端服务（拆除/退出链不得被它卡住；失败只留痕）。 */
async function stopPcCompanionServicesQuietly(reason: string): Promise<void> {
  if (!pcCompanionServices) return
  try {
    await pcCompanionServices.stop()
    runtimeLog('info', `pc companion services stopped (${reason})`)
  } catch (error) {
    runtimeLog('warn', `pc companion services stop failed (${reason}): ${String(error)}`)
  }
  pcCompanionServices = undefined
}

/**
 * F2：PC 端服务（重）装配。会话建成（首启或重建）后从**新鲜** `pcCompanionContext()`
 * 取真实 database / 扫描根 / 配对串——旧会话的这些引用在 dispose 后全部失效；
 * 装配前先停掉残留旧服务。上下文缺席（Runtime 未起 / 老链接缺深入口）只 warn，
 * 绝不抛进启动/拆除链。
 */
async function assemblePcCompanionServices(
  manager: NikkiSyncRuntimeHandle,
  options: NikkiSyncSessionOptions
): Promise<void> {
  await stopPcCompanionServicesQuietly('stale session context')
  manager.pcCompanionServices = undefined
  const liveContext = manager.pcCompanionContext?.()
  if (!liveContext) {
    runtimeLog('warn', 'pc companion services unavailable: session not ready')
    return
  }
  try {
    const switches = options.pcCompanion
    pcCompanionServices = await startPcCompanionServices({
      projectRoot: app.getAppPath(),
      packagingContext: options.packagingContext,
      resourcesDir: resolvePcAssetsDir({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        projectRoot: app.getAppPath()
      }),
      wechatGallery: switches?.wechatGallery === true,
      desktopControl: switches?.desktopControl === true,
      host: () => resolveLanHost(),
      database: liveContext.database,
      scanRoots: liveContext.scanRoots,
      // 4cb71e2（v1.0.31）：微信画廊包装器 / 控制页四面板 / 图标缓存与 LAN 服务端口的
      // 只读透传（同一会话实例，字段缺席即不挂键——上下文侧已按「缺席不伪造」产出）。
      inspirations: liveContext.inspirations,
      deletions: liveContext.deletions,
      extraDirectories: liveContext.extraDirectories,
      accounts: liveContext.accounts,
      thumbnailCache: liveContext.thumbnailCache,
      // a49764bb：本地图标包（与会话同一实例），供画廊侧注入 localClothingIcons
      localClothingIcons: liveContext.localClothingIcons,
      syncPort: liveContext.syncPort,
      pairingUri: () => {
        try {
          return liveContext.pairingUri(resolveLanHost())
        } catch (error) {
          runtimeLog('warn', `pc companion pairing uri unavailable: ${String(error)}`)
          return ''
        }
      },
      log: (level, message) => runtimeLog(level, message)
    })
    if (pcCompanionServices) {
      manager.pcCompanionServices = pcCompanionServices
      runtimeLog('info', `pc companion services started: ${pcCompanionServices.desktopUrl()}`)
    }
  } catch (error) {
    runtimeLog('warn', `pc companion services unavailable: ${String(error)}`)
  }
}

/**
 * 装配内嵌运行时并注入 `ctx.nikkisyncRuntime`。
 * 返回值即状态机句柄；是否自启由 `resolveRuntimeEnabled` 决定。
 * 任何失败都不抛出到启动链之外（由调用方 lifecycle 的 try/catch 二次兜底）。
 */
export async function initNikkiSyncRuntime(ctx: AppContext): Promise<NikkiSyncRuntimeHandle> {
  // K8-a：回收 helper 路径注入（上游 DeletionQueue 执行期读该 env；未设置时上游抛
  // recycle_unavailable，删除任务标 failed、绝不退化为永久删除）。exe 尚未构建
  // （fresh dev 环境未跑 build:recycle-helper）时保持未设置并 warn，可诊断不静默。
  const recycleHelperPath = resolveRecycleHelperPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    projectRoot: app.getAppPath()
  })
  if (existsSync(recycleHelperPath)) {
    process.env[RECYCLE_HELPER_ENV] = recycleHelperPath
  } else {
    runtimeLog(
      'warn',
      `recycle helper not built, organizer deletions will fail safely: expected ${recycleHelperPath}`
    )
  }
  const settings = settingsFrom(ctx)
  // Windows 外壳托盘：默认关 ⇒ 工厂不被调用、不加载 Electron Tray。
  // 开关由用户在同步服务页显式开启；shutdown 时统一 dispose。
  try {
    await syncTray(settings.getBoolean(SETTING_SHELL_TRAY, false), async () => {
      const electron = (await import('electron')) as unknown as TrayElectronApi
      const iconPath = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'icons', 'icon.ico')
        : path.join(app.getAppPath(), 'resources', 'icons', 'icon.ico')
      return createTray({
        iconPath,
        onShow: () => {
          const window = ctx.getMainWindow()
          window?.show()
          window?.focus()
        },
        onQuit: () => app.quit(),
        electron
      })
    })
  } catch (error) {
    // 托盘是可选能力：装配失败只 warn，绝不阻断内嵌 Runtime 启动。
    runtimeLog('warn', `system tray unavailable: ${String(error)}`)
  }
  const options = buildSessionOptions({
    userDataDir: app.getPath('userData'),
    projectRoot: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    env: process.env,
    settings
  })
  let sessionOptions = options
  let pairingHostsResolver: (() => string[]) | undefined
  // K5：多 host 配对（默认开）。开启时装载上游 listLanIpv4（仅枚举本机网卡，无子网扫描），
  // 同时作为配对串的 hosts 来源与 /v1/server 的 connectionHosts 回调；装载失败只降级
  // 单 host（warn 可诊断），绝不影响既有配对路径。
  if (settings.getBoolean(SETTING_MULTI_HOST_PAIRING, MULTI_HOST_PAIRING_DEFAULT)) {
    try {
      pairingHostsResolver = await loadLanAddressLister(options)
      sessionOptions = {
        ...options,
        syncServer: { ...options.syncServer!, connectionHosts: pairingHostsResolver }
      }
    } catch (error) {
      runtimeLog(
        'warn',
        `multi-host pairing disabled (LanAddress deep entry unavailable): ${String(error)}`
      )
    }
  }
  // F2：PC 端服务随会话生命周期重建——旧会话的 database / scanRoots / pairingUri 在
  // dispose 后全部失效。manager 在 teardown（dispose 前）与 start 成功尾部各给一个回调：
  // 先停旧、再从新鲜上下文重装配。回调闭包引用的 manager 变量在运行期已赋值完毕。
  const manager = createRuntimeManager({
    ...createManagerDependencies(
      sessionOptions,
      (level, message) => runtimeLog(level, message),
      // 配对二维码里要写真实的局域网地址（与移植面同款解析：默认路由优先 + 虚拟网卡过滤）。
      // K5-1① 偏差裁示：配对 host 保留仓内 resolveLanHost（默认路由优先），上游
      // listLanIpv4 仅作备选地址来源——见 04 执行记录偏差表。
      resolveLanHost,
      pairingHostsResolver
    ),
    onSessionStopping: async () => {
      await stopPcCompanionServicesQuietly('session teardown')
      manager.pcCompanionServices = undefined
    },
    onSessionStarted: () => assemblePcCompanionServices(manager, options)
  })
  ctx.nikkisyncRuntime = manager

  const syncEnabled = resolveSyncEnabled(settings, process.env)
  const switches = options.pcCompanion
  runtimeLog(
    'info',
    `pc companion switches: runtime=${resolveRuntimeEnabled(process.env, settings)} autostart=${syncEnabled} ` +
      `resolver=${options.metadataResolverEnabled} ` +
      Object.entries(switches ?? {})
        .map(([name, value]) => `${name}=${value}`)
        .join(' ')
  )
  // 开了同步服务就必须开 Runtime：没有会话就没有可 start() 的上游服务器。
  // 图库数据源切到 nikkisync 同样 forcing：取数与导出授权都依赖会话在位。
  const forceForGallery = shouldForceRuntimeForGallerySource(process.env, settings)
  if (!resolveRuntimeEnabled(process.env, settings) && !syncEnabled && !forceForGallery) {
    runtimeLog('info', `embedded runtime registered but disabled (${options.databaseFile})`)
    return manager
  }
  if (forceForGallery) {
    runtimeLog('info', 'embedded runtime forcing start: gallery.dataSource=nikkisync')
  }
  const status = await manager.start(sessionOptions)
  runtimeLog(
    status.state === 'error' ? 'error' : 'info',
    `embedded runtime start result: state=${status.state} linkReady=${status.linkReady} ` +
      `tables=${status.tables?.length ?? 0} error=${status.error ?? 'none'}`
  )
  if (syncEnabled) {
    // 失败不外抛：端口占用等由 startSyncServer 归一化进状态，UI 经 server-status 可见
    const sync = await manager.startSyncServer()
    runtimeLog(
      sync.running ? 'info' : 'warn',
      `sync server autostart: running=${sync.running} port=${sync.port} error=${sync.error ?? 'none'}`
    )
  }
  // C1/F2：PC 端控制页 / 微信画廊的首启装配改由 manager 的 onSessionStarted 回调触发
  // （start() 成功尾部已 await 它完成），本函数不再内联装配。
  return manager
}

/** 优雅停止（由 app/cleanup.ts 在 dbManager.close 之前调用；未注入即 no-op）。 */
export async function stopNikkiSyncRuntime(ctx: AppContext): Promise<void> {
  // Windows 外壳托盘：即使 Runtime 句柄未装配也要销毁，避免托盘图标随进程残留。
  disposeTray()
  // N7：先停 PC 端服务（helper 内每步独立 try/catch，绝不卡住退出链）；即使 Runtime
  // 句柄未装配也要走这一段，避免 listen 的端口随进程残留。
  await stopPcCompanionServicesQuietly('app shutdown')
  // N4：会话拆除后清空活动会话注册表，避免灵感库通道拿到已关库的旧 session
  try {
    setActiveRuntimeSession(undefined)
  } catch {
    // 纯内存赋值，理论不抛；仍不让任何异常影响退出链
  }
  const manager = ctx.nikkisyncRuntime
  if (!manager) return
  try {
    await manager.stop()
    runtimeLog('info', 'embedded runtime stopped')
  } catch (error) {
    runtimeLog('warn', `embedded runtime stop failed: ${String(error)}`)
  }
}
