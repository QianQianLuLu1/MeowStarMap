/**
 * 插件系统 IPC handler：插件管理
 *
 * 设计目标：
 * - 提供插件管理 IPC（list / install / uninstall / toggle / checkUpdate / update / detail）
 * - 能力桥 IPC 见 `plugin-bridge-handler.ts`
 *
 * 兼容性：不修改任何现有 IPC 通道，所有插件相关通道以 `plugin:` 前缀
 *
 * 复用：
 * - wrapHandler / wrapHandlerNoArgs / wrapHandlerRaw 统一包装器
 */
import { ipcMain } from 'electron'
import fs from 'fs'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs, wrapHandlerRaw, ok } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { pluginHost } from '../../plugins/plugin-host'
import { assertTrustedManagementCaller } from '../../plugins/permission-guard'
import type { PluginFullInfo } from '../../../shared/types/plugin'
import { t } from '../../i18n'

/**
 * 注册插件管理域所有 IPC handler
 *
 * 在 Application.setupIPC() 末尾调用（能力桥紧随其后，见 plugin-bridge-handler.ts）
 */
export function registerPluginManagementHandlers(_ctx: HandlerContext): void {
  /**
   * 列出所有已安装插件（含完整元信息）
   */
  ipcMain.handle(
    'plugin:list',
    wrapHandlerNoArgs(_ctx, () => {
      return pluginHost.getAllPluginFullInfo()
    })
  )

  /**
   * 获取单个插件详情
   */
  ipcMain.handle(
    'plugin:detail',
    wrapHandler(_ctx, z.tuple([z.string().min(1)]), async ([name]) => {
      const info = pluginHost.getPluginFullInfo(name)
      if (!info) {
        throw AppError.notFound(t('main.plugin.error.notFound', { name }))
      }
      return info
    })
  )

  /**
   * 安装插件（npm 包名或 .tgz 文件路径）
   *
   * 安装会执行 npm postinstall 脚本，等价于任意代码执行，
   * 因此调用方必须是主窗口主框架（插件与子框架一律拒绝）。
   */
  ipcMain.handle(
    'plugin:install',
    wrapHandler(
      _ctx,
      z.tuple([z.array(z.string().min(1)).min(1)]),
      async ([specifiers], _c, event) => {
        assertTrustedManagementCaller(event, 'install')
        await pluginHost.installPlugins(specifiers)
        // 返回最新的完整列表，便于 UI 一次性刷新
        return pluginHost.getAllPluginFullInfo()
      }
    )
  )

  /**
   * 卸载插件
   */
  ipcMain.handle(
    'plugin:uninstall',
    wrapHandler(_ctx, z.tuple([z.string().min(1)]), async ([name], _c, event) => {
      assertTrustedManagementCaller(event, 'uninstall')
      await pluginHost.uninstallPlugin(name)
      return pluginHost.getAllPluginFullInfo()
    })
  )

  /**
   * 启用/停用插件
   */
  ipcMain.handle(
    'plugin:toggleActive',
    wrapHandler(
      _ctx,
      z.tuple([z.string().min(1), z.boolean()]),
      async ([name, active], _c, event) => {
        assertTrustedManagementCaller(event, 'toggleActive')
        await pluginHost.toggleActive(name, active)
        if (active) pluginHost.clearPluginError(name)
        const info = pluginHost.getPluginFullInfo(name)
        if (!info) {
          throw AppError.notFound(t('main.plugin.error.notFound', { name }))
        }
        return info
      }
    )
  )

  /**
   * 检查插件更新
   */
  ipcMain.handle(
    'plugin:checkUpdate',
    wrapHandler(_ctx, z.tuple([z.string().min(1)]), async ([name]) => {
      const version = await pluginHost.checkUpdate(name)
      return { name, latestVersion: version }
    })
  )

  /**
   * 更新插件
   *
   * 与 install 同样会拉取并执行远端包脚本，按同等强度校验调用方。
   */
  ipcMain.handle(
    'plugin:update',
    wrapHandler(_ctx, z.tuple([z.string().min(1)]), async ([name], _c, event) => {
      assertTrustedManagementCaller(event, 'update')
      const success = await pluginHost.updatePlugin(name)
      return { name, success }
    })
  )

  /**
   * 获取插件存储目录路径（用于 UI 显示）
   */
  ipcMain.handle(
    'plugin:getPluginsPath',
    wrapHandlerNoArgs(_ctx, () => {
      return pluginHost.getPluginsPath()
    })
  )

  /**
   * 记录插件加载错误（PluginRuntime 在 init 抛异常时通过 IPC 上报）
   */
  ipcMain.handle(
    'plugin:reportError',
    wrapHandlerRaw(_ctx, async (rawArgs) => {
      const [name, errorMessage] = rawArgs as [string, string]
      if (typeof name !== 'string' || typeof errorMessage !== 'string') {
        return ok({ success: false })
      }
      pluginHost.recordPluginError(name, errorMessage)
      return ok({ success: true })
    })
  )
}

/**
 * 判断插件存储目录是否存在（用于 PluginRuntime 启动时检测）
 */
export function isPluginStoreReady(): boolean {
  try {
    const pluginsPath = pluginHost.getPluginsPath()
    return !!pluginsPath && fs.existsSync(pluginsPath)
  } catch {
    return false
  }
}

/**
 * 获取所有插件的完整元信息（供其他模块使用，如启动诊断）
 */
export function listPluginsForDiagnostic(): PluginFullInfo[] {
  return pluginHost.getAllPluginFullInfo()
}
