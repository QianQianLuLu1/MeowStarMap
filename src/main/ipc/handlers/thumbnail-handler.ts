// @core-change: thumbnail:generate 媒体读取守卫改为已授权媒体口径，修复装在未注册盘的游戏目录按需生成恒被误拦
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, schemas } from '../validator'
import { assertMediaAccessPath } from '../media-read-guard'
import { MediaRepository } from '../../database/media-repository'
import { logger } from '../../utils/logger'
import { isAppError } from '../../../shared/errors/app-error'

/**
 * 把任意抛出值展开为可判定的日志文本。
 *
 * 为什么必须在字符串里展开：electron-log 的默认序列化只读取可枚举自身属性，而 Error 的
 * message/stack 定义在原型上，`logger.warn(text, error)` 落到日志文件里就是 `{}`——
 * 历史上一轮定位「thumbnail 列恒 NULL」时，告警行原因字段全是 `{}`，真实原因（SQLITE_BUSY /
 * 写失败转译 / 参数错误）无从判断，只能靠对照实验重做取证。
 * 这里按 AppError（含 code）> Error（含 name）> 原始值 三级展开，并最多下钻两层 cause。
 */
function describeWriteFailure(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 3 && current !== undefined && current !== null; depth++) {
    if (isAppError(current)) {
      parts.push(`${current.name}(${current.code}): ${current.message}`)
      current = current.cause
    } else if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`)
      current = (current as Error & { cause?: unknown }).cause
    } else {
      parts.push(String(current))
      current = null
    }
  }
  return parts.join(' <- ')
}

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
        // 媒体读取口径必须与 media://（isMediaPathAllowed）/ file:delete / 导出通道一致：
        // 裸 PathGuard 的 roots 只覆盖 userHome、userData 与「已注册媒体根」，游戏装在未注册的
        // 独立盘（如 H:\InfinityNikki Launcher\...）时，照片在图库能正常显示，但按需生成会被
        // 判「路径不在白名单内」——本机打包态实测：同批已入库路径 file:getExif 全通过，
        // thumbnail:generate 4/4 被拒（0~1ms 即失败），DB thumbnail 恒 NULL、卡片停在骨架。
        assertMediaAccessPath(ctx, filePath)
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
                // 实际写入后仅失效新增缩略图路径的否定缓存，避免可视区每张图全清
                ctx.invalidateMediaPathCache([result])
              }
            }
          } catch (error) {
            logger.warn(
              `[Thumbnail] 按需生成结果回写数据库失败（不影响本次返回）: ${describeWriteFailure(error)}`
            )
          }
        }
        return result
      }
    )
  )
}
