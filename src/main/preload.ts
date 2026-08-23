/**
 * preload 入口：装配各命名空间模块并暴露到渲染进程
 *
 * 结构说明（2026-08 命名空间化拆分重构，原单体文件约 1176 行）：
 * - IPC 基础层（IpcError 类 / call<T> 解包 / subscribe 订阅）→ ./preload/ipc.ts
 * - electronAPI 各命名空间按功能域拆分 → ./preload/api/*.ts（每文件导出 <key>API 对象）
 * - 插件能力桥（window.pluginAPI）与 i18n.t 注入点 → ./preload/plugin-bridge.ts
 * - 业务 DTO 类型快照 → src/shared/types/electron-api.ts（preload 层不再内联类型定义）
 * 本文件只做装配与 contextBridge 暴露；对外契约（全局名 / 方法签名 / 通道字符串）保持不变。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { preloadLogger } from './preload-logger'
import { IpcError } from './preload/ipc'
import { pluginBridgeAPI, setPluginI18nT } from './preload/plugin-bridge'
import { scannerAPI } from './preload/api/scanner'
import { fileAPI } from './preload/api/file'
import { editorAPI } from './preload/api/editor'
import { watermarkAPI } from './preload/api/watermark'
import { categoryAPI } from './preload/api/category'
import { mediaActionAPI } from './preload/api/media-action'
import { videoAPI } from './preload/api/video'
import { dialogAPI } from './preload/api/dialog'
import { thumbnailAPI } from './preload/api/thumbnail'
import { mediaAPI } from './preload/api/media'
import { profileAPI } from './preload/api/profile'
import { uiThemeAPI } from './preload/api/ui-theme'
import { shellAPI } from './preload/api/shell'
import { settingsAPI } from './preload/api/settings'
import { exportAPI } from './preload/api/export'
import { dataAPI } from './preload/api/data'
import { backupAPI } from './preload/api/backup'
import { shareAPI } from './preload/api/share'
import { cacheAPI } from './preload/api/cache'
import { logAPI } from './preload/api/log'
import { crashAPI } from './preload/api/crash'
import { appAPI } from './preload/api/app'
import { taskAPI } from './preload/api/task'
import { importAPI } from './preload/api/import'
import { importRootAPI } from './preload/api/import-root'
import { operationHistoryAPI } from './preload/api/operation-history'
import { decryptAPI } from './preload/api/decrypt'
import { pluginAPI } from './preload/api/plugin'

// ============ 暴露给渲染进程的 API ============
// 所有方法返回 Promise<T>（T 为业务数据类型），失败时抛出 IpcError
// 渲染层用法：
//   try {
//     const result = await electronAPI.file.delete(paths)
//     // result 即业务数据
//   } catch (err) {
//     if (err instanceof window.IpcError) {
//       console.error(err.code, err.message)
//     }
//   }

const electronAPI = {
  // P0-白屏修复·诊断：渲染进程挂载完成后上报就绪，主进程据此取消 8s 诊断超时
  reportReady: () => ipcRenderer.send('renderer:ready'),
  // 扫描器
  scanner: scannerAPI,
  // 文件操作
  file: fileAPI,
  // 编辑器
  editor: editorAPI,
  // 水印
  watermark: watermarkAPI,
  // 分类
  category: categoryAPI,
  // P0-B：删除 tag 命名空间（tag:list/add/remove IPC 已移除）
  // 媒体操作
  mediaAction: mediaActionAPI,
  // 视频
  video: videoAPI,
  // 对话框
  dialog: dialogAPI,
  // 缩略图
  thumbnail: thumbnailAPI,
  // 媒体列表更新通知
  media: mediaAPI,
  // P0-02：角色档案管理
  profile: profileAPI,
  // 界面主题（统一主题接口）
  uiTheme: uiThemeAPI,
  // 系统
  shell: shellAPI,
  // 应用设置
  settings: settingsAPI,
  // 导出偏好
  export: exportAPI,
  // 数据管理
  data: dataAPI,
  // T01：数据库备份管理
  backup: backupAPI,
  // T08：WiFi 局域网分享 + T09 剪贴板分享
  share: shareAPI,
  // T10：缩略图缓存管理
  cache: cacheAPI,
  // 日志管理
  log: logAPI,
  // T13：崩溃报告管理（crashReporter dump 文件）
  crash: crashAPI,
  // 应用控制（重启等）
  app: appAPI,
  // 性能重构 v3 改造项三：统一任务进度通道
  task: taskAPI,
  // T14：文件导入向导
  import: importAPI,
  // 指定目录扫描：已登记导入根（import_roots）的管理——列表 / 移除
  importRoot: importRootAPI,
  // 建议改#9：操作历史持久化（支持跨重启撤销）
  operationHistory: operationHistoryAPI,
  // 游戏参数解密
  decrypt: decryptAPI,
  // 插件系统管理（与主进程 pluginHost 通信，能力桥通过 window.pluginAPI 独立暴露）
  plugin: pluginAPI
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
// 暴露 IpcError 类供渲染层做 instanceof 判断
contextBridge.exposeInMainWorld('IpcError', IpcError)

// ============ 插件系统 facade + 能力桥 ============
// 这里刻意不使用 pluggable-electron 自带的 initFacade()。
//
// 原版 useFacade() 会把 install / uninstall / update / toggleActive 一并挂到
// window.pluggableElectronIpc。install 最终执行 npm 包的 postinstall 脚本，
// 于是渲染进程里任意脚本（被 XSS 注入的代码、插件自身代码）只要一行
// window.pluggableElectronIpc.install(['evil-pkg']) 就能拿到任意代码执行。
//
// 因此只暴露插件运行时真正需要的只读方法：
//   - getActive：pluggable-electron/renderer 的 plugins.registerActive() 依赖
//   - updatesAvailable：更新检查，只读
// 所有变更类管理操作统一走 electronAPI.plugin.*（plugin:* 通道，主进程已做
// 可信调用方校验）。对应的 pluggable:* 变更路由也已在主进程侧摘除。
//
// 保留 try/catch：contextBridge 暴露失败不应阻塞 preload，
// 否则渲染进程拿不到 electronAPI 会直接白屏。
try {
  contextBridge.exposeInMainWorld('pluggableElectronIpc', {
    getActive: () => ipcRenderer.invoke('pluggable:getActivePlugins'),
    updatesAvailable: (plugin: unknown[]) =>
      ipcRenderer.invoke('pluggable:updatesAvailable', plugin)
  })
} catch (err) {
  // 暴露失败不阻塞应用启动，仅插件功能不可用
  // preload 运行于渲染上下文无法使用 i18n，内部诊断日志固定英文
  preloadLogger.error('pluggable-electron facade exposure failed:', err)
}

// i18n.t 注入点（可变指针方案的设计说明见 ./preload/plugin-bridge.ts）
contextBridge.exposeInMainWorld('__setPluginI18nT', setPluginI18nT)

// 插件能力桥（设计说明见 ./preload/plugin-bridge.ts）
contextBridge.exposeInMainWorld('pluginAPI', pluginBridgeAPI)

// 类型声明
declare global {
  interface Window {
    electronAPI: typeof electronAPI
    IpcError: typeof IpcError
    /** 插件能力桥 API（仅插件代码使用） */
    pluginAPI: typeof pluginBridgeAPI
    /** 渲染进程注入 i18next.t 函数（由 PluginRuntime.bootstrap 调用） */
    __setPluginI18nT: (fn: (key: string, options?: Record<string, unknown>) => string) => void
    /**
     * pluggable-electron facade（收窄为只读）
     *
     * 变更类方法（install / uninstall / update / toggleActive）已刻意不暴露，
     * 请改用 electronAPI.plugin.*，那条链路在主进程有可信调用方校验。
     */
    pluggableElectronIpc?: {
      getActive: () => Promise<unknown>
      updatesAvailable: (plugin: unknown[]) => Promise<unknown>
    }
  }
}
