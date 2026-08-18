import { ipcMain, dialog } from 'electron'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import type { HandlerContext } from '../handler-context'
import type { ExportOptions, ExifData } from '../../types/file'
import { wrapHandler, schemas, assertFileReadPath, assertFileWritePath } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { moveFile } from '../../utils/file-utils'
import { chunkArray } from '../../database/sql-chunk'
// 日志管理
import { logger } from '../../utils/logger'

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
  renamed: RenameRecord[]
): Promise<void> {
  if (renamed.length === 0) return
  const updateStmt = db.prepare(
    'UPDATE media_files SET file_path = ?, file_name = ? WHERE file_path = ?'
  )
  const tx = db.transaction((rows: RenameRecord[]) => {
    for (const r of rows) {
      updateStmt.run(r.newPath, r.newFileName, r.oldPath)
    }
  })
  try {
    tx(renamed)
  } catch (error) {
    // R2 补偿机制：DB 失败时尝试反向回滚磁盘，回滚失败的项写入 pending_renames
    // 让 startup-tasks.retryPendingRenames 在下次启动时让 DB 接受新路径。
    logger.error('[File] DB 同步失败，尝试反向回滚磁盘:', error)
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
        logger.error('[File] 写入 pending_renames 补偿表失败:', recordErr)
      }
    }
    throw error // 向上抛，让前端感知失败而非静默成功
  }
}

/**
 * 文件操作域 IPC handler
 *
 * 安全基线：
 * - 所有路径参数由 zod schema 校验长度/格式
 * - 所有文件操作调用 assertFileReadPath/assertFileWritePath 完成白名单拦截
 * - 写操作（copy/move/export/rename）额外校验目标目录可写
 *
 * R3：rename/move/batchRename 在文件操作成功后调用 syncMediaFilesAfterRename 同步 DB；
 * copy 不主动入库（新文件由扫描器扫到时入库，强行插入会写出缺字段的脏记录）。
 */
export function registerFileHandlers(ctx: HandlerContext): void {
  // 文件删除（移至回收站）
  ipcMain.handle(
    'file:delete',
    wrapHandler(ctx, z.tuple([schemas.filePathArray]), async ([filePaths]) => {
      for (const p of filePaths) assertFileReadPath(p)
      return ctx.fileService.moveToRecycleBin(filePaths)
    })
  )

  // 文件复制
  // R3：copy 产生新文件，不主动入库——FileService 不知道 file_type/width/height/duration 等字段，
  // 强行插入会写出半成品记录（违反"健壮底线：只做能做对的"）。新文件由扫描器扫到时入库。
  ipcMain.handle(
    'file:copy',
    wrapHandler(
      ctx,
      z.tuple([schemas.filePathArray, schemas.filePath]),
      async ([sourcePaths, targetDir]) => {
        for (const p of sourcePaths) assertFileReadPath(p)
        assertFileWritePath(targetDir)
        return ctx.fileService.copyFiles(sourcePaths, targetDir)
      }
    )
  )

  // 文件移动
  // R3：move 后同步 DB file_path/file_name，避免 DB 指向旧路径让用户视角文件"消失"
  ipcMain.handle(
    'file:move',
    wrapHandler(
      ctx,
      z.tuple([schemas.filePathArray, schemas.filePath]),
      async ([sourcePaths, targetDir]) => {
        for (const p of sourcePaths) assertFileReadPath(p)
        assertFileWritePath(targetDir)
        const result = await ctx.fileService.moveFiles(sourcePaths, targetDir)
        // FIX(组14-1): 部分失败时也要同步已成功移动的项（service 会随失败结果回传
        // 已完成项的 renamed 映射）——失败点之前已物理移动的文件若不同步 DB，
        // media_files.file_path 仍指向旧路径（图库破图），且旧路径已不存在，重试必然失败
        if (result.renamed && result.renamed.length > 0) {
          const db = ctx.dbManager.getDatabase()
          if (db) {
            await syncMediaFilesAfterRename(db, result.renamed)
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
        assertFileReadPath(oldPath)
        const result = await ctx.fileService.renameFile(oldPath, newName)
        // 仅在文件操作成功且有 renamed mapping 时同步 DB
        if (result.success && result.renamed && result.renamed.length > 0) {
          const db = ctx.dbManager.getDatabase()
          if (db) {
            await syncMediaFilesAfterRename(db, result.renamed)
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
          .min(1, '操作列表为空')
          .max(MAX_BATCH_RENAME_SIZE, '操作数量超过上限')
      ]),
      async ([operations]) => {
        for (const op of operations) {
          assertFileReadPath(op.oldPath)
        }
        const result = await ctx.fileService.batchRename(operations)
        if (result.renamed.length > 0) {
          const db = ctx.dbManager.getDatabase()
          if (db) {
            await syncMediaFilesAfterRename(db, result.renamed)
          }
        }
        return result
      }
    )
  )

  // 文件导出（支持默认目录与命名规则）
  ipcMain.handle(
    'file:export',
    wrapHandler(
      ctx,
      z.tuple([
        schemas.filePathArray,
        schemas.filePath,
        z
          .object({
            quality: z.number().min(0).max(100).optional(),
            format: z.enum(['jpg', 'jpeg', 'png', 'webp', 'original']).optional(),
            namingPattern: z.string().max(256).optional(),
            useDefaultDir: z.boolean().optional()
          })
          .optional()
      ]),
      async ([filePaths, targetDir, options]) => {
        for (const p of filePaths) assertFileReadPath(p)
        assertFileWritePath(targetDir)

        // P1-02：useDefaultDir=true 时从 settings 读取默认导出路径
        let finalTargetDir = targetDir
        const finalOptions: ExportOptions = options ? { ...options } : {}
        if (options?.useDefaultDir) {
          const defaultDir = ctx.dbManager.getSetting<string | null>('export.defaultDir', null)
          if (!defaultDir) {
            throw AppError.preconditionFailed('未配置默认导出路径，请先在设置中配置')
          }
          finalTargetDir = defaultDir
          assertFileWritePath(finalTargetDir)
          // 若未显式传 namingPattern，从 settings 读取默认命名规则
          if (!finalOptions.namingPattern) {
            const pattern = ctx.dbManager.getSetting<string | null>('export.namingPattern', null)
            if (pattern && pattern.trim()) {
              finalOptions.namingPattern = pattern.trim()
            }
          }
        }

        // P1-02：若启用命名规则，查询每个文件的 album_type + account_uid 元数据
        let metadataMap: Map<string, { album_type?: string; account_uid?: string }> | undefined
        if (finalOptions.namingPattern && finalOptions.namingPattern.trim()) {
          metadataMap = new Map()
          try {
            const db = ctx.dbManager.getDatabase()
            if (db) {
              // A11：分片查询避免超过 SQLite 单语句参数上限
              for (const batch of chunkArray(filePaths)) {
                const placeholders = batch.map(() => '?').join(',')
                const rows = db
                  .prepare(
                    `SELECT file_path, album_type, account_uid FROM media_files WHERE file_path IN (${placeholders})`
                  )
                  .all(...batch) as Array<{
                  file_path: string
                  album_type: string
                  account_uid: string
                }>
                for (const r of rows) {
                  metadataMap.set(r.file_path, {
                    album_type: r.album_type,
                    account_uid: r.account_uid
                  })
                }
              }
            }
          } catch (err) {
            // 元数据查询失败不阻断导出，仅日志记录
            logger.warn('[file:export] 查询元数据失败，回退到无变量命名:', err)
          }
        }

        return ctx.fileService.exportFiles(filePaths, finalTargetDir, finalOptions, metadataMap)
      }
    )
  )

  // 文件另存为
  ipcMain.handle(
    'file:saveAs',
    wrapHandler(
      ctx,
      z.tuple([schemas.filePath, schemas.filePath, schemas.shortString(255).optional()]),
      async ([filePath, targetDir, newName]) => {
        assertFileReadPath(filePath)
        assertFileWritePath(targetDir)
        return ctx.fileService.saveAs(filePath, targetDir, newName)
      }
    )
  )

  // 永久删除（高危操作二次确认）
  ipcMain.handle(
    'file:deletePermanent',
    wrapHandler(ctx, z.tuple([schemas.filePathArray]), async ([filePaths]) => {
      for (const p of filePaths) assertFileReadPath(p)
      // A-S3：高危操作二次确认（永久删除文件不可恢复）
      const confirmResult = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['取消', '确认删除'],
        defaultId: 0,
        cancelId: 0,
        title: '确认永久删除',
        message: `即将永久删除 ${filePaths.length} 个文件，此操作不可恢复。`,
        detail: '文件将被直接删除（不进入回收站）。是否继续？'
      })
      if (confirmResult.response !== 1) {
        throw AppError.canceled('用户取消操作')
      }
      return ctx.fileService.deletePermanent(filePaths)
    })
  )

  // 获取 EXIF（返回空对象表示无数据，不抛错）
  ipcMain.handle(
    'file:getExif',
    wrapHandler(ctx, z.tuple([schemas.filePath]), async ([filePath]): Promise<ExifData> => {
      assertFileReadPath(filePath)
      return ctx.fileService.getExif(filePath)
    })
  )
}
