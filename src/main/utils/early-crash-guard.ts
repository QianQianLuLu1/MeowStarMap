/**
 * 启动最早期「致命错误处理」单一入口（中心化模块）。
 *
 * 设计目标：在主进程任意阶段（含 app ready 前、原生模块预检、窗口创建前）发生致命错误时，
 * 以最小依赖方式（electron 原生 dialog.showErrorBox，无需渲染进程/主窗口）弹出不依赖 i18n
 * 的明确提示，并同步落盘错误日志 + 释放单实例锁 + 退出进程。
 *
 * 依赖：
 *   - startup-diagnostic（diagLog / logStartupError，落盘不稳定阶段日志，不依赖 logger 系统）
 *   - logger（logFaultSync，崩溃退出竞态专用同步写）
 *   - user-diag-path（用户友好诊断目录，不含业务依赖，避免循环）
 *   - electron 原生 dialog / shell（均可在 ready 前同步调用）
 *
 * 注意：本模块不反向 import native-load-guard / error-handlers，避免循环依赖。
 */
import { app, dialog, shell } from 'electron'
import path from 'path'
import { getUserFacingDiagDir } from './user-diag-path'
import { diagLog, logStartupError } from './startup-diagnostic'
import { logFaultSync } from './logger'

const FATAL_TITLE = '启动失败 / Startup Failed'
const NONFATAL_TITLE = '程序出错 / Runtime Error'

export interface EarlyCrashDeps {
  showErrorBox?: (title: string, content: string) => void
  logStartupError?: (stage: string, err: unknown) => void
  diagLog?: (tag: string, msg: string) => void
  logFaultSync?: (type: string, err: unknown, ctx?: Record<string, unknown>) => string
  /** 返回诊断目录（友好路径）。注入便于单测确定性。 */
  getDiagDir?: () => string
  exitApp?: (code: number) => void
  releaseLock?: () => void
  shellShowItemInFolder?: (p: string) => void
}

function resolveDiagDir(deps: EarlyCrashDeps): string {
  if (deps.getDiagDir) return deps.getDiagDir()
  return getUserFacingDiagDir({
    getDocumentsPath: () => {
      try {
        return app.getPath('documents')
      } catch {
        return ''
      }
    }
  })
}

function toMessage(err: unknown): { message: string; stack: string } {
  const e = err instanceof Error ? err : new Error(String(err))
  return {
    message: e.message || String(err),
    stack: e.stack || `${e.name}: ${e.message}`
  }
}

function buildFatalContent(message: string, stack: string, logPath: string): string {
  return [
    'NikkiGallery 启动失败，程序已退出。',
    'NikkiGallery failed to start and has exited.',
    '',
    `原因 / Reason: ${message}`,
    '',
    `日志文件 / Log file:`,
    `  ${logPath}`,
    '',
    '请将上述日志文件发给开发者以协助定位问题。',
    'Please send the log file above to the developer to help diagnose the issue.'
  ].join('\n')
}

function buildNonFatalContent(message: string, logPath: string): string {
  return [
    '程序运行时发生错误，但已继续运行。',
    'A runtime error occurred, but the app continues running.',
    '',
    `原因 / Reason: ${message}`,
    '',
    `日志文件 / Log file:`,
    `  ${logPath}`
  ].join('\n')
}

// 去重 / 退出竞态守卫：多个 uncaughtException 监听器（index 早期 + error-handlers）共享
let hasReported = false
let isExiting = false

/**
 * 完整致命处理：落盘 + 弹框 + 释放单实例锁 + 退出进程。
 * 带去重守卫，可被 index 早期监听器与 error-handlers 监听器同时调用而不重复弹窗/退出。
 */
export function reportEarlyFatal(
  err: unknown,
  opts: { stage?: string; deps?: EarlyCrashDeps } = {}
): void {
  const deps = opts.deps ?? {}
  const showErrorBox =
    deps.showErrorBox ??
    ((t: string, c: string) => {
      try {
        dialog.showErrorBox(t, c)
      } catch {
        /* 弹框失败不阻塞退出 */
      }
    })
  const logStartupErr = deps.logStartupError ?? logStartupError
  const diag = deps.diagLog ?? diagLog
  const logFault = deps.logFaultSync ?? logFaultSync
  const exitApp =
    deps.exitApp ??
    ((code: number) => {
      try {
        app.exit(code)
      } catch {
        /* 忽略 */
      }
    })
  const releaseLock =
    deps.releaseLock ??
    (() => {
      try {
        app.releaseSingleInstanceLock?.()
      } catch {
        /* 忽略 */
      }
    })
  const showItem =
    deps.shellShowItemInFolder ??
    ((p: string) => {
      try {
        shell?.showItemInFolder?.(p)
      } catch {
        /* 忽略 */
      }
    })
  const stage = opts.stage ?? 'early-crash'

  if (hasReported) return
  hasReported = true

  const dir = resolveDiagDir(deps)
  const logPath = path.join(dir, 'startup-errors.log')
  const { message, stack } = toMessage(err)

  try {
    logStartupErr(stage, err)
  } catch {
    /* 忽略 */
  }
  try {
    diag('EARLY-FATAL', `stage=${stage} ${message}\n${stack}`)
  } catch {
    /* 忽略 */
  }
  try {
    logFault('uncaughtException', err, { stage })
  } catch {
    /* 日志失败不影响退出 */
  }
  showErrorBox(FATAL_TITLE, buildFatalContent(message, stack, logPath))
  try {
    showItem(logPath)
  } catch {
    /* 忽略 */
  }

  if (isExiting) return
  isExiting = true
  releaseLock()
  exitApp(1)
}

/**
 * 仅弹框（不退出），不依赖 i18n，文案含友好日志路径，并高亮日志文件。
 * 供 index.ts FATAL catch 与 native-load-guard 复用（调用方负责 app.exit）。
 */
export function showFatalStartupErrorBox(
  err: unknown,
  opts: { logPath?: string; deps?: EarlyCrashDeps } = {}
): void {
  const deps = opts.deps ?? {}
  const showErrorBox =
    deps.showErrorBox ??
    ((t: string, c: string) => {
      try {
        dialog.showErrorBox(t, c)
      } catch {
        /* 忽略 */
      }
    })
  const showItem =
    deps.shellShowItemInFolder ??
    ((p: string) => {
      try {
        shell?.showItemInFolder?.(p)
      } catch {
        /* 忽略 */
      }
    })
  const dir = resolveDiagDir(deps)
  const logPath = opts.logPath ?? path.join(dir, 'startup-errors.log')
  const { message, stack } = toMessage(err)
  // 仅弹框，不退出（调用方负责 app.exit）
  showErrorBox(FATAL_TITLE, buildFatalContent(message, stack, logPath))
  try {
    showItem(logPath)
  } catch {
    /* 忽略 */
  }
}

/**
 * 偶发级错误框（不退出），i18n 无关。供 error-handlers 的 unhandledRejection 偶发分支使用。
 */
export function showNonFatalErrorBox(err: unknown, opts: { deps?: EarlyCrashDeps } = {}): void {
  const deps = opts.deps ?? {}
  const showErrorBox =
    deps.showErrorBox ??
    ((t: string, c: string) => {
      try {
        dialog.showErrorBox(t, c)
      } catch {
        /* 忽略 */
      }
    })
  const showItem =
    deps.shellShowItemInFolder ??
    ((p: string) => {
      try {
        shell?.showItemInFolder?.(p)
      } catch {
        /* 忽略 */
      }
    })
  const dir = resolveDiagDir(deps)
  const logPath = path.join(dir, 'startup-errors.log')
  const { message } = toMessage(err)
  showErrorBox(NONFATAL_TITLE, buildNonFatalContent(message, logPath))
  try {
    showItem(logPath)
  } catch {
    /* 忽略 */
  }
}

export { getUserFacingDiagDir }
