import { app } from 'electron'
import { diagLog, logStartupError } from '../utils/startup-diagnostic'
import { logger } from '../utils/logger'
import { AppError } from '../../shared/errors/app-error'
import {
  SETTING_KEY_LAUNCH_AT_LOGIN,
  LAUNCH_AT_LOGIN_DEFAULT,
  normalizeLaunchAtLoginSetting
} from '../../shared/settings-keys'
import { t } from '../i18n'

// 既有导出名保持不变（lifecycle.ts / 单测已 import），键名真相源下沉到 shared 层
export const SETTING_LAUNCH_AT_LOGIN = SETTING_KEY_LAUNCH_AT_LOGIN
export { LAUNCH_AT_LOGIN_DEFAULT }
export const normalizeLaunchAtLogin = normalizeLaunchAtLoginSetting

/**
 * 当前受管的 Windows Run 值名。Electron 41 的 `Settings.name` 缺省取
 * `AppUserModelId()`；src/main/index.ts 在 whenReady 前调用
 * `setAppUserModelId('com.qianlu.meow-star-map')`，与 package.json 的 build.appId 同源。
 * 由 D5 用例钉住，防止三处漂移。
 */
export const CURRENT_LOGIN_ITEM_NAME = 'com.qianlu.meow-star-map'

/**
 * 人工确认的额外历史值名（补充通道）。常规残留由 detectLegacyLoginItemNames()
 * 依据 OS 读数按 exe 路径精确识别，不在这里猜测值名；本常量留作现场取证确认后
 * 需要强制清理的补充名单。**无确证名单时保持空数组，绝不误删第三方启动项。**
 *
 * 背景：自启功能由 69343e3（2026-11-07）引入，显式 AUMID 由 c7c7c92 才引入，
 * 中间分发的构建写入的是旧默认名；升级后旧名残留，关闭开关只删当前名。
 *
 * 主路径 setLoginItemSettings 不传 name（与 getLoginItemSettings() 默认的
 * AppUserModelId() 值名严格一致，回读校验才有效）；旧名只用 Settings.name 单独删除。
 */
export const LEGACY_LOGIN_ITEM_NAMES: readonly string[] = []

export type LoginItemSyncResult = { synced: true } | { synced: false; skipped: 'dev' }

// 注册表值名合法性：非空、≤256、不含路径分隔符与控制字符
function isValidRegistryValueName(name: unknown): name is string {
  if (typeof name !== 'string') return false
  if (name.length === 0 || name.length > 256) return false
  if (name.includes('\\') || name.includes('/')) return false
  for (const ch of name) {
    if (ch.charCodeAt(0) < 0x20) return false
  }
  return true
}

/** 统一失败出口：留痕后抛 AppError，绝不静默吞掉、绝不谎报成功。 */
function failLoginItemSync(err: unknown): never {
  logStartupError('setLoginItemSettings', err)
  logger.error('[LOGIN] failed to sync login item:', err)
  diagLog('LOGIN', `login item sync failed: ${String(err)}`)
  throw AppError.internal(`[LOGIN] failed to sync login item: ${String(err)}`, undefined, {
    userMessage: t('main.settings.error.launchAtLoginSyncFailed'),
    cause: err
  })
}

/**
 * 读取 OS 登录项当前状态。dev 态不触碰 OS；读失败/非布尔一律返回 undefined，
 * 由调用方保守处理（启动期仍同步一次，写入后校验则判为失败）。
 */
export function readLoginItemOpenAtLogin(): boolean | undefined {
  if (app.isPackaged !== true) return undefined
  try {
    const settings = app.getLoginItemSettings()
    const value: unknown = settings?.openAtLogin
    if (typeof value !== 'boolean') {
      diagLog('LOGIN', 'login item read failed: openAtLogin is not boolean')
      return undefined
    }
    return value
  } catch (err) {
    diagLog('LOGIN', `login item read failed: ${String(err)}`)
    logger.warn('[LOGIN] failed to read login item:', err)
    return undefined
  }
}

/**
 * 规范化注册表里的 exe 路径：去掉包裹引号、统一分隔符与大小写。
 * 非字符串或空串返回 undefined，由调用方拒绝匹配。
 */
function normalizeExePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/^"+|"+$/g, '')
  if (trimmed.length === 0) return undefined
  return trimmed.replace(/\//g, '\\').toLowerCase()
}

/**
 * 从 Electron 官方 `getLoginItemSettings().launchItems` 读数中，按 exe 路径精确识别
 * 本应用的历史残留 Run 值名。只认 user 作用域、指向当前 exe、且不是当前受管名的项；
 * 绝不按猜测值名清理，也不会误删其它应用的启动项。枚举失败只留痕并返回空名单。
 *
 * 局限：升级后安装目录变更时，旧项的 path 不再等于 process.execPath，此时检测不到，
 * 需由现场人工验收清单处理（见开机自启动修复计划 §7）。
 */
export function detectLegacyLoginItemNames(): string[] {
  if (app.isPackaged !== true) return []
  try {
    const settings: unknown = app.getLoginItemSettings()
    const items = (settings as { launchItems?: unknown } | null | undefined)?.launchItems
    if (!Array.isArray(items)) return []
    const ownPath = normalizeExePath(process.execPath)
    if (ownPath === undefined) return []
    return items
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .filter((item) => item.scope === 'user')
      .filter((item) => normalizeExePath(item.path) === ownPath)
      .map((item) => item.name)
      .filter((name): name is string => typeof name === 'string')
      .filter((name) => name !== CURRENT_LOGIN_ITEM_NAME)
  } catch (err) {
    diagLog('LOGIN', `legacy detection failed: ${String(err)}`)
    logger.warn('[LOGIN] failed to detect legacy login items:', err)
    return []
  }
}

/**
 * 清理历史遗留 Run 值名（补偿动作）。dev 态完全不触碰 OS；
 * 每项独立校验与独立兜底，单项失败只留痕、不阻断主设置。
 */
export function cleanupLegacyLoginItemNames(names: readonly string[]): void {
  if (app.isPackaged !== true) return
  for (const name of names) {
    if (!isValidRegistryValueName(name)) {
      diagLog('LOGIN', `legacy cleanup skipped invalid name: ${String(name)}`)
      logger.warn(`[LOGIN] legacy cleanup skipped invalid name: ${String(name)}`)
      continue
    }
    try {
      app.setLoginItemSettings({ openAtLogin: false, name })
      diagLog('LOGIN', `legacy cleanup: name=${name}`)
    } catch (err) {
      diagLog('LOGIN', `legacy cleanup failed: name=${name} err=${String(err)}`)
      logger.warn(`[LOGIN] legacy cleanup failed: name=${name}`, err)
    }
  }
}

/**
 * 把应用内设置同步到 OS 登录项，并回读校验。
 *
 * dev 态只记诊断日志、不写 OS（避免把 electron.exe 写进 Run 项），但返回可区分的
 * skipped 态，不再把「什么都没做」伪装成「已生效」。系统 API 抛错或回读不一致
 * 一律抛 AppError（经 wrapHandler → IpcError → 渲染层回滚），不静默吞掉。
 */
export function syncLoginItemSetting(openAtLogin: boolean): LoginItemSyncResult {
  if (app.isPackaged !== true) {
    diagLog('LOGIN', `dev mode: skip login item, desired openAtLogin=${openAtLogin}`)
    logger.info(`[LOGIN] dev mode: skip login item, desired openAtLogin=${openAtLogin}`)
    return { synced: false, skipped: 'dev' }
  }

  try {
    // 不传 name：与 getLoginItemSettings() 默认 AUMID 值名严格一致
    app.setLoginItemSettings({ openAtLogin })
  } catch (err) {
    return failLoginItemSync(err)
  }

  const actual = readLoginItemOpenAtLogin()
  // 回读不可用（OS 抛错或非布尔）与「明确不一致」是两类失败：分开留痕，便于现场定位，
  // 但两者同样是可感知失败，绝不把无法验证的写入当成成功。
  if (actual === undefined) {
    diagLog(
      'LOGIN',
      `login item read-back unavailable: OS state could not be verified, desired openAtLogin=${openAtLogin}`
    )
    return failLoginItemSync(
      new Error('read-back unavailable: OS state could not be verified after write')
    )
  }
  if (actual !== openAtLogin) {
    return failLoginItemSync(
      new Error(`read-back mismatch: expected ${String(openAtLogin)}, got ${String(actual)}`)
    )
  }

  diagLog('LOGIN', `login item synced: openAtLogin=${openAtLogin}`)
  logger.info(`[LOGIN] login item synced: openAtLogin=${openAtLogin}`)
  // 人工确认名单 + OS 读数动态识别，去重后逐项清理（动态识别不猜测值名）
  cleanupLegacyLoginItemNames([
    ...new Set([...LEGACY_LOGIN_ITEM_NAMES, ...detectLegacyLoginItemNames()])
  ])
  return { synced: true }
}
