/**
 * 插件管理 store
 *
 * 设计目标：
 * - 集中管理已安装插件列表、加载状态、操作状态
 * - 通过 window.electronAPI.plugin.* IPC 与主进程 PluginHost 通信
 * - UI 组件订阅 store，无需直接调用 IPC
 *
 * 复用：
 * - zustand 状态管理（项目既有依赖）
 * - 主进程 IPC 通道 plugin:list / install / uninstall / toggleActive / detail
 */
import { create } from 'zustand'
import type { PluginFullInfo } from '../../shared/types/plugin'

// ============ 插件 IPC 接口 ============
// preload 中 electronAPI.plugin 命名空间定义（此处独立声明，避免 preload 全量类型导入）
interface PluginIPC {
  list: () => Promise<PluginFullInfo[]>
  detail: (name: string) => Promise<PluginFullInfo>
  install: (specifiers: string[]) => Promise<PluginFullInfo[]>
  uninstall: (name: string) => Promise<PluginFullInfo[]>
  toggleActive: (name: string, active: boolean) => Promise<PluginFullInfo>
  checkUpdate: (name: string) => Promise<{ name: string; latestVersion: string | false }>
  update: (name: string) => Promise<{ name: string; success: boolean }>
  getPluginsPath: () => Promise<string>
  reportError: (name: string, errorMessage: string) => Promise<{ success: boolean }>
}

interface PluginIPCWindow {
  plugin?: PluginIPC
}

function getPluginIPC(): PluginIPC | null {
  const w = window as unknown as PluginIPCWindow
  return w.plugin ?? null
}

// ============ Store 类型定义 ============

interface PluginState {
  /** 已安装插件完整列表（含元信息） */
  plugins: PluginFullInfo[]
  /** 是否正在加载插件列表 */
  loading: boolean
  /** 加载/操作错误信息（null 表示无错误） */
  error: string | null
  /** 插件存储目录路径（用于 UI 展示） */
  pluginsPath: string
  /** 正在执行操作的插件名（防止重复点击） */
  operatingName: string | null
  /** 正在执行的操作类型 */
  operatingAction: 'install' | 'uninstall' | 'toggle' | 'update' | null

  /** 加载插件列表 */
  loadPlugins: () => Promise<void>
  /** 加载插件存储目录路径 */
  loadPluginsPath: () => Promise<void>
  /** 安装插件 */
  installPlugin: (specifier: string) => Promise<boolean>
  /** 卸载插件 */
  uninstallPlugin: (name: string) => Promise<boolean>
  /** 启用/停用插件 */
  togglePlugin: (name: string, active: boolean) => Promise<boolean>
  /** 检查插件更新 */
  checkUpdate: (name: string) => Promise<string | false>
  /** 更新插件 */
  updatePlugin: (name: string) => Promise<boolean>
  /** 重置错误状态 */
  clearError: () => void
}

// ============ Store 实现 ============

export const usePluginStore = create<PluginState>((set, get) => ({
  plugins: [],
  loading: false,
  error: null,
  pluginsPath: '',
  operatingName: null,
  operatingAction: null,

  loadPlugins: async () => {
    const ipc = getPluginIPC()
    if (!ipc) {
      // 预览版无 IPC，静默返回
      set({ plugins: [], loading: false, error: null })
      return
    }
    set({ loading: true, error: null })
    try {
      const list = await ipc.list()
      set({ plugins: list, loading: false })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ loading: false, error: msg })
    }
  },

  loadPluginsPath: async () => {
    const ipc = getPluginIPC()
    if (!ipc) return
    try {
      const p = await ipc.getPluginsPath()
      set({ pluginsPath: p })
    } catch {
      // 路径获取失败不阻塞列表加载
    }
  },

  installPlugin: async (specifier) => {
    const ipc = getPluginIPC()
    if (!ipc) {
      set({ error: '插件系统不可用（预览版无 IPC）' })
      return false
    }
    set({ operatingName: specifier, operatingAction: 'install', error: null })
    try {
      const list = await ipc.install([specifier])
      set({ plugins: list, operatingName: null, operatingAction: null })
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ operatingName: null, operatingAction: null, error: msg })
      return false
    }
  },

  uninstallPlugin: async (name) => {
    const ipc = getPluginIPC()
    if (!ipc) return false
    set({ operatingName: name, operatingAction: 'uninstall', error: null })
    try {
      const list = await ipc.uninstall(name)
      set({ plugins: list, operatingName: null, operatingAction: null })
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ operatingName: null, operatingAction: null, error: msg })
      return false
    }
  },

  togglePlugin: async (name, active) => {
    const ipc = getPluginIPC()
    if (!ipc) return false
    set({ operatingName: name, operatingAction: 'toggle', error: null })
    try {
      const info = await ipc.toggleActive(name, active)
      // 更新单条插件信息，避免全量刷新
      set((state) => ({
        plugins: state.plugins.map((p) => (p.name === name ? info : p)),
        operatingName: null,
        operatingAction: null
      }))
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ operatingName: null, operatingAction: null, error: msg })
      return false
    }
  },

  checkUpdate: async (name) => {
    const ipc = getPluginIPC()
    if (!ipc) return false
    try {
      const res = await ipc.checkUpdate(name)
      return res.latestVersion
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg })
      return false
    }
  },

  updatePlugin: async (name) => {
    const ipc = getPluginIPC()
    if (!ipc) return false
    set({ operatingName: name, operatingAction: 'update', error: null })
    try {
      const res = await ipc.update(name)
      if (res.success) {
        // 更新成功后重新加载列表
        await get().loadPlugins()
      }
      set({ operatingName: null, operatingAction: null })
      return res.success
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ operatingName: null, operatingAction: null, error: msg })
      return false
    }
  },

  clearError: () => set({ error: null })
}))
