import { invoke } from '@tauri-apps/api/core'
import type { InstallOptions, InstallSummary, InstallerState } from './types'

/** 读取当前安装状态（是否已安装、版本、目录、应用是否在运行、推断模式）。 */
export function detectState(): Promise<InstallerState> {
  return invoke<InstallerState>('detect_state')
}

/** 读取安装进度的最新快照（事件通道不可用时的兜底轮询）。 */
export function getInstallProgress(): Promise<{ percent: number; message: string }> {
  return invoke<{ percent: number; message: string }>('get_install_progress')
}

/** 读取本次安装的日志（逐行）。 */
export function getInstallLog(): Promise<string[]> {
  return invoke<string[]>('get_install_log')
}

/** 执行安装/覆盖升级；返回执行日志。 */
export function startInstall(options: InstallOptions): Promise<InstallSummary> {
  return invoke<InstallSummary>('start_install', { options })
}

/** 取消当前安装任务（协作式）。 */
export function cancelInstall(): Promise<void> {
  return invoke<void>('cancel_install')
}

/** 卸载当前安装。 */
export function uninstall(): Promise<void> {
  return invoke<void>('uninstall')
}

/** 安装完成后启动应用。 */
export function launchApp(): Promise<void> {
  return invoke<void>('launch_app')
}
