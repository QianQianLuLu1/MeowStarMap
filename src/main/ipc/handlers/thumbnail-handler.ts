import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, schemas, assertFileReadPath } from '../validator'
import { MediaRepository } from '../../database/media-repository'
import { logger } from '../../utils/logger'

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
        const result = await ctx.thumbnailGen.generate(filePath, quality)
        // 按需生成结果回写（N2，fix-thumbnail-persist-and-ondemand）：结果只存渲染层
        // 组件 state 会让 DB thumbnail 保持 NULL，该行生成的缓存文件不在启动孤儿清理
        // 白名单内，每次启动被当孤儿删除、下个会话重新生成。仅填补 thumbnail IS NULL
        // 的行（不覆盖扫描/批量写入值），让缩略图跨启动持久生效；low/high 是派生档位，
        // 不是 thumbnail 列的规范值，不回写。写库失败仅告警，不影响本次返回。
        if (result && (quality === undefined || quality === 'standard')) {
          try {
            const db = ctx.dbManager.getDatabase()
            if (db) {
              const repo = new MediaRepository(
                db,
                ctx.dbManager.getWorkerBridge(),
                ctx.dbManager.getDbPath()
              )
              if (await repo.setThumbnailIfNull(filePath, result)) {
                // 实际写入后失效 media:// 白名单缓存（对齐 notifyMediaUpdated 既有模式）
                ctx.invalidateMediaPathCache()
              }
            }
          } catch (error) {
            logger.warn(`[Thumbnail] 按需生成结果回写数据库失败（不影响本次返回）:`, error)
          }
        }
        return result
      }
    )
  )
}
