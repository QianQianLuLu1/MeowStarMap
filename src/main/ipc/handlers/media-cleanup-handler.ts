// @core-change: sync-integration 阶段5：清理硬删接线同步变更日志（候选 id 批量 journal asset.deleted）
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
import { logger } from '../../utils/logger'
import { t } from '../../i18n'

export function registerMediaCleanupHandlers(ctx: HandlerContext): void {
  // 每次调用动态获取 Repository（db 可能在初始化/重连时变化）
  // 数据库写操作进程拆分：传入 workerBridge 与 dbPath，写方法走独立 utilityProcess
  const getRepo = (): MediaRepository => {
    const db = ctx.dbManager.getDatabase()
    if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
    return new MediaRepository(db, ctx.dbManager.getWorkerBridge(), ctx.dbManager.getDbPath())
  }

  // sync-integration 阶段5：清理硬删落账——删除谓词（全量 is_missing/is_corrupted=1）
  // 是候选查询（且 is_duplicate=0，同步资产域）的超集，cleared ≥ 候选数即可断言候选
  // 已全部删除；计数不一致（并发删/部分失败）保守跳过 journal，避免对仍存在的资产行
  // 发出 asset.deleted 误报。
  const journalCleanupDeletions = async (
    candidateIds: number[],
    cleared: number
  ): Promise<void> => {
    if (!ctx.syncEvents || candidateIds.length === 0) return
    if (cleared < candidateIds.length) {
      logger.warn(
        `[Sync] cleanup deleted ${cleared} rows but ${candidateIds.length} candidates were captured; skip journaling`
      )
      return
    }
    await ctx.syncEvents.recordAssetChanges(
      candidateIds.map((id) => ({ eventType: 'asset.deleted' as const, assetId: String(id) }))
    )
  }

  // T02：清理丢失记录
  ipcMain.handle(
    'media:cleanupMissing',
    wrapHandlerNoArgs(ctx, async () => {
      const repo = getRepo()
      const candidateIds = repo.listCleanupCandidateIds('missing')
      const cleared = await repo.cleanupMissingRecords()
      await journalCleanupDeletions(candidateIds, cleared)
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
      await ctx.syncEvents?.recordAssetChange('asset.deleted', String(mediaId))
      ctx.notifyMediaUpdated()
      return { message: t('main.media.message.missingRemoved') }
    })
  )

  // 损坏文件容错：清理所有 is_corrupted=1 的记录（用户确认后批量删除）
  // 与 cleanupMissing 对称：missing 是文件被外部删除，corrupted 是文件存在但内容损坏
  ipcMain.handle(
    'media:cleanupCorrupted',
    wrapHandlerNoArgs(ctx, async () => {
      const repo = getRepo()
      const candidateIds = repo.listCleanupCandidateIds('corrupted')
      const cleared = await repo.cleanupCorruptedRecords()
      await journalCleanupDeletions(candidateIds, cleared)
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
      await ctx.syncEvents?.recordAssetChange('asset.deleted', String(mediaId))
      ctx.notifyMediaUpdated()
      return { message: t('main.media.message.corruptedRemoved') }
    })
  )
}
