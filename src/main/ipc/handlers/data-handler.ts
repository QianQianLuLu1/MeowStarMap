import { ipcMain, dialog } from 'electron'
import path from 'path'
import fs from 'fs'
import type { HandlerContext } from '../handler-context'
import { wrapHandlerNoArgs } from '../validator'
import { AppError } from '../../../shared/errors/app-error'

/**
 * data 域 IPC handler：本地数据清空。
 */
export function registerDataHandlers(ctx: HandlerContext): void {
  // ---- data 域 ----
  // 数据管理
  ipcMain.handle(
    'data:clear',
    wrapHandlerNoArgs(ctx, async () => {
      const db = ctx.dbManager.getDatabase()
      if (!db) throw AppError.preconditionFailed('数据库未初始化')

      // A-S3：高危操作二次确认（清空所有媒体数据不可恢复）
      const confirmResult = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['取消', '确认清空'],
        defaultId: 0,
        cancelId: 0,
        title: '确认清空数据',
        message: '此操作将清除所有媒体记录、扫描历史、自定义筛选器与水印模板，且不可恢复。',
        detail: '缩略图缓存也将被清空。是否继续？'
      })
      if (confirmResult.response !== 1) {
        throw AppError.canceled('用户取消操作')
      }

      const clearAll = db.transaction(() => {
        db.exec('DELETE FROM media_files')
        db.exec('DELETE FROM scan_history')
        db.exec('DELETE FROM filter_presets WHERE is_builtin = 0')
        db.exec('DELETE FROM watermark_templates WHERE is_builtin = 0')
        db.exec('DELETE FROM edit_history')
      })
      clearAll()

      // 清理缩略图缓存目录
      const thumbnailDir = ctx.thumbnailGen.getCacheDir()
      try {
        const entries = await fs.promises.readdir(thumbnailDir)
        await Promise.all(
          entries.map((entry) =>
            fs.promises.rm(path.join(thumbnailDir, entry), { recursive: true, force: true })
          )
        )
      } catch {
        // 目录不存在时忽略
      }

      ctx.notifyMediaUpdated()
      return { message: '本地数据已清除' }
    })
  )
}
