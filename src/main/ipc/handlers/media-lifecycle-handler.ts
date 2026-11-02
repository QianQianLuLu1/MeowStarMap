// @core-change: 清空回收站新增可选 force 参数——用户显式同意后可跳过系统回收站直接彻底删除，救活「卷级不接受 shell.trashItem」场景（真机 H 盘 41 项恒失败）
/**
 * 媒体生命周期域 IPC handler：删除 / 恢复 / 回收站
 *
 * 覆盖：物理删除记录 / 软删除 / 恢复 / 彻底删除 / 清空回收站。
 * 彻底删除采用三阶段事务保证 DB 与文件系统一致；二次确认由渲染端 ConfirmDialog 承担。
 * 回收站批量操作工具（含缩略图清理：缓存三档位 + 同图衍生文件及其 DB 记录）见 `_trash-utils.ts`；丢失与损坏记录清理见 `media-cleanup-handler.ts`。
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, schemas } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { MediaRepository } from '../../database/media-repository'
import { trashBatch, cleanupThumbnailsForRows, makeNativeThumbRecordCleaner } from './_trash-utils'
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
      // #fix-gallery-delete-thumbnail-cleanup：清理范围扩展为缓存三档位 + 严格推导的游戏原生同图衍生文件
      // #fix-permanent-delete-game-photo-variants：衍生文件含 LQ 与 X6Game\ScreenShot 同名副本
      //（它们本身也是入库媒体记录，删除后同步硬删其 DB 记录，避免悬空记录）
      const rows = repo.getMediaPathsByIds([mediaId])
      await repo.hardDelete(mediaId)
      await cleanupThumbnailsForRows(rows, ctx.thumbnailGen.getCacheDir(), {
        onNativeThumbnailRemoved: makeNativeThumbRecordCleaner(repo, ctx.thumbnailGen.getCacheDir())
      })
      await ctx.syncEvents?.recordAssetChange('asset.deleted', String(mediaId))
      ctx.notifyMediaUpdated()
      return { deleted: true }
    })
  )

  // F-S6 回收站：软删除
  ipcMain.handle(
    'media:softDelete',
    wrapHandler(ctx, z.tuple([schemas.mediaIdArrayBulk]), async ([mediaIds]) => {
      await getRepo().softDeleteBatch(mediaIds)
      // 同步变更日志：批量写 journal（合并广播最后一条，防移动端事件风暴）
      await ctx.syncEvents?.recordAssetChanges(
        mediaIds.map((id) => ({ eventType: 'asset.deleted' as const, assetId: String(id) }))
      )
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
      await ctx.syncEvents?.recordAssetChanges(
        mediaIds.map((id) => ({ eventType: 'asset.updated' as const, assetId: String(id) }))
      )
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

      // F-S1 三阶段：①事务软删除标记 ②逐个移入系统回收站（shell.trashItem） ③事务物理删除已处理记录
      // 保证 DB 与文件系统一致：中断后 DB 仍有 is_deleted=1 记录，用户可重试

      // 阶段1：幂等软删除标记
      await repo.softDeleteForPermanentDelete(rows.map((r) => r.id))

      // 阶段2：逐个移入系统回收站（#fix-empty-recyclebin-system-trash：
      // a5d154c 曾改 fsp.unlink 物理删除，但回收站页确认文案始终承诺「文件会先移至
      // 系统回收站」；且 80d910a 后文件留在原位，unlink 会 100% 永久删除用户文件。
      // 旧「Shell API 大批量 94.5% 失败」是旧架构删除时已搬走文件所致，前提已消失），
      // 区分「成功」「文件已不存在」「失败」
      const { idsToDelete, failedPaths } = await trashBatch(rows)

      // 阶段3：事务中物理删除已成功处理的记录
      await repo.hardDeleteBatch(idsToDelete)

      // 阶段 4：清理已删除记录的缩略图（best-effort；#fix-gallery-delete-thumbnail-cleanup：
      // 缓存三档位 + 由 file_path 严格推导的游戏原生同图衍生文件及其 DB 记录）
      const deletedRows = rows.filter((r) => idsToDelete.includes(r.id))
      await cleanupThumbnailsForRows(deletedRows, ctx.thumbnailGen.getCacheDir(), {
        onNativeThumbnailRemoved: makeNativeThumbRecordCleaner(repo, ctx.thumbnailGen.getCacheDir())
      })

      await ctx.syncEvents?.recordAssetChanges(
        idsToDelete.map((id) => ({ eventType: 'asset.deleted' as const, assetId: String(id) }))
      )
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
  // #fix-empty-recyclebin-failed-as-success：新增可选 force。
  // 真机取证（「同卷换路径形态 / 同形态换卷」分离实验，结论见 docs/plans/
  // 2026-11-02-fix-empty-recyclebin-failed-as-success-实施计划.md 节点 0）：同一 Electron
  // 进程在 C 盘可正常移入系统回收站（空格与非 ASCII 路径同样正常），而 H 盘连刚新建的
  // ASCII 无空格文件也返回 `Failed to perform delete operation` ⇒ 属**卷级**不可用，重试永远失败。
  // 原 B1 行为（移入失败且文件仍在时保留 DB 记录）是正确的，但用户没有任何出路；force 把
  // 「直接永久删除」的选择权交回用户，仅在渲染端就「不经过系统回收站、不可恢复」显式二次
  // 确认后传入。零实参调用 ⇒ force=false ⇒ 行为不变。
  ipcMain.handle(
    'media:emptyRecycleBin',
    wrapHandler(ctx, z.tuple([z.boolean().optional()]), async ([force]) => {
      const forceMode = force === true
      const repo = getRepo()
      const rows = repo.getSoftDeletedMediaPaths()

      if (rows.length === 0) {
        return {
          message: t('main.media.message.recycleBinEmpty'),
          movedCount: 0,
          missingCount: 0,
          failedCount: 0,
          forceDeletedCount: 0
        }
      }

      // 回收站语义修复 D5：二次确认由渲染端 ConfirmDialog 承担（与 media:permanentDelete
      // 同构）——原实现此处再弹一次原生 dialog，用户需重复确认，且取消时抛 canceled
      // 被渲染端误报「清空失败」。

      // B1 修复：移入系统回收站失败且文件仍存在时，不删除 DB 记录，保留供用户重试。
      // 仅当文件移入成功 或 文件已不存在（DB 踪迹已无对应实体）时才删除 DB。
      // force 模式下同一不变式成立：unlink 失败且文件仍在 ⇒ 记录保留。
      const { idsToDelete, movedCount, missingCount, failedPaths, forceDeletedCount } =
        await trashBatch(rows, { force: forceMode })
      await repo.hardDeleteBatch(idsToDelete)

      // #fix-recyclebin-permanent-delete：阶段 4 清理已删除记录的缩略图
      //（与 media:permanentDelete 阶段 4 同构，best-effort）——
      // 修复前缺失此阶段，清空回收站后缩略图缓存文件残留为孤儿。
      // #fix-gallery-delete-thumbnail-cleanup：清理范围扩展为缓存三档位 +
      // 由 file_path 严格推导的游戏原生同图衍生文件及其 DB 记录。
      const deletedRows = rows.filter((r) => idsToDelete.includes(r.id))
      await cleanupThumbnailsForRows(deletedRows, ctx.thumbnailGen.getCacheDir(), {
        onNativeThumbnailRemoved: makeNativeThumbRecordCleaner(repo, ctx.thumbnailGen.getCacheDir())
      })

      await ctx.syncEvents?.recordAssetChanges(
        idsToDelete.map((id) => ({ eventType: 'asset.deleted' as const, assetId: String(id) }))
      )
      ctx.notifyMediaUpdated()
      // force 下 movedCount（移入系统回收站数）恒为 0，成功数取 forceDeletedCount + missingCount；
      // 文案必须分支：非 force 的 partial 文案写「已移入系统回收站」，在 force 下是假话。
      const succeededCount = forceMode ? forceDeletedCount + missingCount : idsToDelete.length
      const msg =
        failedPaths.length > 0
          ? forceMode
            ? t('main.media.message.permanentDeletePartialForce', {
                deleted: succeededCount,
                failed: failedPaths.length
              })
            : t('main.media.message.permanentDeletePartial', {
                deleted: succeededCount,
                failed: failedPaths.length
              })
          : forceMode
            ? t('main.media.message.permanentDeleted', { count: succeededCount })
            : t('main.media.message.recycleBinEmptied', { count: movedCount + missingCount })
      return {
        message: msg,
        movedCount,
        missingCount,
        failedCount: failedPaths.length,
        forceDeletedCount
      }
    })
  )
}
