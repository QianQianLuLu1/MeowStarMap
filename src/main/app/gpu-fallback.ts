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
 * 恢复时序（崩溃检测 → 自动降级 → 重启自愈）：
 *  启动1 GPU/渲染进程崩溃被观测 → requestSelfHeal 同步落盘 fallbackActive
 *  → 若本次为硬件加速启动则 app.relaunch+app.exit 自动重启进入软件渲染；
 *  启动2 读到标记 → whenReady 前 app.disableHardwareAcceleration() → 软件渲染正常启动。
 * 若主进程被 FATAL 杀死来不及自愈重启，则靠 consecutiveFailures>=2 阈值
 * 在用户下次手动启动时兜底。观测事件若早于监听器注册而丢失亦由该阈值兜底。
 *
 * 崩溃升级分级（防误判，2026-10-24 优化）：
 *  - clean-exit 一律忽略；启动期崩溃立即回退；运行期崩溃 60s 窗口内达 2 次才回退，
 *    单次瞬时崩溃交 Chromium 自行重启 GPU 进程自愈，避免无谓禁用硬件加速。
 *
 * 全部文件读写 try/catch 容错：无文件/损坏 JSON/userData 不可写 →
 * 视为默认状态（不禁用、不计数），绝不阻塞启动。
 */

/** 连续启动失败达到该阈值即激活回退（观测事件丢失时的兜底路径） */
const FAILURE_THRESHOLD = 2

/**
 * 运行期（首绘后）GPU 崩溃升级窗口：
 * 单次瞬时崩溃交由 Chromium 自行重启 GPU 进程自愈（界面短暂闪烁后恢复），
 * 仅当 60s 窗口内崩溃达到 2 次才升级为「回退软件渲染 + 自动重启」，
 * 避免 VS Code 同源的过度触发问题——一次瞬时异常就把独显/集显设备
 * 永久打入软件渲染（毛玻璃/Canvas/滚动/视频全线变慢）。
 * 启动期（首绘前）崩溃不受此窗口约束，仍立即回退（2026-08-19 白屏根因场景）。
 */
const RUNTIME_CRASH_WINDOW_MS = 60_000
const RUNTIME_CRASH_THRESHOLD = 2

/** 运行期 GPU 崩溃时间戳（毫秒，含最近 10 次；模块级内存态，重启自然清零） */
let runtimeGpuCrashTimestamps: number[] = []

/**
 * 纯函数：判断运行期 GPU 崩溃是否达到升级阈值。
 * @param crashTimestamps 崩溃时间戳数组（**含本次刚发生的这条**）
 * @param nowMs 当前时间
 * 语义：窗口 [nowMs - RUNTIME_CRASH_WINDOW_MS, nowMs] 闭区间内的崩溃数 ≥ 阈值即升级。
 */
export function shouldEscalateRuntimeGpuCrash(crashTimestamps: number[], nowMs: number): boolean {
  return (
    crashTimestamps.filter((t) => nowMs - t <= RUNTIME_CRASH_WINDOW_MS).length >=
    RUNTIME_CRASH_THRESHOLD
  )
}

interface GpuFallbackState {
  consecutiveFailures: number
  fallbackActive: boolean
  /** 激活回退（或最近一次版本级重试）时的应用版本；用于「升级后自动重试硬件加速」记账 */
  fallbackVersion?: string
}

const DEFAULT_STATE: GpuFallbackState = { consecutiveFailures: 0, fallbackActive: false }

/** 启动决策缓存：shouldDisableHardwareAcceleration 首次（index.ts 顶层、ready 前）计算后缓存，
 * 供 requestSelfHeal 判定"本次是否为硬件加速启动"——仅硬件加速启动崩溃才自动重启自愈。 */
let bootDecisionCache: boolean | null = null

/** 首绘是否完成（did-finish-load 成功即标记），用于区分"启动期崩溃"与"运行中崩溃"。 */
let appBooted = false

function getStatePath(): string {
  return path.join(app.getPath('userData'), 'gpu-fallback.json')
}

/** 当前应用版本；不可得（异常/空串）返回 ''，调用方须按「保守不重试」处理 */
function getCurrentAppVersion(): string {
  try {
    const v = app.getVersion()
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

function readState(): GpuFallbackState {
  try {
    const p = getStatePath()
    if (!fs.existsSync(p)) return { ...DEFAULT_STATE }
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      consecutiveFailures?: unknown
      fallbackActive?: unknown
      fallbackVersion?: unknown
    }
    const n = raw?.consecutiveFailures
    const consecutiveFailures =
      typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
    const fallbackVersion =
      typeof raw?.fallbackVersion === 'string' ? raw.fallbackVersion : undefined
    return { consecutiveFailures, fallbackActive: raw?.fallbackActive === true, fallbackVersion }
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
 *  0) 开发/测试强制：NIKKI_FORCE_GPU_COMPAT==='1' → 强制软件渲染（仅用于验证降级路径）；
 *  1) 用户显式关闭（pref===false）→ 绝对优先，强制软件渲染；
 *  2) 未关闭时，崩溃自愈逻辑优先于"用户开启"：若真实 GPU 崩溃已落盘
 *     fallbackActive（或连续失败达阈值），仍回退软件渲染，避免启用后
 *     反复崩溃白屏。用户开启仅通过 writeHardwareAccelPref(true) 清空
 *     fallbackActive 来获得一次干净重试，故正常启动会落入下方返回 false；
 *  3) **版本级自动重试（2026-10-24 优化）**：fallbackActive 已置位但版本戳
 *     与当前版本不一致（含旧格式无戳）→ 说明回退发生在旧版本时期，显卡
 *     驱动/系统可能已修复——落当前版本戳并返回 false，给每个新版本一次
 *     干净重试（真实崩溃观测仍兜底：再崩会重新置位并盖当前版本戳，
 *     同版本内不再重试，杜绝每启动循环）。版本不可得时保守返回 true；
 *  4) 无偏好且无崩溃标记 → 启用硬件加速（默认保留硬件加速，不牺牲性能）。
 *
 * 注意：本函数保持纯函数（每次从磁盘重读），以便既有状态机测试可重复调用；
 * 启动决策仅由 recordBootDecision() 在 index.ts 顶层缓存一次，供 requestSelfHeal 使用。
 */
export function shouldDisableHardwareAcceleration(): boolean {
  if (process.env.NIKKI_FORCE_GPU_COMPAT === '1') return true
  const pref = readHardwareAccelPref()
  if (pref === false) return true
  const state = readState()
  if (state.fallbackActive) {
    const currentVersion = getCurrentAppVersion()
    if (!currentVersion) return true // 版本不可得：保守回退，不做重试
    if (state.fallbackVersion === currentVersion) return true // 同版本已回退/已重试过
    // 版本升级（或旧格式无戳）：记录本次重试并保留硬件加速
    writeState({ ...state, fallbackVersion: currentVersion })
    return false
  }
  if (state.consecutiveFailures >= FAILURE_THRESHOLD) {
    const currentVersion = getCurrentAppVersion()
    writeState({ ...state, fallbackActive: true, fallbackVersion: currentVersion || undefined })
    return true
  }
  return false
}

/**
 * 记录本次启动的硬件加速决策（index.ts 顶层、ready 前调用一次）。
 * 结果缓存于 bootDecisionCache，供 requestSelfHeal 判定"本次是否为硬件加速启动"，
 * 从而决定是否自动重启自愈。
 * @returns 是否应禁用硬件加速（即进入兼容模式）
 */
export function recordBootDecision(): boolean {
  bootDecisionCache = shouldDisableHardwareAcceleration()
  return bootDecisionCache
}

/** 本次启动是否已进入兼容模式（即已禁用硬件加速）。 */
export function wasBootInCompatMode(): boolean {
  return bootDecisionCache === true
}

/** whenReady 后、创建窗口前调用：登记一次启动尝试（失败计数 +1） */
export function markBootAttempt(): void {
  const state = readState()
  writeState({ ...state, consecutiveFailures: state.consecutiveFailures + 1 })
}

/** 标记首绘完成（did-finish-load 成功时调用），退出启动期 */
export function markAppBooted(): void {
  appBooted = true
}

/** 是否仍处于启动期（首绘前）。true 表示渲染进程崩溃发生在启动阶段。 */
export function isStartupPhase(): boolean {
  return !appBooted
}

/** did-finish-load 时调用：启动成功，清零失败计数（fallbackActive 保留） */
export function markBootSuccess(): void {
  markAppBooted()
  const state = readState()
  if (state.consecutiveFailures === 0) return // 幂等：避免重复写盘
  writeState({ ...state, consecutiveFailures: 0 })
}

/**
 * GPU 子进程崩溃时调用：同步 writeFileSync 落盘回退标记（盖当前版本戳，
 * 使同版本内下次启动直接回退、不触发版本级重试），抢在 Chromium FATAL
 * 杀死主进程之前完成（使下一次启动即恢复）。
 */
export function markGpuProcessCrash(reason: string, exitCode: number): void {
  writeState({
    consecutiveFailures: readState().consecutiveFailures,
    fallbackActive: true,
    fallbackVersion: getCurrentAppVersion() || undefined
  })
  diagLog('GPU', `GPU process gone (reason=${reason} exitCode=${exitCode})，已置软件渲染回退标记`)
}

/**
 * 崩溃自愈入口：先同步落盘回退标记（抢在 FATAL 前），再决定是否自动重启。
 * 仅当"本次为硬件加速启动"（bootDecisionCache===false）才 app.relaunch+app.exit
 * 自动重启进入软件渲染；若本次已是兼容模式仍崩，则不重启并返回 false，
 * 交由调用方现有错误对话框处理，避免无限重启死循环。
 * relaunch/exit 全程 try/catch：失败仅保留落盘标记，靠 consecutiveFailures>=2
 * 阈值跨手动启动兜底。
 * @returns 是否已触发自动重启
 */
export function requestSelfHeal(reason: string, exitCode: number): boolean {
  markGpuProcessCrash(reason, exitCode)
  // 已兼容模式仍崩：不再自动重启，避免死循环（由调用方错误对话框兜底）
  if (bootDecisionCache === true) return false
  try {
    app.releaseSingleInstanceLock?.()
  } catch {
    // 单实例锁释放失败不影响自愈重启
  }
  try {
    app.relaunch()
    app.exit(0)
    return true
  } catch {
    return false
  }
}

/**
 * whenReady 内、首个窗口创建前注册：观测子进程崩溃。
 * GPU 事件分级处理（避免误判——Chromium 对单次运行期 GPU 崩溃会自行重启 GPU 进程自愈）：
 *  - reason=clean-exit（正常退出）→ 仅记日志，不计数不回退；
 *  - 启动期（首绘前）崩溃 → 立即 requestSelfHeal（落盘 + 自动重启进入软件渲染）；
 *  - 运行期崩溃 → 60s 窗口内第 1 次仅告警，达阈值（2 次）才升级 requestSelfHeal。
 * 其他类型（Utility/Renderer/PickleBroker 等）→ 仅记日志留痕（取证：主进程存活但子进程消失）。
 */
export function setupGpuProcessWatcher(): void {
  app.on('child-process-gone', (_event, details) => {
    const reason = String(details.reason ?? 'unknown')
    const exitCode = details.exitCode ?? -1
    if (details.type !== 'GPU') {
      diagLog(
        'CHILD-PROC',
        `child-process-gone: type=${details.type} reason=${reason} exitCode=${exitCode}`
      )
      try {
        logger.warn(
          `child-process-gone: type=${details.type} reason=${reason} exitCode=${exitCode}`
        )
      } catch {
        // logger 未初始化时仅依赖 diagLog，不重抛
      }
      return
    }
    // 正常退出（如关机/退出链中的 GPU 进程拆除）不是崩溃，绝不据此降级硬件加速
    if (reason === 'clean-exit') {
      diagLog('GPU', `GPU process clean-exit (exitCode=${exitCode})，按正常退出忽略`)
      return
    }
    // 启动期崩溃：GPU 可能根本无法运行（白屏根因场景），立即回退自愈
    if (isStartupPhase()) {
      try {
        logger.error(t('main.gpu.log.processCrashFallback'), details)
      } catch {
        // logger 未初始化时仅依赖 diagLog，不重抛
      }
      requestSelfHeal(reason, exitCode)
      return
    }
    // 运行期崩溃：窗口计数升级（单次交 Chromium 自愈，避免无谓禁用硬件加速）
    const now = Date.now()
    runtimeGpuCrashTimestamps.push(now)
    if (runtimeGpuCrashTimestamps.length > 10)
      runtimeGpuCrashTimestamps = runtimeGpuCrashTimestamps.slice(-10)
    if (shouldEscalateRuntimeGpuCrash(runtimeGpuCrashTimestamps, now)) {
      try {
        logger.error(t('main.gpu.log.processCrashFallback'), details)
      } catch {
        // logger 未初始化时仅依赖 diagLog，不重抛
      }
      diagLog(
        'GPU',
        `GPU process gone (reason=${reason} exitCode=${exitCode})，${RUNTIME_CRASH_WINDOW_MS / 1000}s 窗口内第 ${RUNTIME_CRASH_THRESHOLD} 次崩溃，升级回退软件渲染`
      )
      requestSelfHeal(reason, exitCode)
    } else {
      const warnMsg =
        `GPU process gone at runtime (reason=${reason} exitCode=${exitCode})，` +
        `窗口内第 1/${RUNTIME_CRASH_THRESHOLD} 次，交 Chromium 自行重启 GPU 进程；` +
        `${RUNTIME_CRASH_WINDOW_MS / 1000}s 内再次崩溃将自动切换软件渲染`
      diagLog('GPU', warnMsg)
      try {
        logger.warn(warnMsg)
      } catch {
        // logger 未初始化时仅依赖 diagLog，不重抛
      }
    }
  })
}
