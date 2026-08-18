import { ipcMain, dialog, shell } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs, schemas } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { MediaRepository } from '../../database/media-repository'
import { pathExists } from '../../utils/file-utils'
import { logger } from '../../utils/logger'
import { t } from '../../i18n'

/**
 * trashItem 三态结果。
 * - ok：成功移至回收站，DB 可安全删除
 * - missing：文件已不存在，DB 可安全删除
 * - failed：移至回收站失败且文件仍存在，DB 必须保留供用户重试
 */
type TrashItemResult = 'ok' | 'missing' | 'failed'

/**
 * 移至系统回收站并区分三态：成功 / 文件不存在 / 失败（文件仍存在）。
 *
 * 抽取此函数是为了让 `emptyRecycleBin` 与 `permanentDelete` 共用同一三态判定逻辑，
 * 避免 B1 类 Bug（trashItem 失败时仍删 DB 记录导致用户数据丢失踪迹）。
 */
async function trashItemWithFallback(filePath: string): Promise<TrashItemResult> {
  try {
    await shell.trashItem(filePath)
    return 'ok'
  } catch (err) {
    // 区分「文件已不存在」与「权限/锁定等真实失败」：仅文件不存在时可安全删 DB
    if (!(await pathExists(filePath))) {
      return 'missing'
    }
    logger.warn(`[RecycleBin] 移至系统回收站失败: ${filePath}`, err) // TODO: i18n: internal log
    return 'failed'
  }
}

/**
 * 媒体生命周期域 IPC handler
 *
 * 覆盖：物理删除 / 软删除 / 恢复 / 彻底删除 / 清空回收站 / 丢失与损坏记录清理。
 * 彻底删除与清空回收站含 dialog 二次确认；彻底删除采用三阶段事务保证 DB 与文件系统一致。
 */
export function registerMediaLifecycleHandlers(ctx: HandlerContext): void {
  // 每次调用动态获取 Repository（db 可能在初始化/重连时变化）
  // 数据库写操作进程拆分：传入 workerBridge 与 dbPath，写方法走独立 utilityProcess
  const getRepo = (): MediaRepository => {
    const db = ctx.dbManager.getDatabase()
    if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
    return new MediaRepository(db, ctx.dbManager.getWorkerBridge(), ctx.dbManager.getDbPath())
  }

  ipcMain.handle(
    'media:delete',
    wrapHandler(ctx, z.tuple([schemas.mediaId]), async ([mediaId]) => {
      await getRepo().hardDelete(mediaId)
      ctx.notifyMediaUpdated()
      return { deleted: true }
    })
  )

  // F-S6 回收站：软删除
  ipcMain.handle(
    'media:softDelete',
    wrapHandler(ctx, z.tuple([schemas.mediaIdArray]), async ([mediaIds]) => {
      await getRepo().softDeleteBatch(mediaIds)
      ctx.notifyMediaUpdated()
      return {
        success: true,
        message: t('main.media.message.softDeleted', { count: mediaIds.length })
      }
    })
  )

  // F-S6 回收站：恢复
  ipcMain.handle(
    'media:restore',
    wrapHandler(ctx, z.tuple([schemas.mediaIdArray]), async ([mediaIds]) => {
      await getRepo().restoreBatch(mediaIds)
      ctx.notifyMediaUpdated()
      return { message: t('main.media.message.restored', { count: mediaIds.length }) }
    })
  )

  // F-S6 回收站：彻底删除（高危操作二次确认 + 三阶段事务）
  ipcMain.handle(
    'media:permanentDelete',
    wrapHandler(ctx, z.tuple([schemas.mediaIdArray]), async ([mediaIds]) => {
      // A-S3：高危操作二次确认（彻底删除不可恢复）
      const confirmResult = await dialog.showMessageBox({
        type: 'warning',
        buttons: [t('main.media.dialog.cancel'), t('main.media.dialog.confirmDelete')],
        defaultId: 0,
        cancelId: 0,
        title: t('main.media.dialog.permanentDeleteTitle'),
        message: t('main.media.dialog.permanentDeleteMessage', { count: mediaIds.length }),
        detail: t('main.media.dialog.permanentDeleteDetail')
      })
      if (confirmResult.response !== 1) {
        throw AppError.canceled(t('main.media.error.userCanceled'))
      }

      const repo = getRepo()
      // 查询文件路径
      const rows = repo.getMediaPathsByIds(mediaIds)

      // F-S1 三阶段：①事务软删除标记 ②异步 trashItem ③事务物理删除已处理记录
      // 保证 DB 与文件系统一致：中断后 DB 仍有 is_deleted=1 记录，用户可重试

      // 阶段1：幂等软删除标记
      await repo.softDeleteForPermanentDelete(rows.map((r) => r.id))

      // 阶段2：逐个移至系统回收站，区分「成功」「文件已不存在」「失败」
      const idsToDelete: number[] = []
      const failedPaths: string[] = []
      for (const row of rows) {
        const result = await trashItemWithFallback(row.file_path)
        if (result === 'failed') {
          failedPaths.push(row.file_path)
        } else {
          idsToDelete.push(row.id)
        }
      }

      // 阶段3：事务中物理删除已成功处理的记录
      await repo.hardDeleteBatch(idsToDelete)

      ctx.notifyMediaUpdated()
      const msg =
        failedPaths.length > 0
          ? t('main.media.message.permanentDeletePartial', {
              deleted: idsToDelete.length,
              failed: failedPaths.length
            })
          : t('main.media.message.permanentDeleted', { count: idsToDelete.length })
      return { message: msg, deletedCount: idsToDelete.length, failedCount: failedPaths.length }
    })
  )

  // F-S6 回收站：清空回收站
  ipcMain.handle(
    'media:emptyRecycleBin',
    wrapHandlerNoArgs(ctx, async () => {
      const repo = getRepo()
      const rows = repo.getSoftDeletedMediaPaths()

      if (rows.length === 0) {
        return { message: t('main.media.message.recycleBinEmpty'), movedCount: 0 }
      }

      // A-S3：高危操作二次确认（清空回收站不可恢复）
      const confirmResult = await dialog.showMessageBox({
        type: 'warning',
        buttons: [t('main.media.dialog.cancel'), t('main.media.dialog.confirmEmpty')],
        defaultId: 0,
        cancelId: 0,
        title: t('main.media.dialog.emptyRecycleBinTitle'),
        message: t('main.media.dialog.emptyRecycleBinMessage', { count: rows.length }),
        detail: t('main.media.dialog.permanentDeleteDetail')
      })
      if (confirmResult.response !== 1) {
        throw AppError.canceled(t('main.media.error.userCanceled'))
      }

      // B1 修复：trashItem 失败且文件仍存在时，不删除 DB 记录，保留供用户重试。
      // 仅当 trashItem 成功 或 文件已不存在（DB 踪迹已无对应实体）时才删除 DB。
      let movedCount = 0
      let missingCount = 0
      const idsToDelete: number[] = []
      const failedPaths: string[] = []
      for (const row of rows) {
        const result = await trashItemWithFallback(row.file_path)
        if (result === 'ok') {
          idsToDelete.push(row.id)
          movedCount++
        } else if (result === 'missing') {
          idsToDelete.push(row.id)
          missingCount++
        } else {
          failedPaths.push(row.file_path)
        }
      }
      await repo.hardDeleteBatch(idsToDelete)
      ctx.notifyMediaUpdated()
      const msg =
        failedPaths.length > 0
          ? t('main.media.message.permanentDeletePartial', {
              deleted: idsToDelete.length,
              failed: failedPaths.length
            })
          : t('main.media.message.recycleBinEmptied', { count: movedCount + missingCount })
      return {
        message: msg,
        movedCount,
        missingCount,
        failedCount: failedPaths.length
      }
    })
  )

  // T02：清理丢失记录
  ipcMain.handle(
    'media:cleanupMissing',
    wrapHandlerNoArgs(ctx, async () => {
      const cleared = await getRepo().cleanupMissingRecords()
      ctx.notifyMediaUpdated()
      return { message: t('main.media.message.cleanedMissing', { count: cleared }), cleared }
    })
  )

  // T02：从库中移除单条 missing 记录
  ipcMain.handle(
    'media:removeMissing',
    wrapHandler(ctx, z.tuple([schemas.mediaId]), async ([mediaId]) => {
      const deleted = await getRepo().removeMissingRecord(mediaId)
      if (!deleted) {
        throw AppError.notFound(t('main.media.error.missingNotFound'))
      }
      ctx.notifyMediaUpdated()
      return { message: t('main.media.message.missingRemoved') }
    })
  )

  // 损坏文件容错：清理所有 is_corrupted=1 的记录（用户确认后批量删除）
  // 与 cleanupMissing 对称：missing 是文件被外部删除，corrupted 是文件存在但内容损坏
  ipcMain.handle(
    'media:cleanupCorrupted',
    wrapHandlerNoArgs(ctx, async () => {
      const cleared = await getRepo().cleanupCorruptedRecords()
      ctx.notifyMediaUpdated()
      return { message: t('main.media.message.cleanedCorrupted', { count: cleared }), cleared }
    })
  )

  // 损坏文件容错：从库中移除单条 corrupted 记录
  ipcMain.handle(
    'media:removeCorrupted',
    wrapHandler(ctx, z.tuple([schemas.mediaId]), async ([mediaId]) => {
      const deleted = await getRepo().removeCorruptedRecord(mediaId)
      if (!deleted) {
        throw AppError.notFound(t('main.media.error.corruptedNotFound'))
      }
      ctx.notifyMediaUpdated()
      return { message: t('main.media.message.corruptedRemoved') }
    })
  )
}
