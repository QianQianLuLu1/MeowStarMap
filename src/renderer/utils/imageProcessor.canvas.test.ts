// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { processImageData, defaultFilterParams } from './imageProcessor'

/** vi.fn() 的返回类型（vitest 1.6 下为 Mock<any[], unknown>），带实现的 mock 需断言一次 */
type AnyMock = ReturnType<typeof vi.fn>

/**
 * @layer L3
 * @module src/renderer/utils/imageProcessor
 * @coverage processImageData 的尺寸钳制与重采样质量（预览模糊根因之一）
 * @dependencies jsdom；自行 stub canvas 2d context 与 createImageBitmap
 * @remarks jsdom 无 canvas 实现，getContext 需 stub；
 *          使用 defaultFilterParams 以跳过清晰度/锐化/暗角等重卷积分支
 */

interface CtxStub {
  drawImage: AnyMock
  getImageData: AnyMock
  putImageData: AnyMock
  imageSmoothingEnabled: boolean
  imageSmoothingQuality: string
}

let ctxStub: CtxStub
let originalGetContext: HTMLCanvasElement['getContext']
let originalCreateImageBitmap: typeof createImageBitmap | undefined

function makeCtx(): CtxStub {
  return {
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4)
    })) as unknown as AnyMock,
    putImageData: vi.fn(),
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low'
  }
}

/** 构造指定尺寸的伪图片源 */
function makeSource(width: number, height: number): HTMLImageElement {
  const img = new Image()
  img.width = width
  img.height = height
  return img
}

function installCreateImageBitmap(): AnyMock {
  const factory = vi.fn(async () => ({
    width: 1,
    height: 1,
    close: vi.fn()
  }))
  globalThis.createImageBitmap = factory as unknown as typeof createImageBitmap
  return factory as unknown as AnyMock
}

describe('processImageData 尺寸与重采样质量', () => {
  beforeEach(() => {
    ctxStub = makeCtx()
    originalGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => ctxStub
    ) as unknown as HTMLCanvasElement['getContext']
    originalCreateImageBitmap = globalThis.createImageBitmap
    installCreateImageBitmap()
  })

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
    if (originalCreateImageBitmap === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).createImageBitmap
    } else {
      globalThis.createImageBitmap = originalCreateImageBitmap
    }
  })

  it('6000x4000 源 + maxSize 1500：走 createImageBitmap 高质量重采样，画布为 1500x1000', async () => {
    const source = makeSource(6000, 4000)
    await processImageData(source, defaultFilterParams, { maxSize: 1500 })

    expect(globalThis.createImageBitmap).toHaveBeenCalledTimes(1)
    const [argSource, argOptions] = (globalThis.createImageBitmap as ReturnType<typeof vi.fn>).mock
      .calls[0]
    expect(argSource).toBe(source)
    expect(argOptions).toMatchObject({
      resizeWidth: 1500,
      resizeHeight: 1000,
      resizeQuality: 'high'
    })
    expect(ctxStub.getImageData).toHaveBeenCalledWith(0, 0, 1500, 1000)
  })

  it('createImageBitmap 不可用时回退 drawImage，并开启 imageSmoothingQuality=high', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).createImageBitmap
    const source = makeSource(6000, 4000)

    await processImageData(source, defaultFilterParams, { maxSize: 1500 })

    expect(ctxStub.imageSmoothingQuality).toBe('high')
    expect(ctxStub.imageSmoothingEnabled).toBe(true)
    expect(ctxStub.drawImage).toHaveBeenCalledWith(source, 0, 0, 1500, 1000)
  })

  it('源图小于 maxSize 时按 1:1 直绘，不做任何重采样', async () => {
    const source = makeSource(800, 600)

    await processImageData(source, defaultFilterParams, { maxSize: 1500 })

    expect(ctxStub.getImageData).toHaveBeenCalledWith(0, 0, 800, 600)
    expect(ctxStub.drawImage).toHaveBeenCalledWith(source, 0, 0)
  })

  it('maxSize 缺省 / 0 / 负数 / NaN 一律视为不限制，保留原图分辨率', async () => {
    const source = makeSource(2000, 1000)

    for (const maxSize of [undefined, 0, -1, NaN]) {
      ctxStub = makeCtx()
      HTMLCanvasElement.prototype.getContext = vi.fn(
        () => ctxStub
      ) as unknown as HTMLCanvasElement['getContext']

      await processImageData(source, defaultFilterParams, { maxSize })

      expect(ctxStub.getImageData).toHaveBeenCalledWith(0, 0, 2000, 1000)
    }
  })

  it('maxSize 为 Infinity 时保留原图分辨率（导出 fullSize 路径）', async () => {
    const source = makeSource(6000, 4000)

    await processImageData(source, defaultFilterParams, { maxSize: Number.POSITIVE_INFINITY })

    expect(ctxStub.getImageData).toHaveBeenCalledWith(0, 0, 6000, 4000)
    expect(ctxStub.drawImage).toHaveBeenCalledWith(source, 0, 0)
  })

  it('源图尺寸缺失（0x0）时不抛未捕获异常', async () => {
    const source = makeSource(0, 0)
    await expect(
      processImageData(source, defaultFilterParams, { maxSize: 1500 })
    ).resolves.toBeTruthy()
  })

  it('getContext 返回 null 时抛出可读错误', async () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => null
    ) as unknown as HTMLCanvasElement['getContext']
    const source = makeSource(800, 600)

    await expect(processImageData(source, defaultFilterParams, {})).rejects.toThrow()
  })
})
