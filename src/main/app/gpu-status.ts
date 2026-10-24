import { app } from 'electron'
import { diagLog } from '../utils/startup-diagnostic'
import { logger } from '../utils/logger'
import type {
  GpuBootDecisionReason,
  GpuDeviceSummary,
  GpuStatusSummary
} from '../../shared/types/electron-api'
import {
  classifyBootDecisionForStatus,
  readGpuFallbackState,
  type GpuFallbackStateSnapshot
} from './gpu-fallback'
import { getDiscretePreferenceStatus, type GpuPreferenceMode } from './gpu-preference'

/**
 * GPU 状态聚合（app:gpu-status 只读探针 + 启动日志摘要）：
 * 把分散在 gpu-fallback（回退状态机）、gpu-preference（独显注册表）、
 * Electron app API（FeatureStatus / GPUInfo）的信号收拢为一份快照，
 * 供诊断面板展示与启动日志取证——回答「硬件加速是否真的开着、
 * 当前用哪块卡、哪些特性被降级到软件、独显偏好应用结果」。
 *
 * 全程防御式解析 + fail-open：GPU 信息不可得（软件回退态 complete 缺失、
 * getGPUInfo 挂起等）时降级为 null，绝不抛错影响调用方。
 */

/** complete GPUInfo 挂起时的兜底超时（真实环境几十 ms 内返回，3s 足够宽裕） */
const DEFAULT_GPU_INFO_TIMEOUT_MS = 3_000

export interface GpuStatusDeps {
  classify?: () => { enabled: boolean; reason: GpuBootDecisionReason }
  readFallbackState?: () => GpuFallbackStateSnapshot
  getFeatureStatus?: () => Record<string, string> | null
  getGpuInfo?: (mode: 'complete' | 'basic') => Promise<unknown>
  getPreference?: () => { mode: GpuPreferenceMode; registry: string | null }
  electronVersion?: () => string
  platform?: string
  gpuInfoTimeoutMs?: number
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gpu-info timeout after ${ms}ms`)), ms)
    timer.unref?.()
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** 防御式解析 Chromium GPUInfo：gpuDevice 数组 + auxAttributes.glRenderer（活动显卡最可靠信号） */
export function parseGpuInfo(info: unknown): {
  gpus: GpuDeviceSummary[] | null
  activeGpu: string | null
} {
  try {
    if (!info || typeof info !== 'object') return { gpus: null, activeGpu: null }
    const obj = info as { gpuDevice?: unknown; auxAttributes?: unknown }
    let gpus: GpuDeviceSummary[] | null = null
    if (Array.isArray(obj.gpuDevice)) {
      gpus = obj.gpuDevice.map((d) => {
        const dev = (d ?? {}) as Record<string, unknown>
        return {
          vendorId: asNonEmptyString(dev.vendorId),
          deviceId: asNonEmptyString(dev.deviceId),
          vendor: asNonEmptyString(dev.vendor),
          device: asNonEmptyString(dev.device),
          active: typeof dev.active === 'boolean' ? dev.active : null
        }
      })
    }
    let activeGpu: string | null = null
    const aux = obj.auxAttributes
    if (aux && typeof aux === 'object') {
      const a = aux as Record<string, unknown>
      activeGpu = asNonEmptyString(a.glRenderer) ?? asNonEmptyString(a.activeGPU)
    }
    return { gpus, activeGpu }
  } catch {
    return { gpus: null, activeGpu: null }
  }
}

/** 聚合 GPU 状态快照（所有依赖可注入，默认接真实 Electron API 与本仓库状态模块） */
export async function collectGpuStatus(deps: GpuStatusDeps = {}): Promise<GpuStatusSummary> {
  const classify = deps.classify ?? classifyBootDecisionForStatus
  const readFallbackState = deps.readFallbackState ?? readGpuFallbackState
  const getFeatureStatus =
    deps.getFeatureStatus ??
    (() => {
      try {
        return app.getGPUFeatureStatus() ?? null
      } catch {
        return null
      }
    })
  const getGpuInfo = deps.getGpuInfo ?? ((mode) => app.getGPUInfo(mode))
  const getPreference = deps.getPreference ?? getDiscretePreferenceStatus
  const electronVersion =
    deps.electronVersion ??
    (() => {
      try {
        return app.getVersion()
      } catch {
        return ''
      }
    })
  const platform = deps.platform ?? process.platform
  const timeoutMs = deps.gpuInfoTimeoutMs ?? DEFAULT_GPU_INFO_TIMEOUT_MS

  // complete（含 auxAttributes）→ 失败/超时降级 basic（仅设备清单）→ 再失败置 null
  let parsed: { gpus: GpuDeviceSummary[] | null; activeGpu: string | null } = {
    gpus: null,
    activeGpu: null
  }
  try {
    try {
      parsed = parseGpuInfo(await withTimeout(getGpuInfo('complete'), timeoutMs))
    } catch {
      parsed = parseGpuInfo(await getGpuInfo('basic'))
    }
  } catch {
    // GPU 信息整体不可得（如软件回退态）：保持 null
  }

  let featureStatus: Record<string, string> | null = null
  try {
    // Electron 的 GPUFeatureStatus 是具体键型接口，归一为通用记录便于跨端消费
    featureStatus = (getFeatureStatus() as Record<string, string> | null) ?? null
  } catch {
    featureStatus = null
  }

  return {
    hardwareAcceleration: classify(),
    fallback: readFallbackState(),
    discretePreference: getPreference(),
    featureStatus,
    gpus: parsed.gpus,
    activeGpu: parsed.activeGpu,
    electronVersion: electronVersion(),
    platform
  }
}

/** 构建单行启动日志摘要（GPU 状态卡之外的可观测兜底，落 diag.log 与 main.log） */
export function buildGpuStatusSummaryLine(s: GpuStatusSummary): string {
  const hw = s.hardwareAcceleration.enabled ? 'on' : 'off'
  const gpuCount = s.gpus === null ? 'unknown' : String(s.gpus.length)
  const fallback = s.fallback.active
    ? `on(v=${s.fallback.fallbackVersion ?? '?'},fails=${s.fallback.consecutiveFailures})`
    : 'off'
  const active = s.activeGpu ?? 'unknown'
  return (
    `GPU 状态: hwAccel=${hw}(${s.hardwareAcceleration.reason}) activeGPU=${active} ` +
    `gpus=${gpuCount} fallback=${fallback} ` +
    `discrete=${s.discretePreference.mode}(${s.discretePreference.registry ?? 'n/a'})`
  )
}

/** 首帧加载完成后记一行 GPU 状态摘要（异步、fire-and-forget，绝不影响窗口流程） */
export async function logGpuStatusSummary(): Promise<void> {
  try {
    const s = await collectGpuStatus()
    const line = buildGpuStatusSummaryLine(s)
    diagLog('GPU', line)
    try {
      logger.info(`[GPU Status] ${line}`)
    } catch {
      // logger 未初始化时仅依赖 diagLog
    }
  } catch {
    // 状态聚合失败绝不影响主流程
  }
}
