/**
 * 文件操作域 IPC handler：导出 / 另存为
 *
 * 覆盖：file:export（支持默认目录与命名规则）/ file:saveAs。
 * 删除/复制等通道见 `file.ts`，重命名/移动通道见 `file-rename-handler.ts`。
 *
 * 安全基线（与文件操作域一致）：
 * - 所有路径参数由 zod schema 校验长度/格式
 * - 所有文件操作调用 assertFileReadPath/assertFileWritePath 完成白名单拦截
 * - 写操作额外校验目标目录可写
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import type { ExportOptions } from '../../types/file'
import { wrapHandler, schemas, assertFileReadPath, assertFileWritePath } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { chunkArray } from '../../database/sql-chunk'
// 日志管理
import { logger } from '../../utils/logger'
import { t } from '../../i18n'

export function registerFileExportHandlers(ctx: HandlerContext): void {
  // 文件导出（支持默认目录与命名规则）
  ipcMain.handle(
    'file:export',
    wrapHandler(
      ctx,
      z.tuple([
        schemas.filePathArrayBulk,
        schemas.filePath,
        z
          .object({
            quality: z.number().min(0).max(100).optional(),
            format: z.enum(['jpg', 'jpeg', 'png', 'webp', 'original']).optional(),
            namingPattern: z.string().max(256).optional(),
            useDefaultDir: z.boolean().optional()
          })
          .optional()
      ]),
      async ([filePaths, targetDir, options]) => {
        for (const p of filePaths) assertFileReadPath(p)
        assertFileWritePath(targetDir)

        // P1-02：useDefaultDir=true 时从 settings 读取默认导出路径
        let finalTargetDir = targetDir
        const finalOptions: ExportOptions = options ? { ...options } : {}
        if (options?.useDefaultDir) {
          const defaultDir = ctx.dbManager.getSetting<string | null>('export.defaultDir', null)
          if (!defaultDir) {
            throw AppError.preconditionFailed(t('main.file.error.noDefaultExportDir'))
          }
          finalTargetDir = defaultDir
          assertFileWritePath(finalTargetDir)
          // 若未显式传 namingPattern，从 settings 读取默认命名规则
          if (!finalOptions.namingPattern) {
            const pattern = ctx.dbManager.getSetting<string | null>('export.namingPattern', null)
            if (pattern && pattern.trim()) {
              finalOptions.namingPattern = pattern.trim()
            }
          }
        }

        // P1-02：若启用命名规则，查询每个文件的 album_type + account_uid 元数据
        let metadataMap: Map<string, { album_type?: string; account_uid?: string }> | undefined
        if (finalOptions.namingPattern && finalOptions.namingPattern.trim()) {
          metadataMap = new Map()
          try {
            const db = ctx.dbManager.getDatabase()
            if (db) {
              // A11：分片查询避免超过 SQLite 单语句参数上限
              for (const batch of chunkArray(filePaths)) {
                const placeholders = batch.map(() => '?').join(',')
                const rows = db
                  .prepare(
                    `SELECT file_path, album_type, account_uid FROM media_files WHERE file_path IN (${placeholders})`
                  )
                  .all(...batch) as Array<{
                  file_path: string
                  album_type: string
                  account_uid: string
                }>
                for (const r of rows) {
                  metadataMap.set(r.file_path, {
                    album_type: r.album_type,
                    account_uid: r.account_uid
                  })
                }
              }
            }
          } catch (err) {
            // 元数据查询失败不阻断导出，仅日志记录
            logger.warn(t('main.file.log.exportMetadataFallback'), err)
          }
        }

        return ctx.fileService.exportFiles(filePaths, finalTargetDir, finalOptions, metadataMap)
      }
    )
  )

  // 文件另存为
  ipcMain.handle(
    'file:saveAs',
    wrapHandler(
      ctx,
      z.tuple([schemas.filePath, schemas.filePath, schemas.shortString(255).optional()]),
      async ([filePath, targetDir, newName]) => {
        assertFileReadPath(filePath)
        assertFileWritePath(targetDir)
        return ctx.fileService.saveAs(filePath, targetDir, newName)
      }
    )
  )
}
