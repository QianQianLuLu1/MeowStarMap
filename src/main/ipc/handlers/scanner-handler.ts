import { ipcMain } from 'electron'
import { z } from 'zod'
import path from 'path'
import type { HandlerContext } from '../handler-context'
import {
  wrapHandler,
  wrapHandlerNoArgs,
  wrapHandlerRaw,
  schemas,
  assertFileReadPath,
  pathGuard
} from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { logger } from '../../utils/logger'
import { scanLogStore } from '../../scanner/scan-log-store'
// P1-A1：4 组函数抽取到共享服务模块，启动路径与 IPC 路径共用同一份实现
import { generateThumbnailsForUnprocessed } from '../../services/thumbnail-phash-service'
import { ImportRootRepository } from '../../database/import-root-repository'
import { detectGameRootCandidates } from '../../scanner/game-directory-discovery'
import { t } from '../../i18n'

// scanner:start 参数 schema（提取到模块级避免每次调用重建）
const scannerStartSchema = z
  .object({
    path: schemas.filePath.optional(),
    incremental: z.boolean().optional(),
    customKnownPaths: z
      .array(schemas.filePath)
      .max(64, t('main.scanner.validation.customPathsMax'))
      .optional(),
    // 需求三.3：用户在设置页取消勾选的游戏目录，扫描时排除。
    // 仅做字符串校验——排除语义无提权风险，不做 assertFileReadPath。
    excludedPaths: z.array(z.string().min(1).max(1024)).max(64).optional(),
    fullScan: z.boolean().optional()
  })
  .optional()

// scanner:detectGameRoots 参数 schema
const detectGameRootsSchema = z
  .object({
    customPaths: z.array(z.string().min(1).max(1024)).max(64).optional()
  })
  .optional()

/**
 * 扫描目标路径读校验。
 *
 * 必须在调用扫描器之前执行：扫描结果会以 source_path 落库，随后
 * refreshPathGuardRoots 会把 source_path 反向注册为 pathGuard 白名单根。
 * 若此处不校验，渲染进程即可用任意路径发起扫描，把该路径"扫"进白名单，
 * 之后所有 file/video/editor 域的读写都对它放行——即一条自助提权链。
 *
 * 合法调用方的路径来源都已在白名单内：
 * - path：dialog:selectDirectory 选中时已 pathGuard.register
 * - customKnownPaths：settings.customScanPaths，启动时由 refreshPathGuardRoots 注册
 * - 用户显式选择（userPicked）路径短路放行：不受敏感目录黑名单误拦（见下方实现注释）
 */
function assertScanPathsAllowed(options?: { path?: string; customKnownPaths?: string[] }): void {
  // userPicked 短路：dialog:selectDirectory / dialog:openFile(openDirectory) 登记的
  // 「用户显式选择」标记 = 用户在真实系统对话框中的授权行为，跳过 PathGuard 校验，
  // 修复敏感目录黑名单误拦显式选择的系统目录（如装在 X:\Program Files 的游戏根）；
  // 渲染进程伪造的路径（未经对话框，无任何 IPC 可写入标记集合）不命中，
  // 仍走 assertFileReadPath 完整白名单 + 黑名单校验，防自助提权链不放宽。
  if (options?.path && !pathGuard.isUserPicked(options.path)) assertFileReadPath(options.path)
  for (const p of options?.customKnownPaths ?? []) {
    if (!pathGuard.isUserPicked(p)) assertFileReadPath(p)
  }
}

/**
 * scanner 域 IPC handler：扫描启动 / 停止 / 状态查询。
 */
export function registerScannerHandlers(ctx: HandlerContext): void {
  // FIX(组2-3): 扫描完成后的链式动作与 scanner:complete 广播抽取为共享函数——
  // IPC 发起路径与崩溃自动重启恢复的扫描（restoredComplete 事件）需要一致的处理：
  // 恢复扫描的完成不经过 scanner:start 的 await 路径（其 Promise 已在崩溃合成事件时
  // 以失败 resolve），不补齐则渲染端永久认为本次扫描失败、链式动作不会执行。
  const runPostScanActions = async (
    result: { success: boolean; message?: string; filesFound?: number },
    options?: { path?: string }
  ): Promise<void> => {
    if (result.success && result.filesFound && result.filesFound > 0) {
      // 扫描完成后异步生成缩略图并读取尺寸
      // 分级调度：链式触发的缩略图生成作为低优先级任务入队，避免与用户操作争抢 CPU
      generateThumbnailsForUnprocessed(ctx, 'low').catch((err) => {
        logger.error(t('main.scanner.log.postScanThumbFailed'), err)
      })
    }
    // 指定目录扫描：登记导入根，使该目录文件对图库视图放行（galleryHighQualityOnly 过滤依赖 import_roots）
    // 登记失败仅记日志，不影响扫描成功返回（与 import-handler 的降级策略一致）
    // 必须在 notifyMediaUpdated 之前 await 完成，确保渲染端刷新时放行条件已生效
    if (result.success && options?.path) {
      try {
        const db = ctx.dbManager.getDatabase()
        if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
        const importRootRepo = new ImportRootRepository(
          db,
          ctx.dbManager.getWorkerBridge(),
          ctx.dbManager.getDbPath()
        )
        await importRootRepo.addImportRoot(options.path)
      } catch (err) {
        logger.warn(t('main.scanner.log.registerImportRootFailed'), err)
      }
    }
    // 通知渲染进程扫描已结束，防止 IPC 返回前 UI 卡在"正在扫描"
    ctx.getMainWindow()?.webContents.send('scanner:complete', result)
    // 扫描完成后刷新媒体列表（含缓存失效 + media_count 刷新 + 节流广播）
    ctx.notifyMediaUpdated()
  }

  // 崩溃恢复的扫描完成：补齐广播与链式动作（见上方 runPostScanActions 注释）
  ctx.scannerManager.on('restoredComplete', (result, options) => {
    void runPostScanActions(result, options)
  })

  // ---- scanner 域 ----
  // scanner:start 特殊：参数校验失败 / handler 抛错也必须广播 scanner:complete 事件，
  // 否则前端 ScanButton.onComplete 兜底失效。故使用 wrapHandlerRaw 自行编排广播逻辑。
  ipcMain.handle(
    'scanner:start',
    wrapHandlerRaw<{ filesFound?: number; message?: string; success: boolean }>(
      ctx,
      async (args, ctx) => {
        const sendComplete = (result: { success: boolean; message?: string }) => {
          ctx.getMainWindow()?.webContents.send('scanner:complete', result)
        }
        const parsed = scannerStartSchema.safeParse(args[0])
        if (!parsed.success) {
          const message = parsed.error.issues
            .map((i) => `[${i.path.join('.')}] ${i.message}`)
            .join('; ')
          sendComplete({
            success: false,
            message: t('main.scanner.error.validationFailed', { reason: message })
          })
          // 抛 AppError 由 wrapHandlerRaw 统一包装为失败响应
          throw AppError.validation(t('main.scanner.error.validationFailed', { reason: message }))
        }
        const options = parsed.data
        // 全链路诊断：每次扫描启动重置诊断日志轨迹
        scanLogStore.startRun()
        // 路径白名单校验：失败同样要广播 complete，否则前端停在"正在扫描"
        // FIX(组1-1): 校验必须先于 registerRoots 执行——原先先登记 scanRoots 再校验，
        // 而登记的恰是待校验的路径（options.path 与 customKnownPaths 的 resolve 结果），
        // 白名单校验对本 handler 永远通过，形同虚设：渲染进程被入侵后可借 scanner:start
        // 把任意绝对路径注册进 pathGuard 白名单（等同任意目录授权），与上方"防自助提权链"
        // 注释的意图矛盾。合法调用方的路径来源此刻已在白名单内（dialog 选择时登记 /
        // settings:set 逐条读校验 + 启动时 refreshPathGuardRoots 注册），不会被误拦。
        try {
          assertScanPathsAllowed(options)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          sendComplete({
            success: false,
            message: t('main.scanner.error.pathCheckFailed', { reason: message })
          })
          // 原样上抛，保留 AppError.forbidden 的错误码，不降级为 internal
          throw error
        }
        // Bug B 修复（校验通过后登记）：扫描根（用户指定目录 / 设置页自定义路径）登记进白名单，
        // 使 file/video/editor 域对扫描到的媒体路径放行。这些路径已通过上方白名单校验，
        // 来自 dialog 选择或 settings.customScanPaths（用户显式授权），与 dialog-handler
        // 的 pathGuard.register 行为一致，并非任意路径提权。
        const scanRoots = [options?.path, ...(options?.customKnownPaths ?? [])]
          .filter((p): p is string => typeof p === 'string' && p.length > 0)
          .map((p) => path.resolve(p))
        if (scanRoots.length > 0) pathGuard.registerRoots(scanRoots)
        try {
          const result = await ctx.scannerManager.startScan(options)
          await runPostScanActions(result, options)
          return result
        } catch (error) {
          const message = t('main.scanner.error.scanFailed', {
            reason: error instanceof Error ? error.message : String(error)
          })
          sendComplete({ success: false, message })
          // 即使扫描失败也刷新一次（DB 可能有旧数据需要重新加载）
          ctx.notifyMediaUpdated()
          logger.error(t('main.scanner.log.startFailed'), error)
          throw AppError.internal(message)
        }
      }
    )
  )

  ipcMain.handle(
    'scanner:stop',
    wrapHandlerNoArgs(ctx, async () => ctx.scannerManager.stopScan())
  )

  ipcMain.handle(
    'scanner:status',
    wrapHandlerNoArgs(ctx, async () => ctx.scannerManager.getStatus())
  )

  // 需求三.3：枚举全部游戏目录候选（含来源、修改时间、是否含 GamePlayPhotos），
  // 供设置页列出并让用户取消勾选；取消项经 scanner:start 的 excludedPaths 传入。
  ipcMain.handle(
    'scanner:detectGameRoots',
    wrapHandler(ctx, z.tuple([detectGameRootsSchema]), async ([options]) =>
      detectGameRootCandidates(options?.customPaths)
    )
  )
}
