// @core-change: 安装器路径校验收紧（绝对路径/拒绝 UNC 与符号链接）并接入 i18n
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '../../shared/errors/app-error'
import { t } from '../i18n'
import { logger } from '../utils/logger'

/**
 * 兼容版本：自定义安装器启动通道（仅供主进程内部调用）。
 *
 * 安全约束（2026-11-25 审查后收紧）：
 *   - 不再通过 IPC 接受渲染层传入的路径；
 *   - 只接受绝对路径，拒绝 UNC 网络路径与符号链接；
 *   - 扩展名必须 .exe、文件存在且非空；
 *   - 参数固定 `--updated --force-run`（旧客户端/旧安装器契约）。
 */
export const EXTERNAL_INSTALLER_ARGS = ['--updated', '--force-run'] as const

/** 校验并规范化安装器路径；非法输入抛 AppError。 */
export function validateInstallerPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw AppError.validation(t('main.externalInstaller.pathRequired'))
  }
  const input = raw.trim()
  if (!path.isAbsolute(input)) {
    throw AppError.validation(t('main.externalInstaller.mustBeAbsolute'), { path: input })
  }
  // UNC 判据走纯字符串形态（与 isBareDirectoryRoot 同口径：不依赖 path 语义、不触盘，
  // Windows 真宿主与 CI posix 装置同判据，无需在 path-semantics-guard 登记）：
  // Windows API 同样接受正斜杠 UNC，`//server/share/x.exe` 与 `\\server\share\x.exe`
  // 指同一个网络共享，只查 `\\` 前缀会放行正斜杠形态（同型绕过见 isBareDirectoryRoot F3）。
  if (input.startsWith('\\\\') || input.startsWith('//')) {
    throw AppError.validation(t('main.externalInstaller.uncNotAllowed'), { path: input })
  }
  const resolved = path.normalize(input)
  if (path.extname(resolved).toLowerCase() !== '.exe') {
    throw AppError.validation(t('main.externalInstaller.mustBeExe'), { path: resolved })
  }

  let linkStat: fs.Stats
  try {
    linkStat = fs.lstatSync(resolved)
  } catch {
    throw AppError.notFound(t('main.externalInstaller.notFound'), { path: resolved })
  }
  if (linkStat.isSymbolicLink()) {
    throw AppError.validation(t('main.externalInstaller.symlinkNotAllowed'), { path: resolved })
  }
  if (!linkStat.isFile() || linkStat.size <= 0) {
    throw AppError.validation(t('main.externalInstaller.invalidFile'), { path: resolved })
  }
  return resolved
}

/**
 * 启动外部安装器（detached，不等待退出）。
 * @returns 子进程 pid（拿不到时返回 -1）
 */
export function launchExternalInstaller(
  installerPath: string,
  extraArgs: readonly string[] = []
): number {
  const resolved = validateInstallerPath(installerPath)
  const args = [...EXTERNAL_INSTALLER_ARGS, ...extraArgs]
  const child = spawn(resolved, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  child.unref()
  logger.info(`[external-installer] 已启动自定义安装器: ${resolved} ${args.join(' ')}`)
  return child.pid ?? -1
}
