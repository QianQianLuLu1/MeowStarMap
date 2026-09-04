import { ipcMain } from 'electron'
import type { HandlerContext } from '../handler-context'
import { logger } from '../../utils/logger'
import { wrapHandlerNoArgs } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import {
  listCrashes,
  getCrashStats,
  openCrashDirectory,
  clearAllCrashes,
  getCrashDirectory
} from '../../services/crash-service'
import { registerSetDirHandler, registerResetDirHandler } from './set-dir-handler'
import { t } from '../../i18n'

/**
 * P0-A1：从 Application.setupIPC() 迁移的崩溃报告域 IPC handler 集合。
 */
export function registerCrashHandlers(ctx: HandlerContext): void {
  // T13：崩溃报告 IPC
  // 列出所有崩溃 dump 文件（按时间倒序）
  ipcMain.handle(
    'crash:list',
    wrapHandlerNoArgs(ctx, async () => {
      try {
        const crashes = await listCrashes()
        return { crashes }
      } catch (error) {
        logger.error(t('main.crash.log.listFailed'), error)
        throw AppError.internal(
          t('main.crash.error.listFailed', {
            reason: error instanceof Error ? error.message : String(error)
          })
        )
      }
    })
  )

  // 获取崩溃目录统计信息
  ipcMain.handle(
    'crash:getStats',
    wrapHandlerNoArgs(ctx, async () => {
      try {
        return await getCrashStats()
      } catch (error) {
        throw AppError.internal(
          t('main.crash.error.getStatsFailed', {
            reason: error instanceof Error ? error.message : String(error)
          })
        )
      }
    })
  )

  // 打开崩溃目录（系统资源管理器）
  ipcMain.handle(
    'crash:openDirectory',
    wrapHandlerNoArgs(ctx, async () => openCrashDirectory())
  )

  // 清空所有崩溃 dump 文件
  ipcMain.handle(
    'crash:clear',
    wrapHandlerNoArgs(ctx, async () => {
      try {
        const result = await clearAllCrashes()
        if (result.success) {
          logger.info(t('main.crash.log.clearedAll'))
        }
        return result
      } catch (error) {
        throw AppError.internal(
          t('main.crash.error.clearFailed', {
            reason: error instanceof Error ? error.message : String(error)
          })
        )
      }
    })
  )

  // P1-A11：setDir/resetDir 改用工厂函数（原 45 行模板代码消除）
  registerSetDirHandler(ctx, 'crash:setDir', 'crashDir')
  registerResetDirHandler(ctx, 'crash:resetDir', 'crashDir')

  // 获取崩溃目录路径（供 UI 显示，避免 UI 硬编码）
  ipcMain.handle(
    'crash:getDir',
    wrapHandlerNoArgs(ctx, async () => getCrashDirectory())
  )
}
