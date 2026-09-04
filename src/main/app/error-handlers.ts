import { app, dialog } from 'electron'
import { logFault, getLogDirectory } from '../utils/logger'
import { logStartupError } from '../utils/startup-diagnostic'
import { t } from '../i18n'
import { reportEarlyFatal, showNonFatalErrorBox } from '../utils/early-crash-guard'

// P1-5：首次异常弹出对话框提示用户，避免高频打扰
// P1-A9：退出竞态 guard——仅 uncaughtException（致命路径）会置位并退出；
// unhandledRejection 走分级策略不再退出，避免游离 rejection 杀死整个应用
let hasShownRuntimeErrorDialog = false
// 退出竞态守卫：uncaughtException 致命路径现已委托 early-crash-guard.reportEarlyFatal（内含 isExiting），
// 此处保留仅作 unhandledRejection 路径的短路保护（reportEarlyFatal 退出后不再处理游离 rejection）。
const isExiting = false

// unhandledRejection 分级策略：时间窗口内连续高频才提示重启，偶发仅记录 + 提示
const REJECTION_WINDOW_MS = 10_000
const REJECTION_HIGH_FREQ_THRESHOLD = 5
let rejectionWindowStart = 0
let rejectionCount = 0

// P1-5：安全获取日志目录路径，避免在 logger 未初始化或异常情况下抛错
// 用于错误对话框等关键路径，必须保证不会因获取路径失败而再次抛错
function getLogDirectorySafe(): string {
  try {
    const dir = getLogDirectory()
    return dir || t('main.errorHandlers.unknownPath')
  } catch {
    return t('main.errorHandlers.unknownPath')
  }
}

/**
 * 注册全局错误处理器。
 * 使用闭包封装 hasShownRuntimeErrorDialog / isExiting 状态，避免重复弹窗与重复退出。
 * 必须在 dbManager.initialize() 之前调用，确保 initialize 期间的异常能被捕获。
 */
export function registerGlobalErrorHandlers(): void {
  process.on('uncaughtException', (err) => {
    // 中心化到 early-crash-guard：不依赖 i18n 的原生弹框 + 同步落盘 + 释放锁 + 退出。
    // 与 index.ts 早期监听器共用 reportEarlyFatal 的去重守卫，避免重复弹窗 / 退出；
    // 同时修复原 t() 弹框在 i18n 未就绪时二次抛错 → 无弹窗的静默崩溃问题。
    reportEarlyFatal(err, { stage: 'uncaughtException' })
  })
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    logStartupError('unhandledRejection', err)
    try {
      // 非致命路径不退出，无退出竞态，异步记录即可
      logFault('unhandledRejection', err, { source: 'process.unhandledRejection' }).catch(() => {})
    } catch {}
    // 已进入退出流程（uncaughtException 触发）则不再打扰用户
    if (isExiting) return

    // 分级策略：统计时间窗口内连续 rejection 次数，高频才提示重启
    const now = Date.now()
    if (rejectionCount === 0) {
      rejectionWindowStart = now
    } else if (now - rejectionWindowStart > REJECTION_WINDOW_MS) {
      // 超出时间窗口视为新的一轮，重置计数
      rejectionWindowStart = now
      rejectionCount = 0
    }
    rejectionCount++
    if (rejectionCount >= REJECTION_HIGH_FREQ_THRESHOLD) {
      // 连续高频：提示重启（用户主动选择，非退出式兜底）
      try {
        logStartupError(
          'unhandledRejection-high-frequency',
          new Error(`${REJECTION_WINDOW_MS / 1000}s 内出现 ${rejectionCount} 次未处理 rejection`)
        )
      } catch {}
      try {
        dialog
          .showMessageBox({
            type: 'warning',
            title: t('main.errorHandlers.dialog.frequentErrorTitle'),
            message: t('main.errorHandlers.dialog.frequentErrorMessage'),
            detail: t('main.errorHandlers.dialog.frequentErrorDetail', {
              logPath: getLogDirectorySafe()
            }),
            buttons: [
              t('main.errorHandlers.dialog.restartApp'),
              t('main.errorHandlers.dialog.continueUsing')
            ],
            defaultId: 1,
            cancelId: 1,
            noLink: true
          })
          .then((result) => {
            if (result.response === 0) {
              // 用户主动选择重启（非强制兜底）
              try {
                app.relaunch()
              } catch {}
              try {
                app.releaseSingleInstanceLock?.()
              } catch {}
              try {
                app.quit()
              } catch {}
            }
          })
          .catch(() => {})
      } catch {}
      // 重置窗口，避免高频期间每次 rejection 都重复弹窗
      rejectionCount = 0
      return
    }

    // 偶发：首次弹出对话框提示用户，后续静默记录避免打扰。
    // 改用不依赖 i18n 的 showNonFatalErrorBox（修复 t() 未就绪二次抛错 → 无弹窗）。
    if (!hasShownRuntimeErrorDialog) {
      hasShownRuntimeErrorDialog = true
      showNonFatalErrorBox(err)
    }
  })
}
