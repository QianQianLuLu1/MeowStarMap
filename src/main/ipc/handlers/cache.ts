import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { logger } from '../../utils/logger'
import { wrapHandler, wrapHandlerNoArgs, schemas } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { registerSetDirHandler, registerResetDirHandler } from './set-dir-handler'
import { MediaRepository } from '../../database/media-repository'
import { MIN_CACHE_LIMIT_BYTES } from '../../thumbnail/generator'

/**
 * P0-A1：从 Application.setupIPC() 迁移的缩略图缓存域 IPC handler 集合。
 */
export function registerCacheHandlers(ctx: HandlerContext): void {
  // T10：缩略图缓存管理
  // 获取缓存统计（总大小 / 文件数 / 上限 / 目录）
  ipcMain.handle(
    'cache:getStats',
    wrapHandlerNoArgs(ctx, async () => {
      try {
        return await ctx.thumbnailGen.getCacheStats()
      } catch (error) {
        logger.error('[Cache] getStats 失败:', error)
        throw AppError.internal(
          `获取缓存统计失败: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  )

  // 手动清理所有缩略图
  ipcMain.handle(
    'cache:clean',
    wrapHandlerNoArgs(ctx, async () => {
      try {
        return await ctx.thumbnailGen.cleanAll()
      } catch (error) {
        logger.error('[Cache] clean 失败:', error)
        throw AppError.internal(
          `清理缓存失败: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  )

  // 调整缓存上限（字节），立即触发 LRU 淘汰
  // R13：DB 持久化走 worker 事务，且在 in-memory 更新之前完成——
  //   DB 失败 → in-memory 未被触碰（一致）；DB 成功 + in-memory 失败 → 下次重启从 DB 加载正确值
  ipcMain.handle(
    'cache:setLimit',
    wrapHandler(ctx, z.tuple([schemas.cacheLimitBytes]), async ([limitBytes]) => {
      try {
        // 预校验：低于下限直接返回 applied:false，不触碰 DB 也不改 in-memory
        if (!Number.isFinite(limitBytes) || limitBytes < MIN_CACHE_LIMIT_BYTES) {
          return { applied: false, evicted: 0 }
        }
        // Step 1：持久化到 DB（走 worker 事务，与其他写操作一致）
        const db = ctx.dbManager.getDatabase()
        if (db) {
          const repo = new MediaRepository(
            db,
            ctx.dbManager.getWorkerBridge(),
            ctx.dbManager.getDbPath()
          )
          await repo.setSetting('thumbnailCacheLimitBytes', limitBytes)
        } else {
          // DB 未初始化时降级为同步直写（与原行为兼容）
          ctx.dbManager.setSetting('thumbnailCacheLimitBytes', limitBytes)
        }
        // Step 2：DB 成功后再更新 in-memory 并触发 LRU 淘汰
        const result = await ctx.thumbnailGen.setCacheLimit(limitBytes)
        return result
      } catch (error) {
        logger.error('[Cache] setLimit 失败:', error)
        throw AppError.internal(
          `设置缓存上限失败: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  )

  // 手动触发 LRU 淘汰检查
  ipcMain.handle(
    'cache:enforceLimit',
    wrapHandlerNoArgs(ctx, async () => {
      try {
        return await ctx.thumbnailGen.enforceLimitNow()
      } catch (error) {
        logger.error('[Cache] enforceLimit 失败:', error)
        throw AppError.internal(
          `触发 LRU 淘汰失败: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })
  )

  // P1-A11：setDir/resetDir 改用工厂函数（原 45 行模板代码消除）
  registerSetDirHandler(ctx, 'cache:setDir', 'thumbnailCacheDir')
  registerResetDirHandler(ctx, 'cache:resetDir', 'thumbnailCacheDir')

  // 获取缓存目录路径（供 UI 显示，避免 UI 硬编码）
  ipcMain.handle(
    'cache:getDir',
    wrapHandlerNoArgs(ctx, async () => ctx.thumbnailGen.getCacheDir())
  )
}
