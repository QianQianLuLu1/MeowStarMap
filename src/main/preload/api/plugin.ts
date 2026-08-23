// 插件系统管理命名空间：对应主进程 pluginHost 注册的 plugin:* 通道
// （能力桥通过 window.pluginAPI 独立暴露，见 ../plugin-bridge.ts）
import { call } from '../ipc'
import type { PluginFullInfo } from '../../../shared/types/plugin'

/** electronAPI.plugin：插件系统管理（与主进程 pluginHost 通信） */
export const pluginAPI = {
  list: () => call<PluginFullInfo[]>('plugin:list'),
  detail: (name: string) => call<PluginFullInfo>('plugin:detail', name),
  install: (specifiers: string[]) => call<PluginFullInfo[]>('plugin:install', specifiers),
  uninstall: (name: string) => call<PluginFullInfo[]>('plugin:uninstall', name),
  toggleActive: (name: string, active: boolean) =>
    call<PluginFullInfo>('plugin:toggleActive', name, active),
  checkUpdate: (name: string) =>
    call<{ name: string; latestVersion: string | false }>('plugin:checkUpdate', name),
  update: (name: string) => call<{ name: string; success: boolean }>('plugin:update', name),
  getPluginsPath: () => call<string>('plugin:getPluginsPath'),
  reportError: (name: string, errorMessage: string) =>
    call<{ success: boolean }>('plugin:reportError', name, errorMessage)
}
