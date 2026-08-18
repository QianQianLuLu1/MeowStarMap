import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs, schemas } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { runWithConcurrency } from '../../utils/concurrency'
import { MediaRepository } from '../../database/media-repository'
import type { GroupDimension, MediaSourceFilter } from '../../database/media-repository'
import type { OutfitStat } from '../../../shared/scene-category'

// 标签长度内部常量（与 utils/constants 的 MAX_TAG_NAME_LENGTH 保持一致，但避免循环依赖）
const MAX_TAG_NAME_LENGTH_INTERNAL = 64

/**
 * 媒体元数据域 IPC handler
 *
 * 覆盖：评分 / 收藏 / 标签 / 备注 / 分类 / 套装 / 场景时段 / 套装图鉴 / 列表 / 分组 / 搜索。
 * 所有 SQL 访问通过 MediaRepository，handler 仅做 zod 校验 + 副作用编排。
 */
export function registerMediaMetadataHandlers(ctx: HandlerContext): void {
  // 每次调用动态获取 Repository（db 可能在初始化/重连时变化）
  // 数据库写操作进程拆分：传入 workerBridge 与 dbPath，写方法走独立 utilityProcess
  const getRepo = (): MediaRepository => {
    const db = ctx.dbManager.getDatabase()
    if (!db) throw AppError.preconditionFailed('数据库未初始化')
    return new MediaRepository(db, ctx.dbManager.getWorkerBridge(), ctx.dbManager.getDbPath())
  }

  ipcMain.handle(
    'media:updateRating',
    wrapHandler(ctx, z.tuple([schemas.mediaId, schemas.rating]), async ([mediaId, rating]) => {
      await getRepo().updateRating(mediaId, rating)
      ctx.notifyMediaUpdated()
      return { updated: true }
    })
  )

  ipcMain.handle(
    'media:updateFavorite',
    wrapHandler(ctx, z.tuple([schemas.mediaId, z.boolean()]), async ([mediaId, isFavorite]) => {
      await getRepo().updateFavorite(mediaId, isFavorite)
      ctx.notifyMediaUpdated()
      return { updated: true }
    })
  )

  ipcMain.handle(
    'media:updateTags',
    wrapHandler(
      ctx,
      z.tuple([
        schemas.mediaId,
        z.array(schemas.shortString(MAX_TAG_NAME_LENGTH_INTERNAL)).max(100, '标签数量超过上限 100')
      ]),
      async ([mediaId, tags]) => {
        await getRepo().updateTags(mediaId, tags)
        ctx.notifyMediaUpdated()
        return { updated: true }
      }
    )
  )

  ipcMain.handle(
    'media:updateNotes',
    wrapHandler(
      ctx,
      z.tuple([schemas.mediaId, z.string().max(10000, 'notes 长度必须在 0-10000 之间')]),
      async ([mediaId, notes]) => {
        await getRepo().updateNotes(mediaId, notes)
        ctx.notifyMediaUpdated()
        return { updated: true }
      }
    )
  )

  ipcMain.handle(
    'media:updateCategory',
    wrapHandler(
      ctx,
      z.tuple([schemas.mediaId, schemas.positiveIntId.nullable()]),
      async ([mediaId, categoryId]) => {
        await getRepo().updateCategory(mediaId, categoryId)
        ctx.notifyMediaUpdated()
        return { updated: true }
      }
    )
  )

  // F-O1：更新套装标注
  ipcMain.handle(
    'media:updateOutfit',
    wrapHandler(
      ctx,
      z.tuple([schemas.mediaId, z.string().max(100, 'outfit 长度必须在 0-100 之间')]),
      async ([mediaId, outfit]) => {
        await getRepo().updateOutfit(mediaId, outfit)
        ctx.notifyMediaUpdated()
        return { updated: true }
      }
    )
  )

  // F-O1：批量分析图像场景时段（基于亮度直方图）
  ipcMain.handle(
    'media:analyzeSceneTime',
    wrapHandler(ctx, z.tuple([schemas.mediaIdArray.optional()]), async ([mediaIds]) => {
      const repo = getRepo()
      // 查询待分析的图片记录：未指定 ID 时分析全部 scene_time='unknown' 的图片
      const rows = repo.getMediaForSceneAnalysis(mediaIds)

      if (rows.length === 0) {
        return { message: '没有需要分析的图片', analyzed: 0 }
      }

      const { analyzeSceneBrightness } = await import('../../utils/scene-brightness')

      let analyzed = 0
      const tasks = rows.map((row) => async () => {
        const sceneTime = await analyzeSceneBrightness(row.file_path)
        await repo.updateSceneTime(row.id, sceneTime)
        analyzed++
      })
      await runWithConcurrency(tasks, 4)

      ctx.notifyMediaUpdated()
      return { message: `已分析 ${analyzed} 张图片的场景时段`, analyzed }
    })
  )

  // T03：套装图鉴统计
  ipcMain.handle(
    'media:getOutfitStats',
    wrapHandlerNoArgs(ctx, async () => {
      const repo = getRepo()
      const rows = repo.getOutfitAggStats()

      // 取每个套装最新一张的缩略图路径作为封面
      const stats: OutfitStat[] = []
      for (const row of rows) {
        const latest = repo.getLatestOutfitMedia(row.outfit)
        stats.push({
          outfit: row.outfit,
          count: row.count,
          latestCreatedAt: row.latest_created,
          coverFilePath: latest?.file_path || '',
          coverThumbnail: latest?.thumbnail || null
        })
      }
      return { stats }
    })
  )

  // 媒体列表
  ipcMain.handle(
    'media:list',
    wrapHandler(
      ctx,
      z.tuple([
        z
          .object({
            page: z.number().int().min(0).optional(),
            pageSize: z.number().int().positive().max(500).optional(),
            includeDeleted: z.boolean().optional(),
            deletedOnly: z.boolean().optional(),
            sortBy: z.string().max(64).optional(),
            sortOrder: z.string().max(16).optional(),
            accountUid: z.string().max(64).optional(),
            albumType: z.string().max(32).optional(),
            hideDuplicates: z.boolean().optional(),
            // 损坏文件容错：corruptedOnly 仅返回 is_corrupted=1 的记录（用于"仅看损坏"筛选器）
            corruptedOnly: z.boolean().optional(),
            // 默认隐藏损坏文件（hideCorrupted=true 时过滤 is_corrupted=1 的记录，图库默认视图）
            hideCorrupted: z.boolean().optional(),
            // 媒体来源过滤：'launcher' 用于启动器缓存视图，undefined 时后端默认排除 launcher
            mediaSource: z.enum(['game', 'launcher', 'cloud', 'all']).optional(),
            // 图库板块目录限制：true 时仅返回 ...\GamePlayPhotos\{uid}\NikkiPhotos_HighQuality 下的图片
            // 仅图库（gallery）视图传入；缓存/收藏/回收站/重复等板块不受影响
            galleryHighQualityOnly: z.boolean().optional()
          })
          .optional()
      ]),
      async ([options]) => {
        const result = getRepo().listMedia(options ?? {})
        return {
          files: result.rows.map((f) => ({
            ...f,
            id: String(f.id),
            is_favorite: Boolean(f.is_favorite),
            is_deleted: Boolean(f.is_deleted),
            is_missing: Boolean(f.is_missing),
            is_duplicate: Boolean(f.is_duplicate),
            is_corrupted: Boolean(f.is_corrupted)
          })),
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          hasMore: result.hasMore
        }
      }
    )
  )

  // P0-03：智能媒体分组——按维度统计分组数量
  ipcMain.handle(
    'media:getGroupCounts',
    wrapHandler(
      ctx,
      z.tuple([
        z.enum(['album_type', 'scene_category', 'scene_time', 'outfit', 'file_type']),
        z.string().max(64).optional(),
        z.enum(['game', 'launcher', 'cloud', 'all']).optional()
      ]),
      async ([dimension, accountUid, mediaSource]) => {
        const groups = getRepo().getGroupCounts(
          dimension as GroupDimension,
          accountUid,
          mediaSource as MediaSourceFilter | undefined
        )
        return { groups }
      }
    )
  )

  // 性能重构 v3 改造项二：全文搜索文件名（FTS5 优先，LIKE fallback）
  // 文档：docs/PERFORMANCE_REFACTOR_PLAN.md §3.6
  // 调用方：渲染进程 electronAPI.media.search(keyword)
  ipcMain.handle(
    'media:search',
    wrapHandler(
      ctx,
      z.tuple([z.string().min(1).max(200), z.number().int().positive().max(1000).optional()]),
      async ([keyword, limit]) => {
        const rows = getRepo().searchByFileName(keyword, limit ?? 200)
        return {
          results: rows,
          total: rows.length,
          usedFts5: getRepo().isFts5Available()
        }
      }
    )
  )
}
