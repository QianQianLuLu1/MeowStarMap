/**
 * 渲染进程插件运行时封装
 *
 * 设计目标：
 * - 调用 pluggable-electron/renderer 的 setup({ importer }) 完成框架初始化
 * - 注册所有已激活插件（plugins.registerActive()）
 * - 触发 init 激活点，让插件执行 extensionPoints.register(...) 注册扩展
 * - 注入 i18n.t 到能力桥（通过 window.__setPluginI18nT）
 * - 失败容错：单个插件 init 抛异常不影响其他插件与主程序
 *
 * 异步非阻塞：bootstrap 不阻塞首屏渲染，失败仅记录日志
 *
 * 关键设计：pluggable-electron/renderer 通过动态 import 加载，
 * 避免 sandbox 环境下该模块内部 import 'electron' 失败导致整个 bundle 崩溃（白屏）。
 * 在 sandbox + contextIsolation 环境下，渲染进程不能直接 import 'electron'，
 * 只能通过 preload 暴露的 window.electronAPI / window.pluggableElectronIpc 通信。
 */
import type { PluginWatermarkTemplate } from '../../shared/types/plugin'
import { EXTENSION_POINTS } from '../../shared/types/plugin'
// i18n 已在入口静态加载，此处直接静态引用避免"既静态又动态 import"导致拆包失效。
// i18n/index.ts 不 import 本模块，无循环依赖，可安全静态化。
import i18n from '../i18n'

/**
 * pluggable-electron/renderer 的 API 接口
 * 动态加载后存入模块级变量，未加载时为 null
 */
interface PluggableElectronApi {
  setup: (config: { importer: (path: string) => Promise<unknown>; presetEPs?: boolean }) => void
  plugins: {
    registerActive: () => Promise<unknown>
  }
  activationPoints: {
    trigger: (name: string) => Promise<unknown>
  }
  extensionPoints: {
    add: (name: string) => void
    execute: (name: string, input?: unknown) => Promise<unknown>[] | unknown[]
    unregisterAll: (pattern: RegExp) => void
  }
}

let peApi: PluggableElectronApi | null = null

/**
 * 标记 bootstrap 是否已完成
 * 避免重复初始化（React StrictMode 下 useEffect 会执行两次）
 */
let bootstrapped = false
let bootstrapping: Promise<void> | null = null

/**
 * 动态 import 插件入口
 *
 * pluggable-electron 在 registerActive() / trigger() 时通过此 importer 加载插件入口文件
 *
 * 实现说明：
 * - 用 @vite-ignore 注释让 Vite 跳过构建时模块解析，运行时才解析该路径
 * - 不能改回 new Function('return import(path)')：CSP 的 script-src 未开 'unsafe-eval'，
 *   构造器会抛 EvalError；且该语句在模块顶层，会连带整个 bundle 求值失败导致白屏
 */
const pluginImporter = async (entryPoint: string): Promise<unknown> => {
  try {
    const mod = await import(/* @vite-ignore */ entryPoint)
    return mod
  } catch (err) {
    console.error(`[PluginRuntime] 插件入口加载失败: ${entryPoint}`, err)
    throw err
  }
}

/**
 * 初始化插件系统
 *
 * 在 App.tsx 启动 useEffect 中调用，不阻塞首屏渲染
 *
 * 流程：
 *   1. 动态加载 pluggable-electron/renderer
 *   2. pe.setup({ importer })           ← 框架原生初始化
 *   3. plugins.registerActive()         ← 注册已持久化插件
 *   4. activationPoints.trigger('init') ← 触发 init 激活点
 *
 * 失败容错：
 *   - 任何步骤抛异常都不影响主程序运行
 *   - 单个插件 init 抛异常不影响其他插件
 */
export async function bootstrapPluginRuntime(): Promise<void> {
  if (bootstrapped || bootstrapping) return bootstrapping ?? Promise.resolve()
  bootstrapping = doBootstrap().finally(() => {
    bootstrapped = true
    bootstrapping = null
  })
  return bootstrapping
}

async function doBootstrap(): Promise<void> {
  // 检测 facade 是否就绪（preload 加载失败时不初始化）
  if (typeof window === 'undefined' || !window.pluggableElectronIpc) {
    console.warn(i18n.t('plugins.log.facadeNotReady'))
    return
  }

  try {
    // 动态加载 pluggable-electron/renderer
    // sandbox 环境下该模块内部 import 'electron' 可能失败，用 try/catch 兜底
    const mod = await import('pluggable-electron/renderer')
    const api: PluggableElectronApi = {
      setup: mod.setup,
      plugins: mod.plugins,
      activationPoints: mod.activationPoints,
      extensionPoints: mod.extensionPoints
    }
    peApi = api

    // 注入 i18n.t 到能力桥（复用 i18next 实例）
    injectI18n()

    // ① 框架初始化：注册 importer
    // presetEPs: false 表示扩展点可在运行时动态创建（无需预先定义）
    api.setup({ importer: pluginImporter, presetEPs: false })

    // ② 预先创建 6 个业务扩展点（确保消费者 execute 时不会因扩展点不存在而异常）
    Object.values(EXTENSION_POINTS).forEach((name) => {
      try {
        api.extensionPoints.add(name as string)
      } catch {
        // 扩展点可能已存在，忽略
      }
    })

    // ③ 注册所有已激活插件（从 .plugin-registry.json 读取）
    try {
      await api.plugins.registerActive()
    } catch (err) {
      console.error(i18n.t('plugins.log.registerActiveFailed'), err)
    }

    // ④ 触发 init 激活点：插件在此调用 extensionPoints.register 注册扩展
    // 失败容错：单个插件 init 抛异常被框架捕获，不影响其他插件
    try {
      await api.activationPoints.trigger('init')
    } catch (err) {
      console.error(i18n.t('plugins.log.triggerInitFailed'), err)
    }
  } catch (err) {
    console.error(i18n.t('plugins.log.bootstrapFailed'), err)
  }
}

/**
 * 注入 i18next.t 到能力桥
 *
 * 复用渲染进程的 i18next 实例，让插件能通过 window.pluginAPI.i18n.t(key) 翻译
 */
function injectI18n(): void {
  try {
    // i18n 已静态加载，直接复用实例注入到能力桥
    if (window.__setPluginI18nT) {
      window.__setPluginI18nT(
        (key: string, options?: Record<string, unknown>) =>
          i18n.t(key, options as never) as unknown as string
      )
    }
  } catch (err) {
    console.warn(i18n.t('plugins.log.i18nInjectFailed'), err)
  }
}

// ============ 扩展点消费辅助 hook ============

/**
 * 同步执行扩展点并收集结果（用于一次性获取扩展响应）
 *
 * @param extensionPointName 扩展点名称
 * @param input 传入扩展的参数（如果扩展是函数）
 * @returns 所有扩展的非空响应数组
 *
 * @example
 * const templates = executeExtensions<PluginWatermarkTemplate>(
 *   EXTENSION_POINTS.WATERMARK_TEMPLATE
 * )
 */
export function executeExtensions<T>(extensionPointName: string, input?: unknown): T[] {
  if (!peApi) {
    return []
  }
  try {
    const results = peApi.extensionPoints.execute(extensionPointName, input)
    // execute 返回数组，元素可能是 Promise（异步扩展）或值
    return results.filter((r): r is T => (r != null && typeof r !== 'object') || r !== null) as T[]
  } catch (err) {
    console.error(`[PluginRuntime] executeExtensions(${extensionPointName}) 失败:`, err)
    return []
  }
}

/**
 * 异步执行扩展点并等待所有结果
 *
 * 使用 Promise.allSettled 包装，丢弃失败扩展的返回值
 *
 * @example
 * const templates = await executeExtensionsAsync<PluginWatermarkTemplate>(
 *   EXTENSION_POINTS.WATERMARK_TEMPLATE
 * )
 */
export async function executeExtensionsAsync<T>(
  extensionPointName: string,
  input?: unknown
): Promise<T[]> {
  if (!peApi) {
    return []
  }
  try {
    const results = peApi.extensionPoints.execute(extensionPointName, input)
    const settled = await Promise.allSettled(results)
    return settled
      .filter((r): r is PromiseFulfilledResult<T> => r.status === 'fulfilled' && r.value != null)
      .map((r) => r.value)
  } catch (err) {
    console.error(`[PluginRuntime] executeExtensionsAsync(${extensionPointName}) 失败:`, err)
    return []
  }
}

/**
 * 停用插件时清理其注册的扩展
 *
 * 约定：插件注册扩展时使用 'pluginName:extName' 命名空间前缀
 * 停用时调用 extensionPoints.unregisterAll(/^pluginName:/) 批量清理
 */
export function cleanupPluginExtensions(pluginName: string): void {
  if (!peApi) {
    return
  }
  try {
    const pattern = new RegExp(`^${escapeRegExp(pluginName)}:`)
    peApi.extensionPoints.unregisterAll(pattern)
  } catch (err) {
    console.error(`[PluginRuntime] cleanupPluginExtensions(${pluginName}) 失败:`, err)
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 获取水印模板扩展点的所有模板（便捷方法）
 */
export async function getPluginWatermarkTemplates(): Promise<PluginWatermarkTemplate[]> {
  return executeExtensionsAsync<PluginWatermarkTemplate>(EXTENSION_POINTS.WATERMARK_TEMPLATE)
}
