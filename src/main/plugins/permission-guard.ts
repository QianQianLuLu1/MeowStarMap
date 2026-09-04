/**
 * 插件能力桥权限校验
 *
 * 设计目标：
 * - 在能力桥 IPC handler 调用前校验插件是否声明了对应权限
 * - 越权调用返回 IpcError，不执行实际操作
 * - 路径操作额外走 pathGuard 白名单校验
 *
 * 校验流程：
 *   1. 从 IPC event.senderFrame.url 推断插件来源
 *   2. 从 .plugin-registry.json / 插件目录读取插件的 permissions 清单
 *   3. 校验请求的权限是否在清单内
 *   4. 路径操作额外走 pathGuard 白名单
 */
import path from 'path'
import fs from 'fs'
import type { IpcMainInvokeEvent } from 'electron'
import { AppError } from '../../shared/errors/app-error'
import { pluginHost } from './plugin-host'
import { pathGuard } from '../ipc/validator'
import type { PluginPermission } from '../../shared/types/plugin'

/**
 * plugin:// 协议前缀（pluggable-electron 加载插件时使用的 URL 前缀）
 *
 * 插件入口在渲染进程加载时，import.meta.url / location.href 形如：
 *   plugin://<plugin-name>/index.js
 * 或在 file:// 模式下：
 *   file:///<pluginsPath>/<plugin-name>/index.js
 */
const PLUGIN_URL_PROTOCOL = 'plugin:'

/**
 * 从 IPC event 推断调用方插件名
 *
 * pluggable-electron 在渲染进程加载插件，event.senderFrame.url 包含插件路径
 * 形如：
 *   - plugin://custom-watermark-template/index.js
 *   - file:///C:/Users/.../plugins/custom-watermark-template/index.js
 *
 * 如果无法推断（如来自主窗口非插件代码），返回 null
 */
export function inferPluginName(event: IpcMainInvokeEvent): string | null {
  try {
    // Electron v33+ 起 senderFrame 在 frame detached 时可能为 null
    const frame = event.senderFrame
    if (!frame) return null
    const url = frame.url
    if (!url) return null

    // plugin:// 协议
    if (url.startsWith(PLUGIN_URL_PROTOCOL)) {
      const rest = url.slice(PLUGIN_URL_PROTOCOL.length)
      const slashIdx = rest.indexOf('/')
      if (slashIdx > 0) return rest.slice(0, slashIdx)
      return null
    }

    // file:// 协议：路径中包含 plugins/<plugin-name>/
    if (url.startsWith('file://')) {
      const filePath = decodeURIComponent(url.slice('file://'.length))
      const pluginsPath = pluginHost.getPluginsPath()
      const normalizedPluginsPath = path.resolve(pluginsPath).toLowerCase()
      const normalizedFilePath = path.resolve(filePath).toLowerCase()
      if (normalizedFilePath.startsWith(normalizedPluginsPath + path.sep)) {
        const relative = normalizedFilePath.slice(normalizedPluginsPath.length + 1)
        const slashIdx = relative.indexOf(path.sep)
        if (slashIdx > 0) return relative.slice(0, slashIdx)
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * 校验插件是否声明了指定权限
 *
 * @param event IPC 事件，用于推断调用方插件
 * @param permission 请求的权限标识
 * @throws AppError(forbidden) 当越权或无法推断调用方时
 */
export function assertPluginPermission(
  event: IpcMainInvokeEvent,
  permission: PluginPermission
): void {
  const pluginName = inferPluginName(event)
  if (!pluginName) {
    // 无法推断调用方插件来源：拒绝（保守策略）
    throw AppError.forbidden(`无法识别插件来源，拒绝执行 ${permission} 操作`, { permission })
  }

  const info = pluginHost.getPluginFullInfo(pluginName)
  if (!info) {
    throw AppError.notFound(`插件 ${pluginName} 未在注册表中找到`, { pluginName, permission })
  }

  const declared = info.nikkiGallery?.permissions ?? []
  if (!declared.includes(permission)) {
    throw AppError.forbidden(`插件 ${pluginName} 未声明 ${permission} 权限，拒绝执行`, {
      pluginName,
      permission,
      declared
    })
  }
}

/**
 * 校验插件「管理」操作（安装/卸载/更新/启停）的调用方是否可信
 *
 * 与 assertPluginPermission 的语义相反，不要混用：
 * - assertPluginPermission 用于能力桥：调用方就是插件，校验它声明过该权限
 * - 本函数用于管理通道：调用方必须是应用自身主界面，插件永远无权调用
 *
 * 管理通道不能复用「插件自声明权限」模型 —— 插件只要在自己的 package.json 里
 * 写上 install 权限就能装任意 npm 包（postinstall 即 RCE），等于自授权提权。
 * 因此这里做的是来源校验：只认主窗口的主框架，其余一律拒绝。
 *
 * @param event IPC 事件
 * @param action 操作名，仅用于错误信息与审计日志
 * @throws AppError(forbidden) 当调用方不是主窗口主框架时
 */
export function assertTrustedManagementCaller(event: IpcMainInvokeEvent, action: string): void {
  const mainWindow = pluginHost.getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw AppError.forbidden(`主窗口不可用，拒绝执行插件 ${action} 操作`, { action })
  }

  if (event.sender !== mainWindow.webContents) {
    const pluginName = inferPluginName(event)
    throw AppError.forbidden(`非主窗口调用，拒绝执行插件 ${action} 操作`, {
      action,
      // 能推断出插件名说明是插件在尝试提权，记录下来便于排查
      suspectPlugin: pluginName ?? undefined
    })
  }

  // 子框架（iframe / plugin:// 框架）不可信，只接受主框架
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame) {
    throw AppError.forbidden(`非主框架调用，拒绝执行插件 ${action} 操作`, { action })
  }
}

/**
 * 校验路径是否在 pathGuard 白名单内
 *
 * @param filePath 待校验路径
 * @param op 操作类型
 * @throws AppError(forbidden) 当路径不在白名单内时
 */
export function assertPluginPath(filePath: string, op: 'read' | 'write' = 'write'): void {
  pathGuard.assertAllowed(filePath, op)
}

/**
 * 读取插件目录下的文件路径（pluginName + relativePath 拼接）
 *
 * 用于插件加载自身资源（如 templates/festival.png）
 *
 * @param pluginName 插件名
 * @param relativePath 相对插件根目录的路径
 * @returns 绝对路径
 */
export function resolvePluginAsset(pluginName: string, relativePath: string): string {
  const pluginsPath = pluginHost.getPluginsPath()
  return path.resolve(pluginsPath, pluginName, relativePath)
}

/**
 * 检查插件资源文件是否存在
 */
export function pluginAssetExists(pluginName: string, relativePath: string): boolean {
  try {
    const fullPath = resolvePluginAsset(pluginName, relativePath)
    return fs.existsSync(fullPath)
  } catch {
    return false
  }
}
