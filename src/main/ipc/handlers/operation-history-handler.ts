import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs, schemas } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { MediaRepository } from '../../database/media-repository'
import { t } from '../../i18n'

/**
 * operation-history 域 IPC handler：操作历史持久化（支持跨重启撤销）。
 *
 * R8：撤销乐观锁——
 * - add 时若 mediaId 存在，读取 media_files.updated_at 写入 snapshot_updated_at。
 * - checkConflict 比对当前 media_files.updated_at 与 snapshot_updated_at，
 *   不一致说明操作发生后媒体被独立修改，前端应弹窗确认是否仍要撤销。
 */
export function registerOperationHistoryHandlers(ctx: HandlerContext): void {
  // ---- operation-history 域 ----
  // 建议改#9：操作历史持久化 IPC（支持跨重启撤销）
  // 新增记录，返回自增 id
  ipcMain.handle(
    'operation-history:add',
    wrapHandler(
      ctx,
      z.tuple([
        z.object({
          operationType: z
            .string()
            .min(1, t('main.operationHistory.validation.operationTypeRequired'))
            .max(64),
          mediaId: z.number().int().positive().optional(),
          payload: z.unknown(),
          description: z.string().min(1).max(512),
          createdAt: z.string().min(1).max(64)
        })
      ]),
      async ([record]) => {
        const db = ctx.dbManager.getDatabase()
        if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))

        // R8：捕获操作发生时对应媒体的 updated_at 快照（若 mediaId 存在且已迁移字段）。
        // 旧库无 updated_at 列时 prepare 抛错，catch 后置 null（跳过冲突检测，兼容老版本）。
        let snapshotUpdatedAt: string | null = null
        if (record.mediaId != null) {
          try {
            const repo = new MediaRepository(
              db,
              ctx.dbManager.getWorkerBridge(),
              ctx.dbManager.getDbPath()
            )
            snapshotUpdatedAt = repo.getMediaUpdatedAt(record.mediaId)
          } catch {
            // 字段未迁移或 mediaId 不存在，置 null（撤销时跳过冲突检测）
          }
        }

        const result = db
          .prepare(
            'INSERT INTO operation_history (operation_type, media_id, payload, description, created_at, snapshot_updated_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(
            record.operationType,
            record.mediaId ?? null,
            JSON.stringify(record.payload),
            record.description,
            record.createdAt,
            snapshotUpdatedAt
          )
        return { id: Number(result.lastInsertRowid) }
      }
    )
  )

  // 查询最近 N 条记录（按时间正序，栈顶在末尾）
  ipcMain.handle(
    'operation-history:list',
    wrapHandler(ctx, z.tuple([z.number().int().min(1).max(50).optional()]), async ([limitOpt]) => {
      const db = ctx.dbManager.getDatabase()
      if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
      const safeLimit = limitOpt ?? 50
      const rows = db
        .prepare(
          'SELECT id, operation_type, media_id, payload, description, created_at, snapshot_updated_at FROM operation_history ORDER BY created_at DESC LIMIT ?'
        )
        .all(safeLimit) as Array<{
        id: number
        operation_type: string
        media_id: number | null
        payload: string
        description: string
        created_at: string
        snapshot_updated_at: string | null
      }>
      // 反转为正序（栈顶在末尾），与内存栈一致
      const records = rows.reverse().map((r) => ({
        id: r.id,
        operationType: r.operation_type,
        mediaId: r.media_id,
        payload: r.payload,
        description: r.description,
        createdAt: r.created_at,
        snapshotUpdatedAt: r.snapshot_updated_at
      }))
      return { records }
    })
  )

  // 删除指定 id 的记录（撤销成功后调用）
  ipcMain.handle(
    'operation-history:remove',
    wrapHandler(ctx, z.tuple([schemas.positiveIntId]), async ([id]) => {
      const db = ctx.dbManager.getDatabase()
      if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
      db.prepare('DELETE FROM operation_history WHERE id = ?').run(id)
      return { removed: true }
    })
  )

  // 清空所有操作历史
  ipcMain.handle(
    'operation-history:clear',
    wrapHandlerNoArgs(ctx, async () => {
      const db = ctx.dbManager.getDatabase()
      if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
      db.prepare('DELETE FROM operation_history').run()
      return { cleared: true }
    })
  )

  // R8：撤销前乐观锁冲突检测。
  // 比对 operation_history.snapshot_updated_at 与 media_files.updated_at：
  //   - snapshot 为 NULL（旧记录/老库未迁移）→ 无冲突，跳过检测
  //   - media 不存在或 updated_at 为 NULL → 无冲突（media 已被物理删除或从未被用户操作）
  //   - 两者一致 → 无冲突
  //   - 两者不一致 → 冲突，前端应弹窗确认
  ipcMain.handle(
    'operation-history:checkConflict',
    wrapHandler(ctx, z.tuple([schemas.positiveIntId]), async ([operationId]) => {
      const db = ctx.dbManager.getDatabase()
      if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
      const row = db
        .prepare('SELECT media_id, snapshot_updated_at FROM operation_history WHERE id = ?')
        .get(operationId) as
        { media_id: number | null; snapshot_updated_at: string | null } | undefined
      if (!row) {
        // 操作记录不存在（可能已被清理），不阻塞撤销
        return { conflict: false, reason: 'not_found' as const }
      }
      // snapshot 为 NULL：旧记录无快照，跳过冲突检测（仅对新操作生效）
      if (row.snapshot_updated_at == null) {
        return { conflict: false, reason: 'no_snapshot' as const }
      }
      // media_id 为 NULL：操作不针对具体媒体（如 file_move 无 mediaId），跳过
      if (row.media_id == null) {
        return { conflict: false, reason: 'no_media' as const }
      }
      const repo = new MediaRepository(
        db,
        ctx.dbManager.getWorkerBridge(),
        ctx.dbManager.getDbPath()
      )
      const currentUpdatedAt = repo.getMediaUpdatedAt(row.media_id)
      // media 已被物理删除或未迁移 updated_at 字段 → 无冲突
      if (currentUpdatedAt == null) {
        return { conflict: false, reason: 'media_missing' as const }
      }
      if (currentUpdatedAt !== row.snapshot_updated_at) {
        return { conflict: true, reason: 'modified' as const }
      }
      return { conflict: false, reason: 'match' as const }
    })
  )
}
