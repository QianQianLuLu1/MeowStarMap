import { describe, it, expect, vi } from 'vitest'
import { generateShareCardPages } from './shareCardJob'
import { buildShareCardPayload } from './shareCardModel'
import type { ShareCardCopy } from './shareCardRender'

/**
 * 阶段 5 · B4：出图编排单测。canvas 与导出都是注入的假件，
 * 因此这里能真实跑到「布局 → 绘制 → 导出」整条链，而不只是 mock 断言。
 */

/** 覆盖 render 用到的全部 op；未实现的属性读取一律返回 undefined，避免真 canvas 依赖。 */
const fakeCtx = (): CanvasRenderingContext2D => {
  const noop = (): void => undefined
  const target: Record<string, unknown> = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: 'left',
    measureText: (text: string) => ({ width: String(text).length * 20 }),
    fillRect: noop,
    fillText: noop,
    drawImage: noop,
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    closePath: noop,
    fill: noop,
    stroke: noop,
    arc: noop
  }
  return new Proxy(target, {
    get: (obj, prop) => (prop in obj ? obj[prop as string] : undefined),
    set: (obj, prop, value) => {
      obj[prop as string] = value
      return true
    }
  }) as unknown as CanvasRenderingContext2D
}

const COPY: ShareCardCopy = {
  brand: 'brand',
  fallbackTitle: 'fallback',
  outfitHeading: 'outfit',
  parameterHeading: 'parameters',
  iconMissing: 'missing',
  categoryBadge: 'category',
  noOutfit: 'noOutfit',
  footer: 'footer',
  parameterLabels: {},
  effectLabels: {}
}

const payloadOf = (outfitCount: number) =>
  buildShareCardPayload({
    date: '2026-10-15',
    rows: [{ key: 'focalLength', value: '50' }],
    outfits: Array.from({ length: outfitCount }, (_, i) => ({
      key: `k${i}`,
      name: `item${i}`,
      iconSource: 'item'
    }))
  })

describe('generateShareCardPages', () => {
  it('拿不到图标时逐条计入 missingIcons，但仍照常出图', async () => {
    const canvas = { width: 0, height: 0 }
    const exportPage = vi.fn(() => 'data:image/png;base64,AA')
    const result = await generateShareCardPages({
      canvas,
      ctx: fakeCtx(),
      payload: payloadOf(3),
      copy: COPY,
      image: { width: 1000, height: 800 },
      soft: null,
      rotation: 0,
      exportPage,
      isCancelled: () => false
    })
    expect(result.cancelled).toBe(false)
    expect(result.missingIcons).toBe(3)
    expect(result.pages).toHaveLength(1)
  })

  it('exportPage 收到 1440 × 页高，且画布尺寸先被设成同一组值', async () => {
    const canvas = { width: 0, height: 0 }
    const exportPage = vi.fn(() => 'x')
    await generateShareCardPages({
      canvas,
      ctx: fakeCtx(),
      payload: payloadOf(0),
      copy: COPY,
      image: { width: 1000, height: 800 },
      rotation: 0,
      exportPage,
      isCancelled: () => false
    })
    expect(canvas.width).toBe(1440)
    expect(canvas.height).toBe(1740)
    expect(exportPage).toHaveBeenCalledWith(canvas, 1440, 1740)
  })

  it('穿搭超界时分页，每页各导出一张', async () => {
    const exportPage = vi.fn(() => 'x')
    const result = await generateShareCardPages({
      canvas: { width: 0, height: 0 },
      ctx: fakeCtx(),
      payload: payloadOf(40),
      copy: COPY,
      image: { width: 900, height: 900 },
      rotation: 0,
      exportPage,
      isCancelled: () => false
    })
    expect(result.pages.length).toBeGreaterThan(1)
    expect(exportPage).toHaveBeenCalledTimes(result.pages.length)
  })

  it('取消 ⇒ 不导出任何页、返回空数组且 cancelled 为真', async () => {
    const exportPage = vi.fn(() => 'x')
    const onProgress = vi.fn()
    const result = await generateShareCardPages({
      canvas: { width: 0, height: 0 },
      ctx: fakeCtx(),
      payload: payloadOf(40),
      copy: COPY,
      image: { width: 900, height: 900 },
      rotation: 0,
      exportPage,
      onProgress,
      isCancelled: () => true
    })
    expect(result).toEqual({ pages: [], missingIcons: 0, cancelled: true })
    expect(exportPage).not.toHaveBeenCalled()
    expect(onProgress).not.toHaveBeenCalled()
  })

  it('onProgress 按页递增上报 (current, total)', async () => {
    const onProgress = vi.fn()
    const result = await generateShareCardPages({
      canvas: { width: 0, height: 0 },
      ctx: fakeCtx(),
      payload: payloadOf(40),
      copy: COPY,
      image: { width: 900, height: 900 },
      rotation: 0,
      exportPage: () => 'x',
      onProgress,
      isCancelled: () => false
    })
    const total = result.pages.length
    expect(onProgress.mock.calls[0]).toEqual([1, total])
    expect(onProgress.mock.calls[total - 1]).toEqual([total, total])
  })
})
