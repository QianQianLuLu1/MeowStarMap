import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs, schemas } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { t } from '../../i18n'

/**
 * 收藏夹域 IPC handler（示例）
 *
 * 覆盖：收藏项的添加 / 移除 / 列表查询。
 * 用于演示 ipc-handler skill 的完整流程。
 */
export function registerFavoritesHandlers(ctx: HandlerContext): void {
  // 每次调用动态获取 db（db 可能在初始化/重连时变化）
  const getDb = () => {
    const db = ctx.dbManager.getDatabase()
    if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
    return db
  }

  // 获取收藏列表
  ipcMain.handle(
    'favorites:list',
    wrapHandlerNoArgs(ctx, async () => {
      const db = getDb()
      const rows = db
        .prepare('SELECT id, media_id, created_at FROM favorites ORDER BY created_at DESC')
        .all() as Array<{ id: number; media_id: number; created_at: string }>
      return { favorites: rows }
    })
  )

  // 添加收藏
  ipcMain.handle(
    'favorites:add',
    wrapHandler(ctx, z.tuple([schemas.mediaId]), async ([mediaId]) => {
      const db = getDb()
      const existing = db.prepare('SELECT id FROM favorites WHERE media_id = ?').get(mediaId) as
        { id: number } | undefined
      if (existing) {
        throw AppError.validation(t('main.favorites.alreadyExists', { mediaId }))
      }
      const info = db
        .prepare('INSERT INTO favorites (media_id, created_at) VALUES (?, datetime("now"))')
        .run(mediaId)
      return { id: info.lastInsertRowid as number }
    })
  )

  // 移除收藏
  ipcMain.handle(
    'favorites:remove',
    wrapHandler(ctx, z.tuple([schemas.mediaId]), async ([mediaId]) => {
      const db = getDb()
      const result = db.prepare('DELETE FROM favorites WHERE media_id = ?').run(mediaId)
      if (result.changes === 0) {
        throw AppError.notFound(t('main.favorites.notFound', { mediaId }))
      }
      return { removed: true }
    })
  )
}
