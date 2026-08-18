import path from 'path'
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import {
  wrapHandler,
  schemas,
  assertFileReadPath,
  assertFileWritePath,
  pathGuard
} from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { logger } from '../../utils/logger'
import { ImportRootRepository } from '../../database/import-root-repository'

// 文件导入支持的命名规则 / 分类策略 / 冲突策略枚举
const importOptionsSchema = z.object({
  namingRule: z.enum(['keep', 'date', 'seq']),
  categorize: z.enum(['flat', 'byDate', 'byMonth']),
  conflictStrategy: z.enum(['skip', 'rename', 'overwrite']),
  seqStart: z.number().int().min(0).max(1_000_000).optional()
})

/**
 * import 域 IPC handler：批量文件导入向导（预览 + 执行）。
 */
export function registerImportHandlers(ctx: HandlerContext): void {
  // ---- import 域 ----
  // T14：文件导入向导 IPC
  // 预览源目录中的待导入文件（仅元信息，不复制）
  ipcMain.handle(
    'import:preview',
    wrapHandler(ctx, z.tuple([schemas.filePath]), async ([sourceDir]) => {
      // 手动输入的路径未经过 dialog 注册，需显式 register 后才能通过 PathGuard 校验
      pathGuard.register(sourceDir)
      assertFileReadPath(sourceDir)
      return ctx.fileService.previewImport(sourceDir)
    })
  )

  // 执行批量导入（复制到目标目录，支持命名规则与分类策略）
  ipcMain.handle(
    'import:run',
    wrapHandler(
      ctx,
      z.tuple([schemas.filePathArray, schemas.filePath, importOptionsSchema]),
      async ([sourcePaths, targetBaseDir, options]) => {
        // 手动输入的路径未经过 dialog 注册，需显式 register 其所在目录后再校验
        for (const p of sourcePaths) {
          pathGuard.register(path.dirname(p))
          assertFileReadPath(p)
        }
        pathGuard.register(targetBaseDir)
        assertFileWritePath(targetBaseDir)
        const warnings: string[] = []
        try {
          const result = await ctx.fileService.importFiles(
            sourcePaths,
            targetBaseDir,
            options,
            (current: number, total: number) => {
              ctx.getMainWindow()?.webContents.send('import:progress', { current, total })
            }
          )
          if (result.imported.length > 0) {
            // A2：登记导入根为"归本应用管理的目录"，并针对该根触发增量扫描入库
            // 失败仅记日志，不影响已复制文件与导入成功返回（阶段 0 已登记白名单，此处无需再 register）
            try {
              const db = ctx.dbManager.getDatabase()
              if (!db) throw new Error('数据库未初始化')
              const importRootRepo = new ImportRootRepository(
                db,
                ctx.dbManager.getWorkerBridge(),
                ctx.dbManager.getDbPath()
              )
              await importRootRepo.addImportRoot(targetBaseDir)
              await ctx.scannerManager.scanRoot(targetBaseDir)
            } catch (postErr) {
              warnings.push(
                '登记导入根或触发扫描失败: ' +
                  (postErr instanceof Error ? postErr.message : String(postErr))
              )
              logger.error('[Import] 登记导入根或触发扫描失败（已复制文件不受影响）:', postErr)
            }
            // 通知媒体列表刷新（导入文件经扫描已入库）
            ctx.notifyMediaUpdated()
            logger.info(
              `[Import] 导入完成: 成功 ${result.imported.length} 个，跳过 ${result.skipped.length} 个，失败 ${result.failed.length} 个`
            )
          }
          return { ...result, warnings }
        } catch (error) {
          logger.error('[Import] 导入失败:', error)
          throw AppError.internal(
            `导入失败: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    )
  )
}
