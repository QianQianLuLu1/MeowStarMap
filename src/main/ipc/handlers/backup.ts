import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { logger } from '../../utils/logger'
import { backupService } from '../../services/backup-service'
import { wrapHandler, wrapHandlerNoArgs, schemas } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { registerSetDirHandler, registerResetDirHandler } from './set-dir-handler'

/**
 * P0-A1：从 Application.setupIPC() 迁移的数据库备份域 IPC handler 集合。
 */
export function registerBackupHandlers(ctx: HandlerContext): void {
  // T01：数据库备份 IPC
  // 手动创建备份
  ipcMain.handle(
    'backup:create',
    wrapHandler(
      ctx,
      z.tuple([
        z
          .object({
            accountUid: z.string().min(1).max(64).optional()
          })
          .optional()
      ]),
      async ([options]) => {
        try {
          // P1-04：支持按档案备份——文件名加入 UID 后缀以便识别
          // 实际备份内容仍是整库（还原时不会丢失其他档案数据，更安全）
          const result = await backupService.createBackup(options?.accountUid)
          if (result.success) {
            const label = options?.accountUid ? `（档案 ${options.accountUid}）` : ''
            logger.info(`[Backup] 用户手动创建备份成功${label}`)
          }
          return result
        } catch (error) {
          logger.error('[Backup] 创建备份 IPC 失败:', error)
          throw AppError.internal(
            `创建备份失败: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    )
  )

  // 列出所有备份
  ipcMain.handle(
    'backup:list',
    wrapHandlerNoArgs(ctx, async () => {
      try {
        const backups = await backupService.listBackups()
        return { backups, backupDir: backupService.getBackupDirectory() }
      } catch (error) {
        logger.error('[Backup] 列出备份失败:', error)
        throw AppError.internal(
          `列出备份失败: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  )

  // 从备份恢复
  // P1-04：文件名正则支持可选的 _{uid} 后缀（按档案备份场景）
  ipcMain.handle(
    'backup:restore',
    wrapHandler(ctx, z.tuple([schemas.backupFilename]), async ([filename]) => {
      try {
        const result = await backupService.restoreBackup(filename)
        if (result.success) {
          logger.info(`[Backup] 用户从备份恢复: ${filename}`)
        }
        return result
      } catch (error) {
        logger.error('[Backup] 恢复备份 IPC 失败:', error)
        throw AppError.internal(
          `恢复备份失败: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  )

  // 删除指定备份（P1-04：正则同步支持 _{uid} 后缀）
  ipcMain.handle(
    'backup:delete',
    wrapHandler(ctx, z.tuple([schemas.backupFilename]), async ([filename]) => {
      try {
        return await backupService.deleteBackup(filename)
      } catch (error) {
        throw AppError.internal(
          `删除备份失败: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  )

  // P1-A11：setDir/resetDir 改用工厂函数（原 45 行模板代码消除）
  registerSetDirHandler(ctx, 'backup:setDir', 'backupDir')
  registerResetDirHandler(ctx, 'backup:resetDir', 'backupDir')

  // 获取备份目录路径（供 UI 显示，避免 UI 硬编码）
  ipcMain.handle(
    'backup:getDir',
    wrapHandlerNoArgs(ctx, async () => backupService.getBackupDirectory())
  )
}
