/**
 * 插件能力桥（window.pluginAPI）+ i18n.t 注入点
 *
 * 通过 contextBridge 暴露给渲染进程插件，所有方法返回 Promise。
 * 主进程在每个 handler 内通过 permission-guard 校验调用方插件是否声明了对应权限。
 *
 * 与 api/plugin.ts 的分工：那边是「插件系统管理」（electronAPI.plugin.*，
 * 由用户在设置页操作），这边是「插件运行时能力」（插件代码调用）。
 */
import { call } from './ipc'

/**
 * i18n.t 注入点
 *
 * contextBridge 暴露的对象会被冻结，无法后续覆盖方法。
 * 因此用一个可变的内部函数指针，PluginRuntime.bootstrap 时通过 window.__setPluginI18nT 注入。
 * 插件调用 window.pluginAPI.i18n.t 时，contextBridge 调用闭包，闭包读取最新 i18nT 值。
 */
let i18nT: (key: string, options?: Record<string, unknown>) => string = (key) => key

/**
 * 渲染进程调用此函数注入实际 i18next.t
 * PluginRuntime.bootstrap 时执行：window.__setPluginI18nT(i18next.t.bind(i18next))
 */
export function setPluginI18nT(
  fn: (key: string, options?: Record<string, unknown>) => string
): void {
  i18nT = fn
}

/** 插件能力桥 API（入口以 pluginAPI 全局名暴露） */
export const pluginBridgeAPI = {
  /** 媒体能力桥 */
  media: {
    read: (filePath: string) => call<Record<string, unknown> | null>('plugin:media.read', filePath),
    list: (filter?: { accountUid?: string; albumType?: string; limit?: number; offset?: number }) =>
      call<Array<Record<string, unknown>>>('plugin:media.list', filter ?? {}),
    write: (targetDir: string, data: ArrayBuffer | string, fileName: string) =>
      call<string>('plugin:media.write', targetDir, data, fileName),
    delete: (filePaths: string[]) => call<{ deleted: number }>('plugin:media.delete', filePaths)
  },
  /** 数据库能力桥（受限 SELECT） */
  db: {
    query: <T = unknown>(sql: string, params?: unknown[]) =>
      call<T[]>('plugin:db.query', sql, params ?? [])
  },
  /** 文件系统能力桥（受 pathGuard 约束） */
  fs: {
    read: (filePath: string) => call<ArrayBuffer>('plugin:fs.read', filePath),
    write: (filePath: string, data: ArrayBuffer | string) =>
      call<{ written: number }>('plugin:fs.write', filePath, data)
  },
  /** 水印能力桥（复用主进程 WatermarkService） */
  watermark: {
    apply: (config: unknown, filePaths: string[], targetDir: string) =>
      call<{
        success: boolean
        processed: number
        failed?: number
        message?: string
      }>('plugin:watermark.apply', config, filePaths, targetDir)
  },
  /** 任务进度能力桥（接入统一 task:progress 通道） */
  task: {
    progress: (taskId: string, current: number, total: number, phase?: string) =>
      call<{ reported: boolean }>('plugin:task.progress', taskId, current, total, phase)
  },
  /** 国际化（同步方法，复用渲染进程 i18next 实例，由 PluginRuntime 注入） */
  i18n: {
    t: (key: string, options?: Record<string, unknown>): string => i18nT(key, options)
  }
}
