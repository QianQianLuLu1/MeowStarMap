import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import type { ExifData } from '../../types/file'
import { wrapHandler, schemas, assertFileReadPath, assertFileWritePath } from '../validator'
import { assertMediaReadPath, assertMediaDeletePath } from '../media-read-guard'

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
      // 删除通道三级校验：userPicked → 已入库媒体白名单 → PathGuard 兜底
      // （与 media:// 展示、media:permanentDelete 口径对齐，修复敏感目录形态下已入库媒体删除被拒）
      for (const p of filePaths) assertMediaDeletePath(ctx, p)
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

  // 永久删除（高危操作；二次确认由渲染端 ConfirmDialog 承担）
  // #fix-permanent-delete-error-toast：原实现在此处再弹一次原生 dialog 二次确认，
  // 但渲染端调用方已在调用前经 ConfirmDialog 确认过——用户需重复确认，
  // 且在原生弹窗取消时会向渲染端抛 canceled 误报「出错」Toast。主进程不再弹窗。
  ipcMain.handle(
    'file:deletePermanent',
    wrapHandler(ctx, z.tuple([schemas.filePathArrayBulk]), async ([filePaths]) => {
      // 删除通道三级校验：userPicked → 已入库媒体白名单 → PathGuard 兜底（与 file:delete 同口径）
      for (const p of filePaths) assertMediaDeletePath(ctx, p)
      return ctx.fileService.deletePermanent(filePaths)
    })
  )

  // 获取 EXIF（返回空对象表示无数据，不抛错）
  ipcMain.handle(
    'file:getExif',
    wrapHandler(ctx, z.tuple([schemas.filePath]), async ([filePath]): Promise<ExifData> => {
      // 双层校验：已索引媒体白名单优先，PathGuard 兜底（与 media:// 显示授权一致）
      assertMediaReadPath(ctx, filePath)
      return ctx.fileService.getExif(filePath)
    })
  )
}
