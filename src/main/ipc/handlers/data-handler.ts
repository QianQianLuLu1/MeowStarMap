import { ipcMain, dialog } from 'electron'
import path from 'path'
import fs from 'fs'
import type { HandlerContext } from '../handler-context'
import { wrapHandlerNoArgs } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { t } from '../../i18n'

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
      if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))

      // A-S3：高危操作二次确认（清空所有媒体数据不可恢复）
      const confirmResult = await dialog.showMessageBox({
        type: 'warning',
        buttons: [t('main.data.dialog.cancel'), t('main.data.dialog.confirmClear')],
        defaultId: 0,
        cancelId: 0,
        title: t('main.data.dialog.clearTitle'),
        message: t('main.data.dialog.clearMessage'),
        detail: t('main.data.dialog.clearDetail')
      })
      if (confirmResult.response !== 1) {
        throw AppError.canceled(t('main.media.error.userCanceled'))
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
      return { message: t('main.data.message.cleared') }
    })
  )
}
