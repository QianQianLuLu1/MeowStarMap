// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { handlePreviewRenderRequest, type PreviewRenderRequest } from './preview-worker'
import { defaultFilterParams } from './imageProcessor'

/**
 * @layer L3
 * @module src/renderer/utils/preview-worker
 * @coverage worker 入口的 RENDER 处理：底图 → 调色 → 编码 Blob
 * @dependencies jsdom；stub canvas 2d context 与 toBlob（jsdom 无 canvas 实现）
 * @remarks
 * 这里跑的是**真实管线函数**（processPreviewBase / imageDataToBlob），只把环境缺的
 * 画布补上——与 useImageProcessor.worker.test.ts 的桩 Worker 用例互补：
 * 那边验证「hook 会不会走 worker」，这边验证「worker 收到请求真能出图」。
 */

/**
 * jsdom 未安装 canvas 包时不导出 ImageData，而真实管线要用它。
 * 补一个与浏览器同签名且同样「复制入参」的最小实现（同 imageProcessor.pixels.test.ts）。
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

function makeRequest(overrides: Partial<PreviewRenderRequest> = {}): PreviewRenderRequest {
  const width = 4
  const height = 4
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 100
    data[i + 1] = 120
    data[i + 2] = 140
    data[i + 3] = 255
  }
  return {
    type: 'RENDER',
    reqId: 1,
    buffer: data.buffer,
    width,
    height,
    params: defaultFilterParams,
    watermark: null,
    mime: 'image/jpeg',
    quality: 0.9,
    ...overrides
  }
}

let originalGetContext: HTMLCanvasElement['getContext']

beforeEach(() => {
  originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    putImageData: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4)
    })),
    drawImage: vi.fn(),
    measureText: vi.fn(() => ({ width: 40 })),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    fill: vi.fn()
  })) as unknown as HTMLCanvasElement['getContext']
  // jsdom 没有 canvas 编码能力，用 toBlob 替身返回一个可辨识的 Blob
  HTMLCanvasElement.prototype.toBlob = vi.fn((cb: ((b: Blob | null) => void) | null) => {
    cb?.(new Blob(['encoded'], { type: 'image/jpeg' }))
  }) as unknown as HTMLCanvasElement['toBlob']
})

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext
  vi.restoreAllMocks()
})

describe('handlePreviewRenderRequest', () => {
  it('RENDER 请求返回编码后的 Blob（正常）', async () => {
    const blob = await handlePreviewRenderRequest(makeRequest())
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('image/jpeg')
    expect(blob.size).toBeGreaterThan(0)
  })

  it('请求携带水印配置时按主线程同等口径合成（正常）', async () => {
    const blob = await handlePreviewRenderRequest(
      makeRequest({
        watermark: {
          position: 'bottomRight',
          customX: 0,
          customY: 0,
          rotation: 0,
          margin: 10,
          tile: false,
          tileSpacingX: 50,
          tileSpacingY: 50,
          text: {
            content: '暖暖',
            size: 12,
            color: '#ffffff',
            opacity: 80,
            font: 'sans-serif',
            bold: false,
            italic: false,
            underline: false
          }
        }
      })
    )
    expect(blob).toBeInstanceOf(Blob)
  })

  it('上下文不可用时抛错而非静默返回空图（异常）', async () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => null
    ) as unknown as HTMLCanvasElement['getContext']
    await expect(handlePreviewRenderRequest(makeRequest())).rejects.toThrow()
  })
})
