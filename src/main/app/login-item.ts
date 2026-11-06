import { app } from 'electron'
import { diagLog, logStartupError } from '../utils/startup-diagnostic'
import { logger } from '../utils/logger'

/** 设置项：登录 Windows 时是否自动启动本应用（默认开启）。 */
export const SETTING_LAUNCH_AT_LOGIN = 'launchAtLogin'
export const LAUNCH_AT_LOGIN_DEFAULT = true

/** 外部输入（SQLite 历史脏值）一律收敛：非布尔回落到默认开启。 */
export function normalizeLaunchAtLogin(value: unknown): boolean {
  return typeof value === 'boolean' ? value : LAUNCH_AT_LOGIN_DEFAULT
}

/**
 * 把应用内设置同步到 OS 登录项。dev 态只记诊断日志，避免把 electron.exe 写进 Run 项；
 * 系统 API 抛错（策略/权限）不阻塞启动链——设置已持久化，下次启动会重试同步。
 */
export function syncLoginItemSetting(openAtLogin: boolean): void {
  if (app.isPackaged !== true) {
    diagLog('LOGIN', `dev mode: skip login item, desired openAtLogin=${openAtLogin}`)
    logger.info(`[LOGIN] dev mode: skip login item, desired openAtLogin=${openAtLogin}`)
    return
  }
  try {
    app.setLoginItemSettings({ openAtLogin })
    diagLog('LOGIN', `login item synced: openAtLogin=${openAtLogin}`)
    logger.info(`[LOGIN] login item synced: openAtLogin=${openAtLogin}`)
  } catch (err) {
    logStartupError('setLoginItemSettings', err)
    logger.error('[LOGIN] failed to sync login item:', err)
    diagLog('LOGIN', `login item sync failed: ${String(err)}`)
  }
}
