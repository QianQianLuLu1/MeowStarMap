import { dialog } from 'electron'
import type { AppContext } from './app-context'
import type { WorkerCrashInfo } from '../utils/worker-restart-policy'
import { logger } from '../utils/logger'
import { cleanupInterruptedScanHistory } from './startup-tasks'

/**
 * 注册数据库恢复 + 3 个 worker 崩溃监听器，事件暂存到 pendingRecoveryEvents。
 * 必须在 dbManager.initialize() 之前调用，确保 initialize 期间的恢复事件能被捕获。
 *
 * R18：worker 崩溃后主动修复脏状态：
 * - 扫描进程崩溃 → 清理 scan_history 孤儿 status='running' 记录
 * - 数据库写进程崩溃 → 刷新 media_count 缓存（写操作可能丢失导致缓存陈旧）
 */
export function registerRecoveryListeners(ctx: AppContext): void {
  // 数据库恢复监听器
  ctx.dbManager.addRecoveryListener((info) => {
    const title = info.success ? '数据库已自动恢复' : '数据库恢复失败'
    const bodyParts = [info.reason]
    if (info.sourceBackup) {
      bodyParts.push(`来源备份：${info.sourceBackup.filename}`)
    }
    if (info.corruptedBackupPath) {
      bodyParts.push(`损坏数据库已备份至：${info.corruptedBackupPath}`)
    }
    ctx.pendingRecoveryEvents.push({
      kind: 'database',
      title,
      body: bodyParts.join('\n')
    })
  })

  // 三个 worker 的崩溃监听器
  // R18：repairAction 在事件 push 后执行，清理崩溃留下的脏状态
  const registerWorkerCrashListener = (
    bridge: {
      onCrash: (listener: (info: WorkerCrashInfo) => void) => () => void
    },
    workerLabel: string,
    repairAction?: () => void
  ): void => {
    bridge.onCrash((info) => {
      // 启动握手超时：worker 从未就绪，文案区别于"运行中崩溃"
      const isStartupTimeout = info.stage === 'startup-timeout'
      const title = isStartupTimeout
        ? `${workerLabel} 启动失败`
        : info.restartScheduled
          ? `${workerLabel} 已自动重启`
          : info.restartExhausted
            ? `${workerLabel} 重启次数耗尽`
            : `${workerLabel} 异常退出`
      const bodyParts = isStartupTimeout
        ? [`发生时间：${info.crashedAt}`]
        : [
            `退出码：${info.exitCode}`,
            `崩溃时间：${info.crashedAt}`,
            `重启次数：${info.restartCount} / ${info.restartExhausted ? '已耗尽' : '允许继续'}`
          ]
      if (isStartupTimeout) {
        bodyParts.push('后台进程未在限定时间内就绪，相关任务已停止等待。请重试或重启应用。')
      } else if (info.restartScheduled) {
        bodyParts.push('系统已自动重启 worker 进程，相关任务将尝试恢复。')
      } else if (info.restartExhausted) {
        bodyParts.push('worker 多次崩溃，已停止自动重启。相关功能可能不可用，请重启应用。')
      }
      ctx.pendingRecoveryEvents.push({
        kind: 'worker',
        title,
        body: bodyParts.join('\n')
      })

      // R18：主动修复脏状态（不阻塞事件通知流程）
      if (repairAction) {
        try {
          repairAction()
        } catch (err) {
          logger.error(`[App] ${workerLabel} 崩溃后主动修复失败:`, err)
        }
      }
    })
  }

  // R18：扫描进程崩溃 → 清理 scan_history 孤儿记录
  registerWorkerCrashListener(ctx.scannerWorkerBridge, '扫描进程', () => {
    cleanupInterruptedScanHistory(ctx)
  })
  // R18：数据库写进程崩溃 → 刷新 media_count 缓存
  registerWorkerCrashListener(ctx.databaseWorkerBridge, '数据库写进程', () => {
    ctx.notifyMediaUpdated()
  })
  registerWorkerCrashListener(ctx.mediaWorkerBridge, '媒体处理进程')
  // FIX(组17-1)：解密网络解码进程崩溃提示（一次性请求语义，无需恢复动作）
  registerWorkerCrashListener(ctx.decryptionWorkerBridge, '解密网络解码进程')
}

/**
 * 补查 dbManager.initialize() 期间的恢复事件。
 * 监听器虽已注册，但 initialize 内部触发的恢复事件可能因时序问题未被监听器捕获，
 * 通过 getLastRecovery() 兜底查询，确保用户收到提示。
 */
export function checkPendingDatabaseRecovery(ctx: AppContext): void {
  const last = ctx.dbManager.getLastRecovery()
  if (!last) return
  // 仅当暂存队列中尚无数据库恢复事件时才补入，避免重复
  const hasDbEvent = ctx.pendingRecoveryEvents.some((e) => e.kind === 'database')
  if (hasDbEvent) return
  const title = last.success ? '数据库已自动恢复' : '数据库恢复失败'
  const bodyParts = [last.reason]
  if (last.sourceBackup) {
    bodyParts.push(`来源备份：${last.sourceBackup.filename}`)
  }
  if (last.corruptedBackupPath) {
    bodyParts.push(`损坏数据库已备份至：${last.corruptedBackupPath}`)
  }
  ctx.pendingRecoveryEvents.push({
    kind: 'database',
    title,
    body: bodyParts.join('\n')
  })
}

/**
 * 弹出所有暂存的恢复 / 崩溃事件提示。
 * 在 createMainWindow 完成后调用，确保 dialog 有正确的父级窗口。
 */
export function flushPendingRecoveryEvents(ctx: AppContext): void {
  if (ctx.pendingRecoveryEvents.length === 0) return
  const events = ctx.pendingRecoveryEvents.splice(0)
  // 优先用 mainWindow 作为父级；窗口不存在时退化为无父级弹窗
  const parent = ctx.mainWindow ?? undefined
  // 串行弹窗，避免多个 dialog 重叠
  const showDialogs = async (): Promise<void> => {
    for (const event of events) {
      try {
        // Electron 30+ dialog.showMessageBox 重载：传 BrowserWindow 与不传两种调用方式
        await (parent
          ? dialog.showMessageBox(parent, {
              type: event.kind === 'database' ? 'warning' : 'info',
              title: event.title,
              message: event.title,
              detail: event.body,
              buttons: ['确定'],
              defaultId: 0,
              cancelId: 0,
              noLink: true
            })
          : dialog.showMessageBox({
              type: event.kind === 'database' ? 'warning' : 'info',
              title: event.title,
              message: event.title,
              detail: event.body,
              buttons: ['确定'],
              defaultId: 0,
              cancelId: 0,
              noLink: true
            }))
      } catch (err) {
        logger.error('[App] 弹出恢复事件提示失败:', err)
      }
    }
  }
  void showDialogs()
}
