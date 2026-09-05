import path from 'path'
import fs from 'fs'
import { session } from 'electron'
import type { AppContext } from './app-context'
import { sendToRenderer } from './renderer-bridge'
import { ImportRootRepository } from '../database/import-root-repository'
import {
  processThumbnailForRow,
  generatePhashForUnprocessed,
  markDuplicates
} from '../services/thumbnail-phash-service'
import { THUMBNAIL_CONCURRENCY, CACHE_METADATA_FILENAME } from '../utils/constants'
// FIX(组19-1): 孤儿缩略图清理需豁免 LRU 元数据文件与 _low/_high 变体，见 cleanupOrphanThumbnails
import { runWithConcurrency } from '../utils/concurrency'
import { pathExists } from '../utils/file-utils'
import { isBlankCachedThumbnail } from '../utils/video-frame'
import { logger } from '../utils/logger'
import { setActiveIndexingTask } from '../utils/active-task-store'
import { ProgressThrottle } from '../utils/progress-throttle'
import { EtaCalculator } from '../utils/eta-calculator'
import { taskRegistry } from '../utils/task-registry'
import type Database from 'better-sqlite3'
import type { TaskProgress } from '../../shared/types/progress'
import { t } from '../i18n'

/**
 * 启动时后台执行一次自动扫描。
 * - 首次启动强制全盘扫描（增量=off, fullScan=on）
 * - 后续启动按用户设置（incrementalScan）
 * - 扫描完成发送 scanner:complete 事件
 * - 链式触发缩略图生成 / pHash 补算（低优先级入队）
 * - 扫描后自动分析 scene_time='unknown' 的图片
 */
export async function performStartupScan(ctx: AppContext): Promise<void> {
  try {
    // 修复：首次启动默认使用全盘扫描
    // 原版默认 incremental:true，若游戏目录查找失败则用户看不到任何媒体
    // 全盘扫描直接搜索所有盘符的媒体特征文件夹，覆盖所有安装场景
    // 后续启动按用户设置（incrementalScan）执行
    const db = ctx.dbManager.getDatabase()
    let isFirstLaunch = false
    if (db) {
      try {
        const row = db.prepare('SELECT COUNT(*) as count FROM scan_history').get() as {
          count: number
        }
        isFirstLaunch = row.count === 0
      } catch {
        // scan_history 表不存在时视为首次启动
        isFirstLaunch = true
      }
    }

    const incremental = isFirstLaunch ? false : ctx.dbManager.getSetting('incrementalScan', true)
    const fullScan = isFirstLaunch // 首次启动强制全盘扫描
    logger.info(
      `[Startup] 开始后台自动扫描，首次启动: ${isFirstLaunch}，全盘扫描: ${fullScan}，增量模式: ${incremental}`
    )
    // 修复：读取用户在设置页配置的自定义游戏路径，原先未传导致设置失效
    // key 名与 SettingKeyMap / 前端 settings:set 一致：'customScanPaths'
    const savedPaths = ctx.dbManager.getSetting<string[]>('customScanPaths', [])
    const customScanPathList = Array.isArray(savedPaths) ? savedPaths : []
    // 合并已登记导入根：导入后 scanRoot 若失败（worker 崩溃/断电），重启时补扫导入目录，
    // 避免导入文件因扫描未完成而永久不入库
    let importRoots: string[] = []
    if (db) {
      try {
        importRoots = new ImportRootRepository(db).listImportRoots()
      } catch {
        // import_roots 表缺失或读取失败时静默降级
      }
    }
    const mergedPaths = Array.from(new Set([...customScanPathList, ...importRoots]))
    const customKnownPaths = mergedPaths.length > 0 ? mergedPaths : undefined
    const result = await ctx.scannerManager.startScan({
      incremental,
      customKnownPaths,
      fullScan
    })
    logger.info(t('main.startup.log.scanComplete'), result)
    // 启动扫描也需发送 complete 事件，否则渲染进程的 scanProgress 会一直停留在 scanning:true
    sendToRenderer(ctx, 'scanner:complete', result)
    // 扫描完成后立即通知渲染进程刷新媒体列表
    // 使用 notifyMediaUpdated 而非直接 send，确保同时刷新 media_count 缓存 + 失效路径白名单
    // 不等场景分析（autoAnalyzeSceneTime 可能耗时数分钟），确保用户立即看到扫描结果
    ctx.notifyMediaUpdated()
    // 扫描后长任务（缩略图 / pHash / 场景分析）统一走 task:progress 的 indexing 任务，
    // 让弹窗在扫描完成后继续显示进度，消除"假死"无反馈
    if (result.success) {
      // 索引链独立驱动：扫描完成后立即返回，释放低优先级并发槽位。
      // 索引链本身已在 startup-scan 低优先级伞内运行，若在此 await 且在内部再次入队
      // 低优先级任务，会因 maxLowConcurrency=1 自锁（外层占满唯一槽位，内层永不启动）。
      // 改为 fire-and-forget 后，startup-integrity-check 等后续低优先级任务可正常 pump。
      void runPostScanIndexing(ctx, result.filesFound ?? 0).catch((e) =>
        logger.error(t('main.startup.log.indexingTaskError'), e)
      )
    }
  } catch (error) {
    // Bug #08-F1：console.error → logger.error，统一日志渠道
    logger.error(t('main.startup.log.autoScanFailed'), error)
    sendToRenderer(ctx, 'scanner:complete', {
      success: false,
      message: String(error)
    })
    // 即使扫描失败也刷新一次（GalleryPage 可能在 DB 就绪前加载了空列表）
    ctx.notifyMediaUpdated()
  }
}

// 索引链整体兜底超时：10 分钟。超时后强制推送终态 + fault 日志。
// 被截断的未处理文件（thumbnail IS NULL 等）下次启动/手动触发会重跑，可恢复。
const INDEXING_TOTAL_TIMEOUT_MS = 10 * 60_000

/**
 * 扫描后长任务（缩略图 / pHash / 场景分析）以统一的 'indexing' 任务推送进度。
 *
 * 为什么需要：这些任务在 scanner:complete 之后链式运行，可能耗时数分钟，
 * 原实现不推送任何进度，界面在扫描弹窗消失后长期"假死"，且无法取消。
 *
 * 改造要点（复用 task:progress / task:getActive 基础设施）：
 * - 注册为单一 taskRegistry 任务（taskType='indexing'），用户取消 → AbortController.abort()
 *   触发后中止剩余处理（停止 media-worker 的缩略图/pHash 批次 + 置 aborted 标志跳过场景分析）。
 * - 用 ProgressThrottle 在每批处理完成后上报真实 current/total/percent/eta（不再用步骤估算百分比），
 *   让 TaskProgressOverlay 在扫描完成后继续显示"建立索引"进度并可取消。
 * - 三阶段真实总量在启动时一次性统计（缩略图/phash/场景），驱动连续百分比；场景阶段额外逐张上报。
 * - 调用语义与改造前一致（向后兼容既有测试契约）：缩略图仅当 filesFound>0 执行；pHash reject 仍记日志。
 */
export async function runPostScanIndexing(ctx: AppContext, filesFound: number): Promise<void> {
  const taskId = `indexing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const startedAt = Date.now()

  // 注册统一 indexing 任务，获得 AbortController 供取消链路口径使用
  const controller = taskRegistry.register(taskId)
  // ProgressThrottle 节流推送（5 FPS），避免每批/逐张进度刷爆 IPC
  const throttle = new ProgressThrottle(200)
  // EtaCalculator 基于滑动窗口吞吐量估算剩余时间
  const eta = new EtaCalculator(10)

  // 提前统计三阶段真实总量：驱动连续百分比，避免原步骤估算的百分比跳变
  const db = ctx.dbManager.getDatabase()
  const thumbTotal = countUnprocessed(db, THUMB_QUERY)
  const phashTotal = countUnprocessed(db, PHASH_QUERY)
  const sceneTotal = countUnprocessed(db, SCENE_QUERY)
  const total = thumbTotal + phashTotal + sceneTotal
  let processed = 0
  let aborted = false
  let timedOut = false // 区分「超时」与「用户取消」的终态文案
  let cleanedUp = false

  // 统一上报：节流推送 task:progress + 同步活动快照（供挂载即拉补偿订阅前丢失事件）
  const report = (phase: TaskProgress['phase'], message: string, current = processed): void => {
    const safeTotal = Math.max(total, 1)
    const { etaMs, perSec } = total > 0 ? eta.push(current, safeTotal) : { etaMs: 0, perSec: 0 }
    const percent = safeTotal > 0 ? Math.min(100, Math.floor((current / safeTotal) * 100)) : 0
    const p: TaskProgress = {
      taskId,
      taskType: 'indexing',
      phase,
      current,
      total: safeTotal,
      percent,
      processedPerSec: perSec,
      etaMs,
      message,
      startedAt,
      canCancel: true
    }
    throttle.push(p)
    setActiveIndexingTask(p)
  }

  // 幂等清理：watchdog 与 finally 共用，避免链挂死时清理永不执行、或双清理
  const cleanup = (): void => {
    if (cleanedUp) return
    cleanedUp = true
    if (watchdogTimer) clearTimeout(watchdogTimer)
    taskRegistry.unregister(taskId)
    throttle.dispose()
    eta.reset()
    setTimeout(() => setActiveIndexingTask(null), 1500) // 终态快照渐隐，保持原样
  }

  // 整体兜底超时：fire-and-forget 链无人 await，超时必须在监听器内自清，不能只依赖 finally
  const watchdogTimer = setTimeout(() => {
    timedOut = true
    logger.error(
      `[Startup] 索引任务超过 ${INDEXING_TOTAL_TIMEOUT_MS}ms 未完成，强制终止（已处理 ${processed}）`
    )
    void logger.fault?.(
      'indexingTimeout',
      new Error(t('main.startup.error.indexingTotalTimeout')),
      {
        taskId,
        elapsedMs: Date.now() - startedAt
      }
    )
    controller.abort() // 触发下方统一 abort 监听
  }, INDEXING_TOTAL_TIMEOUT_MS)
  watchdogTimer.unref?.() // 后台启动任务不应持有 event loop

  // 取消链路口径：用户取消（task:cancel）与整体超时都走这里，幂等只触发一次。
  // abort 后停止进行中的 worker 批次，并置标志跳过场景分析（避免 cancel 无效）。
  controller.signal.addEventListener('abort', () => {
    if (aborted) return
    aborted = true
    report(
      timedOut ? 'error' : 'cancelled',
      timedOut ? t('main.startup.index.timeoutStopped') : t('main.startup.index.cancelled')
    )
    ctx.mediaWorkerManager?.stopThumbnailBatch?.()
    ctx.mediaWorkerManager?.stopPhashBatch?.()
    // 链内 markDuplicates 检查的是 shouldStopDuplicate，单独补一刀停止其续跑
    ctx.mediaWorkerManager?.stopDuplicateMark?.()
    cleanup()
  })

  try {
    report('preparing', t('main.startup.index.preparing'), 0)
    // 缩略图：仅当本次扫描发现新文件时执行（与原 if (filesFound>0) 门控一致）
    // 直接调 worker 批次，不再经 generateThumbnailsForUnprocessed → taskScheduler.enqueueLow。
    // 索引链已在 startup-scan 低优先级伞内运行，再次入队低优先级会因 maxLowConcurrency=1
    // 自锁（外层占满唯一槽位，队列内任务永不启动）。此处复刻原 runBatch 的互斥锁与 media:updated 广播。
    if (filesFound > 0 && !aborted) {
      if (ctx.isThumbnailsGenerating()) {
        logger.info(t('main.startup.log.thumbnailAlreadyRunning'))
      } else {
        ctx.setThumbnailsGenerating(true)
        try {
          const result = await ctx.mediaWorkerManager.startThumbnailBatch({
            cacheDir: ctx.thumbnailGen.getCacheDir(),
            thumbnailQuality: 'standard'
          })
          if (result.success) {
            ctx.getMainWindow()?.webContents.send('media:updated')
          } else {
            // 被抢占取消时 worker 返回 success=false + message='用户取消'，不视为错误
            // 匹配用 keyword key（zh-CN 值与 worker 返回文案一致），语言切换后应改用结构化错误码
            if (
              !result.message.includes(t('main.task.keyword.canceled')) &&
              !result.message.includes(t('main.task.keyword.alreadyRunning'))
            ) {
              logger.error(t('main.startup.log.thumbnailBatchFailed'), result.message)
            }
          }
        } finally {
          ctx.setThumbnailsGenerating(false)
        }
      }
      // 缩略图阶段进度由 worker 的 batch 真实进度独占（fix-indexing-progress §2.5），
      // 不再段末整段跳变上报；processed 仍累计，作为场景阶段百分比基底
      if (!aborted) {
        processed += thumbTotal
      }
    }
    // pHash：直接调 worker 批次（原 generatePhashForUnprocessed 在撞上低优先级自锁时 never返回，
    // 这里改为直接 await startPhashBatch，reject 仍记日志不中断）
    if (!aborted) {
      const r = await ctx.mediaWorkerManager.startPhashBatch().catch((e) => {
        logger.error(t('main.startup.log.phashStartFailed'), e)
        return { processed: 0, total: 0 }
      })
      // pHash 阶段进度由 worker 的 duplicate 真实进度独占（fix-indexing-progress §2.5），
      // 不再段末整段跳变上报；processed 仍累计，作为场景阶段百分比基底
      if (!aborted) {
        processed += r.total || phashTotal
      }
    }
    // 场景时段分析：传入 abort 信号与进度回调，主进程内降并发执行且可取消
    if (!aborted) {
      const sceneBase = processed
      await autoAnalyzeSceneTime(ctx, {
        signal: controller.signal,
        // 场景阶段：把已完成的缩略图+pHash 作为基底，叠加当前场景进度
        report: (sceneCurrent: number) =>
          report('processing', t('main.startup.index.analyzingSceneTime'), sceneBase + sceneCurrent)
      })
      if (!aborted) {
        processed += sceneTotal
        report('processing', t('main.startup.index.analyzingSceneTime'), processed)
      }
    }
    if (!aborted) {
      report('finalizing', t('main.startup.index.finalizing'), total)
      report('done', t('main.startup.index.done'), total)
    }
  } catch (err) {
    logger.error(t('main.startup.log.indexingFailed'), err)
    report('error', t('main.startup.index.errorStopped'))
  } finally {
    cleanup() // 幂等：watchdog 已清理则此处为空操作
  }
}

/** 扫描后长任务三阶段各自的总量统计 SQL（与 media-worker 内部判定保持一致） */
// GamePlayPhotos 豁免（仅图片）：与 media-worker/worker-entry.ts 缩略图批次查询同口径的归一化排除
// （口径同 media-repository.ts NORMALIZED_PATH_EXPR），避免永不处理的行计入进度分母导致进度条虚高。
// 视频例外（fix-gameplayphotos-video-thumbnail-null 节点3）：Videos/ 子树的视频无原生低清缩略图，
// 必须计入分母并由批量任务实际处理，两条 NOT LIKE 各自携带 OR file_type = 'video'。
const THUMB_QUERY =
  "SELECT COUNT(*) as count FROM media_files WHERE (thumbnail IS NULL OR width IS NULL OR height IS NULL) AND (LOWER(REPLACE(file_path, '\\', '/')) NOT LIKE '%/x6game/saved/gameplayphotos/%' OR file_type = 'video') AND (LOWER(REPLACE(file_path, '\\', '/')) NOT LIKE '%/x6game/gameplayphotos/%' OR file_type = 'video')"
const PHASH_QUERY =
  "SELECT COUNT(*) as count FROM media_files WHERE file_type = 'image' AND is_deleted = 0"
const SCENE_QUERY =
  "SELECT COUNT(*) as count FROM media_files WHERE scene_time = 'unknown' AND file_type = 'image' AND is_deleted = 0"

/**
 * 统计某阶段待处理总数（COUNT 失败时降级为 0，不阻塞索引流程）。
 */
function countUnprocessed(db: Database.Database | null, sql: string): number {
  if (!db) return 0
  try {
    const row = db.prepare(sql).get() as { count?: number } | undefined
    return row?.count ?? 0
  } catch {
    return 0
  }
}

/**
 * 场景时段自动分析：启动后自动运行，分析结果写入数据库缓存。
 * 基于 analyzeSceneBrightness 的本地图像亮度分析，不重复扫描文件。
 *
 * 改造要点（修复主进程阻塞 / 不可取消 / 无进度）：
 * - 降并发到 SCENE_CONCURRENCY（3）路，避免 sharp 解码占满主线程事件循环。
 * - 单图分析加 SCENE_PER_IMAGE_TIMEOUT_MS（10s）超时兜底：异常/超大图超时时跳过该图，仅记录不中断整体。
 * - 支持 AbortSignal：用户取消后停止领取新图（已在进行中的单图由超时兜底收尾），实现可取消。
 * - 每处理 SCENE_REPORT_EVERY 张调用 report 回调上报真实进度，供上层 indexing 任务统一推送。
 *
 * @param opts.signal 取消信号（来自 indexing 任务的 AbortController）
 * @param opts.report 进度回调 (current, total)，由调用方节流后推送 task:progress
 */
const SCENE_CONCURRENCY = 3
const SCENE_PER_IMAGE_TIMEOUT_MS = 10_000
const SCENE_REPORT_EVERY = 10
// 整体超时保护：scene_time='unknown' 图片在极端场景下可能极多，
// 设 5 分钟上限避免场景分析无限阻塞启动长任务链路
const SCENE_TOTAL_TIMEOUT_MS = 5 * 60_000

export async function autoAnalyzeSceneTime(
  ctx: AppContext,
  opts?: { signal?: AbortSignal; report?: (current: number, total: number) => void }
): Promise<void> {
  // 统一取消信号：外部 signal（来自 indexing 任务的 AbortController）或 5 分钟整体超时任一触发即中止，
  // 避免两套 abort 判断分散。用户取消时不再广播 media:updated（外层据此区分"完成"与"取消"）。
  const externalSignal = opts?.signal
  const report = opts?.report
  const controller = new AbortController()
  const totalTimer = setTimeout(() => controller.abort(), SCENE_TOTAL_TIMEOUT_MS)
  // 整体超时定时器不阻止进程退出（后台启动任务不应持有 event loop）
  totalTimer.unref?.()
  const onExternalAbort = (): void => controller.abort()
  externalSignal?.addEventListener('abort', onExternalAbort)
  const aborted = (): boolean => controller.signal.aborted

  try {
    const db = ctx.dbManager.getDatabase()
    if (!db) return

    const rows = db
      .prepare(
        "SELECT id, file_path FROM media_files WHERE scene_time = 'unknown' AND file_type = 'image' AND is_deleted = 0"
      )
      .all() as Array<{ id: number; file_path: string }>

    if (rows.length === 0) {
      logger.info(t('main.startup.log.sceneAnalysisNone'))
      return
    }

    logger.info(`[Startup] 场景时段分析：开始分析 ${rows.length} 张图片`)
    const { analyzeSceneBrightness } = await import('../utils/scene-brightness')
    const updateStmt = db.prepare('UPDATE media_files SET scene_time = ? WHERE id = ?')

    let processed = 0
    let nextIndex = 0
    const total = rows.length

    // 单图分析加超时兜底：sharp 解码异常文件可能长时间挂起，超时/失败时归一返回 unknown 并标记跳过
    const analyzeWithTimeout = (filePath: string): Promise<{ ok: boolean; value: string }> =>
      new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve({ ok: false, value: 'unknown' }),
          SCENE_PER_IMAGE_TIMEOUT_MS
        )
        // 超时定时器不阻止进程退出（后台启动任务不应持有 event loop）
        timer.unref?.()
        Promise.resolve(analyzeSceneBrightness(filePath))
          .then((v) => resolve({ ok: true, value: v }))
          .catch(() => resolve({ ok: false, value: 'unknown' }))
      })

    // 降并发 + 可取消：固定 N 路 worker，每领取下一张前检查统一取消信号
    const worker = async (): Promise<void> => {
      while (true) {
        if (aborted()) return
        const i = nextIndex++
        if (i >= rows.length) return
        const row = rows[i]
        const res = await analyzeWithTimeout(row.file_path)
        if (res.ok) {
          updateStmt.run(res.value, row.id)
        } else {
          // 单图失败/超时仅记录并跳过，不中断整体索引流程
          logger.warn(`[SceneBrightness] 分析失败/超时，跳过 ${row.file_path}`)
        }
        processed++
        // 每 N 张推进一次整体进度（上层 ProgressThrottle 再按 5 FPS 节流）
        if (processed % SCENE_REPORT_EVERY === 0 || processed === total) {
          report?.(processed, total)
        }
      }
    }

    const workers = Array.from({ length: Math.min(SCENE_CONCURRENCY, rows.length) }, () => worker())
    await Promise.all(workers)

    if (externalSignal?.aborted) {
      // 用户主动取消：不广播 media:updated（上层 indexing 任务已置 aborted 跳过场景阶段）
      logger.info(`[Startup] 场景时段分析：已取消，处理 ${processed}/${total} 张`)
    } else {
      logger.info(`[Startup] 场景时段分析：完成 ${processed} 张图片`)
      sendToRenderer(ctx, 'media:updated')
    }
  } catch (error) {
    logger.error(t('main.startup.log.sceneAnalysisFailed'), error)
  } finally {
    // 清理整体超时定时器与监听器，避免定时器/事件监听泄漏
    clearTimeout(totalTimer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * 清理无对应数据库记录的孤儿缩略图。
 * 读取缩略图目录，删除不在 media_files.thumbnail 列表中的文件。
 */
export async function cleanupOrphanThumbnails(ctx: AppContext): Promise<void> {
  const db = ctx.dbManager.getDatabase()
  if (!db) return

  try {
    const thumbnailDir = ctx.thumbnailGen.getCacheDir()
    const entries = await fs.promises.readdir(thumbnailDir)
    if (entries.length === 0) return

    const referencedThumbnails = new Set(
      (
        db.prepare('SELECT thumbnail FROM media_files WHERE thumbnail IS NOT NULL').all() as Array<{
          thumbnail: string
        }>
      ).map((r) => path.resolve(r.thumbnail))
    )

    let removed = 0
    await Promise.all(
      entries.map(async (entry) => {
        // FIX(组19-1): media_files.thumbnail 只引用标准档 ${hash}.jpg，首屏低质量档（${hash}_low.jpg）、
        // 高分屏高清档（${hash}_high.jpg）与 LRU 访问时间持久化文件（cache-metadata.json）不在引用集合内，
        // 曾被当作孤儿每次启动整体删除——LRU 持久化机制失效、变体缓存跨重启不可用、每会话重复生成+删除。
        // 豁免规则：metadata 文件直接保留；变体档剥离 _low/_high 后缀还原标准档名（与 generator
        // enforceCacheLimit 相同的归并手法），标准档仍被引用则保留；标准档也未被引用的变体才是真孤儿
        if (entry === CACHE_METADATA_FILENAME) return
        const thumbPath = path.resolve(thumbnailDir, entry)
        const standardName = entry.replace(/_(low|high)\.jpg$/i, '.jpg')
        const standardPath =
          standardName !== entry ? path.resolve(thumbnailDir, standardName) : thumbPath
        if (referencedThumbnails.has(standardPath)) return
        try {
          await fs.promises.rm(thumbPath, { force: true })
          removed++
        } catch (err) {
          logger.error(`[Thumbnail Cleanup] 删除孤儿缩略图失败 ${thumbPath}:`, err)
        }
      })
    )

    if (removed > 0) {
      logger.info(`[Thumbnail Cleanup] 清理 ${removed} 个孤儿缩略图`)
    }
  } catch (error) {
    logger.error(t('main.startup.log.orphanCleanupFailed'), error)
  }
}

/** 文件首次探测失败后的重试间隔，用于容忍开机时外置磁盘尚未挂载 */
const MISSING_RECHECK_DELAY_MS = 1000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 清理失效/模拟数据，并修复损坏或缺失的缩略图。
 * - 第一阶段：检查文件是否存在，不可访问的记录标记 is_missing=1（不删除）
 * - 第二阶段：并发修复缺失尺寸或缩略图的记录
 * - 最后调用 cleanupOrphanThumbnails 清理孤儿缩略图
 */
export async function cleanupAndRepairDatabase(ctx: AppContext): Promise<void> {
  const db = ctx.dbManager.getDatabase()
  if (!db) return

  // 只检查未软删除、且尚未标记缺失的记录：
  // is_deleted=1 已在回收站，is_missing=1 已知缺失，两者都无需重复探测与修复缩略图
  const rows = db
    .prepare(
      'SELECT id, file_path, file_type, thumbnail, width, height FROM media_files WHERE is_deleted = 0 AND is_missing = 0'
    )
    .all() as Array<{
    id: number
    file_path: string
    file_type: string
    thumbnail: string | null
    width: number | null
    height: number | null
  }>

  let repairedCount = 0
  // FIX(组19-2): 对齐 scanner checkMissingFiles 的"连续两次缺失"防抖——原实现首轮+1s
  // 重试失败即直接置 is_missing=1，外置盘/网络盘挂载慢于 1 秒时整盘文件被标记 missing
  // 并从图库默认视图隐藏。改为累加 missing_count，仅当累计达到 2 次才置 is_missing=1：
  // 首次探测失败只计数（文件在下次扫描/启动时仍存在则由 ON CONFLICT/更新归零）。
  const markMissingStmt = db.prepare(
    'UPDATE media_files SET missing_count = missing_count + 1, is_missing = CASE WHEN missing_count + 1 >= 2 THEN 1 ELSE 0 END WHERE id = ?'
  )
  const updateStmt = db.prepare(
    'UPDATE media_files SET width = ?, height = ?, thumbnail = ? WHERE id = ?'
  )
  const markMissingAll = db.transaction((ids: number[]) => {
    for (const id of ids) markMissingStmt.run(id)
  })

  // 第一阶段：检查文件是否存在，失效记录只标记不删除（对齐 scanner 的 checkMissingFiles）
  const validRows: typeof rows = []
  const suspectRows: typeof rows = []
  // 次因 B：悬空缩略图标记——thumbnail 列非空但其指向的缩略图文件已不存在，
  // 需在第二阶段重建（复用 processThumbnailForRow 重新生成），避免图库大面积破图。
  // 仅对有效（源文件存在）记录判定，可疑/缺失文件的缩略图无意义，跳过。
  const danglingThumbnailIds = new Set<number>()
  for (const row of rows) {
    if (await pathExists(row.file_path)) {
      if (row.thumbnail && !(await pathExists(path.resolve(row.thumbnail)))) {
        danglingThumbnailIds.add(row.id)
      }
      validRows.push(row)
      continue
    }
    suspectRows.push(row)
  }

  // 首轮不可访问的文件延迟重试一次：外置磁盘/网络盘在开机瞬间可能尚未挂载完成，
  // 单次探测会把整盘文件误判为缺失。这里用「整体等待一次 + 只重试可疑项」而非逐条 sleep，
  // 避免 N 个缺失文件累计 N 秒拖慢启动。
  const missingIds: number[] = []
  if (suspectRows.length > 0) {
    await delay(MISSING_RECHECK_DELAY_MS)
    for (const row of suspectRows) {
      if (await pathExists(row.file_path)) {
        validRows.push(row)
        continue
      }
      missingIds.push(row.id)
    }
  }

  // better-sqlite3 的事务体必须同步执行、不能跨 await，
  // 因此先异步收集缺失 id，再一次性原子提交（与 scanner 的 checkMissingFiles 写法一致）
  const missingCount = missingIds.length
  if (missingCount > 0) {
    markMissingAll(missingIds)
  }

  // 第二阶段：并发修复缩略图（也修复视频缩略图）
  // 仅修复缺失尺寸、缺失缩略图、或悬空缩略图（thumbnail 列非空但文件已不存在）的记录，
  // 避免对已正常记录重复调用 sharp/ffmpeg
  const rowsToRepair = validRows.filter((row) => {
    const needsDimensions = row.width == null || row.height == null
    const thumbnailDangling = danglingThumbnailIds.has(row.id)
    // fix-gameplayphotos-video-thumbnail-null 节点3b：thumbnail 为 NULL 的视频行纳入启动修复。
    // 批量补算被 runPostScanIndexing 的 filesFound>0 门控跳过（增量扫描 0 新增时不跑），
    // 这类行（GamePlayPhotos Videos/ 游戏视频扫描入库即 thumbnail=NULL 且尺寸齐全）
    // 若不在此处接管将永远无人补算，表现为「缓存/重复文件」板块视频纯白占位。
    const missingThumbnailVideo = row.file_type === 'video' && row.thumbnail == null
    return needsDimensions || thumbnailDangling || missingThumbnailVideo
  })

  const repairTasks = rowsToRepair.map((row) => async () => {
    // P1-A1：调用共享服务模块，启动路径与 IPC 路径共用同一份实现
    const success = await processThumbnailForRow(
      ctx,
      { id: row.id, file_path: row.file_path, file_type: row.file_type },
      updateStmt
    )
    if (success) repairedCount++
  })
  await runWithConcurrency(repairTasks, THUMBNAIL_CONCURRENCY)

  // ── 视频纯白缩略图存量自愈（fix-video-thumbnail-white-frame 收尾）──
  // seek 阶梯已阻止新白帧，但历史落盘的纯白 ${hash}.jpg 从未被触发重建：
  // 批量任务只选 thumbnail IS NULL、渲染层 generate() 被 HIGH_DPI/!thumbnail 门控、
  // 本函数原 rowsToRepair 只覆盖缺尺寸/悬空。此处对存量视频白帧主动触发一次 generate()，
  // 命中 doGenerate 缓存分支的自愈逻辑重建 standard 帧并删除重建 _low 副本。
  // 直接调 generate、不写库：自愈后 ${hash}.jpg 路径不变，无需更新 DB 指向
  // （processThumbnailForRow 的 updateStmt 参数不匹配隐患已于 fix-gameplayphotos-video-thumbnail-null 节点1 修复）。
  let healedBlankCount = 0
  const blankVideoHealTasks = validRows
    .filter((row) => row.file_type === 'video' && row.thumbnail != null)
    .map((row) => async () => {
      try {
        const thumb = row.thumbnail
        if (!thumb) return
        const resolvedThumb = path.resolve(thumb)
        if (await isBlankCachedThumbnail(resolvedThumb)) {
          await ctx.thumbnailGen.generate(row.file_path)
          // 复检 DB 实际指向的缩略图：仅当确实由白变非白才计数。
          // 覆盖三种“未真正自愈”：generate 返回 null、三位点全白仍保留白帧、内容 hash 漂移（DB 仍指旧白图）。
          // 从而全白视频不再每次启动误触发全局 clearCache，healedBlankCount 语义收敛为“真正白→真帧的转换数”。
          if (!(await isBlankCachedThumbnail(resolvedThumb))) {
            healedBlankCount++
          }
        }
      } catch (err) {
        logger.warn(`[Cleanup] 视频纯白缩略图自愈失败: ${row.file_path}`, err)
      }
    })
  await runWithConcurrency(blankVideoHealTasks, THUMBNAIL_CONCURRENCY)

  // media:// 对缩略图响应设了 Cache-Control: max-age=31536000（一年强缓存），
  // 自愈就地覆盖同名文件、URL 不变，Chromium HTTP 缓存可能仍返回旧白图字节。
  // 仅当本次确有自愈时清一次会话 HTTP 缓存，保证渲染层取到重建后的帧。
  if (healedBlankCount > 0) {
    try {
      await session.defaultSession.clearCache()
    } catch (err) {
      logger.warn(`[Cleanup] 清理 HTTP 缓存失败，缩略图自愈可能需重启后生效`, err)
    }
  }

  if (missingCount > 0 || repairedCount > 0 || healedBlankCount > 0) {
    logger.info(
      `[Cleanup] 标记 ${missingCount} 条缺失记录，修复 ${repairedCount} 条缩略图记录，自愈 ${healedBlankCount} 张纯白视频缩略图`
    )
    sendToRenderer(ctx, 'media:updated')
  }

  // 清理无对应记录的孤儿缩略图
  await cleanupOrphanThumbnails(ctx)
}

/**
 * R2：启动时重试 pending_renames 补偿表中的待处理项。
 *
 * 场景：batchRename 磁盘已 rename 但 DB 事务失败，且反向回滚磁盘也失败时，
 * handler 将该条目写入 pending_renames 表。本函数在启动时让 DB 接受磁盘的新路径，
 * 而非尝试再次回滚磁盘——因为磁盘停在 newPath 是合法的最终状态，DB 应跟随磁盘。
 *
 * 策略：
 * 1. 读取 pending_renames 全部记录
 * 2. 对每条：若 newPath 文件存在 → UPDATE media_files SET file_path=new_path, file_name=new_file_name WHERE file_path=old_path
 *    - 成功（changes>0）→ DELETE pending_renames
 *    - 失败（文件不存在 或 UPDATE 0 行）→ retry_count++，超过上限则告警但不删除
 * 3. retry_count 超过 MAX_RETRY 的记录保留在表中，便于人工排查
 */
const PENDING_RENAME_MAX_RETRY = 5

export async function retryPendingRenames(ctx: AppContext): Promise<void> {
  const db = ctx.dbManager.getDatabase()
  if (!db) return

  let rows: Array<{
    id: number
    old_path: string
    new_path: string
    new_file_name: string
    retry_count: number
  }> = []
  try {
    rows = db
      .prepare('SELECT id, old_path, new_path, new_file_name, retry_count FROM pending_renames')
      .all() as typeof rows
  } catch (err) {
    // pending_renames 表可能在旧库尚未迁移时不存在，启动失败不阻塞
    logger.warn(t('main.startup.log.readPendingRenamesFailed'), err)
    return
  }

  if (rows.length === 0) return

  logger.info(`[Startup] pending_renames 待重试 ${rows.length} 项`)
  const updateMediaStmt = db.prepare(
    'UPDATE media_files SET file_path = ?, file_name = ? WHERE file_path = ?'
  )
  const deletePendingStmt = db.prepare('DELETE FROM pending_renames WHERE id = ?')
  const incrementRetryStmt = db.prepare(
    "UPDATE pending_renames SET retry_count = retry_count + 1, last_retry_at = datetime('now') WHERE id = ?"
  )

  let recovered = 0
  let deferred = 0
  for (const row of rows) {
    // 文件不存在 → 无法确认正确路径，延后重试
    if (!(await pathExists(row.new_path))) {
      if (row.retry_count + 1 >= PENDING_RENAME_MAX_RETRY) {
        logger.warn(
          `[Startup] pending_renames id=${row.id} 重试 ${row.retry_count + 1} 次仍失败（new_path 不存在），保留待人工排查: old=${row.old_path} new=${row.new_path}`
        )
      } else {
        incrementRetryStmt.run(row.id)
        deferred++
      }
      continue
    }
    try {
      const result = updateMediaStmt.run(row.new_path, row.new_file_name, row.old_path)
      if (result.changes > 0) {
        deletePendingStmt.run(row.id)
        recovered++
      } else {
        // UPDATE 0 行：原 old_path 已不在 DB（可能被其他流程清理），删除补偿记录
        deletePendingStmt.run(row.id)
        logger.info(
          `[Startup] pending_renames id=${row.id} 原记录已不在 DB（old_path=${row.old_path}），删除补偿项`
        )
      }
    } catch (err) {
      logger.warn(`[Startup] pending_renames id=${row.id} UPDATE 失败:`, err)
      incrementRetryStmt.run(row.id)
      deferred++
    }
  }

  if (recovered > 0 || deferred > 0) {
    logger.info(`[Startup] pending_renames 重试完成：恢复 ${recovered} 项，延后 ${deferred} 项`)
    ctx.notifyMediaUpdated()
  }
}

/**
 * R4：启动时清理 scan_history 中 status='running' 的孤儿记录。
 *
 * 场景：进程崩溃/断电/强杀时，扫描 worker 退出未将 status 从 'running' 更新为终态，
 * 导致 UI 显示"扫描进行中"假象，且自动重启会插新记录而非更新旧记录。
 *
 * 策略：将所有 status='running' 的记录批量标记为 'interrupted'，并补写 end_time。
 * 简单、幂等、无副作用——只更新 DB 字段，不涉及文件系统。
 *
 * 返回受影响行数，便于启动日志统计。
 */
export function cleanupInterruptedScanHistory(ctx: AppContext): number {
  const db = ctx.dbManager.getDatabase()
  if (!db) return 0

  try {
    const result = db
      .prepare(
        "UPDATE scan_history SET status = 'interrupted', end_time = datetime('now') WHERE status = 'running'"
      )
      .run()
    if (result.changes > 0) {
      logger.info(
        `[Startup] 清理 ${result.changes} 条 scan_history 孤儿记录（running → interrupted）`
      )
    }
    return result.changes
  } catch (err) {
    // scan_history 表在旧库未迁移时可能不存在，启动失败不阻塞
    logger.warn(t('main.startup.log.cleanupScanHistoryFailed'), err)
    return 0
  }
}

/**
 * R12：扫描半可见性提示。
 *
 * 在 R4 `cleanupInterruptedScanHistory` 之后调用——检测 `status='interrupted'` 的记录，
 * 若存在则向渲染进程发送 `scanner:interrupted` 事件，UI 提示"上次扫描未完成，部分文件可能未入库"。
 *
 * 一次性消费：通知后将 `interrupted` 记录改为 `'failed'`（终态），避免每次启动重复弹窗。
 * 记录保留在 scan_history 中供历史查询，仅状态变更。
 */
export function notifyInterruptedScan(ctx: AppContext): void {
  const db = ctx.dbManager.getDatabase()
  if (!db) return

  try {
    const row = db
      .prepare('SELECT COUNT(*) as count FROM scan_history WHERE status = ?')
      .get('interrupted') as { count: number } | undefined
    const count = row?.count ?? 0
    if (count === 0) return

    logger.info(`[Startup] 检测到 ${count} 条 interrupted 扫描记录，通知 UI`)

    // 通知 UI 显示"上次扫描未完成"提示
    try {
      sendToRenderer(ctx, 'scanner:interrupted', { count })
    } catch (err) {
      // 窗口未就绪时 send 静默失败，不阻塞
      logger.warn(t('main.startup.log.notifyScanInterruptedFailed'), err)
    }

    // 一次性消费：将 interrupted 改为 failed，避免下次启动重复提示
    db.prepare("UPDATE scan_history SET status = 'failed' WHERE status = 'interrupted'").run()
  } catch (err) {
    // scan_history 表不存在或查询失败时不阻塞启动
    logger.warn(t('main.startup.log.detectInterruptedFailed'), err)
  }
}

/**
 * R9：备份恢复后置修复流程。
 *
 * 触发条件：app_settings.restored_at 存在（由 BackupService.markRestoredFlags 在恢复后写入）。
 * 一次性消费——读完即清除 3 个标志 key，避免下次启动重复触发。
 *
 * 修复内容：
 * 1. 通知 UI "已从备份恢复，正在校验数据"（发送 backup:restored 事件）。
 * 2. 若 need_phash_recheck=1：fire-and-forget 触发 phash 重算（R7 mtime 检测会自动识别 stale）。
 * 3. 若 need_duplicate_recheck=1：fire-and-forget 触发 markDuplicates 重新标记重复文件。
 *
 * 设计要点：
 * - phash 重算与 duplicate 重新标记均通过低优先级队列执行，不阻塞启动。
 * - 失败仅 logger.warn，不抛错——后置修复是"尽力而为"，用户可手动触发兜底。
 * - media_count_stale 标志由 R5 的 listMedia 读侧消费，此处不处理。
 */
export async function runPostRestoreRepair(ctx: AppContext): Promise<void> {
  const db = ctx.dbManager.getDatabase()
  if (!db) return

  // restored_at 用空串作默认值（getSetting 的类型守卫对 null 默认值与 string 解析值不兼容）
  const restoredAt = ctx.dbManager.getSetting<string>('restored_at', '')
  if (!restoredAt) return

  const needPhashRecheck = ctx.dbManager.getSetting<number>('need_phash_recheck', 0)
  const needDuplicateRecheck = ctx.dbManager.getSetting<number>('need_duplicate_recheck', 0)

  logger.info(
    `[Startup] 检测到备份恢复事件（restored_at=${restoredAt}），开始后置修复：phash=${needPhashRecheck}, duplicate=${needDuplicateRecheck}`
  )

  // 一次性消费：清除 3 个标志 key，避免下次启动重复触发
  try {
    const deleteStmt = db.prepare('DELETE FROM app_settings WHERE key = ?')
    db.transaction(() => {
      deleteStmt.run('restored_at')
      deleteStmt.run('need_phash_recheck')
      deleteStmt.run('need_duplicate_recheck')
    })()
  } catch (err) {
    // 清除失败不阻塞修复流程，下次启动会再次触发（幂等）
    logger.warn(t('main.startup.log.clearRecoveryFlagsFailed'), err)
  }

  // 通知 UI 显示"已从备份恢复，正在校验数据"
  try {
    sendToRenderer(ctx, 'backup:restored', {
      restoredAt,
      needPhashRecheck: needPhashRecheck === 1,
      needDuplicateRecheck: needDuplicateRecheck === 1
    })
  } catch (err) {
    // 窗口未就绪时 send 静默失败，不阻塞修复流程
    logger.warn(t('main.startup.log.notifyBackupRestoredFailed'), err)
  }

  // fire-and-forget 触发 phash 重算（R7 mtime 检测会自动识别 stale 记录）
  if (needPhashRecheck === 1) {
    void generatePhashForUnprocessed(ctx, 'low').catch((err) => {
      logger.warn(t('main.startup.log.postRestorePhashFailed'), err)
    })
  }

  // fire-and-forget 触发 markDuplicates 重新标记重复文件
  if (needDuplicateRecheck === 1) {
    void markDuplicates(ctx, 'low').catch((err) => {
      logger.warn(t('main.startup.log.postRestoreDuplicateFailed'), err)
    })
  }
}
