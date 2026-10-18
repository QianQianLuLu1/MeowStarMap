// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { processImageData, defaultFilterParams, type FilterParams } from './imageProcessor'

/**
 * @layer L3
 * @module src/renderer/utils/imageProcessor
 * @coverage processImageData 逐像素输出表征（安全网）
 * @dependencies jsdom；自行 stub canvas 2d context
 * @remarks
 * 这是「拖动滑块预览卡顿」修复（docs/plans/2026-10-18-fix-editor-preview-realtime.md N0）的**表征测试**：
 * 用固定 8×8 合成图锁定四条 pass 组合下的逐像素输出，使后续 N5（热循环去冗余、改就地标量、
 * 增量距离表）与 N3（base 缓存 + scratch 拷贝）必须**逐像素等价**才可能通过。
 * 与其它表征测试一样，它在本次修复前即应通过——它是回归安全网，不是缺陷复现测试。
 *
 * 尺寸刻意取 8×8 且 maxSize 不限制，使 `processImageData` 走 `:586-589` 的 1:1 直绘分支，
 * 不触发 createImageBitmap，从而把变量收敛到像素循环本身。
 * 水印分支不在此锁定：applyWatermark 走 putImageData→getImageData 往返，
 * stub 画布不保真往返，其正确性由 imageProcessor.watermark.test.ts 覆盖。
 */

type AnyMock = ReturnType<typeof vi.fn>

/**
 * jsdom 未安装 canvas 包时不导出 ImageData（既有 imageProcessor.canvas.test.ts 因此刻意绕开
 * 卷积分支）。本用例要锁的正是卷积分支，故补一个与浏览器同签名（data, sw, sh）的最小实现。
 */
if (typeof globalThis.ImageData === 'undefined') {
  class ImageDataShim {
    width: number
    height: number
    data: Uint8ClampedArray
    constructor(data: Uint8ClampedArray, sw: number, sh?: number) {
      this.width = sw
      this.height = sh ?? data.length / 4 / sw
      this.data = new Uint8ClampedArray(data)
    }
  }
  globalThis.ImageData = ImageDataShim as unknown as typeof ImageData
}

/**
 * 逐像素加权校验和基准值：由修复前的现网实现采集。
 * N3/N5 的任何改动都必须保持这四个数不变，否则即为像素输出漂移。
 */
const DIGESTS = {
  default: 1858649,
  tonePasses: 2213750,
  convolution: 1856163,
  spatialPasses: 1698958
} as const

const W = 8
const H = 8
const PIXELS = W * H

/** 固定合成渐变：含接近 0 的暗像素与高饱和像素，覆盖 clamp/round 分支 */
function fixtureData(): Uint8ClampedArray {
  const d = new Uint8ClampedArray(PIXELS * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      d[i] = (x * 31 + y * 7) % 256
      d[i + 1] = (x * 13 + y * 29) % 256
      d[i + 2] = (x * 57 + y * 3) % 256
      d[i + 3] = 255
    }
  }
  return d
}

/** 顺序敏感加权校验和：任一像素任一通道漂移都会改变结果 */
function digest(d: Uint8ClampedArray): number {
  let sum = 0
  for (let i = 0; i < d.length; i++) {
    sum = (sum + d[i] * ((i % 97) + 1)) % 4294967296
  }
  return sum
}

function makeSource(): HTMLImageElement {
  const img = new Image()
  img.width = W
  img.height = H
  return img
}

let ctxStub: {
  drawImage: AnyMock
  getImageData: AnyMock
  putImageData: AnyMock
  imageSmoothingEnabled: boolean
  imageSmoothingQuality: string
}
let originalGetContext: HTMLCanvasElement['getContext']

beforeEach(() => {
  originalGetContext = HTMLCanvasElement.prototype.getContext
  ctxStub = {
    drawImage: vi.fn(),
    // 每次返回新副本：像素循环原地写 data，复用同一实例会让用例互相污染
    getImageData: vi.fn(() => ({
      width: W,
      height: H,
      data: new Uint8ClampedArray(fixtureData())
    })) as unknown as AnyMock,
    putImageData: vi.fn(),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low'
  }
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => ctxStub
  ) as unknown as HTMLCanvasElement['getContext']
})

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext
  vi.restoreAllMocks()
})

async function run(params: Partial<FilterParams>): Promise<Uint8ClampedArray> {
  const result = await processImageData(
    makeSource(),
    { ...defaultFilterParams, ...params },
    {
      maxSize: Number.POSITIVE_INFINITY
    }
  )
  return result.data
}

describe('processImageData 逐像素表征（N5 重构安全网）', () => {
  it('默认参数：输出与固定校验和一致，且 alpha 全保留', async () => {
    const data = await run({})
    expect(digest(data)).toBe(DIGESTS.default)
    for (let i = 3; i < data.length; i += 4) {
      expect(data[i]).toBe(255)
    }
  })

  it('色调类 pass 全开：亮度/对比度/饱和/自然饱和/色温/色调/高光/阴影/白黑/去雾/HSL/曲线/分离色调', async () => {
    const data = await run({
      brightness: 20,
      contrast: 30,
      saturation: 25,
      vibrance: 40,
      temperature: 30,
      tint: -20,
      highlights: 25,
      shadows: -15,
      whites: 10,
      blacks: -10,
      dehaze: 30,
      highlightHue: 40,
      highlightSaturation: 30,
      shadowHue: 200,
      shadowSaturation: 25,
      splitBalance: 10,
      hsl: {
        ...defaultFilterParams.hsl,
        red: { hue: 30, saturation: -20, lightness: 10 },
        green: { hue: -40, saturation: 35, lightness: -15 },
        blue: { hue: 15, saturation: 5, lightness: 5 }
      },
      curves: {
        ...defaultFilterParams.curves,
        rgb: [
          { x: 0, y: 0 },
          { x: 0.5, y: 0.62 },
          { x: 1, y: 1 }
        ]
      }
    })
    expect(digest(data)).toBe(DIGESTS.tonePasses)
  })

  it('卷积类 pass 全开：清晰度/锐化/降噪（走 ping-pong 缓冲区分支）', async () => {
    const data = await run({ clarity: 40, sharpen: 60, denoise: 30 })
    expect(digest(data)).toBe(DIGESTS.convolution)
  })

  it('空间类 pass 全开：暗角/颗粒/褪色（Math.random 定值，颗粒为边界可复现值）', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const data = await run({ vignette: 50, grain: 40, fade: 30 })
    expect(digest(data)).toBe(DIGESTS.spatialPasses)
  })

  it('getContext 返回 null 时抛错，不静默产出空预览', async () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => null
    ) as unknown as HTMLCanvasElement['getContext']
    await expect(
      processImageData(makeSource(), defaultFilterParams, { maxSize: Number.POSITIVE_INFINITY })
    ).rejects.toThrow()
  })
})
