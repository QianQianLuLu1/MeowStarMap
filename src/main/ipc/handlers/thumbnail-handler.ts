import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, schemas, assertFileReadPath } from '../validator'

/**
 * thumbnail 域 IPC handler：缩略图生成。
 */
export function registerThumbnailHandlers(ctx: HandlerContext): void {
  // ---- thumbnail 域 ----
  // 缩略图生成
  ipcMain.handle(
    'thumbnail:generate',
    wrapHandler(
      ctx,
      z.tuple([schemas.filePath, schemas.thumbnailQuality]),
      async ([filePath, quality]) => {
        assertFileReadPath(filePath)
        return ctx.thumbnailGen.generate(filePath, quality)
      }
    )
  )
}
