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
import { app, dialog, shell, BrowserWindow } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getUserFacingDiagDir } from './user-diag-path'
import { diagLog, logStartupError, getStartupLogPathValue } from './startup-diagnostic'
import { logFaultSync } from './logger'

const FATAL_TITLE = '启动失败 / Startup Failed'
const NONFATAL_TITLE = '程序出错 / Runtime Error'
const STARTUP_LOG_BASENAME = 'startup-errors.log'

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
  /** 是否已存在主窗口。注入便于单测；默认读 BrowserWindow.getAllWindows()。 */
  hasMainWindow?: () => boolean
}

/**
 * 弹窗展示的启动日志路径必须与 logStartupError 的真实落盘路径同源。
 *
 * 背景：此前展示端按「文档/NikkiGallery/Diagnostics」计算、写入端却回落到
 * 「<homedir>/NikkiGallery/Diagnostics」，用户在弹窗给出的目录下找不到日志。
 * 未注入 getDiagDir（生产路径）时统一取 getStartupLogPathValue()。
 */
function resolveLogPath(deps: EarlyCrashDeps): string {
  if (deps.getDiagDir) return path.join(deps.getDiagDir(), STARTUP_LOG_BASENAME)
  return getStartupLogPathValue()
}

/**
 * 落盘存在性校验：日志没写出来却给了路径，用户必然找不到。
 * 校验失败时退到 tmpdir 应急文件并改展示该路径；仍失败返回 null（调用方展示原路径）。
 */
function ensureStartupLogExists(logPath: string, message: string, stack: string): string | null {
  try {
    if (fs.existsSync(logPath)) return logPath
  } catch {
    // 无法判定存在性时按“不存在”处理
  }
  const emergencyPath = path.join(os.tmpdir(), 'NikkiGallery-startup-errors.log')
  try {
    fs.writeFileSync(
      emergencyPath,
      `[${new Date().toISOString()}] [STAGE: emergency-fallback] ${message}\n${stack}\n`,
      'utf8'
    )
    return emergencyPath
  } catch {
    return null
  }
}

/**
 * 判定是否为「子进程启动失败」（Node 对此类错误设置 syscall='spawn <code>'）。
 * 典型：`spawn EFTYPE`（ERROR_BAD_EXE_FORMAT，目标不是有效的 Win32 可执行文件）。
 */
function isChildProcessSpawnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as NodeJS.ErrnoException
  if (typeof e.syscall === 'string' && /^spawn/i.test(e.syscall)) return true
  return e.code === 'EFTYPE'
}

/**
 * 判定是否为「web 流状态竞态」（2026-10-15 线上启动闪退根因之一）。
 *
 * 为什么需要该分类：undici 对 Node 流 body 的包装（ReadableStreamFrom）在请求取消
 * 竞态下对已关闭流执行无守卫 close，抛 ERR_INVALID_STATE: Invalid state:
 * ReadableStream is already closed（堆栈仅平台帧，无应用状态受损）。该异常本属良性瞬态，
 * 但被一律致命策略升级为 app.exit(1)，叠加媒体请求取消风暴形成崩溃循环。
 * media:// 响应体已改走 Readable.toWeb 根除此路径，本分类作为其余同类平台路径
 * （上传流包装等）的最后防线：已知良性竞态，已就绪的应用不应因此退出。
 * 与 spawn 分级同理的窄匹配：code 精确相等 + message 白名单，宁漏勿滥。
 */
function isStreamStateRaceError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as NodeJS.ErrnoException
  if (e.code !== 'ERR_INVALID_STATE') return false
  return (
    typeof e.message === 'string' && /ReadableStream is already (closed|locked)/.test(e.message)
  )
}

function defaultHasMainWindow(): boolean {
  try {
    return BrowserWindow.getAllWindows().length > 0
  } catch {
    return false
  }
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
// 非致命弹框去重守卫：避免双监听器 + 视频抽帧阶梯导致多次模态框阻塞主进程
let hasShownNonFatal = false

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
  const { message, stack } = toMessage(err)

  // 子进程启动失败（如 spawn EFTYPE）在应用已开窗口后不应杀死整个应用：
  // 未挂 error 监听的子进程会把该错误冒泡为 uncaughtException，表现为
  // 「启动失败 / 程序已退出」的假致命弹窗（现场问题）。启动期（尚无窗口）仍按致命处理。
  if (isChildProcessSpawnError(err) && (deps.hasMainWindow ?? defaultHasMainWindow)()) {
    try {
      diag('SPAWN-NONFATAL', `stage=${stage} ${message}\n${stack}`)
    } catch {
      /* 忽略 */
    }
    // 补落盘：弹窗文案指向 startup-errors.log，该分支必须实际写入本次错误详情，
    // 否则用户按弹窗提示打开日志却看不到对应条目。
    try {
      logStartupErr(stage, err)
    } catch {
      /* 落盘失败不阻塞后续弹框 */
    }
    showNonFatalErrorBox(err, { deps })
    return
  }

  // 流状态竞态降级（2026-10-15 启动闪退修复）：异常抛自已分离的微任务、仅平台帧、
  // 无应用状态受损（受影响的响应流本身已销毁）。应用已就绪（有主窗口）时降级为
  // 仅记录——不弹窗（良性瞬态，弹窗即噪音）、不退出；启动期（无窗口）仍走致命路径，
  // 不影响真实启动故障的发现能力。与 spawn 分级采用同一 hasMainWindow 判定口径。
  if (isStreamStateRaceError(err) && (deps.hasMainWindow ?? defaultHasMainWindow)()) {
    try {
      // 留痕进 faults 通道：线上再出现时可按 declassified 标记检索来源
      logFault('uncaughtException', err, { stage, declassified: 'stream-race' })
    } catch {
      /* 日志失败不影响继续运行 */
    }
    try {
      diag('STREAM-RACE-NONFATAL', `stage=${stage} ${message}\n${stack}`)
    } catch {
      /* 忽略 */
    }
    return
  }

  if (hasReported) return
  hasReported = true

  let logPath = resolveLogPath(deps)

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
  // 仅生产路径做落盘校验：注入 getDiagDir 为单测场景，磁盘上本无该文件
  if (!deps.getDiagDir) {
    const verifiedPath = ensureStartupLogExists(logPath, message, stack)
    if (verifiedPath) logPath = verifiedPath
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
  const logPath = opts.logPath ?? resolveLogPath(deps)
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
  const diag = deps.diagLog ?? diagLog
  const { message } = toMessage(err)

  // 去重守卫：多个 uncaughtException 监听器 + 视频抽帧阶梯会在短时间内多次触发，
  // 模态框会阻塞主进程导致级联卡顿。首次弹框后置位，后续调用仅写 diagLog 保留可观测性。
  if (hasShownNonFatal) {
    try {
      diag('SPAWN-NONFATAL-DEDUP', `skipped duplicate dialog: ${message}`)
    } catch {
      /* 忽略 */
    }
    return
  }
  hasShownNonFatal = true

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
  const logPath = resolveLogPath(deps)
  showErrorBox(NONFATAL_TITLE, buildNonFatalContent(message, logPath))
  try {
    showItem(logPath)
  } catch {
    /* 忽略 */
  }
}

export { getUserFacingDiagDir }
