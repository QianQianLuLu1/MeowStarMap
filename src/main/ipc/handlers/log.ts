import { BrowserWindow, dialog, ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { logger, logFault, getLogDirectory } from '../../utils/logger'
import { wrapHandler, wrapHandlerNoArgs, schemas } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import {
  listFaults,
  getFaultDetail,
  openLogDirectory,
  exportLogsAsZip,
  clearAllLogs,
  getLogStats
} from '../../services/log-service'
import { registerSetDirHandler, registerResetDirHandler } from './set-dir-handler'

/**
 * 复刻 index.ts 中 this.getMainWindow() 的行为：
 * 优先取主窗口，回退到当前焦点窗口，均无则抛错。
 * ctx.getMainWindow() 返回 null 时不抛，这里负责补上抛错语义以保留原行为。
 */
function requireMainWindow(ctx: HandlerContext): BrowserWindow {
  const win = ctx.getMainWindow() ?? BrowserWindow.getFocusedWindow()
  if (!win) throw AppError.preconditionFailed('主窗口未初始化')
  return win
}

/**
 * P0-A1：从 Application.setupIPC() 迁移的日志域 IPC handler 集合。
 */
export function registerLogHandlers(ctx: HandlerContext): void {
  // 日志管理 IPC
  // 获取故障列表（按时间倒序）
  ipcMain.handle(
    'log:listFaults',
    wrapHandlerNoArgs(ctx, async () => {
      try {
        const faults = await listFaults()
        return { faults }
      } catch (error) {
        logger.error('[Log] 获取故障列表失败:', error)
        throw AppError.internal(
          `获取故障列表失败: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  )

  // 获取单个故障详情
  ipcMain.handle(
    'log:getFaultDetail',
    wrapHandler(ctx, z.tuple([schemas.shortId]), async ([id]) => {
      try {
        const fault = await getFaultDetail(id)
        return { fault }
      } catch (error) {
        logger.error('[Log] 获取故障详情失败:', error)
        throw AppError.internal(
          `获取故障详情失败: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  )

  // 打开日志目录（系统资源管理器）
  ipcMain.handle(
    'log:openDirectory',
    wrapHandlerNoArgs(ctx, async () => openLogDirectory())
  )

  // 获取日志目录路径
  ipcMain.handle(
    'log:getDirectoryPath',
    wrapHandlerNoArgs(ctx, async () => ({ path: getLogDirectory() }))
  )

  // 获取日志统计信息
  ipcMain.handle(
    'log:getStats',
    wrapHandlerNoArgs(ctx, async () => {
      try {
        return await getLogStats()
      } catch (error) {
        throw AppError.internal(
          `获取日志统计失败: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  )

  // 导出全部日志为 zip 压缩包
  // 业务决策：先弹出保存对话框让用户选择保存位置，再调用 PowerShell 打包
  ipcMain.handle(
    'log:exportZip',
    wrapHandlerNoArgs(ctx, async () => {
      // 弹出保存对话框，让用户选择 zip 文件保存位置
      const defaultName = `wxnn-logs-${new Date().toISOString().slice(0, 10)}.zip`
      const result = await dialog.showSaveDialog(requireMainWindow(ctx), {
        defaultPath: defaultName,
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
      })
      if (result.canceled || !result.filePath) {
        throw AppError.canceled('用户取消保存')
      }
      return exportLogsAsZip(result.filePath)
    })
  )

  // 清空所有日志文件
  ipcMain.handle(
    'log:clear',
    wrapHandlerNoArgs(ctx, async () => {
      try {
        const result = await clearAllLogs()
        if (result.success) {
          logger.info('[Log] 用户手动清空了所有日志文件')
        }
        return result
      } catch (error) {
        throw AppError.internal(
          `清空日志失败: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  )

  // P0-2：渲染进程错误上报到主进程 faults 日志
  // 接收三种来源的错误：ErrorBoundary / window.onerror / unhandledrejection
  ipcMain.handle(
    'log:reportRendererError',
    wrapHandler(
      ctx,
      z.tuple([
        z.object({
          message: z
            .string()
            .min(1)
            .max(8 * 1024),
          stack: z
            .string()
            .max(32 * 1024)
            .optional(),
          componentStack: z
            .string()
            .max(32 * 1024)
            .optional(),
          filename: z.string().max(1024).optional(),
          lineno: z.number().int().min(0).optional(),
          colno: z.number().int().min(0).optional(),
          source: z.enum(['ErrorBoundary', 'window.onerror', 'unhandledrejection'])
        })
      ]),
      async ([payload]) => {
        try {
          const err = new Error(payload.message || 'Unknown renderer error')
          if (payload.stack) err.stack = payload.stack
          // 根据 source 映射到对应的 FaultType
          const faultTypeMap = {
            ErrorBoundary: 'rendererComponent',
            'window.onerror': 'rendererResource',
            unhandledrejection: 'rendererPromise'
          } as const
          const faultType = faultTypeMap[payload.source] || 'rendererError'
          const context: Record<string, unknown> = { source: payload.source }
          if (payload.componentStack) context.componentStack = payload.componentStack
          if (payload.filename) {
            context.location = `${payload.filename}:${payload.lineno || 0}:${payload.colno || 0}`
          }
          await logFault(faultType, err, context)
          return { reported: true }
        } catch (err) {
          logger.error('[IPC] log:reportRendererError 处理失败:', err)
          throw AppError.internal(
            `上报渲染进程错误失败: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
    )
  )

  // P1-A11：setDir/resetDir 改用工厂函数（原 45 行模板代码消除）
  registerSetDirHandler(ctx, 'log:setDir', 'logDir')
  registerResetDirHandler(ctx, 'log:resetDir', 'logDir')

  // 获取日志目录路径（供 UI 显示，避免 UI 硬编码）
  ipcMain.handle(
    'log:getDir',
    wrapHandlerNoArgs(ctx, async () => getLogDirectory())
  )
}
