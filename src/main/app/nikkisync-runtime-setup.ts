import { app } from 'electron'
import path from 'node:path'
import { diagLog } from '../utils/startup-diagnostic'
import { electronLogger } from '../utils/logger'
import { buildPackagingContext } from '../nikkisync/embedding-paths'
import { createManagerDependencies } from '../nikkisync/runtime-facade'
import { createRuntimeManager } from '../nikkisync/runtime-manager'
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
export const RUNTIME_ENABLED_DEFAULT = false
export const WATCHER_ENABLED_DEFAULT = false
/** 同步服务默认关闭：与阶段 5 移植面 `SYNC_SERVER_ENABLED_DEFAULT` 同口径。 */
export const SYNC_ENABLED_DEFAULT = false
/** 环境变量名（dev / 验证强启）。 */
export const RUNTIME_ENV_FLAG = 'NIKKI_NIKKISYNC_RUNTIME'
/** 环境变量名（dev / 验证强指游戏根，与上游 `NIKKISYNC_GAME_ROOT` 区分：这里归宿主管）。 */
export const GAME_ROOT_ENV_FLAG = 'NIKKI_NIKKISYNC_GAME_ROOT'
/** 库文件相对 userData 的路径段。 */
export const NIKKISYNC_DB_SEGMENTS = ['nikkisync', 'nikkisync.db'] as const

/** 设置读取端口（与 `DatabaseManager.getSetting<T>` 对齐，便于注入与单测）。 */
export interface NikkiSyncSettingsPort {
  getBoolean(key: string, fallback: boolean): boolean
  getString(key: string, fallback: string): string
  getNumber(key: string, fallback: number): number
}

export function nikkisyncDatabaseFile(userDataDir: string): string {
  return path.join(userDataDir, ...NIKKISYNC_DB_SEGMENTS)
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
  const settings = settingsFrom(ctx)
  const options = buildSessionOptions({
    userDataDir: app.getPath('userData'),
    projectRoot: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    env: process.env,
    settings
  })
  const manager = createRuntimeManager(
    createManagerDependencies(
      options,
      (level, message) => runtimeLog(level, message),
      // 配对二维码里要写真实的局域网地址（与移植面同款解析：默认路由优先 + 虚拟网卡过滤）
      resolveLanHost
    )
  )
  ctx.nikkisyncRuntime = manager

  const syncEnabled = resolveSyncEnabled(settings)
  // 开了同步服务就必须开 Runtime：没有会话就没有可 start() 的上游服务器
  if (!resolveRuntimeEnabled(process.env, settings) && !syncEnabled) {
    runtimeLog('info', `embedded runtime registered but disabled (${options.databaseFile})`)
    return manager
  }
  const status = await manager.start(options)
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
