// @core-change: 新增自定义安装器启动通道（兼容版本，供覆盖升级使用）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '../../shared/errors/app-error'
import { logger } from '../utils/logger'

/**
 * 兼容版本：自定义安装器启动通道。
 *
 * 背景：后续版本将用自研安装器替代 NSIS 安装/覆盖升级。为了让"当前版本"能先成为
 * 过渡载体，这里提供与 electron-updater 旧行为等价的启动契约：
 *   - 参数固定 `--updated --force-run`（旧客户端/旧安装器也按这组参数调用安装器，安装完自动重启）；
 *   - 安装器只接受本地已存在、非空、以 .exe 结尾的绝对路径；
 *   - 启动后由调用方退出应用（见 auto-update.installWithExternalInstaller）。
 */
export const EXTERNAL_INSTALLER_ARGS = ['--updated', '--force-run'] as const

/** 校验并规范化安装器路径；非法输入抛 AppError（经 handler 转成 IpcError）。 */
export function validateInstallerPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw AppError.validation('安装器路径不能为空')
  }
  const resolved = path.resolve(raw.trim())
  if (path.extname(resolved).toLowerCase() !== '.exe') {
    throw AppError.validation('安装器必须是 .exe 文件', { path: resolved })
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw AppError.notFound('安装器文件不存在', { path: resolved })
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw AppError.validation('安装器路径不是有效文件', { path: resolved })
  }
  return resolved
}

/**
 * 启动外部安装器（detached，不等待退出）。
 * @returns 子进程 pid（拿不到时返回 -1）
 */
export function launchExternalInstaller(installerPath: string, extraArgs: readonly string[] = []): number {
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
