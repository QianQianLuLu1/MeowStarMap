import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs, schemas } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { MediaRepository } from '../../database/media-repository'
import { t } from '../../i18n'

/**
 * 角色档案管理域 IPC handler
 *
 * 覆盖：档案列表 / 添加 / 更新 / 删除 / 设置当前 / 跨档案转移文件 / 档案统计。
 * update 含动态字段名拼接（仅 nickname / avatar 进白名单）。
 * delete 保护 default 档案，删除前将文件迁移到 default。
 */
export function registerProfileHandlers(ctx: HandlerContext): void {
  // 每次调用动态获取 Repository（db 可能在初始化/重连时变化）
  // 数据库写操作进程拆分：传入 workerBridge 与 dbPath，写方法走独立 utilityProcess
  const getRepo = (): MediaRepository => {
    const db = ctx.dbManager.getDatabase()
    if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
    return new MediaRepository(db, ctx.dbManager.getWorkerBridge(), ctx.dbManager.getDbPath())
  }

  // ============ P0-02：角色档案管理 ============
  ipcMain.handle(
    'profile:list',
    wrapHandlerNoArgs(ctx, async () => {
      const profiles = getRepo().listProfiles()
      return { profiles }
    })
  )

  ipcMain.handle(
    'profile:add',
    wrapHandler(
      ctx,
      z.tuple([schemas.uid, schemas.shortString(64), z.string().max(1024).optional()]),
      async ([uid, nickname, avatar]) => {
        try {
          await getRepo().addProfile(uid, nickname, avatar ?? null)
          return { added: true }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          if (/UNIQUE constraint/i.test(msg)) {
            throw AppError.conflict(t('main.profile.error.uidExists'))
          }
          throw error
        }
      }
    )
  )

  ipcMain.handle(
    'profile:update',
    wrapHandler(
      ctx,
      z.tuple([schemas.uid, schemas.shortString(64).optional(), z.string().max(1024).optional()]),
      async ([uid, nickname, avatar]) => {
        const sets: string[] = []
        const params: unknown[] = []
        if (nickname !== undefined) {
          sets.push('nickname = ?')
          params.push(nickname)
        }
        if (avatar !== undefined) {
          sets.push('avatar = ?')
          params.push(avatar)
        }
        if (sets.length === 0) return { updated: true }
        await getRepo().updateProfileFields(uid, sets, params)
        return { updated: true }
      }
    )
  )

  ipcMain.handle(
    'profile:delete',
    wrapHandler(ctx, z.tuple([schemas.uid]), async ([uid]) => {
      if (uid === 'default') {
        throw AppError.forbidden(t('main.profile.error.defaultUndeletable'))
      }
      // 删除档案前，将该档案下的文件迁移到默认档案
      await getRepo().deleteProfileAndReassign(uid)
      return { deleted: true }
    })
  )

  ipcMain.handle(
    'profile:setCurrent',
    wrapHandler(ctx, z.tuple([schemas.uid]), async ([uid]) => {
      await getRepo().touchProfileActive(uid)
      ctx.dbManager.setSetting('currentProfileUid', uid)
      return { updated: true }
    })
  )

  // P1-04：跨档案转移文件
  // 与 media:softDelete/restore/permanentDelete 同理：批量入口放开 1000 上限，
  // 下游 transferFilesToProfile 经 runChunkedTransaction 已按 500 分片
  ipcMain.handle(
    'profile:transferFiles',
    wrapHandler(
      ctx,
      z.tuple([schemas.mediaIdArrayBulk, schemas.uid]),
      async ([mediaIds, targetUid]) => {
        const repo = getRepo()
        const profile = repo.getProfileByUid(targetUid)
        if (!profile) {
          throw AppError.notFound(t('main.profile.error.targetNotFound', { uid: targetUid }))
        }
        await repo.transferFilesToProfile(mediaIds, targetUid)
        return {
          message: t('main.profile.message.transferred', {
            count: mediaIds.length,
            uid: targetUid
          }),
          transferred: mediaIds.length
        }
      }
    )
  )

  ipcMain.handle(
    'profile:getStats',
    wrapHandler(ctx, z.tuple([schemas.uid]), async ([uid]) => {
      const repo = getRepo()
      const baseStats = repo.getProfileBaseStats(uid)
      const outfitStats = repo.getProfileTopOutfits(uid)
      const sceneStats = repo.getProfileTopScenes(uid)
      const timeStats = repo.getProfileTimeDistribution(uid)

      return {
        stats: {
          totalCount: baseStats.total_count ?? 0,
          imageCount: baseStats.image_count ?? 0,
          videoCount: baseStats.video_count ?? 0,
          totalSize: baseStats.total_size ?? 0,
          earliestTime: baseStats.earliest_time,
          latestTime: baseStats.latest_time,
          topOutfits: outfitStats,
          topScenes: sceneStats,
          timeDistribution: timeStats
        }
      }
    })
  )
}
