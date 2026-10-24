/**
 * @layer L2
 * @module src/main/app/gpu-status
 * @coverage 状态聚合：reason 分类透传 / getGPUInfo complete→basic→null 降级（含超时）/ 独显偏好回填 / 摘要行构建
 * @dependencies 注入式 deps（不真实调 electron GPU API）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetVersion, diagLogMock } = vi.hoisted(() => ({
  mockGetVersion: vi.fn(),
  diagLogMock: vi.fn()
}))

vi.mock('electron', () => ({ app: { getVersion: mockGetVersion } }))
vi.mock('../../utils/startup-diagnostic', () => ({ diagLog: diagLogMock }))
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { collectGpuStatus, buildGpuStatusSummaryLine } from '../gpu-status'

/** Chromium complete GPU info 典型形态（防御式解析，只取我们需要的字段） */
const COMPLETE_INFO = {
  gpuDevice: [
    { vendorId: '0x10de', deviceId: '0x2504', vendor: 'NVIDIA', device: 'NVIDIA GeForce RTX 3060' },
    { vendorId: '0x8086', deviceId: '0x46a6', vendor: 'Intel', device: 'Intel Iris Xe' }
  ],
  auxAttributes: {
    glRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)'
  }
}

beforeEach(() => {
  mockGetVersion.mockReset().mockReturnValue('41.0.0')
  diagLogMock.mockReset()
})

describe('collectGpuStatus（注入式依赖）', () => {
  it('s1. 正常：reason=default + featureStatus + complete GPU info（含双显卡与 activeGpu）', async () => {
    const s = await collectGpuStatus({
      classify: () => ({ enabled: true, reason: 'default' }),
      readFallbackState: () => ({ active: false, consecutiveFailures: 0, fallbackVersion: null }),
      getFeatureStatus: () => ({ canvas: 'enabled', webgl: 'enabled' }),
      getGpuInfo: async (mode) => (mode === 'complete' ? COMPLETE_INFO : null),
      getPreference: () => ({ mode: 'high-performance', registry: 'set' }),
      electronVersion: () => '41.0.0',
      platform: 'win32'
    })
    expect(s.hardwareAcceleration).toEqual({ enabled: true, reason: 'default' })
    expect(s.fallback).toEqual({ active: false, consecutiveFailures: 0, fallbackVersion: null })
    expect(s.featureStatus).toEqual({ canvas: 'enabled', webgl: 'enabled' })
    expect(s.gpus).toHaveLength(2)
    expect(s.gpus?.[0]?.device).toBe('NVIDIA GeForce RTX 3060')
    expect(s.activeGpu).toContain('NVIDIA GeForce RTX 3060')
    expect(s.discretePreference).toEqual({ mode: 'high-performance', registry: 'set' })
    expect(s.electronVersion).toBe('41.0.0')
    expect(s.platform).toBe('win32')
  })

  it('s2. reason 分类透传：user-disabled / crash-fallback / retry-after-update', async () => {
    for (const reason of ['user-disabled', 'crash-fallback', 'retry-after-update'] as const) {
      const s = await collectGpuStatus({
        classify: () => ({ enabled: reason === 'retry-after-update', reason }),
        readFallbackState: () => ({
          active: true,
          consecutiveFailures: 1,
          fallbackVersion: '2.5.4'
        }),
        getFeatureStatus: () => null,
        getGpuInfo: async () => null,
        getPreference: () => ({ mode: 'auto', registry: null }),
        electronVersion: () => '41.0.0',
        platform: 'win32'
      })
      expect(s.hardwareAcceleration.reason).toBe(reason)
      expect(s.fallback.fallbackVersion).toBe('2.5.4')
    }
  })

  it('s3. complete 抛错 → 降级 basic（gpuDevice 仍可解析，activeGpu 缺失为 null）', async () => {
    const s = await collectGpuStatus({
      classify: () => ({ enabled: true, reason: 'default' }),
      readFallbackState: () => ({ active: false, consecutiveFailures: 0, fallbackVersion: null }),
      getFeatureStatus: () => ({}),
      getGpuInfo: async (mode) => {
        if (mode === 'complete') throw new Error('not available in software mode')
        return { gpuDevice: COMPLETE_INFO.gpuDevice }
      },
      getPreference: () => ({ mode: 'high-performance', registry: 'skipped-dev' }),
      electronVersion: () => '41.0.0',
      platform: 'win32'
    })
    expect(s.gpus).toHaveLength(2)
    expect(s.activeGpu).toBeNull()
  })

  it('s4. complete 与 basic 均抛错 → gpus=null 不抛（软件回退态 info 缺失不炸）', async () => {
    const s = await collectGpuStatus({
      classify: () => ({ enabled: false, reason: 'crash-fallback' }),
      readFallbackState: () => ({ active: true, consecutiveFailures: 2, fallbackVersion: null }),
      getFeatureStatus: () => null,
      getGpuInfo: async () => {
        throw new Error('unavailable')
      },
      getPreference: () => ({ mode: 'auto', registry: null }),
      electronVersion: () => '41.0.0',
      platform: 'win32'
    })
    expect(s.gpus).toBeNull()
    expect(s.activeGpu).toBeNull()
    expect(s.hardwareAcceleration.enabled).toBe(false)
  })

  it('s5. complete 挂起 → gpuInfoTimeoutMs 超时后降级 basic', async () => {
    const s = await collectGpuStatus({
      classify: () => ({ enabled: true, reason: 'default' }),
      readFallbackState: () => ({ active: false, consecutiveFailures: 0, fallbackVersion: null }),
      getFeatureStatus: () => null,
      getGpuInfo: (mode) =>
        mode === 'complete'
          ? new Promise<never>(() => {}) // 永不 resolve
          : Promise.resolve({ gpuDevice: [{ vendorId: '0x10de', deviceId: '0x1' }] }),
      getPreference: () => ({ mode: 'high-performance', registry: 'set' }),
      electronVersion: () => '41.0.0',
      platform: 'win32',
      gpuInfoTimeoutMs: 10
    })
    expect(s.gpus).toHaveLength(1)
  })

  it('s6. 独显偏好缺省（getPreference 缺失）→ mode 默认 high-performance', async () => {
    const s = await collectGpuStatus({
      classify: () => ({ enabled: true, reason: 'default' }),
      readFallbackState: () => ({ active: false, consecutiveFailures: 0, fallbackVersion: null }),
      getFeatureStatus: () => null,
      getGpuInfo: async () => null,
      electronVersion: () => '41.0.0',
      platform: 'win32'
    })
    expect(s.discretePreference.mode).toBe('high-performance')
  })
})

describe('buildGpuStatusSummaryLine（启动日志摘要）', () => {
  it('l1. 摘要包含硬件加速态/活动显卡/显卡数/回退态/独显偏好', () => {
    const line = buildGpuStatusSummaryLine({
      hardwareAcceleration: { enabled: true, reason: 'default' },
      fallback: { active: false, consecutiveFailures: 0, fallbackVersion: null },
      discretePreference: { mode: 'high-performance', registry: 'set' },
      featureStatus: { canvas: 'enabled' },
      gpus: [
        { vendorId: '0x10de', deviceId: '0x1', vendor: 'NVIDIA', device: 'RTX', active: null }
      ],
      activeGpu: 'ANGLE (NVIDIA RTX)',
      electronVersion: '41.0.0',
      platform: 'win32'
    })
    expect(line).toContain('hwAccel=on')
    expect(line).toContain('default')
    expect(line).toContain('gpus=1')
    expect(line).toContain('fallback=off')
    expect(line).toContain('discrete=high-performance(set)')
    expect(line).toContain('ANGLE (NVIDIA RTX)')
  })

  it('l2. 禁用态与 null 兜底也可构建', () => {
    const line = buildGpuStatusSummaryLine({
      hardwareAcceleration: { enabled: false, reason: 'user-disabled' },
      fallback: { active: false, consecutiveFailures: 0, fallbackVersion: null },
      discretePreference: { mode: 'auto', registry: null },
      featureStatus: null,
      gpus: null,
      activeGpu: null,
      electronVersion: '41.0.0',
      platform: 'win32'
    })
    expect(line).toContain('hwAccel=off')
    expect(line).toContain('user-disabled')
    expect(line).toContain('gpus=unknown')
  })
})
