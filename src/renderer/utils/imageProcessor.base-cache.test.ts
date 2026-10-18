// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  processImageData,
  buildPreviewBase,
  defaultFilterParams,
  type PreviewBase
} from './imageProcessor'

/**
 * @layer L3
 * @module src/renderer/utils/imageProcessor
 * @coverage 拖动帧的底图复用（base 缓存）与陈旧底图回退
 * @dependencies jsdom；自行 stub canvas 2d context 与 createImageBitmap
 * @remarks
 * 复现根因：修复前每一帧预览都会重新做一次「全分辨率高质量重采样 + getImageData」，
 * 而这两步与调节参数完全无关——拖动 20 次就白做 20 次，是单帧耗时的大头。
 * 现在由 buildPreviewBase 产出一份底图，帧间复用；同时必须证明复用的底图
 * 不会被 processImageData 的原地像素循环污染。
 */

type AnyMock = ReturnType<typeof vi.fn>

/**
 * jsdom 未安装 canvas 包时不导出 ImageData（浏览器里有，`processImageData` 复用底图时要用）。
 * 这里补一个与浏览器同签名（data, sw, sh）且同样**复制**入参的最小实现。
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

interface CtxStub {
  drawImage: AnyMock
  getImageData: AnyMock
  putImageData: AnyMock
  imageSmoothingEnabled: boolean
  imageSmoothingQuality: string
}

let ctxStub: CtxStub
let bitmapFactory: AnyMock
let originalGetContext: HTMLCanvasElement['getContext']
let originalCreateImageBitmap: typeof createImageBitmap | undefined

function makeSource(width: number, height: number): HTMLImageElement {
  const img = new Image()
  img.width = width
  img.height = height
  return img
}

/** getImageData 返回与尺寸相关的确定值：便于比较两帧是否一致 */
function makeCtx(): CtxStub {
  return {
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4)
      for (let i = 0; i < data.length; i += 4) {
        data[i] = (i / 4) % 256
        data[i + 1] = (i / 4 / 2) % 256
        data[i + 2] = 255 - ((i / 4) % 256)
        data[i + 3] = 255
      }
      return { width: w, height: h, data }
    }) as unknown as AnyMock,
    putImageData: vi.fn(),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low'
  } as unknown as CtxStub
}

beforeEach(() => {
  ctxStub = makeCtx()
  originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => ctxStub
  ) as unknown as HTMLCanvasElement['getContext']

  originalCreateImageBitmap = globalThis.createImageBitmap
  bitmapFactory = vi.fn(async (_src: unknown, opts?: { resizeWidth?: number }) => ({
    width: opts?.resizeWidth ?? 1,
    height: 1,
    close: vi.fn()
  }))
  globalThis.createImageBitmap = bitmapFactory as unknown as typeof createImageBitmap
})

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext
  if (originalCreateImageBitmap === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).createImageBitmap
  } else {
    globalThis.createImageBitmap = originalCreateImageBitmap
  }
  vi.restoreAllMocks()
})

describe('buildPreviewBase 底图产出与复用', () => {
  it('底图只重采样一次，后续帧不再调用 createImageBitmap（正常）', async () => {
    const img = makeSource(2000, 1500)

    const base = await buildPreviewBase(img, 1000)
    expect(base.width).toBe(1000)
    expect(base.height).toBe(750)
    expect(bitmapFactory).toHaveBeenCalledTimes(1)

    bitmapFactory.mockClear()
    const first = await processImageData(img, defaultFilterParams, { maxSize: 1000, base })
    const second = await processImageData(img, defaultFilterParams, { maxSize: 1000, base })

    expect(bitmapFactory).not.toHaveBeenCalled()
    expect(first.width).toBe(1000)
    expect(second.width).toBe(1000)
  })

  it('同一份底图连用两帧输出完全一致——证明底图没被原地像素循环污染（异常防护）', async () => {
    const img = makeSource(2000, 1500)
    const base = await buildPreviewBase(img, 1000)
    const snapshotOfBase = base.data.slice()

    const first = await processImageData(
      img,
      { ...defaultFilterParams, brightness: 30 },
      {
        maxSize: 1000,
        base
      }
    )
    const second = await processImageData(
      img,
      { ...defaultFilterParams, brightness: 30 },
      {
        maxSize: 1000,
        base
      }
    )

    expect(Array.from(first.data)).toEqual(Array.from(second.data))
    expect(Array.from(base.data)).toEqual(Array.from(snapshotOfBase))
  })

  it('底图尺寸与目标不符时回退完整重采样路径，不得越界读写（边界）', async () => {
    const img = makeSource(2000, 1500)
    const stale: PreviewBase = {
      width: 640,
      height: 480,
      data: new Uint8ClampedArray(640 * 480 * 4)
    }

    const out = await processImageData(img, defaultFilterParams, { maxSize: 1000, base: stale })

    expect(out.width).toBe(1000)
    expect(out.height).toBe(750)
    expect(bitmapFactory).toHaveBeenCalledTimes(1)
  })

  it('原图小于预算时底图为 1:1 尺寸，复用后尺寸不变（边界）', async () => {
    const img = makeSource(100, 80)
    const base = await buildPreviewBase(img, 4096)

    expect(base.width).toBe(100)
    expect(base.height).toBe(80)
    // 1:1 路径本就不需要重采样
    expect(bitmapFactory).not.toHaveBeenCalled()

    const out = await processImageData(img, defaultFilterParams, { maxSize: 4096, base })
    expect(out.width).toBe(100)
    expect(out.height).toBe(80)
    expect(bitmapFactory).not.toHaveBeenCalled()
  })
})
