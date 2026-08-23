import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { diagLog } from '../utils/startup-diagnostic'
import { logger } from '../utils/logger'
import { t } from '../i18n'

/**
 * GPU 崩溃自动回退软件渲染（复刻 VS Code 的成熟自愈模式）。
 *
 * 根因背景（2026-08-19 用户机数据裁决）：部分机器 GPU 进程无法运行，
 * Chromium 在 gpu_data_manager_impl_private.cc:415 以
 * FATAL "GPU process isn't usable. Goodbye." 自杀主进程，
 * 表现为启动 loadURL 报 ERR_FAILED(-2) 白屏（app:// 协议层无关）。
 *
 * 状态文件 userData/gpu-fallback.json：
 * - consecutiveFailures：连续启动失败次数（did-finish-load 时清零）
 * - fallbackActive：回退激活标记（一旦置位保留，用户更新显卡驱动后
 *   手动删除该文件即可恢复硬件加速）
 *
 * 恢复时序：启动1 GPU 崩溃被 child-process-gone 观测 → 同步落盘
 * fallbackActive → 主进程被 FATAL 杀死；启动2 读到标记 → whenReady 前
 * app.disableHardwareAcceleration() → 软件渲染正常启动。
 * 观测事件若早于监听器注册而丢失，则由 consecutiveFailures>=2 阈值兜底。
 *
 * 全部文件读写 try/catch 容错：无文件/损坏 JSON/userData 不可写 →
 * 视为默认状态（不禁用、不计数），绝不阻塞启动。
 */

/** 连续启动失败达到该阈值即激活回退（观测事件丢失时的兜底路径） */
const FAILURE_THRESHOLD = 2

interface GpuFallbackState {
  consecutiveFailures: number
  fallbackActive: boolean
}

const DEFAULT_STATE: GpuFallbackState = { consecutiveFailures: 0, fallbackActive: false }

function getStatePath(): string {
  return path.join(app.getPath('userData'), 'gpu-fallback.json')
}

function readState(): GpuFallbackState {
  try {
    const p = getStatePath()
    if (!fs.existsSync(p)) return { ...DEFAULT_STATE }
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      consecutiveFailures?: unknown
      fallbackActive?: unknown
    }
    const n = raw?.consecutiveFailures
    const consecutiveFailures =
      typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
    return { consecutiveFailures, fallbackActive: raw?.fallbackActive === true }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

function writeState(state: GpuFallbackState): void {
  try {
    fs.writeFileSync(getStatePath(), JSON.stringify(state))
  } catch {
    // userData 不可写等极端场景：静默降级，不影响启动决策
  }
}

/**
 * 用户偏好镜像 userData/gpu-pref.json：
 * 仅含 { hardwareAcceleration: boolean }，供 whenReady 前同步读取，
 * 因为 sqlite 业务库在 whenReady 后才初始化、启动期无法读库。
 * 与 app_settings.hardwareAcceleration 由 settings:set 双写保持一致。
 */
function getHardwareAccelPrefPath(): string {
  return path.join(app.getPath('userData'), 'gpu-pref.json')
}

/** 读取用户偏好；文件不存在/损坏/字段非布尔 → undefined（等同未设置） */
export function readHardwareAccelPref(): boolean | undefined {
  try {
    const p = getHardwareAccelPrefPath()
    if (!fs.existsSync(p)) return undefined
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      hardwareAcceleration?: unknown
    }
    const v = raw?.hardwareAcceleration
    return typeof v === 'boolean' ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * 写入用户偏好镜像；value===true 时一并复位崩溃自愈标记 fallbackActive，
 * 给用户一次干净的硬件加速重试机会（仍由真实崩溃观测兜底）。
 */
export function writeHardwareAccelPref(value: boolean): void {
  try {
    fs.writeFileSync(getHardwareAccelPrefPath(), JSON.stringify({ hardwareAcceleration: value }))
    if (value === true) {
      const state = readState()
      if (state.fallbackActive) writeState({ ...state, fallbackActive: false })
    }
  } catch {
    // 静默降级，不影响主流程
  }
}

/**
 * whenReady 前调用：本次启动是否应禁用硬件加速。
 * 决策优先级：
 *  1) 用户显式关闭（pref===false）→ 绝对优先，强制软件渲染；
 *  2) 未关闭时，崩溃自愈逻辑优先于"用户开启"：若真实 GPU 崩溃已落盘
 *     fallbackActive（或连续失败达阈值），仍回退软件渲染，避免启用后
 *     反复崩溃白屏。用户开启仅通过 writeHardwareAccelPref(true) 清空
 *     fallbackActive 来获得一次干净重试，故正常启动会落入下方返回 false。
 *  3) 无偏好且无崩溃标记 → 启用硬件加速。
 */
export function shouldDisableHardwareAcceleration(): boolean {
  const pref = readHardwareAccelPref()
  if (pref === false) return true
  const state = readState()
  if (state.fallbackActive) return true
  if (state.consecutiveFailures >= FAILURE_THRESHOLD) {
    writeState({ ...state, fallbackActive: true })
    return true
  }
  return false
}

/** whenReady 后、创建窗口前调用：登记一次启动尝试（失败计数 +1） */
export function markBootAttempt(): void {
  const state = readState()
  writeState({ ...state, consecutiveFailures: state.consecutiveFailures + 1 })
}

/** did-finish-load 时调用：启动成功，清零失败计数（fallbackActive 保留） */
export function markBootSuccess(): void {
  const state = readState()
  if (state.consecutiveFailures === 0) return // 幂等：避免重复写盘
  writeState({ ...state, consecutiveFailures: 0 })
}

/**
 * GPU 子进程崩溃时调用：同步 writeFileSync 落盘回退标记，
 * 抢在 Chromium FATAL 杀死主进程之前完成（使下一次启动即恢复）。
 */
export function markGpuProcessCrash(reason: string, exitCode: number): void {
  writeState({ consecutiveFailures: readState().consecutiveFailures, fallbackActive: true })
  diagLog('GPU', `GPU process gone (reason=${reason} exitCode=${exitCode})，已置软件渲染回退标记`)
}

/**
 * whenReady 内、首个窗口创建前注册：观测 GPU 子进程崩溃。
 * 仅记日志与落盘标记，不干预进程存活（主进程去留由 Chromium 决定）。
 */
export function setupGpuProcessWatcher(): void {
  app.on('child-process-gone', (_event, details) => {
    if (details.type !== 'GPU') return
    markGpuProcessCrash(String(details.reason ?? 'unknown'), details.exitCode ?? -1)
    try {
      logger.error(t('main.gpu.log.processCrashFallback'), details)
    } catch {
      // logger 未初始化时仅依赖 diagLog，不重抛
    }
  })
}
