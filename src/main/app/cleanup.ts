import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import type { AppContext } from './app-context'
import { logStartupError } from '../utils/startup-diagnostic'
import { killAllProcesses, getProcessRegistryStats } from '../utils/process-registry'
import { wifiShareService } from '../services/share-wifi-service'
import { backupService } from '../services/backup-service'
import { markCleanShutdown, markExitStage } from './exit-forensics'
import { t } from '../i18n'

/**
 * 退出前异步清理：确保所有资源正确释放后再调用 app.exit(0)
 * 修复"前几次正常，后续无法启动"的核心问题：
 * 1. 清理启动定时器（防止回调在 db.close 后访问数据库或启动新子进程）
 * 2. kill 所有活跃 ffmpeg/ffprobe/PowerShell 子进程（防止子进程保持事件循环活跃）
 * 3. 停止扫描器 + WiFi 服务
 * 4. flush 缩略图访问时间
 * 5. 关闭数据库（含 WAL checkpoint）
 * 6. 兜底：app.exit(0) 强制退出，不等待事件循环
 */
export async function performCleanup(ctx: AppContext): Promise<void> {
  markExitStage('cleanup')
  // P0-6：清理前记录诊断信息（活跃句柄、子进程数量等），便于诊断"进程不退出"问题
  const beforeStats = collectExitDiagnosis('before-cleanup', ctx)

  // 1. 清理启动定时器
  for (const t of ctx.startupTimers) {
    try {
      clearTimeout(t)
    } catch {}
  }
  // 原地清空，保持与 Application.startupTimers 的引用同步（ctx.startupTimers 指向同一数组）
  ctx.startupTimers.length = 0
  const mediaUpdateTimer = ctx.getMediaUpdateTimer()
  if (mediaUpdateTimer) {
    try {
      clearTimeout(mediaUpdateTimer)
    } catch {}
    ctx.setMediaUpdateTimer(null)
  }

  // 2. kill 所有活跃子进程（ffmpeg/ffprobe/PowerShell）
  try {
    killAllProcesses('SIGKILL')
  } catch {}

  // 2.5 分级调度：暂停调度器 + 取消所有低优先级任务（队列中 + 正在运行）
  // 必须在 stopScan / dispose worker 之前调用，避免新任务在清理过程中启动
  try {
    ctx.taskScheduler.pause()
    ctx.taskScheduler.cancelAllLow()
  } catch {}

  // 3. 停止扫描器（设置 shouldStop 标志）
  try {
    await ctx.scannerManager.stopScan().catch(() => {})
  } catch {}

  // 3.5 全盘扫描模块进程拆分：dispose worker 进程
  // 顺序：先 stopScan（让 worker 自然完成当前批次并退出）→ 再 dispose（kill 兜底）
  // 加 1s 超时保护，避免 worker 卡住阻塞主进程退出
  try {
    await Promise.race([
      ctx.scannerWorkerBridge.dispose(),
      new Promise<void>((resolve) => setTimeout(resolve, 1000))
    ])
  } catch {}

  // 3.6 缩略图 / pHash / 重复检测进程拆分：dispose media worker 进程
  // 加 1s 超时保护，避免 worker 卡住阻塞主进程退出
  // 性能重构 v3：先调用 mediaWorkerManager.dispose() 清理 taskRegistry 注册项
  try {
    ctx.mediaWorkerManager.dispose()
  } catch {}
  try {
    await Promise.race([
      ctx.mediaWorkerBridge.dispose(),
      new Promise<void>((resolve) => setTimeout(resolve, 1000))
    ])
  } catch {}

  // 3.65 视频编辑进程拆分：dispose video editor worker 进程
  // 加 1s 超时保护，避免 worker 卡住阻塞主进程退出（worker 内部 kill ffmpeg 子进程）
  try {
    await Promise.race([
      ctx.videoEditorBridge.dispose(),
      new Promise<void>((resolve) => setTimeout(resolve, 1000))
    ])
  } catch {}

  // FIX(组17-1)：dispose 解密网络解码 worker 进程（DISPOSE → 500ms → kill 兜底）
  // 加 1s 超时保护，避免 worker 卡住阻塞主进程退出
  try {
    await Promise.race([
      ctx.decryptionWorkerBridge.dispose(),
      new Promise<void>((resolve) => setTimeout(resolve, 1000))
    ])
  } catch {}

  // 3.7 数据库写操作进程拆分：dispose database worker 进程
  // 必须在 dbManager.close() 之前完成，确保 worker 中的 WAL checkpoint 落盘
  // 加 1s 超时保护，避免 worker 卡住阻塞主进程退出
  try {
    await Promise.race([
      ctx.databaseWorkerBridge.dispose(),
      new Promise<void>((resolve) => setTimeout(resolve, 1000))
    ])
  } catch {}

  // 4. 停止 WiFi 分享服务
  try {
    wifiShareService.stop()
  } catch {}

  // 5. 备份服务清理定时器
  try {
    backupService.dispose()
  } catch {}

  // F-S5：停止缩略图 LRU 后台定时任务
  try {
    ctx.thumbnailGen.stopLruBackgroundTask()
  } catch {}

  // 6. flush 缩略图访问时间（带超时保护，避免卡住）
  try {
    await Promise.race([
      ctx.thumbnailGen.flushAccessTimes().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 1000))
    ])
  } catch {}

  // 6.5 缩略图 worker 化：dispose worker 进程（DISPOSE → 500ms 等待 → kill 兜底）
  // 单文件 worker 无 DB 连接，dispose 仅清理 pending + 退出 worker 进程
  try {
    await ctx.thumbnailWorkerBridge.dispose()
  } catch {}

  // 7. 关闭数据库（同步，含 WAL checkpoint）
  try {
    ctx.dbManager.close()
    // 启动性能优化：db close 成功（WAL checkpoint 完成）后写「干净退出」标志
    // 崩溃/强杀/超时强制退出（force-exit-timeout 的 app.exit(1)）走不到此 →
    // 标志缺失 = 上次非干净退出 → 下次启动后台全量 integrity_check 复核
    // （docs/plans/startup-perf.md §1.2：侧车文件 {dbPath}.clean-exit）
    ctx.dbManager.markCleanExit()
    // 退出取证收尾：删除心跳文件，下次启动不误报异常终止（DB close 成功 = 走到正常清理链）
    markCleanShutdown()
  } catch (error) {
    logStartupError('before-quit-db-close', error)
  }

  // P0 修复：数据库已关闭（WAL checkpoint 完成），立即释放单实例锁
  // 允许新实例启动打开数据库，不等 DLL 卸载等次要清理
  // 将持锁窗口从 2-5s（整个 cleanup）缩短到 ~1.5s（到 DB close 为止）
  // 避免"关闭应用后立即重开 → 弹'已有实例运行'对话框"的问题
  try {
    app.releaseSingleInstanceLock?.()
  } catch {}

  // P0-A3：卸载 decryption DLL，释放 C 资源，避免进程退出时内存泄漏
  try {
    const { disposeDecryptionService } = await import('../services/decryption-service')
    disposeDecryptionService()
  } catch {
    /* DLL 未加载或已卸载，忽略 */
  }

  // P0-6：清理后记录诊断信息，对比 before/after 可判断哪些资源被释放
  const afterStats = collectExitDiagnosis('after-cleanup', ctx)
  // P0 根因修复：原实现调用 logFault（async，内部用 fs.promises.appendFile），
  // 产生 FileHandleCloseReq 活跃请求，保持事件循环活跃，导致 app.exit(0) 被延迟
  // 改用同步写入 fs.appendFileSync，不产生异步请求，确保进程能立即退出
  try {
    const faultRecord = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      timestamp: new Date().toISOString(),
      type: 'exitDiagnosis',
      summary: t('main.cleanup.log.exitDiagnosisSummary'),
      detail: `before: ${JSON.stringify(beforeStats)}\nafter: ${JSON.stringify(afterStats)}`,
      pid: process.pid,
      uptime: process.uptime()
    }
    const faultPath = path.join(
      app.getPath('userData'),
      'logs',
      `faults-${new Date().toISOString().slice(0, 10)}.jsonl`
    )
    fs.appendFileSync(faultPath, JSON.stringify(faultRecord) + '\n', 'utf-8')
  } catch {}
}

/**
 * P0-6：收集进程退出诊断信息
 * 记录活跃句柄、活跃请求、子进程数量、定时器数量等
 * 这些信息在"进程不退出"问题发生时能快速定位是哪个资源持有了事件循环
 */
export function collectExitDiagnosis(stage: string, ctx: AppContext): Record<string, unknown> {
  const stats = getProcessRegistryStats()
  const diagnosis: Record<string, unknown> = {
    stage,
    timestamp: new Date().toISOString(),
    pid: process.pid,
    uptime: process.uptime(),
    startupTimers: ctx.startupTimers.length,
    hasMediaUpdateTimer: !!ctx.getMediaUpdateTimer(),
    childProcessCount: stats.childProcessCount,
    ffmpegCommandCount: stats.ffmpegCommandCount
  }

  // 收集活跃句柄（HTTP server / socket / pipe 等）
  // _getActiveHandles 是 Node.js 内部 API，可能不存在于所有版本
  try {
    const handles =
      (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() || []
    diagnosis.activeHandles = handles.map((h: unknown) => {
      if (h && typeof h === 'object' && 'constructor' in h) {
        return (h as { constructor: { name: string } }).constructor.name
      }
      return String(h)
    })
  } catch {}

  // 收集活跃请求
  try {
    const requests =
      (process as unknown as { _getActiveRequests?: () => unknown[] })._getActiveRequests?.() || []
    diagnosis.activeRequests = requests.map((r: unknown) => {
      if (r && typeof r === 'object' && 'constructor' in r) {
        return (r as { constructor: { name: string } }).constructor.name
      }
      return String(r)
    })
  } catch {}

  // 仅在检测到异常资源时才记录到 startup-errors.log（避免正常退出污染日志）
  // 异常判定：有活跃句柄/请求/子进程/启动定时器未清理
  const hasIssue =
    (diagnosis.activeHandles as string[]).length > 0 ||
    (diagnosis.activeRequests as string[]).length > 0 ||
    (diagnosis.childProcessCount as number) > 0 ||
    (diagnosis.startupTimers as number) > 0

  if (hasIssue) {
    try {
      logStartupError(`exit-diagnosis-${stage}`, new Error(JSON.stringify(diagnosis, null, 2)))
    } catch {}
  }

  return diagnosis
}
