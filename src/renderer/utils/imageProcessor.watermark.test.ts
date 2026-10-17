// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { processImageData, defaultFilterParams, type WatermarkConfig } from './imageProcessor'

/**
 * @layer L3
 * @module src/renderer/utils/imageProcessor · 图片水印分支
 * @coverage drawImageWatermark 的失败可见化（图片水印「点了没反应」的静默吞错面）
 * @dependencies jsdom；自行 stub canvas 2d context 与 Image
 * @remarks
 * 缺陷：logo 经 media:// 被拒 → img.onerror → drawImageWatermark 的 `catch { return }`
 * 把错误吞掉，水印静默消失，用户看不到任何提示（docs/plans/2026-10-17-fix-image-watermark-media-auth.md §0）。
 * 本组用例锁死「失败必须上报，但预览继续合成」这一对约束——只改其一会踩另一头：
 * 直接抛错会让 useImageProcessor 的降级重渲染把整张预览打没。
 */

/** 每次 getContext 生成一个新替身，便于区分「源图 blit 的 ctx」与「水印合成的 ctx」 */
let ctxInstances: Record<string, { mock: unknown; calls: unknown[] }>[] = []

type AnyMock = ReturnType<typeof vi.fn>

function makeCtxStub(): Record<string, unknown> {
  const fns: Record<string, AnyMock> = {
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
      colorSpace: 'srgb'
    })) as unknown as AnyMock,
    putImageData: vi.fn(),
    drawImage: vi.fn(),
    measureText: vi.fn(() => ({ width: 100 })) as unknown as AnyMock,
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    roundRect: vi.fn(),
    fill: vi.fn()
  }
  ctxInstances.push(fns as unknown as Record<string, { mock: unknown; calls: unknown[] }>)
  // 未预置的属性（font/fillStyle/textBaseline/globalAlpha/globalCompositeOperation/textAlign 等）
  // 一律返回可写的 vi.fn()，避免每加一个 canvas 成员就改一次替身
  return new Proxy(fns as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      target[prop] = vi.fn()
      return target[prop]
    },
    set(target, prop: string, value: unknown) {
      target[prop] = value
      return true
    }
  })
}

/** 取最后一个 ctx（applyWatermark 内部新建的画布）的替身集合 */
function watermarkCtx(): Record<string, AnyMock> {
  return ctxInstances[ctxInstances.length - 1] as unknown as Record<string, AnyMock>
}

/** Image 构造替身：赋值 src 后按 imageFailMode 异步触发 load / error */
let imageFailMode = true
let originalImage: typeof Image
let originalGetContext: HTMLCanvasElement['getContext']

function installFakeImage(): void {
  originalImage = globalThis.Image
  class FakeImage {
    onload: (() => void) | null = null
    onerror: ((this: GlobalEventHandlers, ev: Event) => unknown) | null = null
    crossOrigin: string | null = null
    width = 64
    height = 64
    set src(_value: string) {
      setTimeout(() => {
        if (imageFailMode)
          this.onerror?.call(this as unknown as GlobalEventHandlers, new Event('error'))
        else this.onload?.()
      }, 0)
    }
    get src(): string {
      return 'media://file?path=%2Flogo.png'
    }
  }
  // vitest 5 起桩必须可 new：箭头函数会让内部 `new Image()` 抛错
  globalThis.Image = FakeImage as unknown as typeof Image
}

const logoConfig = (extra?: Partial<WatermarkConfig>): WatermarkConfig => ({
  position: 'bottomRight',
  customX: 0,
  customY: 0,
  rotation: 0,
  margin: 20,
  tile: false,
  tileSpacingX: 50,
  tileSpacingY: 50,
  image: { path: '/logo.png', width: 120, height: 120, opacity: 80, blendMode: 'normal' },
  ...extra
})

function makeSource(): HTMLImageElement {
  return { width: 8, height: 8 } as unknown as HTMLImageElement
}

describe('drawImageWatermark 失败必须可见（图片水印静默吞错修复）', () => {
  beforeEach(() => {
    ctxInstances = []
    imageFailMode = true
    originalGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = vi.fn(() =>
      makeCtxStub()
    ) as unknown as HTMLCanvasElement['getContext']
    installFakeImage()
  })

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
    globalThis.Image = originalImage
  })

  it('C1 logo 加载失败时上报 onWatermarkImageError，且预览仍合成出 ImageData', async () => {
    const onWatermarkImageError = vi.fn()
    const result = await processImageData(makeSource(), defaultFilterParams, {
      watermark: logoConfig(),
      onWatermarkImageError
    } as Parameters<typeof processImageData>[2])

    // 失败必须可见
    expect(onWatermarkImageError).toHaveBeenCalledTimes(1)
    const message = onWatermarkImageError.mock.calls[0][0] as string
    expect(typeof message).toBe('string')
    expect(message.length).toBeGreaterThan(0)
    // 但不能因此让整条预览失败（useImageProcessor 的降级重渲染会因此把图打没）
    expect(result).toBeTruthy()
    expect(result.width).toBe(8)
  })

  it('C2 logo 加载成功时不得误报，且图片水印被绘制', async () => {
    imageFailMode = false
    const onWatermarkImageError = vi.fn()
    await processImageData(makeSource(), defaultFilterParams, {
      watermark: logoConfig(),
      onWatermarkImageError
    } as Parameters<typeof processImageData>[2])

    expect(onWatermarkImageError).not.toHaveBeenCalled()
    expect(watermarkCtx().drawImage).toHaveBeenCalledTimes(1)
  })

  it('C3 文字水印 + 坏 logo 共存时，文字仍照常绘制（一个坏 logo 不得拖垮整条水印）', async () => {
    const onWatermarkImageError = vi.fn()
    await processImageData(makeSource(), defaultFilterParams, {
      watermark: logoConfig({
        text: {
          content: 'WXNN',
          font: 'sans-serif',
          size: 24,
          color: '#ffffff',
          opacity: 80,
          bold: false,
          italic: false,
          underline: false
        }
      }),
      onWatermarkImageError
    } as Parameters<typeof processImageData>[2])

    expect(onWatermarkImageError).toHaveBeenCalledTimes(1)
    expect(watermarkCtx().fillText).toHaveBeenCalled()
  })

  /**
   * 缺陷：`applyWatermark` 在 polaroid 下先由 `drawPolaroidFrame` 在白带里画一次标签，
   * 随后又无条件走 `drawTextWatermark`（按 position/rotation/tile 再画一份）。
   * 面板自带的 polaroid 预设是 `bottomCenter` + `margin: 0`，第二份正好落在白带内
   * → 预览看到两串重叠的字，而批量导出（SVG 只出一次）没有，两侧观感不一致。
   */
  it('P1 style=polaroid 时标签只绘一次（框内居中），不得再按 position 叠加第二份', async () => {
    imageFailMode = false
    await processImageData(makeSource(), defaultFilterParams, {
      watermark: logoConfig({
        text: {
          content: 'WXNN',
          font: 'sans-serif',
          size: 24,
          color: '#ffffff',
          opacity: 80,
          bold: false,
          italic: false,
          underline: false
        },
        style: 'polaroid',
        position: 'bottomCenter',
        margin: 0
      })
    } as Parameters<typeof processImageData>[2])

    const calls = watermarkCtx().fillText.mock.calls as unknown as unknown[][]
    expect(calls).toHaveLength(1)
    // 唯一一次必须落在白带中心：ch=8 → frameHeight=max(1, round(8*0.16))=1 → y=8-0.5
    expect(calls[0][1]).toBe(4)
    expect(calls[0][2]).toBe(7.5)
  })
})
