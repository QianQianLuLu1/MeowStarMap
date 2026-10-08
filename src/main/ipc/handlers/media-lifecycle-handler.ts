// @core-change: 清空回收站移除主进程 dialog 二次确认，与 media:permanentDelete 对齐，消除重复弹窗与取消误报 IPC_CANCELED
/**
 * 媒体生命周期域 IPC handler：删除 / 恢复 / 回收站
 *
 * 覆盖：物理删除记录 / 软删除 / 恢复 / 彻底删除 / 清空回收站。
 * 彻底删除采用三阶段事务保证 DB 与文件系统一致；二次确认由渲染端 ConfirmDialog 承担。
 * 回收站批量操作工具（含缩略图清理：缓存三档位 + 原生 LQ 及其 DB 记录）见 `_trash-utils.ts`；丢失与损坏记录清理见 `media-cleanup-handler.ts`。
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs, schemas } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { MediaRepository } from '../../database/media-repository'
import { unlinkBatch, cleanupThumbnailsForRows, makeNativeThumbRecordCleaner } from './_trash-utils'
import { t } from '../../i18n'

/**
 * 媒体生命周期域 IPC handler
 *
 * 覆盖：物理删除记录 / 软删除 / 恢复 / 彻底删除 / 清空回收站。
 * 彻底删除与清空回收站的二次确认均由渲染端 ConfirmDialog 承担；彻底删除采用三阶段事务保证 DB 与文件系统一致。
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
      const repo = getRepo()
      // #fix-permanent-delete-error-toast：物理删除前先取缩略图路径，删除记录后清理缓存
      // #fix-gallery-delete-thumbnail-cleanup：清理范围扩展为缓存三档位 + 严格推导的游戏原生 LQ
      //（LQ 文件本身也是入库媒体记录，删除后同步硬删其 DB 记录，避免悬空记录）
      const rows = repo.getMediaPathsByIds([mediaId])
      await repo.hardDelete(mediaId)
      await cleanupThumbnailsForRows(rows, ctx.thumbnailGen.getCacheDir(), {
        onNativeThumbnailRemoved: makeNativeThumbRecordCleaner(repo)
      })
      ctx.notifyMediaUpdated()
      return { deleted: true }
    })
  )

  // F-S6 回收站：软删除
  ipcMain.handle(
    'media:softDelete',
    wrapHandler(ctx, z.tuple([schemas.mediaIdArrayBulk]), async ([mediaIds]) => {
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
    wrapHandler(ctx, z.tuple([schemas.mediaIdArrayBulk]), async ([mediaIds]) => {
      await getRepo().restoreBatch(mediaIds)
      ctx.notifyMediaUpdated()
      return { message: t('main.media.message.restored', { count: mediaIds.length }) }
    })
  )

  // F-S6 回收站：彻底删除（三阶段事务；二次确认由渲染端 ConfirmDialog 承担）
  ipcMain.handle(
    'media:permanentDelete',
    wrapHandler(ctx, z.tuple([schemas.mediaIdArrayBulk]), async ([mediaIds]) => {
      // #fix-permanent-delete-error-toast：原实现在此处再弹一次原生 dialog 二次确认，
      // 但全部渲染端调用方（图库/回收站/重复页）已在调用前经 ConfirmDialog 确认过——
      // 用户需重复确认，回收站批量场景每个 id 弹一次；取消时还会向渲染端抛
      // canceled 误报「出错」。二次确认职责回归渲染端，主进程不再弹窗。

      const repo = getRepo()
      // 查询文件路径（含缩略图，供阶段 4 清理缓存）
      const rows = repo.getMediaPathsByIds(mediaIds)

      // F-S1 三阶段：①事务软删除标记 ②逐个物理删除文件（fsp.unlink） ③事务物理删除已处理记录
      // 保证 DB 与文件系统一致：中断后 DB 仍有 is_deleted=1 记录，用户可重试

      // 阶段1：幂等软删除标记
      await repo.softDeleteForPermanentDelete(rows.map((r) => r.id))

      // 阶段2：逐个物理删除文件（#fix-recyclebin-permanent-delete：
      // 原用 shell.trashItem 只是把文件移入系统回收站，磁盘不释放；现改 fsp.unlink 真正删除），
      // 区分「成功」「文件已不存在」「失败」
      const { idsToDelete, failedPaths } = await unlinkBatch(rows)

      // 阶段3：事务中物理删除已成功处理的记录
      await repo.hardDeleteBatch(idsToDelete)

      // 阶段 4：清理已删除记录的缩略图（best-effort；#fix-gallery-delete-thumbnail-cleanup：
      // 缓存三档位 + 由 file_path 严格推导的游戏原生 LQ 文件及其 DB 记录）
      const deletedRows = rows.filter((r) => idsToDelete.includes(r.id))
      await cleanupThumbnailsForRows(deletedRows, ctx.thumbnailGen.getCacheDir(), {
        onNativeThumbnailRemoved: makeNativeThumbRecordCleaner(repo)
      })

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

      // 回收站语义修复 D5：二次确认由渲染端 ConfirmDialog 承担（与 media:permanentDelete
      // 同构）——原实现此处再弹一次原生 dialog，用户需重复确认，且取消时抛 canceled
      // 被渲染端误报「清空失败」。

      // B1 修复：文件删除失败且文件仍存在时，不删除 DB 记录，保留供用户重试。
      // 仅当文件物理删除成功 或 文件已不存在（DB 踪迹已无对应实体）时才删除 DB。
      const { idsToDelete, movedCount, missingCount, failedPaths } = await unlinkBatch(rows)
      await repo.hardDeleteBatch(idsToDelete)

      // #fix-recyclebin-permanent-delete：阶段 4 清理已删除记录的缩略图
      //（与 media:permanentDelete 阶段 4 同构，best-effort）——
      // 修复前缺失此阶段，清空回收站后缩略图缓存文件残留为孤儿。
      // #fix-gallery-delete-thumbnail-cleanup：清理范围扩展为缓存三档位 +
      // 由 file_path 严格推导的游戏原生 LQ 文件及其 DB 记录。
      const deletedRows = rows.filter((r) => idsToDelete.includes(r.id))
      await cleanupThumbnailsForRows(deletedRows, ctx.thumbnailGen.getCacheDir(), {
        onNativeThumbnailRemoved: makeNativeThumbRecordCleaner(repo)
      })

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
}
