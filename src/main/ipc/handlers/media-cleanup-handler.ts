/**
 * 媒体生命周期域 IPC handler：丢失与损坏记录清理
 *
 * 覆盖：media:cleanupMissing / removeMissing / cleanupCorrupted / removeCorrupted。
 * missing 是文件被外部删除，corrupted 是文件存在但内容损坏；两组通道行为对称。
 * 删除/恢复/回收站通道见 `media-lifecycle-handler.ts`。
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs, schemas } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { MediaRepository } from '../../database/media-repository'
import { t } from '../../i18n'

export function registerMediaCleanupHandlers(ctx: HandlerContext): void {
  // 每次调用动态获取 Repository（db 可能在初始化/重连时变化）
  // 数据库写操作进程拆分：传入 workerBridge 与 dbPath，写方法走独立 utilityProcess
  const getRepo = (): MediaRepository => {
    const db = ctx.dbManager.getDatabase()
    if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
    return new MediaRepository(db, ctx.dbManager.getWorkerBridge(), ctx.dbManager.getDbPath())
  }

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
