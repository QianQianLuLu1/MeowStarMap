import sharp from 'sharp'
import type Database from 'better-sqlite3'
import type { HandlerContext } from '../ipc/handler-context'
import { calculatePHash } from '../utils/phash'
import type { TaskPriority } from '../scheduler/task-scheduler'
import { logger } from '../utils/logger'

/**
 * P1-A1：抽取自 index.ts / misc.ts / media.ts 的 4 组重复函数
 *
 * 原 index.ts 的 Application 类与 misc.ts/media.ts 各持有一份逻辑相同的副本，
 * 此模块作为单一数据源，启动路径与 IPC 路径共用同一份实现，避免两份代码逐渐分叉。
 *
 * 进程拆分改造（v2.3.x）：
 * - generateThumbnailsForUnprocessed / generatePhashForUnprocessed / markDuplicates
 *   三个批量函数改为通过 ctx.mediaWorkerManager 下发到独立 utilityProcess
 * - processThumbnailForRow 保留在主进程执行（cleanupAndRepairDatabase 修复路径仍在主进程使用）
 * - 函数签名与返回值结构完全不变，上层调用方无需修改
 *
 * 分级调度改造（v2.3.x）：
 * - 新增 priority 参数（默认 'high'），高优先级立即执行可抢占低优先级，低优先级入队串行
 * - 启动路径与扫描后链式触发传 'low'，用户主动触发的 IPC 默认 'high'
 * - 互斥锁移到任务本体内部，避免低优先级入队等待期间持锁阻塞高优先级抢占
 * - 低优先级任务通过闭包变量传递结果（enqueueLow 返回 Promise<void>）
 */

/** 单条媒体记录的缩略图/尺寸/pHash 处理（成功返回 true） */
export async function processThumbnailForRow(
  ctx: HandlerContext,
  row: { id: number; file_path: string; file_type: string },
  updateStmt: Database.Statement
): Promise<boolean> {
  try {
    let width: number | null = null
    let height: number | null = null
    let thumbnailPath: string | null = null
    let phash: string | null = null

    if (row.file_type === 'image') {
      // C-G7：原实现 sharp 加载原图 3 次（metadata/generate/phash）串行执行
      // 优化为 Promise.all 并行执行，总耗时 = max(三操作) 而非 sum
      // metadata 只读文件头极轻量；generate 和 calculatePHash 各自完整解码，并行后重叠 IO/CPU
      const [metadata, thumbResult, phashResult] = await Promise.all([
        sharp(row.file_path)
          .metadata()
          .catch(() => null),
        ctx.thumbnailGen.generate(row.file_path),
        calculatePHash(row.file_path)
      ])
      width = metadata?.width ?? null
      height = metadata?.height ?? null
      thumbnailPath = thumbResult
      // T05：同步计算 pHash（仅图片，视频不计算）
      phash = phashResult
    } else if (row.file_type === 'video') {
      // 视频文件使用 ffmpeg 提取第一帧缩略图
      thumbnailPath = await ctx.thumbnailGen.generate(row.file_path)
    }

    updateStmt.run(width, height, thumbnailPath, phash, row.id)
    return true
  } catch (error) {
    logger.error(`[Thumbnail] 处理文件失败 ${row.file_path}:`, error)
    return false
  }
}

/**
 * 为数据库中尚未生成缩略图/尺寸的记录生成缩略图并读取尺寸
 * 通过 ctx 的 isThumbnailsGenerating/setThumbnailsGenerating 互斥，防止并发重复执行
 *
 * 进程拆分改造：批量任务下发到 media worker（utilityProcess）执行，
 * 解决主进程 sharp/ffmpeg CPU 密集计算导致的 UI 卡顿问题。
 *
 * 分级调度改造：
 * - priority='high'（默认）：用户主动触发，立即执行，可抢占低优先级任务
 * - priority='low'：启动路径 / 扫描后链式触发，入队串行执行
 * 互斥锁移到 runBatch 内部，避免低优先级入队等待期间持锁阻塞高优先级抢占。
 */
export async function generateThumbnailsForUnprocessed(
  ctx: HandlerContext,
  priority: TaskPriority = 'high'
): Promise<void> {
  // 互斥锁移到 runBatch 内部：低优先级入队等待期间不持锁，高优先级到来时可正常抢占
  const runBatch = async (): Promise<void> => {
    if (ctx.isThumbnailsGenerating()) {
      // 高优先级抢占后低优先级可能刚释放锁，这里是正常防御
      logger.info('[Thumbnail] 缩略图生成已在进行中，跳过本次触发')
      return
    }
    ctx.setThumbnailsGenerating(true)
    try {
      const result = await ctx.mediaWorkerManager.startThumbnailBatch({
        cacheDir: ctx.thumbnailGen.getCacheDir(),
        thumbnailQuality: 'standard'
      })

      if (!result.success) {
        // 被抢占取消时 worker 返回 success=false + message='用户取消'，不视为错误
        if (!result.message.includes('取消') && !result.message.includes('已在进行中')) {
          logger.error('[Thumbnail] 批量生成失败:', result.message)
        }
        return
      }

      ctx.getMainWindow()?.webContents.send('media:updated')
    } finally {
      ctx.setThumbnailsGenerating(false)
    }
  }

  if (priority === 'high') {
    await ctx.taskScheduler.runHighPriority(runBatch)
  } else {
    await ctx.taskScheduler.enqueueLow(runBatch, {
      id: 'thumbnail-batch',
      cancel: () => ctx.mediaWorkerManager.stopThumbnailBatch()
    })
  }
}

/**
 * T05：为数据库中尚未计算 pHash 的图片记录补算感知哈希
 * 返回 { processed, total }：processed 成功条数，total 待补算总数
 * 补算完成后自动触发重复标记（worker 内部链式调用，无需主进程手动触发）
 *
 * 分级调度改造：
 * - priority='high'（默认）：用户主动触发
 * - priority='low'：启动路径 / 扫描后链式触发
 * 低优先级任务通过闭包变量 result 传递返回值（enqueueLow 返回 Promise<void>）。
 */
export async function generatePhashForUnprocessed(
  ctx: HandlerContext,
  priority: TaskPriority = 'high'
): Promise<{ processed: number; total: number }> {
  let result = { processed: 0, total: 0 }

  const runBatch = async (): Promise<void> => {
    try {
      const r = await ctx.mediaWorkerManager.startPhashBatch()
      if (r.success) {
        result = { processed: r.processed, total: r.total }
      } else if (!r.message.includes('取消') && !r.message.includes('已在进行中')) {
        logger.error('[pHash] 补算失败:', r.message)
      }
    } catch (error) {
      logger.error('[pHash] 补算失败:', error)
    }
  }

  if (priority === 'high') {
    await ctx.taskScheduler.runHighPriority(runBatch)
  } else {
    await ctx.taskScheduler.enqueueLow(runBatch, {
      id: 'phash-batch',
      cancel: () => ctx.mediaWorkerManager.stopPhashBatch()
    })
  }
  return result
}

/**
 * P1-01：基于 pHash 极严格阈值（≤2）聚类，评分标记重复文件
 * 每组评分最高的设为 is_duplicate=0/original_id=NULL（推荐保留），
 * 其余设为 is_duplicate=1/original_id=最佳项id（图库默认隐藏）
 *
 * 分级调度改造：
 * - priority='high'（默认）：用户主动触发
 * - priority='low'：扫描后链式触发（worker 内部链式调用不经过此处）
 * 低优先级任务通过闭包变量 result 传递返回值。
 */
export async function markDuplicates(
  ctx: HandlerContext,
  priority: TaskPriority = 'high'
): Promise<{ markedDuplicates: number; totalGroups: number }> {
  let result = { markedDuplicates: 0, totalGroups: 0 }

  const runBatch = async (): Promise<void> => {
    try {
      const r = await ctx.mediaWorkerManager.startDuplicateMark()
      if (r.success) {
        result = { markedDuplicates: r.markedDuplicates, totalGroups: r.totalGroups }
      } else if (!r.message.includes('取消') && !r.message.includes('已在进行中')) {
        logger.error('[Duplicate] 标记失败:', r.message)
      }
    } catch (error) {
      logger.error('[Duplicate] 标记失败:', error)
    }
  }

  if (priority === 'high') {
    await ctx.taskScheduler.runHighPriority(runBatch)
  } else {
    await ctx.taskScheduler.enqueueLow(runBatch, {
      id: 'duplicate-mark',
      cancel: () => ctx.mediaWorkerManager.stopDuplicateMark()
    })
  }
  return result
}
