import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import {
  wrapHandler,
  wrapHandlerNoArgs,
  schemas,
  assertFileReadPath,
  assertFileWritePath
} from '../validator'
import { AppError } from '../../../shared/errors/app-error'
// 水印配置类型
import type { WatermarkConfig } from '../../types/file'
// 性能重构 v3 改造项三：watermark:apply 接入 TaskRegistry + ProgressThrottle + EtaCalculator
import { taskRegistry } from '../../utils/task-registry'
import { ProgressThrottle } from '../../utils/progress-throttle'
import { EtaCalculator } from '../../utils/eta-calculator'
import type { TaskProgress } from '../../../shared/types/progress'
import { t } from '../../i18n'

export function registerWatermarkHandlers(ctx: HandlerContext): void {
  // 水印
  ipcMain.handle(
    'watermark:apply',
    wrapHandler(
      ctx,
      z.tuple([
        // config 由 WatermarkService 内部校验，IPC 层仅做基本存在性检查
        z.record(z.string(), z.unknown()),
        schemas.filePathArray,
        schemas.filePath
      ]),
      async ([config, filePaths, targetDir]) => {
        for (const p of filePaths) assertFileReadPath(p)
        assertFileWritePath(targetDir)

        // 性能重构 v3 改造项三：注册任务到 TaskRegistry，支持 task:cancel 统一取消
        // taskId 唯一标识本次水印任务，渲染进程从 task:progress.taskId 取得后可调用 task:cancel
        const taskId = `watermark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const startedAt = Date.now()
        const controller = taskRegistry.register(taskId)
        const progressThrottle = new ProgressThrottle(200) // 200ms = 5 FPS
        const etaCalculator = new EtaCalculator(10)
        const total = filePaths.length

        // 监听 abort：用户调用 task:cancel 时立即推送 cancelled 终态
        // applyBatch 内部会检测 signal.aborted 主动 return，此处仅负责推送终态进度
        controller.signal.addEventListener('abort', () => {
          progressThrottle.push({
            taskId,
            taskType: 'watermark',
            phase: 'cancelled',
            current: 0,
            total: 0,
            percent: 0,
            message: t('main.watermark.message.cancelled'),
            startedAt,
            canCancel: false
          })
        })

        // 推送统一进度通道（task:progress，节流 200ms）
        const pushProgress = (current: number, message: string) => {
          if (controller.signal.aborted) return
          const { etaMs, perSec } = etaCalculator.push(current, total)
          const p: TaskProgress = {
            taskId,
            taskType: 'watermark',
            phase: 'processing',
            current,
            total,
            percent: Math.min(100, Math.floor((current / total) * 100)),
            processedPerSec: perSec,
            etaMs,
            message,
            startedAt,
            canCancel: true
          }
          progressThrottle.push(p)
        }

        const pushTerminal = (phase: 'done' | 'error', message: string) => {
          progressThrottle.push({
            taskId,
            taskType: 'watermark',
            phase,
            current: 0,
            total: 0,
            percent: phase === 'done' ? 100 : 0,
            message,
            startedAt,
            canCancel: false
          })
        }

        try {
          const result = await ctx.watermarkService.applyBatch(
            config as unknown as WatermarkConfig,
            filePaths,
            targetDir,
            (current, total) => {
              // 向后兼容：保留 watermark:progress 通道推送（旧监听者忽略新增字段）
              ctx.getMainWindow()?.webContents.send('watermark:progress', { current, total })
              // 同时推送统一 task:progress 通道（含 ETA + taskId，供新 UI 订阅）
              pushProgress(current, t('main.watermark.progress.applying', { current, total }))
            },
            controller.signal
          )

          // 终态推送（取消的终态已由 abort 监听器立即推送，此处跳过避免重复）
          if (result.cancelled) {
            // 取消时已由 abort 监听器推送 cancelled 终态，无需再推 done
          } else if (result.success) {
            pushTerminal('done', result.message || t('main.watermark.message.done'))
          } else {
            pushTerminal('error', result.message || t('main.watermark.message.failed'))
          }

          return {
            ...result,
            // 性能重构 v3：附带 taskId，便于 UI 在异常情况下也能调用 task:cancel
            taskId
          }
        } finally {
          taskRegistry.unregister(taskId)
          progressThrottle.dispose()
          etaCalculator.reset()
        }
      }
    )
  )

  ipcMain.handle(
    'watermark:saveTemplate',
    wrapHandler(
      ctx,
      z.tuple([
        schemas.shortString(128),
        // config 为 JSON 字符串，限长 256KB 避免恶意超大写入
        z
          .string()
          .min(1, t('main.watermark.validation.configRequired'))
          .max(256 * 1024, t('main.watermark.validation.configMaxLength'))
      ]),
      async ([name, config]) => {
        const db = ctx.dbManager.getDatabase()
        if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
        const result = db
          .prepare(
            'INSERT INTO watermark_templates (name, config, is_builtin, created_at) VALUES (?, ?, 0, datetime("now"))'
          )
          .run(name, config)
        return { id: Number(result.lastInsertRowid) }
      }
    )
  )

  ipcMain.handle(
    'watermark:loadTemplates',
    wrapHandlerNoArgs(ctx, async () => {
      const db = ctx.dbManager.getDatabase()
      if (!db) return []
      return db.prepare('SELECT * FROM watermark_templates ORDER BY created_at DESC').all()
    })
  )

  ipcMain.handle(
    'watermark:deleteTemplate',
    wrapHandler(ctx, z.tuple([schemas.positiveIntId]), async ([id]) => {
      const db = ctx.dbManager.getDatabase()
      if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
      db.prepare('DELETE FROM watermark_templates WHERE id = ?').run(id)
      return { deleted: true }
    })
  )
}
