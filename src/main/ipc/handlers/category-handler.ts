import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs, schemas } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { MediaRepository } from '../../database/media-repository'
import { t } from '../../i18n'

/**
 * 分类管理域 IPC handler
 *
 * 覆盖：分类的创建 / 更新 / 删除 / 重排 / 列表。
 * update 含动态字段名拼接，通过 allowedFields 白名单防 SQL 注入。
 * delete 级联清理 media_files.category_id。
 */
export function registerCategoryHandlers(ctx: HandlerContext): void {
  // 每次调用动态获取 Repository（db 可能在初始化/重连时变化）
  // 数据库写操作进程拆分：传入 workerBridge 与 dbPath，写方法走独立 utilityProcess
  const getRepo = (): MediaRepository => {
    const db = ctx.dbManager.getDatabase()
    if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
    return new MediaRepository(db, ctx.dbManager.getWorkerBridge(), ctx.dbManager.getDbPath())
  }

  // ============ 分类持久化 ============
  ipcMain.handle(
    'category:create',
    wrapHandler(
      ctx,
      z.tuple([
        schemas.shortString(64),
        z
          .object({
            icon: z.string().max(64).optional(),
            color: z.string().max(32).optional(),
            parentId: schemas.positiveIntId.optional()
          })
          .optional()
      ]),
      async ([name, options]) => {
        const id = await getRepo().createCategory(
          name,
          options?.icon || 'folder',
          options?.color || '#888888',
          options?.parentId || null
        )
        return { id }
      }
    )
  )

  ipcMain.handle(
    'category:update',
    wrapHandler(
      ctx,
      z.tuple([
        schemas.positiveIntId,
        z.object({
          name: schemas.shortString(64).optional(),
          icon: z.string().max(64).optional(),
          color: z.string().max(32).optional(),
          parent_id: schemas.positiveIntId.nullable().optional()
        })
      ]),
      async ([id, updates]) => {
        const allowedFields = ['name', 'icon', 'color', 'parent_id']
        const fields: string[] = []
        const values: unknown[] = []
        for (const [key, value] of Object.entries(updates)) {
          if (!allowedFields.includes(key)) continue
          fields.push(`${key} = ?`)
          values.push(value)
        }
        if (fields.length === 0) {
          throw AppError.validation(t('main.category.error.noUpdatableFields'))
        }
        await getRepo().updateCategoryFields(id, fields, values)
        return { updated: true }
      }
    )
  )

  ipcMain.handle(
    'category:delete',
    wrapHandler(ctx, z.tuple([schemas.positiveIntId]), async ([id]) => {
      // FIX(组8-1): 系统分类前置拒绝——原实现 DELETE ... AND is_system = 0 影响 0 行时，
      // 事务内 UPDATE 仍会清空该系统分类下 media_files.category_id（数据损伤），
      // 且无条件返回 deleted:true 误报成功。前置校验使前端得到明确错误而非假成功
      const repo = getRepo()
      if (repo.isSystemCategory(id)) {
        throw AppError.validation(t('main.category.error.systemCategoryUndeletable'))
      }
      // F-G9：删除分类前级联清理 media_files.category_id
      await repo.deleteCategoryCascade(id)
      return { deleted: true }
    })
  )

  ipcMain.handle(
    'category:reorder',
    wrapHandler(
      ctx,
      z.tuple([
        z
          .array(
            z.object({
              id: schemas.positiveIntId,
              sort_order: z.number().int().min(0),
              parent_id: schemas.positiveIntId.nullable().optional()
            })
          )
          .min(1, t('main.category.error.ordersRequired'))
          .max(500, t('main.category.error.ordersMax'))
      ]),
      async ([orders]) => {
        await getRepo().reorderCategories(orders)
        return { reordered: true }
      }
    )
  )

  ipcMain.handle(
    'category:list',
    wrapHandlerNoArgs(ctx, async () => {
      const rows = getRepo().listCategories()
      return {
        categories: rows.map((c) => ({ ...c, is_system: Boolean(c.is_system) }))
      }
    })
  )
}
