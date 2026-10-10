// @core-change: 共鸣录同步上游 65bb3d8f，新增卡池心愿单读写通道 resonance:setWishlist 并让导入批次可覆盖心愿单
import { ipcMain } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { HandlerContext } from '../handler-context'
import {
  wrapHandler,
  wrapHandlerNoArgs,
  assertFileReadPath,
  assertFileWritePath
} from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import {
  MAX_IMPORT_FILE_BYTES,
  resonanceAddManualRecordArgs,
  resonanceCommitImportArgs,
  resonanceDeleteRecordArgs,
  resonanceExportArgs,
  resonanceReadImportFileArgs,
  resonanceSetWishlistArgs,
  resonanceUpdateManualRecordArgs,
  resonanceUpdateWardrobeArgs,
  type ResonanceWardrobeData
} from '../../../shared/types/resonance'
import { ResonanceRepository } from '../../database/resonance-repository'
import { t } from '../../i18n'
import { logger } from '../../utils/logger'

/**
 * 共鸣录域 IPC handler（离线本地功能：记录存取 / 文件读入 / 导出写盘 / 衣橱）。
 *
 * 职责边界：主进程只做 参数校验、PathGuard 白名单、文件读写与 SQLite 存取；
 * 导入解析、合并去重、差异计数、导出组装均为渲染层纯函数（shared/resonance 与
 * renderer utils 中，配套单测）。导入提交由渲染层分批调用（批间更新进度/取消），
 * 每批一个事务，INSERT OR IGNORE 幂等，可安全续传。
 */
export function registerResonanceHandlers(ctx: HandlerContext): void {
  // 每次调用动态获取 Repository（db 可能在初始化/重连时变化）
  const getRepo = (): ResonanceRepository => {
    const db = ctx.dbManager.getDatabase()
    if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
    return new ResonanceRepository(db)
  }

  // ============ 数据读取 ============

  ipcMain.handle(
    'resonance:getData',
    wrapHandlerNoArgs(ctx, async () => {
      return getRepo().getAllData()
    })
  )

  // ============ 共鸣记录增删改 ============

  ipcMain.handle(
    'resonance:addManualRecord',
    wrapHandler(ctx, resonanceAddManualRecordArgs, async ([bannerId, itemId, obtainedAt]) => {
      try {
        await getRepo().addManualEdit(bannerId, itemId, obtainedAt)
        return { added: true }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (/UNIQUE constraint/i.test(msg)) {
          throw AppError.conflict(t('main.resonance.error.recordExists'))
        }
        throw error
      }
    })
  )

  ipcMain.handle(
    'resonance:updateManualRecord',
    wrapHandler(ctx, resonanceUpdateManualRecordArgs, async ([id, obtainedAt]) => {
      try {
        await getRepo().updateEditTime(id, obtainedAt)
        return { updated: true }
      } catch (error) {
        if (
          error instanceof Error &&
          (error as Error & { code?: string }).code === 'RESONANCE_RECORD_NOT_FOUND'
        ) {
          throw AppError.notFound(t('main.resonance.error.recordNotFound'))
        }
        throw error
      }
    })
  )

  ipcMain.handle(
    'resonance:deleteRecord',
    wrapHandler(ctx, resonanceDeleteRecordArgs, async ([{ kind, id }]) => {
      try {
        await getRepo().deleteRecord(kind, id)
        return { deleted: true }
      } catch (error) {
        if (
          error instanceof Error &&
          (error as Error & { code?: string }).code === 'RESONANCE_RECORD_NOT_FOUND'
        ) {
          throw AppError.notFound(t('main.resonance.error.recordNotFound'))
        }
        throw error
      }
    })
  )

  // ============ 导入（主进程仅读文件；解析/校验/计数在渲染层纯函数） ============

  ipcMain.handle(
    'resonance:readImportFile',
    wrapHandler(ctx, resonanceReadImportFileArgs, async ([filePath]) => {
      assertFileReadPath(filePath)
      let stat: fs.Stats
      try {
        stat = await fs.promises.stat(filePath)
      } catch {
        throw AppError.notFound(t('main.resonance.error.importFileNotReadable', { path: filePath }))
      }
      if (!stat.isFile()) {
        throw AppError.validation(t('main.resonance.error.importFileNotFile', { path: filePath }))
      }
      if (stat.size > MAX_IMPORT_FILE_BYTES) {
        throw AppError.validation(t('main.resonance.error.importFileTooLarge', { size: stat.size }))
      }
      let content: string
      try {
        content = await fs.promises.readFile(filePath, 'utf8')
      } catch (error) {
        throw AppError.internal(
          t('main.resonance.error.importFileReadFailed', {
            reason: error instanceof Error ? error.message : String(error)
          })
        )
      }
      return { content, sizeBytes: stat.size }
    })
  )

  // 导入提交批次：渲染层按 MAX_COMMIT_BATCH_ROWS 分批送达，每批一个事务（幂等可续传）
  ipcMain.handle(
    'resonance:commitImport',
    wrapHandler(ctx, resonanceCommitImportArgs, async ([batch]) => {
      const repo = getRepo()
      let imported = 0
      if (batch.pulls.length > 0) {
        imported += repo.importPullsBatch(
          batch.pulls.map((r) => ({
            banner_id: r.bannerId,
            item_id: r.itemId,
            obtained_at: r.obtainedAt
          }))
        )
      }
      if (batch.edits.length > 0) {
        imported += repo.importEditsBatch(
          batch.edits.map((r) => ({
            banner_id: r.bannerId,
            item_id: r.itemId,
            obtained_at: r.obtainedAt
          }))
        )
      }
      if (batch.pearpal.length > 0) {
        imported += repo.importPearpalBatch(
          batch.pearpal.map((r) => ({
            banner_id: r.bannerId,
            item_id: r.itemId,
            pool_cnt: r.poolCnt,
            obtained_at: r.obtainedAt,
            raw_json: JSON.stringify(r.raw)
          }))
        )
      }
      if (batch.evo.length > 0) {
        imported += repo.importEvo(
          batch.evo.map((r) => ({ banner_id: r.bannerId, outfit_id: r.outfitId, level: r.level }))
        )
      }
      // 仅最后一个批次携带 wardrobe（全量覆盖）
      if (batch.includeWardrobe === true && batch.wardrobe) {
        await repo.replaceWardrobe(batch.wardrobe as unknown as ResonanceWardrobeData)
      }
      // 仅最后一个批次携带 wishlist（全量覆盖）
      if (batch.includeWishlist === true && batch.wishlist) {
        await repo.replaceWishlist(batch.wishlist)
      }
      return { imported }
    })
  )

  // ============ 导出（载荷由渲染层纯函数组装；主进程守卫 envelope + 写盘） ============

  ipcMain.handle(
    'resonance:export',
    wrapHandler(ctx, resonanceExportArgs, async ([{ filePath }, payload]) => {
      assertFileWritePath(filePath)
      // 导出路径前置校验：父目录必须存在且为目录
      const parentDir = path.dirname(filePath)
      let parentStat: fs.Stats
      try {
        parentStat = await fs.promises.stat(parentDir)
      } catch {
        throw AppError.validation(t('main.resonance.error.exportDirMissing', { path: parentDir }))
      }
      if (!parentStat.isDirectory()) {
        throw AppError.validation(t('main.resonance.error.exportDirMissing', { path: parentDir }))
      }
      if (!/\.json$/i.test(filePath)) {
        throw AppError.validation(t('main.resonance.error.exportNotJson', { path: filePath }))
      }
      const json = JSON.stringify(payload)
      try {
        await fs.promises.writeFile(filePath, json, 'utf8')
      } catch (error) {
        throw AppError.internal(
          t('main.resonance.error.exportWriteFailed', {
            reason: error instanceof Error ? error.message : String(error)
          })
        )
      }
      const recordCount =
        Object.values(payload.pulls).reduce((acc, list) => acc + list.length, 0) +
        Object.values(payload.edits).reduce((acc, list) => acc + list.length, 0) +
        Object.values(payload.evo).reduce((acc, list) => acc + list.length, 0) +
        Object.values(payload.pearpal).reduce((acc, list) => acc + list.length, 0)
      logger.info(t('main.resonance.log.exported', { path: filePath, count: recordCount }))
      return { path: filePath, recordCount }
    })
  )

  // ============ 衣橱 ============

  ipcMain.handle(
    'resonance:updateWardrobe',
    wrapHandler(ctx, resonanceUpdateWardrobeArgs, async ([{ adds, removes }]) => {
      const repo = getRepo()
      await repo.updateWardrobe(adds, removes)
      return { wardrobe: repo.getWardrobe() }
    })
  )

  // ============ 卡池心愿单 ============

  ipcMain.handle(
    'resonance:setWishlist',
    wrapHandler(ctx, resonanceSetWishlistArgs, async ([wishlist]) => {
      const repo = getRepo()
      await repo.replaceWishlist(wishlist)
      return { wishlist: repo.getWishlist() }
    })
  )

  // ============ 清空（危险操作；渲染层负责二次确认） ============

  ipcMain.handle(
    'resonance:clearAll',
    wrapHandlerNoArgs(ctx, async () => {
      await getRepo().clearAll()
      return { cleared: true }
    })
  )
}
