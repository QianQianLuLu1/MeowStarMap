import { app, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import { execFile } from 'child_process'
import { logger } from '../utils/logger'
import { logStartupError } from '../utils/startup-diagnostic'
import { t } from '../i18n'

/**
 * 确保桌面快捷方式存在（仅打包环境执行）。
 * NSIS 安装器在覆盖安装等场景下可能未创建桌面快捷方式。
 * 启动时主动检查并补创建，使用 Electron 原生 shell.writeShortcutLink（仅 Windows）。
 */
export async function ensureDesktopShortcut(): Promise<void> {
  // 仅打包环境执行（开发环境不需要桌面快捷方式）
  if (!app.isPackaged) return

  try {
    // F5 修复：显式读注册表自定义桌面路径 + 写权限校验
    // 硬约束：Application must handle custom desktop paths configured via Windows registry
    const desktopPath = await resolveDesktopPath()
    if (!desktopPath) {
      logger.warn(t('main.desktopShortcut.log.noWritableDesktop'))
      return
    }
    // 快捷方式文件名须跨语言保持稳定（与应用名一致），不随 i18n 切换
    const shortcutPath = path.join(desktopPath, '喵星图.lnk') // eslint-disable-line no-restricted-syntax -- 快捷方式文件名须与应用名一致且跨语言稳定，非 UI 文案
    const exePath = app.getPath('exe')

    // P2-A9：快捷方式已存在时校验目标有效性——target 指向的 exe 不存在则重建
    // 修复：原实现仅检查 .lnk 文件存在就跳过，exe 被移动/重命名后快捷方式失效
    if (fs.existsSync(shortcutPath)) {
      try {
        const link = shell.readShortcutLink(shortcutPath)
        if (link.target && fs.existsSync(link.target)) {
          return // 快捷方式有效，跳过
        }
        // target 失效，删除旧快捷方式后重建
        try {
          fs.unlinkSync(shortcutPath)
        } catch {}
      } catch {
        // readShortcutLink 失败（快捷方式损坏），删除后重建
        try {
          fs.unlinkSync(shortcutPath)
        } catch {}
      }
    }

    // F5 修复：shell.writeShortcutLink 返回 false 表示创建失败，fallback 到用户主目录
    // 硬约束：错误必须被处理，不能静默失败
    const shortcutOpts: Electron.ShortcutDetails = {
      target: exePath,
      description: t('main.app.name'),
      icon: exePath,
      iconIndex: 0
    }
    const created = shell.writeShortcutLink(shortcutPath, 'create', shortcutOpts)
    if (created) {
      try {
        logger.info(t('main.desktopShortcut.log.created'))
      } catch {}
      return
    }

    // 桌面不可写或创建失败，fallback 到用户主目录
    logger.warn(t('main.desktopShortcut.log.createFailedFallback'))
    const homePath = app.getPath('home')
    const fallbackPath = path.join(homePath, '喵星图.lnk') // eslint-disable-line no-restricted-syntax -- 快捷方式文件名须与应用名一致且跨语言稳定，非 UI 文案
    const fallbackCreated = shell.writeShortcutLink(fallbackPath, 'create', shortcutOpts)
    if (fallbackCreated) {
      try {
        logger.info(t('main.desktopShortcut.log.createdFallback', { path: homePath }))
      } catch {}
    } else {
      logger.error(t('main.desktopShortcut.log.createFailedAll'))
    }
  } catch (err) {
    logStartupError('ensureDesktopShortcut', err)
  }
}

/**
 * F5 修复：解析可写的桌面路径
 * 优先级：1) 注册表 HKCU\...\Shell Folders\Desktop（处理 OneDrive 重定向 + 自定义桌面路径）
 *         2) app.getPath('desktop')（Electron 内置）
 * 校验：路径必须存在且可写（fs.accessSync W_OK），否则尝试下一个候选
 * 返回：第一个可写的候选路径；全部不可写时返回 null
 */
async function resolveDesktopPath(): Promise<string | null> {
  const candidates: string[] = []

  // 1) 注册表自定义桌面路径（硬约束：Application must handle custom desktop paths configured via Windows registry）
  if (process.platform === 'win32') {
    const regDesktop = await regQueryDesktopPath()
    if (regDesktop) candidates.push(regDesktop)
  }

  // 2) Electron 内置桌面路径作为兜底候选
  try {
    const electronDesktop = app.getPath('desktop')
    if (electronDesktop) candidates.push(electronDesktop)
  } catch {}

  // 选第一个存在且可写的候选路径
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.W_OK)
      return candidate
    } catch {
      // 路径不存在或不可写，尝试下一个候选
    }
  }
  return null
}

/**
 * F5 修复：读取注册表 HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders\Desktop
 * 处理 REG_EXPAND_SZ 类型值（含 %USERPROFILE% 等环境变量，process.cwd 已展开）
 * 未读取到或非 Windows 平台返回 null
 */
function regQueryDesktopPath(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders',
        '/v',
        'Desktop'
      ],
      { timeout: 3000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        const lines = stdout.split(/\r?\n/)
        for (const line of lines) {
          const m = line.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i)
          if (m) {
            resolve(m[1].trim())
            return
          }
        }
        resolve(null)
      }
    )
  })
}
