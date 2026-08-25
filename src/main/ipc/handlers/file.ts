import { ipcMain, dialog } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import type { ExifData } from '../../types/file'
import { wrapHandler, schemas, assertFileReadPath, assertFileWritePath } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { t } from '../../i18n'

/**
 * 文件操作域 IPC handler：删除 / 复制 / 永久删除 / EXIF
 *
 * 安全基线：
 * - 所有路径参数由 zod schema 校验长度/格式
 * - 所有文件操作调用 assertFileReadPath/assertFileWritePath 完成白名单拦截
 * - 写操作（copy）额外校验目标目录可写
 *
 * copy 不主动入库（新文件由扫描器扫到时入库，强行插入会写出缺字段的脏记录）。
 * 重命名/移动通道见 `file-rename-handler.ts`，导出/另存为通道见 `file-export-handler.ts`。
 */
export function registerFileHandlers(ctx: HandlerContext): void {
  // 文件删除（移至回收站）
  ipcMain.handle(
    'file:delete',
    wrapHandler(ctx, z.tuple([schemas.filePathArrayBulk]), async ([filePaths]) => {
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
      z.tuple([schemas.filePathArrayBulk, schemas.filePath]),
      async ([sourcePaths, targetDir]) => {
        for (const p of sourcePaths) assertFileReadPath(p)
        assertFileWritePath(targetDir)
        return ctx.fileService.copyFiles(sourcePaths, targetDir)
      }
    )
  )

  // 永久删除（高危操作二次确认）
  ipcMain.handle(
    'file:deletePermanent',
    wrapHandler(ctx, z.tuple([schemas.filePathArrayBulk]), async ([filePaths]) => {
      for (const p of filePaths) assertFileReadPath(p)
      // A-S3：高危操作二次确认（永久删除文件不可恢复）
      const confirmResult = await dialog.showMessageBox({
        type: 'warning',
        buttons: [t('main.media.dialog.cancel'), t('main.media.dialog.confirmDelete')],
        defaultId: 0,
        cancelId: 0,
        title: t('main.file.dialog.permanentDeleteTitle'),
        message: t('main.file.dialog.permanentDeleteMessage', { count: filePaths.length }),
        detail: t('main.file.dialog.permanentDeleteDetail')
      })
      if (confirmResult.response !== 1) {
        throw AppError.canceled(t('main.media.error.userCanceled'))
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
