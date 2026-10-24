import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'
import { diagLog } from '../utils/startup-diagnostic'
import { readGpuBootPrefs } from './gpu-fallback'

/**
 * 独显优先（Windows 混合显卡设备的高性能 GPU 偏好）：
 *
 * Windows 上进程用哪块 GPU 由系统按「每应用 GPU 首选项」分派（默认常落在集显），
 * 应用层无法通过 Chromium 开关干预（force_high_performance_gpu 仅 macOS 生效）。
 * 成熟做法（与 Windows 图形设置界面等价）是写注册表：
 *   HKCU\Software\Microsoft\DirectX\UserGpuPreferences
 *     值名 = 应用 exe 完整路径，值数据 = "GpuPreference=2;"（2 = 高性能）
 *
 * 安全边界：
 * - 仅 HKCU、仅本应用 exe 路径的值；切换回 'auto' 时只删除**恰好等于我们写入格式**
 *   的值（reg query 先比对），用户/其他工具对该路径的设置绝不误删；
 * - 仅打包版写（dev 的 electron.exe 被所有开发中 Electron 应用共享，写了会越界）；
 * - 注册表在进程创建时被系统读取，故写入对**下一次启动**生效；
 * - 全程 fail-open：reg 执行失败只记日志，绝不影响启动。
 */
export type GpuPreferenceMode = 'auto' | 'high-performance'

/** 我们管理的注册表键（Windows 图形设置「每应用 GPU 首选项」的用户态存储位） */
export const GPU_PREFERENCE_REG_KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences'

/** 我们写入的唯一值格式（清理时也只认这个格式，防误删外来设置） */
export const MANAGED_GPU_PREFERENCE_VALUE = 'GpuPreference=2;'

/** reg add：为 execPath 写入高性能 GPU 偏好（/f 覆盖我们此前写入的同名值） */
export function buildRegAddArgs(execPath: string): string[] {
  return [
    'add',
    GPU_PREFERENCE_REG_KEY,
    '/v',
    execPath,
    '/t',
    'REG_SZ',
    '/d',
    MANAGED_GPU_PREFERENCE_VALUE,
    '/f'
  ]
}

/** reg query：读取 execPath 当前值（不存在时 reg 以非零退出码失败） */
export function buildRegQueryArgs(execPath: string): string[] {
  return ['query', GPU_PREFERENCE_REG_KEY, '/v', execPath]
}

/** reg delete：删除 execPath 的值（仅在现值为自有格式时调用） */
export function buildRegDeleteArgs(execPath: string): string[] {
  return ['delete', GPU_PREFERENCE_REG_KEY, '/v', execPath, '/f']
}

/** 从 reg query 输出中解析值数据；无 REG_SZ 行（值不存在）返回 undefined */
export function parseRegQueryValueData(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const idx = line.indexOf('REG_SZ')
    if (idx < 0) continue
    const data = line.slice(idx + 'REG_SZ'.length).trim()
    return data.length > 0 ? data : undefined
  }
  return undefined
}

export interface GpuPreferenceApplyResult {
  applied: 'set' | 'removed' | 'kept-foreign' | 'skipped-platform' | 'skipped-dev' | 'noop'
  detail?: string
}

export interface GpuPreferenceDeps {
  execPath?: string
  isPackaged?: boolean
  platform?: NodeJS.Platform
  /** 注入式命令执行器（默认 reg.exe 经 execFile，参数数组不经 shell，路径含空格/中文无注入面） */
  run?: (args: string[]) => Promise<{ stdout: string; stderr: string }>
}

const execFileAsync = promisify(execFile)

function defaultRun(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('reg', args, { windowsHide: true })
}

/** 最近一次 applyDiscreteGpuPreference 的结果（模块级内存态，供 gpu-status 展示） */
let lastApplyStatus: { mode: GpuPreferenceMode; registry: string } | null = null

/**
 * 独显偏好状态（供 GPU 状态面板）：优先返回本次启动已应用的结果；
 * 尚未应用（或非 win32 提前跳过的调用路径未覆盖）时回退启动偏好镜像，
 * 镜像缺省按默认策略 high-performance 返回。
 */
export function getDiscretePreferenceStatus(): {
  mode: GpuPreferenceMode
  registry: string | null
} {
  if (lastApplyStatus) return { ...lastApplyStatus }
  const prefs = readGpuBootPrefs()
  return { mode: prefs.discretePreference ?? 'high-performance', registry: null }
}

/**
 * 应用独显优先偏好（在主进程启动早期调用；对下次启动生效）。
 * @param mode 'high-performance'（默认，缺省/undefined 同样按此处理）写 GpuPreference=2；
 *             'auto' 跟随系统——仅清理我们写入过的自有格式值。
 * 任何异常都被吞掉并降级为 noop：注册表不可用绝不阻塞启动。
 */
export async function applyDiscreteGpuPreference(
  mode: GpuPreferenceMode | undefined,
  deps: GpuPreferenceDeps = {}
): Promise<GpuPreferenceApplyResult> {
  const effectiveMode: GpuPreferenceMode = mode ?? 'high-performance'
  const result = await applyDiscreteGpuPreferenceInternal(effectiveMode, deps)
  lastApplyStatus = { mode: effectiveMode, registry: result.applied }
  return result
}

async function applyDiscreteGpuPreferenceInternal(
  effectiveMode: GpuPreferenceMode,
  deps: GpuPreferenceDeps
): Promise<GpuPreferenceApplyResult> {
  const platform = deps.platform ?? process.platform
  const isPackaged = deps.isPackaged ?? app.isPackaged
  const execPath = deps.execPath ?? process.execPath
  const run = deps.run ?? defaultRun

  try {
    if (platform !== 'win32') {
      diagLog('GPU-PREF', `GPU 偏好跳过：非 win32 平台（${platform}）`)
      return { applied: 'skipped-platform' }
    }
    if (!isPackaged) {
      diagLog('GPU-PREF', `GPU 偏好跳过：dev 模式（electron.exe 为共享二进制，不写注册表）`)
      return { applied: 'skipped-dev' }
    }
    if (effectiveMode === 'high-performance') {
      await run(buildRegAddArgs(execPath))
      diagLog(
        'GPU-PREF',
        `GPU 偏好已写注册表（下次启动生效）：${execPath} = ${MANAGED_GPU_PREFERENCE_VALUE}`
      )
      return { applied: 'set' }
    }
    // 'auto'：只清理我们写入过的自有格式值，外来设置原样保留
    let queryData: string | undefined
    try {
      const q = await run(buildRegQueryArgs(execPath))
      queryData = parseRegQueryValueData(q.stdout)
    } catch {
      queryData = undefined // 值不存在（reg 非零退出）视为无自有值
    }
    if (queryData === undefined) {
      diagLog('GPU-PREF', `GPU 偏好清理 noop：注册表中无本应用值`)
      return { applied: 'noop' }
    }
    if (queryData !== MANAGED_GPU_PREFERENCE_VALUE) {
      diagLog('GPU-PREF', `GPU 偏好清理跳过：现值为外来格式（${queryData}），不误删`)
      return { applied: 'kept-foreign' }
    }
    await run(buildRegDeleteArgs(execPath))
    diagLog('GPU-PREF', `GPU 偏好已清理（跟随系统）：${execPath}`)
    return { applied: 'removed' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    diagLog('GPU-PREF', `GPU 偏好操作失败（不影响启动）：${msg}`)
    return { applied: 'noop', detail: msg }
  }
}
