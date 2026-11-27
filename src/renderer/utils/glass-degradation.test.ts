/**
 * @vitest-environment jsdom
 *
 * 玻璃效果自动降级（2026-11-20 视图闪屏软件渲染自动降级 N1）
 *
 * 缺陷：软件渲染（GPU 兼容档位 ≥1 / 硬件加速被禁用）下液态玻璃 SVG 折射 + 氛围层
 * 动画在纯 CPU 合成下逐帧全量重光栅，是故障机（level2）滚动白闪/黑闪的头号负载源；
 * glass-lite 降级链早已存在，但只接用户设置，从未接能力检测。
 * 契约：detectSoftwareRendering 经 app.getGpuStatus() 判定并缓存；fail-open
 * （探针失败/缺失不得改变用户视觉设置）；applyGlassMode 统一根类决策。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetGlassDegradationForTest,
  applyGlassMode,
  detectSoftwareRendering
} from './glass-degradation'

type GpuStatusLike = {
  hardwareAcceleration?: { enabled?: boolean; reason?: string }
  fallback?: { compatLevel?: number }
}

const installApi = (impl: () => Promise<GpuStatusLike>) => {
  const getGpuStatus = vi.fn(impl)
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    app: { getGpuStatus }
  }
  return getGpuStatus
}

const healthy: GpuStatusLike = {
  hardwareAcceleration: { enabled: true, reason: 'default' },
  fallback: { compatLevel: 0 }
}

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  __resetGlassDegradationForTest()
  document.documentElement.classList.remove('glass-lite')
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  document.documentElement.classList.remove('glass-lite')
})

describe('detectSoftwareRendering', () => {
  it('正常：level2 + 硬件加速禁用 → true', async () => {
    installApi(async () => ({
      hardwareAcceleration: { enabled: false, reason: 'user-disabled' },
      fallback: { compatLevel: 2 }
    }))
    expect(await detectSoftwareRendering()).toBe(true)
  })

  it('正常：level1（仅禁用硬件加速）→ true', async () => {
    installApi(async () => ({
      hardwareAcceleration: { enabled: false, reason: 'crash-fallback' },
      fallback: { compatLevel: 1 }
    }))
    expect(await detectSoftwareRendering()).toBe(true)
  })

  it('正常：硬件健康（level0 + enabled）→ false', async () => {
    installApi(async () => healthy)
    expect(await detectSoftwareRendering()).toBe(false)
  })

  it('异常：getGpuStatus 抛错 → fail-open false', async () => {
    installApi(async () => {
      throw new Error('ipc down')
    })
    expect(await detectSoftwareRendering()).toBe(false)
  })

  it('异常：electronAPI 缺失（预览版）→ false', async () => {
    expect(await detectSoftwareRendering()).toBe(false)
  })

  it('边界：旧载荷缺 fallback/compatLevel → 按 0 处理，仅看 enabled', async () => {
    installApi(async () => ({ hardwareAcceleration: { enabled: true } }))
    expect(await detectSoftwareRendering()).toBe(false)
  })

  it('边界：enabled=false 即使缺 compatLevel 也判软件渲染', async () => {
    installApi(async () => ({ hardwareAcceleration: { enabled: false } }))
    expect(await detectSoftwareRendering()).toBe(true)
  })

  it('边界：结果缓存（二次探测不再发 IPC），__reset 后重新探测', async () => {
    const spy = installApi(async () => healthy)
    await detectSoftwareRendering()
    await detectSoftwareRendering()
    expect(spy).toHaveBeenCalledTimes(1)
    __resetGlassDegradationForTest()
    await detectSoftwareRendering()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('并发：两个调用共享延迟探针，后到失败不得覆盖正向降级结果', async () => {
    const firstProbe = deferred<GpuStatusLike>()
    const lateFailure = deferred<GpuStatusLike>()
    // 单探针修复后第二个桩不会被调用；预先接住拒绝，避免未使用桩产生未处理拒绝。
    void lateFailure.promise.catch(() => undefined)
    const getGpuStatus = vi
      .fn<() => Promise<GpuStatusLike>>()
      .mockImplementationOnce(() => firstProbe.promise)
      .mockImplementationOnce(() => lateFailure.promise)
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      app: { getGpuStatus }
    }

    const firstCall = detectSoftwareRendering()
    const secondCall = detectSoftwareRendering()
    firstProbe.resolve({ hardwareAcceleration: { enabled: false }, fallback: { compatLevel: 2 } })
    await expect(firstCall).resolves.toBe(true)
    lateFailure.reject(new Error('late probe failure'))
    await expect(secondCall).resolves.toBe(true)

    expect(getGpuStatus).toHaveBeenCalledTimes(1)
    applyGlassMode('rich')
    expect(document.documentElement.classList.contains('glass-lite')).toBe(true)
    await expect(detectSoftwareRendering()).resolves.toBe(true)
    expect(getGpuStatus).toHaveBeenCalledTimes(1)
  })
})

describe('applyGlassMode', () => {
  it('正常：软件渲染下 rich 仍强制 glass-lite', async () => {
    installApi(async () => ({
      hardwareAcceleration: { enabled: false },
      fallback: { compatLevel: 2 }
    }))
    await detectSoftwareRendering()
    applyGlassMode('rich')
    expect(document.documentElement.classList.contains('glass-lite')).toBe(true)
  })

  it('正常：硬件健康下 rich 无 glass-lite、lite 有（用户档不受 GPU 影响）', async () => {
    installApi(async () => healthy)
    await detectSoftwareRendering()
    applyGlassMode('rich')
    expect(document.documentElement.classList.contains('glass-lite')).toBe(false)
    applyGlassMode('lite')
    expect(document.documentElement.classList.contains('glass-lite')).toBe(true)
  })

  it('异常：探针失败后 rich 保持用户设置（不强制降级）', async () => {
    installApi(async () => {
      throw new Error('ipc down')
    })
    await detectSoftwareRendering()
    applyGlassMode('rich')
    expect(document.documentElement.classList.contains('glass-lite')).toBe(false)
  })

  it('边界：未探测（标志 null）时按用户设置；非法 effect 值按 rich', async () => {
    applyGlassMode('rich')
    expect(document.documentElement.classList.contains('glass-lite')).toBe(false)
    applyGlassMode('bogus')
    expect(document.documentElement.classList.contains('glass-lite')).toBe(false)
    applyGlassMode('lite')
    expect(document.documentElement.classList.contains('glass-lite')).toBe(true)
  })
})
