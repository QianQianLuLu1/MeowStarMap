// @core-change: 导出/另存为源图读校验口径统一到媒体授权，修复已入库媒体「看得见导不出」
/**
 * 文件操作域 IPC handler：导出 / 另存为
 *
 * 覆盖：file:export（支持默认目录与命名规则）/ file:saveAs。
 * 删除/复制等通道见 `file.ts`，重命名/移动通道见 `file-rename-handler.ts`。
 *
 * 安全基线（与文件操作域一致）：
 * - 所有路径参数由 zod schema 校验长度/格式
 * - 源文件读取走 assertMediaAccessPath 三级校验（userPicked → 已入库媒体白名单 →
 *   PathGuard 兜底），与 media:// 展示、file:delete、editor:batchExportWithMetadata 同口径；
 *   目标目录写入仍走 assertFileWritePath（严格白名单，未放宽）
 * - 写操作额外校验目标目录可写
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import type { ExportOptions } from '../../types/file'
import { wrapHandler, schemas, assertFileWritePath } from '../validator'
import { assertMediaAccessPath } from '../media-read-guard'
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
        // 源图是图库里已入库、media:// 能正常展示的媒体；裸 PathGuard 会因敏感目录黑名单
        // （官方启动器默认装在 Program Files）或目录未登记为根而恒拒，且本校验先于目标目录
        // 写校验执行，表现为「导出到默认」与「选目录导出」同时失败。口径见文件头安全基线。
        for (const p of filePaths) assertMediaAccessPath(ctx, p)
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
        // 源图读校验与 file:export 同口径（三级校验，见文件头安全基线）
        assertMediaAccessPath(ctx, filePath)
        assertFileWritePath(targetDir)
        return ctx.fileService.saveAs(filePath, targetDir, newName)
      }
    )
  )
}
