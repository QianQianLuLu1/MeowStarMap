import { ipcMain } from 'electron'
import fs from 'fs'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, schemas, assertFileReadPath, assertFileWritePath } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
// C-3：统一媒体常量
import { VIDEO_EXPORT_FORMATS } from '../../utils/media-constants'
// P1-05：Live Photo 导出服务（单例）
import { livePhotoService } from '../../services/livephoto-service'
// 日志管理
import { logger } from '../../utils/logger'
// 视频编辑任务类型
import type { VideoEditRequest, VideoEditBatchRequest } from '../../video-editor/types'

// 视频编辑 zod schema（与 VideoEditTask 结构一致，宽松校验，主进程不解析内部 params/watermark）
const videoEditTaskSchema = z.object({
  inputPath: z.string().min(1),
  outputPath: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  watermark: z.unknown().nullable().optional(),
  trim: z
    .object({ start: z.number().min(0), end: z.number().min(0) })
    .nullable()
    .optional(),
  speed: z.number().min(0.25).max(4.0).nullable().optional(),
  format: z.string().nullable().optional()
})

export function registerVideoHandlers(ctx: HandlerContext): void {
  ipcMain.handle(
    'video:thumbnail',
    wrapHandler(ctx, z.tuple([schemas.filePath]), async ([filePath]) => {
      assertFileReadPath(filePath)
      const thumbnail = await ctx.thumbnailGen.generate(filePath)
      return { thumbnail, hasThumbnail: !!thumbnail }
    })
  )

  ipcMain.handle(
    'video:metadata',
    wrapHandler(ctx, z.tuple([schemas.filePath]), async ([filePath]) => {
      assertFileReadPath(filePath)
      const stats = await fs.promises.stat(filePath)
      const metadata = await ctx.videoService.getMetadata(filePath)
      return {
        path: filePath,
        size: stats.size,
        duration: metadata.duration ?? 0,
        width: metadata.width ?? 0,
        height: metadata.height ?? 0,
        codec: metadata.codec ?? '',
        frameRate: metadata.frameRate ?? 0
      }
    })
  )

  ipcMain.handle(
    'video:export',
    wrapHandler(
      ctx,
      z.tuple([
        schemas.filePath,
        schemas.filePath,
        z.enum(VIDEO_EXPORT_FORMATS as unknown as [string, ...string[]])
      ]),
      async ([filePath, targetDir, format]) => {
        assertFileReadPath(filePath)
        assertFileWritePath(targetDir)
        if (!VIDEO_EXPORT_FORMATS.includes(format as (typeof VIDEO_EXPORT_FORMATS)[number])) {
          throw AppError.validation(`不支持的视频格式: ${format}`)
        }
        return ctx.videoService.exportVideo(filePath, targetDir, format)
      }
    )
  )

  ipcMain.handle(
    'video:captureFrame',
    wrapHandler(
      ctx,
      z.tuple([
        schemas.filePath,
        z
          .number()
          .min(0)
          .max(24 * 3600 * 1000),
        schemas.filePath.optional()
      ]),
      async ([filePath, currentTime, targetDir]) => {
        assertFileReadPath(filePath)
        if (targetDir !== undefined) {
          assertFileWritePath(targetDir)
        }
        return ctx.videoService.captureFrame(filePath, currentTime, targetDir)
      }
    )
  )

  // F-S9：视频裁剪
  ipcMain.handle(
    'video:trim',
    wrapHandler(
      ctx,
      z.tuple([
        schemas.filePath,
        z
          .number()
          .min(0)
          .max(24 * 3600),
        z
          .number()
          .min(0)
          .max(24 * 3600),
        schemas.filePath
      ]),
      async ([filePath, startTime, endTime, targetDir]) => {
        assertFileReadPath(filePath)
        assertFileWritePath(targetDir)
        if (endTime <= startTime) {
          throw AppError.validation('结束时间必须大于开始时间')
        }
        return ctx.videoService.trimVideo(filePath, startTime, endTime, targetDir)
      }
    )
  )

  // F-S9：视频调速
  ipcMain.handle(
    'video:changeSpeed',
    wrapHandler(
      ctx,
      z.tuple([schemas.filePath, z.number().min(0.25).max(4.0), schemas.filePath]),
      async ([filePath, speed, targetDir]) => {
        assertFileReadPath(filePath)
        assertFileWritePath(targetDir)
        return ctx.videoService.changeSpeed(filePath, speed, targetDir)
      }
    )
  )

  // P1-05：导出 Live Photo
  ipcMain.handle(
    'video:exportLivePhoto',
    wrapHandler(
      ctx,
      z.tuple([schemas.filePath, schemas.filePath]),
      async ([filePath, targetDir]) => {
        assertFileReadPath(filePath)
        assertFileWritePath(targetDir)
        try {
          return await livePhotoService.exportLivePhoto(filePath, targetDir)
        } catch (error) {
          logger.error('[IPC] video:exportLivePhoto 失败:', error)
          throw error
        }
      }
    )
  )

  // 视频编辑：调色 + 水印 + 可选裁剪/调速/格式 → utilityProcess ffmpeg
  // 渲染层将 VideoEditRequest.task 传入，handler 仅做路径校验后委托给 VideoEditorBridge
  ipcMain.handle(
    'video:edit',
    wrapHandler(ctx, z.tuple([z.object({ task: videoEditTaskSchema })]), async ([payload]) => {
      const { task } = payload as unknown as VideoEditRequest
      assertFileReadPath(task.inputPath)
      // outputPath 由调用方保证目录存在（渲染层选目录后拼接）
      // 但仍需校验白名单，避免写入系统敏感目录
      assertFileWritePath(task.outputPath)
      try {
        const outputPath = await ctx.videoEditorBridge.editSingle(task)
        return {
          success: true,
          taskId: '',
          message: '视频编辑成功',
          outputPath
        }
      } catch (error) {
        // bridge 内部已通过 task:progress 推送终态，handler 仅返回失败结果
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, taskId: '', message }
      }
    })
  )

  // 批量视频编辑：runWithConcurrency 控制并发，单任务失败不中断后续
  ipcMain.handle(
    'video:editBatch',
    wrapHandler(
      ctx,
      z.tuple([
        z.object({
          tasks: z.array(videoEditTaskSchema).min(1).max(100),
          concurrency: z.number().int().min(1).max(4).optional()
        })
      ]),
      async ([payload]) => {
        const { tasks, concurrency } = payload as unknown as VideoEditBatchRequest
        // 批量校验路径白名单
        for (const t of tasks) {
          assertFileReadPath(t.inputPath)
          assertFileWritePath(t.outputPath)
        }
        try {
          const result = await ctx.videoEditorBridge.editBatch(tasks, concurrency ?? 2)
          return {
            success: true,
            taskId: '',
            failedIndexes: result.failedIndexes,
            message:
              result.failedIndexes.length === 0
                ? `批量编辑完成（共 ${tasks.length} 个）`
                : `批量编辑完成（成功 ${tasks.length - result.failedIndexes.length} 个，失败 ${result.failedIndexes.length} 个）`
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { success: false, taskId: '', failedIndexes: [], message }
        }
      }
    )
  )
}
