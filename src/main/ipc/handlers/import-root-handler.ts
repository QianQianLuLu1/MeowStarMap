import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs, schemas } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { logger } from '../../utils/logger'
import { ImportRootRepository } from '../../database/import-root-repository'
import { MediaRepository } from '../../database/media-repository'

/**
 * import-root 域 IPC handler：管理"指定目录扫描"登记的导入根（import_roots 表）。
 *
 * 背景：用户经"指定目录扫描"（scanner:start({ path })）导入后，主进程把目录登记进
 * import_roots，但此前没有任何可视化入口查看或移除，导致"只增不减"。
 * 本模块补齐这一缺口：
 *   - import:roots       列出全部已登记目录
 *   - import:removeRoot  移除单个目录（仅移出管理 / 或同时软删其媒体索引记录进回收站）
 */
export function registerImportRootHandlers(ctx: HandlerContext): void {
  // 列出全部已登记的"指定目录扫描"导入根（归一化后的原始大小写路径）
  ipcMain.handle(
    'import:roots',
    wrapHandlerNoArgs(ctx, async (c) => {
      const db = c.dbManager.getDatabase()
      if (!db) throw new Error('数据库未初始化')
      const repo = new ImportRootRepository(
        db,
        c.dbManager.getWorkerBridge(),
        c.dbManager.getDbPath()
      )
      return repo.listImportRoots()
    })
  )

  // 移除一个导入根；clearRecords=true 时同时软删该根下 media_files 记录（进回收站，可恢复）
  ipcMain.handle(
    'import:removeRoot',
    wrapHandler(
      ctx,
      z.tuple([schemas.filePath, z.boolean()]),
      async ([rootPath, clearRecords], c) => {
        const db = c.dbManager.getDatabase()
        if (!db) throw new Error('数据库未初始化')
        const importRootRepo = new ImportRootRepository(
          db,
          c.dbManager.getWorkerBridge(),
          c.dbManager.getDbPath()
        )
        const mediaRepo = new MediaRepository(
          db,
          c.dbManager.getWorkerBridge(),
          c.dbManager.getDbPath()
        )

        // 1) 先移除 import_roots 登记（核心操作，失败即整体失败）
        let removed = false
        try {
          await importRootRepo.removeImportRoot(rootPath)
          removed = true
        } catch (err) {
          logger.error('[ImportRoot] 移除导入根失败:', err)
          throw AppError.internal(
            `移除指定目录失败: ${err instanceof Error ? err.message : String(err)}`
          )
        }

        // 2) 媒体软删独立于 import_roots 移除：任一失败不影响另一操作结果
        let cleared = 0
        // FIX(组1-2): 软删失败必须可区分——原实现仅记日志并返回 cleared:0，
        // 前端无法区分"该根下无媒体记录"与"软删失败"（且 import_roots 行已删，
        // 此入口无法重试软删）。返回 clearFailed + 错误消息，前端给出明确提示。
        let clearFailed = false
        let clearErrorMessage: string | undefined
        if (clearRecords && removed) {
          try {
            cleared = await mediaRepo.softDeleteByRootPath(rootPath)
            c.notifyMediaUpdated()
          } catch (err) {
            // 媒体软删失败不影响 import_roots 行移除结果（removed 仍为 true）
            logger.error('[ImportRoot] 清除目录媒体索引记录失败（指定目录已移除）:', err)
            clearFailed = true
            clearErrorMessage = err instanceof Error ? err.message : String(err)
          }
        }
        return { removed, cleared, clearFailed, clearErrorMessage }
      }
    )
  )
}
