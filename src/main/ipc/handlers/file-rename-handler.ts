// @core-change: 移动/重命名源路径读校验并入媒体授权三级口径，与导出/删除对齐（替换阶段4原因串）
/**
 * 文件操作域 IPC handler：重命名 / 移动
 *
 * 覆盖：file:move / file:rename / file:batchRename。
 * 操作成功后调用 syncMediaFilesAfterRename 同步 media_files.file_path/file_name，
 * DB 失败走反向回滚 + pending_renames 补偿。
 * 删除/复制/导出等通道见 `file.ts` 与 `file-export-handler.ts`。
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, schemas, assertFileWritePath } from '../validator'
import { assertMediaAccessPath } from '../media-read-guard'
import { moveFile } from '../../utils/file-utils'
// 日志管理
import { logger } from '../../utils/logger'
import { t } from '../../i18n'

// A11：单次批量重命名的操作数上限（防止一次请求撑爆磁盘操作与 DB 事务）
const MAX_BATCH_RENAME_SIZE = 999

/**
 * R3：单条/批量 rename、move 操作后同步 media_files.file_path/file_name 的共享工具函数。
 *
 * 行为：
 * - DB 事务内对每条记录执行 `UPDATE media_files SET file_path=newPath, file_name=newFileName WHERE file_path=oldPath`。
 * - DB 失败时复用 R2 补偿机制：反向回滚磁盘（moveFile newPath→oldPath）；回滚失败的项写入
 *   `pending_renames` 补偿表，由 `startup-tasks.retryPendingRenames` 在下次启动时让 DB 接受新路径。
 * - 无论回滚是否成功，DB 失败的错误都向上抛，让前端感知失败而非静默成功。
 *
 * 设计目标：让 `file:rename` / `file:move` / `file:batchRename` 三处 handler 共享同一份
 * DB 同步+补偿逻辑，避免代码重复（极简健壮开发者信条：发现两个相似函数就合并）。
 */
type RenameRecord = { oldPath: string; newPath: string; newFileName: string }

async function syncMediaFilesAfterRename(
  db: Database.Database,
  renamed: RenameRecord[],
  onAssetsChanged?: (mediaIds: number[]) => void
): Promise<void> {
  if (renamed.length === 0) return
  const updateStmt = db.prepare(
    'UPDATE media_files SET file_path = ?, file_name = ? WHERE file_path = ?'
  )
  const selectIdStmt = db.prepare('SELECT id FROM media_files WHERE file_path = ?')
  const tx = db.transaction((rows: RenameRecord[]) => {
    for (const r of rows) {
      updateStmt.run(r.newPath, r.newFileName, r.oldPath)
    }
  })
  try {
    tx(renamed)
    // sync-integration 阶段4：收集受影响媒体 id 供同步变更日志接线（ctx.syncEvents）
    if (onAssetsChanged) {
      const changedIds: number[] = []
      for (const r of renamed) {
        const row = selectIdStmt.get(r.newPath) as { id: number } | undefined
        if (row) changedIds.push(row.id)
      }
      if (changedIds.length > 0) onAssetsChanged(changedIds)
    }
  } catch (error) {
    // R2 补偿机制：DB 失败时尝试反向回滚磁盘，回滚失败的项写入 pending_renames
    // 让 startup-tasks.retryPendingRenames 在下次启动时让 DB 接受新路径。
    logger.error(t('main.file.log.dbSyncFailed'), error)
    const stuck: RenameRecord[] = []
    for (const r of renamed) {
      try {
        await moveFile(r.newPath, r.oldPath)
      } catch {
        // 反向回滚失败：磁盘文件停在 newPath，DB 仍指向 oldPath
        stuck.push(r)
      }
    }
    if (stuck.length > 0) {
      try {
        const insertStmt = db.prepare(
          "INSERT INTO pending_renames (old_path, new_path, new_file_name, created_at) VALUES (?, ?, ?, datetime('now'))"
        )
        const insertTx = db.transaction((rows: RenameRecord[]) => {
          for (const r of rows) {
            insertStmt.run(r.oldPath, r.newPath, r.newFileName)
          }
        })
        insertTx(stuck)
        logger.warn(`[File] 反向回滚失败 ${stuck.length} 项，已写入 pending_renames 待启动重试`)
      } catch (recordErr) {
        logger.error(t('main.file.log.pendingRenamesRecordFailed'), recordErr)
      }
    }
    throw error // 向上抛，让前端感知失败而非静默成功
  }
}

/**
 * 重命名/移动域安全基线（与文件操作域一致）：
 * - 所有路径参数由 zod schema 校验长度/格式
 * - 源路径读取走 assertMediaAccessPath 三级校验（userPicked → 已入库媒体白名单 →
 *   PathGuard 兜底），与 file:export / file:delete 同口径；目标目录写入用 assertFileWritePath
 *
 * R3：rename/move/batchRename 在文件操作成功后调用 syncMediaFilesAfterRename 同步 DB。
 */
export function registerFileRenameHandlers(ctx: HandlerContext): void {
  // sync-integration 阶段4：rename/move 后的媒体路径变更 → 批量 journal（合并广播，
  // recordAssetChanges 内部吞错，仅告警不中断文件操作主流程）
  const recordSyncChanges = (mediaIds: number[]): void => {
    void ctx.syncEvents?.recordAssetChanges(
      mediaIds.map((id) => ({ eventType: 'asset.updated' as const, assetId: String(id) }))
    )
  }
  // 文件移动
  // R3：move 后同步 DB file_path/file_name，避免 DB 指向旧路径让用户视角文件"消失"
  ipcMain.handle(
    'file:move',
    wrapHandler(
      ctx,
      z.tuple([schemas.filePathArrayBulk, schemas.filePath]),
      async ([sourcePaths, targetDir]) => {
        for (const p of sourcePaths) assertMediaAccessPath(ctx, p)
        assertFileWritePath(targetDir)
        const result = await ctx.fileService.moveFiles(sourcePaths, targetDir)
        // FIX(组14-1): 部分失败时也要同步已成功移动的项（service 会随失败结果回传
        // 已完成项的 renamed 映射）——失败点之前已物理移动的文件若不同步 DB，
        // media_files.file_path 仍指向旧路径（图库破图），且旧路径已不存在，重试必然失败
        if (result.renamed && result.renamed.length > 0) {
          const db = ctx.dbManager.getDatabase()
          if (db) {
            await syncMediaFilesAfterRename(db, result.renamed, recordSyncChanges)
          }
        }
        return result
      }
    )
  )

  // 文件重命名
  // R3：rename 后同步 DB file_path/file_name，与 batchRename 行为对齐
  ipcMain.handle(
    'file:rename',
    wrapHandler(
      ctx,
      z.tuple([schemas.filePath, schemas.shortString(255)]),
      async ([oldPath, newName]) => {
        assertMediaAccessPath(ctx, oldPath)
        const result = await ctx.fileService.renameFile(oldPath, newName)
        // 仅在文件操作成功且有 renamed mapping 时同步 DB
        if (result.success && result.renamed && result.renamed.length > 0) {
          const db = ctx.dbManager.getDatabase()
          if (db) {
            await syncMediaFilesAfterRename(db, result.renamed, recordSyncChanges)
          }
        }
        return result
      }
    )
  )

  // T12：批量重命名——文件系统操作 + 数据库 path/file_name 同步更新
  // R3：复用 syncMediaFilesAfterRename，与 rename/move 行为一致
  ipcMain.handle(
    'file:batchRename',
    wrapHandler(
      ctx,
      z.tuple([
        z
          .array(z.object({ oldPath: schemas.filePath, newName: schemas.shortString(255) }))
          .min(1, t('main.file.validation.operationsRequired'))
          .max(MAX_BATCH_RENAME_SIZE, t('main.file.validation.operationsMax'))
      ]),
      async ([operations]) => {
        for (const op of operations) {
          assertMediaAccessPath(ctx, op.oldPath)
        }
        const result = await ctx.fileService.batchRename(operations)
        if (result.renamed.length > 0) {
          const db = ctx.dbManager.getDatabase()
          if (db) {
            await syncMediaFilesAfterRename(db, result.renamed, recordSyncChanges)
          }
        }
        return result
      }
    )
  )
}
