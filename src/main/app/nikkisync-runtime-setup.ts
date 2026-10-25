import { app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { diagLog } from '../utils/startup-diagnostic'
import { electronLogger } from '../utils/logger'
import { buildPackagingContext } from '../nikkisync/embedding-paths'
import { createManagerDependencies, loadLanAddressLister } from '../nikkisync/runtime-facade'
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
import type { NikkiSyncRuntimeHandle, NikkiSyncSessionOptions } from '../nikkisync/runtime-types'
import type { AppContext } from './app-context'

/**
 * NikkiSync 内嵌运行时装配点（整合阶段 2）。
 *
 * 遵守 `src/main/nikkisync/AGENTS.md` 的分工：装载缝只碰 `@nikkisync/*`，
 * 本文件只碰 Electron（userData 路径、设置项、日志、生命周期挂载），
 * 扫描 / 建库 / DTO 一律由上游组件完成。
 *
 * 启动策略（与阶段 5 的同步服务同口径：**默认关闭**，避免与原扫描器常态化争用）：
 * - 环境变量 `NIKKI_NIKKISYNC_RUNTIME=1` 强开（dev / 验证用），`=0` 强关（排障用），优先级高于设置；
 * - 否则读设置项 `nikkisync.runtimeEnabled`（缺省 false）；
 * - 关闭时仍然注册句柄，使 `nikkisync:runtime-status` 始终能给出可读状态，
 *   `nikkisync:start-scan` 也能惰性启动。
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
export const RUNTIME_ENABLED_DEFAULT = false
export const WATCHER_ENABLED_DEFAULT = false
export const METADATA_RESOLVER_ENABLED_DEFAULT = false
export const MULTI_HOST_PAIRING_DEFAULT = false
/** 同步服务默认关闭：与阶段 5 移植面 `SYNC_SERVER_ENABLED_DEFAULT` 同口径。 */
export const SYNC_ENABLED_DEFAULT = false
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
/** 库文件相对 userData 的路径段。 */
export const NIKKISYNC_DB_SEGMENTS = ['nikkisync', 'nikkisync.db'] as const
/** K2：在线解析同意文件相对 userData 的路径段（上游 0600 JSON，读写全在上游）。 */
export const NIKKISYNC_CONSENT_SEGMENTS = ['nikkisync', 'metadata-online-consent.json'] as const
/** K6：额外照片目录清单相对 userData 的路径段（上游 0600 JSON 即单一真相源，不落设置键）。 */
export const NIKKISYNC_EXTRA_DIRECTORIES_SEGMENTS = [
  'nikkisync',
  'extra-scan-directories.json'
] as const

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
  return {
    databaseFile: nikkisyncDatabaseFile(input.userDataDir),
    ...(gameRoot ? { gameRoot } : {}),
    watcher: input.settings.getBoolean(SETTING_WATCHER, WATCHER_ENABLED_DEFAULT),
    // 阶段 6：元数据解析开关。关闭时下游 `createRuntimeSession` 连配置键都不下发，
    // 上游因此不构造 MetadataResolverService ⇒ 零出站请求、零定时器。
    metadataResolverEnabled: resolveMetadataResolverEnabled(input.env, input.settings),
    // K2：同意文件路径（与库同目录；仅解析开启时被消费，fail-closed 由上游构造器承担）
    consentFile: nikkisyncMetadataConsentFile(input.userDataDir),
    // K6：额外目录清单文件（上游 0600 JSON 即单一真相源；未给出时 facade 不挂目录面）
    extraDirectoriesFile: path.join(input.userDataDir, ...NIKKISYNC_EXTRA_DIRECTORIES_SEGMENTS),
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

/** 同步服务自启判定：服务开关隐含 Runtime 开关（不开 Runtime 就没有会话可启服务）。 */
export function resolveSyncEnabled(settings: NikkiSyncSettingsPort): boolean {
  return settings.getBoolean(SETTING_SYNC_ENABLED, SYNC_ENABLED_DEFAULT)
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

/** 双通道日志：diag.log 本机存在静默失败历史，因此同步走 electron-log（阶段 1 既有口径）。 */
function runtimeLog(level: 'info' | 'warn' | 'error', message: string): void {
  diagLog('NIKKISYNC', message)
  try {
    electronLogger[level](`[NIKKISYNC] ${message}`)
  } catch {
    // 日志通道不可用时仅依赖 diagLog，绝不影响启动链
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
  // K5：多 host 配对（默认关）。开启时装载上游 listLanIpv4（仅枚举本机网卡，无子网扫描），
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
  const manager = createRuntimeManager(
    createManagerDependencies(
      sessionOptions,
      (level, message) => runtimeLog(level, message),
      // 配对二维码里要写真实的局域网地址（与移植面同款解析：默认路由优先 + 虚拟网卡过滤）。
      // K5-1① 偏差裁示：配对 host 保留仓内 resolveLanHost（默认路由优先），上游
      // listLanIpv4 仅作备选地址来源——见 04 执行记录偏差表。
      resolveLanHost,
      pairingHostsResolver
    )
  )
  ctx.nikkisyncRuntime = manager

  const syncEnabled = resolveSyncEnabled(settings)
  // 开了同步服务就必须开 Runtime：没有会话就没有可 start() 的上游服务器
  if (!resolveRuntimeEnabled(process.env, settings) && !syncEnabled) {
    runtimeLog('info', `embedded runtime registered but disabled (${options.databaseFile})`)
    return manager
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
  return manager
}

/** 优雅停止（由 app/cleanup.ts 在 dbManager.close 之前调用；未注入即 no-op）。 */
export async function stopNikkiSyncRuntime(ctx: AppContext): Promise<void> {
  const manager = ctx.nikkisyncRuntime
  if (!manager) return
  try {
    await manager.stop()
    runtimeLog('info', 'embedded runtime stopped')
  } catch (error) {
    runtimeLog('warn', `embedded runtime stop failed: ${String(error)}`)
  }
}
