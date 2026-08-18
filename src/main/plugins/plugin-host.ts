/**
 * PluginHost 主进程封装
 *
 * 基于 pluggable-electron 核心 init/usePlugins，提供：
 * - 应用启动时初始化插件系统（pluginsPath + confirmInstall 回调）
 * - 持久化注册表的读取与查询（getAllPlugins / getActivePlugins / getPlugin）
 * - 插件安装、激活、停用、卸载的统一入口
 * - 插件完整元信息读取（含 package.json nikkiGallery 字段）
 *
 * 设计原则：
 * - 100% 复用 pluggable-electron，不重新造轮子
 * - 失败容错：单个插件 init 抛异常不影响其他插件
 * - 异步非阻塞：插件加载不阻塞主窗口首屏
 *
 * 兼容性：不修改现有 Application 类，仅在 createMainWindow 前调用 PluginHost.init()
 */
import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import path from 'path'
import fs from 'fs'
import { init as peInit, type pluginManager } from 'pluggable-electron/main'
import { logger } from '../utils/logger'
import { logStartupError } from '../utils/startup-diagnostic'
import type {
  NikkiGalleryManifest,
  PluginFullInfo,
  PluginPermission
} from '../../shared/types/plugin'

/**
 * pluggable-electron 的 Plugin 对象（最小必要字段）
 * 框架内部字段较多，这里仅取本封装需要的部分
 */
interface PePlugin {
  name: string
  version: string
  origin?: string
  url?: string
  main?: string
  activationPoints?: string[]
  active: boolean
  uninstall(): Promise<unknown>
  setActive(active: boolean): unknown
  isUpdateAvailable(): Promise<unknown>
  update(version?: string): boolean
}

/** PluginHost 单例 */
class PluginHost {
  private pluginManager: pluginManager | null = null
  private pluginsPath = ''
  private initialized = false
  /** 插件加载错误记录：插件名 → 错误消息 */
  private pluginErrors = new Map<string, string>()
  /** 主窗口引用（用于 confirmInstall 弹窗父级） */
  private mainWindow: BrowserWindow | null = null

  /**
   * 初始化插件系统
   *
   * 在 Application.initialize() 中、createMainWindow 之前调用
   * - 注册 confirmInstall 回调（弹窗让用户确认安装）
   * - 调用 pe.init 完成 facade 通信与持久化注册表加载
   *
   * @returns 是否初始化成功
   */
  async init(): Promise<boolean> {
    if (this.initialized) return true

    try {
      this.pluginsPath = path.join(app.getPath('userData'), 'plugins')
      // 确保插件目录存在
      if (!fs.existsSync(this.pluginsPath)) {
        fs.mkdirSync(this.pluginsPath, { recursive: true })
      }

      // pe.init 内部完成 facade IPC 通道注册 + 读取 .plugin-registry.json
      // confirmInstall 在用户安装插件时被调用，弹窗让用户确认
      this.pluginManager = peInit({
        pluginsPath: this.pluginsPath,
        confirmInstall: this.confirmInstall,
        useFacade: true
      }) as pluginManager

      // peInit 内部注册了未校验的管理路由，必须紧接着摘除
      this.removeUnguardedFacadeRoutes()

      this.initialized = true
      try {
        logger.info(`[PluginHost] 插件系统已初始化，pluginsPath=${this.pluginsPath}`)
      } catch {}
      return true
    } catch (err) {
      // 初始化失败不阻塞应用启动，仅记录日志
      logStartupError('PluginHost.init', err)
      return false
    }
  }

  /**
   * 摘除 pluggable-electron 自带的未校验管理 IPC 路由
   *
   * pluginMgr/router.js 注册的 pluggable:install / uninstall / update /
   * togglePluginActive 对调用方不做任何校验，其中 install 会执行 npm 包的
   * postinstall 脚本 —— 渲染进程一旦被 XSS 注入，或插件代码拿到该通道，
   * 即构成完整的任意代码执行链。
   *
   * 摘除不影响现有功能：应用 UI 走已加校验的 plugin:* 通道，主进程内部安装
   * 直接调用 pluginManager，两者都不经过这些路由。
   * 只读的 pluggable:getActivePlugins / updatesAvailable 保留，渲染进程
   * 插件运行时 registerActive() 依赖它们。
   */
  private removeUnguardedFacadeRoutes(): void {
    const unguarded = [
      'pluggable:install',
      'pluggable:uninstall',
      'pluggable:update',
      'pluggable:togglePluginActive'
    ]
    for (const channel of unguarded) {
      try {
        ipcMain.removeHandler(channel)
      } catch (err) {
        logStartupError(`PluginHost.removeUnguardedFacadeRoutes(${channel})`, err)
      }
    }
    try {
      logger.info(`[PluginHost] 已摘除未校验的插件管理 IPC 路由：${unguarded.join(', ')}`)
    } catch {}
  }

  /**
   * 设置主窗口引用（用于 confirmInstall 弹窗父级）
   */
  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win
  }

  /**
   * 获取主窗口引用
   *
   * 供 permission-guard 校验插件管理 IPC 的调用方是否来自主窗口
   */
  getMainWindow(): BrowserWindow | null {
    return this.mainWindow
  }

  /**
   * 安装前用户确认回调
   *
   * pluggable-electron 在 installPlugins 时调用此回调
   * 返回 true 继续安装，返回 false 取消安装
   */
  private confirmInstall = async (specifiers: string[]): Promise<boolean> => {
    try {
      const list = specifiers.map((s) => `  • ${s}`).join('\n')
      const parent = this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow : undefined
      const options = {
        type: 'question' as const,
        title: '插件安装确认',
        message: '即将安装以下插件：',
        detail: `${list}\n\n插件拥有您授予的能力权限（如读写文件、应用水印等）。\n仅安装来自可信来源的插件。\n\n是否继续安装？`,
        buttons: ['安装', '取消'],
        // 默认聚焦「取消」：安装会执行 npm postinstall 脚本，等价于任意代码执行。
        // 若默认停在「安装」，连按回车或诱导性弹窗即可无意中放行。
        defaultId: 1,
        cancelId: 1,
        noLink: true
      }
      const result = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options)
      return result.response === 0
    } catch (err) {
      logStartupError('PluginHost.confirmInstall', err)
      return false
    }
  }

  /**
   * 获取插件管理器（pluggable-electron 原生 pluginManager）
   */
  getManager(): pluginManager | null {
    return this.pluginManager
  }

  /**
   * 获取插件存储目录
   */
  getPluginsPath(): string {
    return this.pluginsPath
  }

  /**
   * 获取所有已安装插件（pluggable-electron 原生 Plugin 对象列表）
   */
  getAllPlugins(): PePlugin[] {
    if (!this.pluginManager) return []
    try {
      return this.pluginManager.getAllPlugins() as PePlugin[]
    } catch (err) {
      logStartupError('PluginHost.getAllPlugins', err)
      return []
    }
  }

  /**
   * 获取所有已激活插件
   */
  getActivePlugins(): PePlugin[] {
    if (!this.pluginManager) return []
    try {
      return this.pluginManager.getActivePlugins() as PePlugin[]
    } catch (err) {
      logStartupError('PluginHost.getActivePlugins', err)
      return []
    }
  }

  /**
   * 按名获取插件
   */
  getPlugin(name: string): PePlugin | null {
    if (!this.pluginManager) return null
    try {
      return (this.pluginManager.getPlugin(name) as PePlugin) ?? null
    } catch (err) {
      logStartupError('PluginHost.getPlugin', err)
      return null
    }
  }

  /**
   * 安装插件
   *
   * @param specifiers npm 包名或 .tgz 文件路径数组
   * @returns 安装成功的插件名列表（已转为 PluginFullInfo 的 name 字段），失败抛错
   */
  async installPlugins(specifiers: string[]): Promise<PePlugin[]> {
    if (!this.pluginManager) {
      throw new Error('插件系统未初始化')
    }
    if (specifiers.length === 0) {
      throw new Error('未指定要安装的插件')
    }
    try {
      const installed = (await this.pluginManager.installPlugins(specifiers, true)) as PePlugin[]
      return installed
    } catch (err) {
      logStartupError('PluginHost.installPlugins', err)
      throw err
    }
  }

  /**
   * 卸载插件
   */
  async uninstallPlugin(name: string): Promise<void> {
    const plugin = this.getPlugin(name)
    if (!plugin) {
      throw new Error(`插件 ${name} 不存在`)
    }
    try {
      await plugin.uninstall()
      this.pluginErrors.delete(name)
    } catch (err) {
      logStartupError(`PluginHost.uninstallPlugin(${name})`, err)
      throw err
    }
  }

  /**
   * 启用/停用插件
   *
   * @param name 插件名
   * @param active true=启用 false=停用
   */
  async toggleActive(name: string, active: boolean): Promise<void> {
    const plugin = this.getPlugin(name)
    if (!plugin) {
      throw new Error(`插件 ${name} 不存在`)
    }
    try {
      plugin.setActive(active)
    } catch (err) {
      logStartupError(`PluginHost.toggleActive(${name}, ${active})`, err)
      throw err
    }
  }

  /**
   * 检查插件是否有可用更新
   */
  async checkUpdate(name: string): Promise<string | false> {
    const plugin = this.getPlugin(name)
    if (!plugin) return false
    try {
      const result = await plugin.isUpdateAvailable()
      return result as string | false
    } catch (err) {
      logStartupError(`PluginHost.checkUpdate(${name})`, err)
      return false
    }
  }

  /**
   * 更新插件到指定版本（不指定则更新到最新）
   */
  async updatePlugin(name: string, version?: string): Promise<boolean> {
    const plugin = this.getPlugin(name)
    if (!plugin) return false
    try {
      return plugin.update(version)
    } catch (err) {
      logStartupError(`PluginHost.updatePlugin(${name})`, err)
      return false
    }
  }

  /**
   * 记录插件加载错误（PluginRuntime 在 init 抛异常时调用）
   */
  recordPluginError(name: string, error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error)
    this.pluginErrors.set(name, msg)
  }

  /**
   * 清除插件错误记录
   */
  clearPluginError(name: string): void {
    this.pluginErrors.delete(name)
  }

  /**
   * 获取所有插件的完整元信息（包含 package.json nikkiGallery 字段）
   *
   * 用于插件管理 UI 展示
   */
  getAllPluginFullInfo(): PluginFullInfo[] {
    const plugins = this.getAllPlugins()
    return plugins.map((p) => this.buildPluginFullInfo(p))
  }

  /**
   * 按名获取插件完整元信息
   */
  getPluginFullInfo(name: string): PluginFullInfo | null {
    const plugin = this.getPlugin(name)
    if (!plugin) return null
    return this.buildPluginFullInfo(plugin)
  }

  /**
   * 组装 PluginFullInfo：从插件目录读取 package.json，提取 nikkiGallery 字段
   */
  private buildPluginFullInfo(plugin: PePlugin): PluginFullInfo {
    const info: PluginFullInfo = {
      name: plugin.name,
      version: plugin.version,
      main: plugin.main ?? 'index.js',
      activationPoints: plugin.activationPoints ?? [],
      active: plugin.active,
      error: this.pluginErrors.get(plugin.name)
    }

    // 从插件目录读取 package.json 补充 description / author / license / nikkiGallery
    try {
      const pluginDir = path.join(this.pluginsPath, plugin.name)
      const pkgPath = path.join(pluginDir, 'package.json')
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>
        if (typeof pkg.description === 'string') info.description = pkg.description
        if (pkg.author !== undefined) info.author = pkg.author as PluginFullInfo['author']
        if (typeof pkg.license === 'string') info.license = pkg.license
        if (pkg.nikkiGallery && typeof pkg.nikkiGallery === 'object') {
          info.nikkiGallery = this.validateManifest(pkg.nikkiGallery)
        }
      }
    } catch (err) {
      // package.json 读取失败不阻塞，仅记录
      logStartupError(`PluginHost.buildPluginFullInfo(${plugin.name})`, err)
    }

    return info
  }

  /**
   * 校验并规范化 nikkiGallery 字段
   */
  private validateManifest(raw: unknown): NikkiGalleryManifest | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const obj = raw as Record<string, unknown>
    const engines = typeof obj.engines === 'string' ? obj.engines : ''
    const permissions = Array.isArray(obj.permissions)
      ? (obj.permissions as unknown[]).filter((p): p is PluginPermission => typeof p === 'string')
      : []
    if (!engines) return undefined
    const manifest: NikkiGalleryManifest = { engines, permissions }
    if (Array.isArray(obj.extensionPoints)) {
      manifest.extensionPoints = (obj.extensionPoints as unknown[]).filter(
        (p): p is string => typeof p === 'string'
      )
    }
    if (typeof obj.i18n === 'string') manifest.i18n = obj.i18n
    if (obj.type === 'renderer' || obj.type === 'main-process') manifest.type = obj.type
    return manifest
  }
}

/** PluginHost 单例 */
export const pluginHost = new PluginHost()
