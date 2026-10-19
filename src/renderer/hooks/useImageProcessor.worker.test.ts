/**
 * @layer L3
 * @module src/renderer/hooks/useImageProcessor · worker 出图路径
 * @coverage B2：worker 就绪后由 worker 出图、失败/超时回落主线程、图片水印帧留在主线程
 * @dependencies jsdom；桩 Worker / canvas / imageProcessor 模块
 * @remarks
 * 用**真实定时器**而非 vi.useFakeTimers：本组用例要跑完「READY → 帧请求 → 线程异步回复
 * → FileReader 转 dataURL」的真实异步链，假定时器需要精确数微任务，脆弱且难读。
 */
import { StrictMode, createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, renderHook } from '@testing-library/react'

vi.mock('../utils/imageProcessor', () => ({
  processImageData: vi.fn(),
  imageToDataUrl: vi.fn(),
  buildPreviewBase: vi.fn(),
  clearWatermarkLogoCache: vi.fn(),
  defaultFilterParams: {
    brightness: 0,
    contrast: 0,
    saturation: 0,
    temperature: 0,
    tint: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    vibrance: 0,
    clarity: 0,
    dehaze: 0,
    sharpen: 0,
    denoise: 0,
    curves: { rgb: [], r: [], g: [], b: [] },
    hsl: {},
    splitBalance: 0,
    highlightHue: 0,
    highlightSaturation: 0,
    shadowHue: 0,
    shadowSaturation: 0,
    grain: 0,
    vignette: 0,
    fade: 0,
    lut: null
  }
}))
vi.mock('../utils/filter', () => ({
  mergeFilterParams: vi.fn((params) => params)
}))

import { useImageProcessor } from './useImageProcessor'
import { processImageData, imageToDataUrl, buildPreviewBase } from '../utils/imageProcessor'

const mockProcessImageData = processImageData as ReturnType<typeof vi.fn>
const mockImageToDataUrl = imageToDataUrl as ReturnType<typeof vi.fn>
const mockBuildPreviewBase = buildPreviewBase as ReturnType<typeof vi.fn>

const SOURCE = 'media://file?path=a%2Fb.jpg'

interface RenderRequest {
  type: string
  reqId: number
  buffer?: ArrayBuffer
  width?: number
  height?: number
  watermark?: unknown
}

/** 可控 worker 替身：记录收到的 RENDER 请求，并按 mode 决定回复 RESULT / ERROR / 不回复 */
const workers: FakeWorker[] = []
let workerMode: 'result' | 'error' | 'silent' = 'result'

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { message?: string }) => void) | null = null
  requests: RenderRequest[] = []
  terminated = false

  constructor() {
    workers.push(this)
    // 真实 worker 的 READY 是异步的，这里用宏任务对齐时序
    setTimeout(() => this.onmessage?.({ data: { type: 'READY' } }), 0)
  }

  postMessage(message: RenderRequest): void {
    if (message.type !== 'RENDER') return
    this.requests.push(message)
    if (workerMode === 'silent') return
    const reply =
      workerMode === 'result'
        ? {
            type: 'RESULT',
            reqId: message.reqId,
            blob: new Blob(['fake-jpeg'], { type: 'image/jpeg' })
          }
        : { type: 'ERROR', reqId: message.reqId, message: 'worker boom' }
    setTimeout(() => this.onmessage?.({ data: reply }), 0)
  }

  terminate(): void {
    this.terminated = true
  }
}

/** 轮询等待某个条件成立（真实定时器世界里的确定性由超时兜底） */
async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
}

function makeLoadedImage() {
  const img = new Image()
  vi.spyOn(global, 'Image').mockImplementation(function mockImageConstructor(): HTMLImageElement {
    return img
  })
  return img
}

/**
 * StrictMode 宿主：复现开发模式下 React 的「挂载 → 执行清理 → 再次挂载」同实例二次挂载。
 * 生产入口 `src/renderer/main.tsx:18` 就套着 StrictMode，所以这条路径是 dev 必经。
 *
 * 必须用 `render(createElement(StrictMode, …))` 而不是 `renderHook({ wrapper })`：
 * 实测本环境里后者**不会**双调用 effect（探针读数 mount 一次），前者为 mount→cleanup→mount，
 * 与 `useOnDemandThumbnails.test.tsx:48` 的既有范式一致。
 */
function renderInStrictMode(hook: () => unknown) {
  let latest: unknown = null
  const Probe = () => {
    latest = hook()
    return null
  }
  render(createElement(StrictMode, null, createElement(Probe)))
  return () => latest as ReturnType<typeof useImageProcessor>
}

describe('useImageProcessor · worker 出图', () => {
  beforeEach(() => {
    workers.length = 0
    workerMode = 'result'
    mockProcessImageData.mockReset()
    mockImageToDataUrl.mockReset()
    mockBuildPreviewBase.mockReset()
    mockProcessImageData.mockResolvedValue({
      width: 8,
      height: 8,
      data: new Uint8ClampedArray(256)
    })
    mockImageToDataUrl.mockResolvedValue('data:image/jpeg;base64,MAIN')
    mockBuildPreviewBase.mockResolvedValue({
      width: 8,
      height: 8,
      data: new Uint8ClampedArray(256)
    })
    vi.stubGlobal('Worker', FakeWorker)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('worker 就绪后由 worker 出图，主线程像素管线不再被调用（正常）', async () => {
    const img = makeLoadedImage()
    const { result } = renderHook(() => useImageProcessor({ source: SOURCE }))
    await act(async () => {
      img.dispatchEvent(new Event('load'))
    })
    await waitUntil(() => workers.length > 0)
    await waitUntil(() => workers[0].requests.length >= 1)

    const mainThreadCalls = mockProcessImageData.mock.calls.length
    await act(async () => {
      result.current.updateParam('brightness', 25)
    })
    await waitUntil(() => workers[0].requests.length >= 2)

    // 关键断言：这一帧交给 worker，主线程 processImageData 调用数没有增加
    expect(mockProcessImageData.mock.calls.length).toBe(mainThreadCalls)
    await waitUntil(() => result.current.previewUrl?.startsWith('data:') === true)
    expect(result.current.previewUrl).toContain('base64')
  })

  it('请求携带零拷贝底图缓冲与当前参数（正常）', async () => {
    const img = makeLoadedImage()
    const { result } = renderHook(() => useImageProcessor({ source: SOURCE }))
    await act(async () => {
      img.dispatchEvent(new Event('load'))
    })
    await waitUntil(() => workers.length > 0)
    await act(async () => {
      result.current.updateParam('contrast', 40)
    })
    await waitUntil(() => workers[0].requests.length >= 1)

    const request = workers[0].requests[0]
    expect(request.buffer).toBeInstanceOf(ArrayBuffer)
    expect(request.width).toBe(8)
    expect(request.height).toBe(8)
    expect((request as unknown as { params: { contrast: number } }).params.contrast).toBe(40)
  })

  it('worker 报错时回落主线程并仍然出图（异常）', async () => {
    workerMode = 'error'
    const img = makeLoadedImage()
    const { result } = renderHook(() => useImageProcessor({ source: SOURCE }))
    await act(async () => {
      img.dispatchEvent(new Event('load'))
    })
    await waitUntil(() => mockProcessImageData.mock.calls.length >= 1)
    expect(result.current.previewUrl).toBe('data:image/jpeg;base64,MAIN')
    expect(result.current.error).toBeNull()
  })

  it('worker 无响应时超时回落主线程（边界）', async () => {
    workerMode = 'silent'
    const img = makeLoadedImage()
    const { result } = renderHook(() => useImageProcessor({ source: SOURCE }))
    await act(async () => {
      img.dispatchEvent(new Event('load'))
    })
    // 2s 超时 + 主线程出图，整条链路应自愈而不是永远白屏
    await waitUntil(() => mockProcessImageData.mock.calls.length >= 1, 6000)
    expect(result.current.previewUrl).toBe('data:image/jpeg;base64,MAIN')
  })

  it('配置了图片水印时不使用 worker——logo 只能由主线程经 media:// 取（边界）', async () => {
    const img = makeLoadedImage()
    const { result } = renderHook(() => useImageProcessor({ source: SOURCE }))
    await act(async () => {
      img.dispatchEvent(new Event('load'))
    })
    await waitUntil(() => workers.length > 0 && workers[0].requests.length >= 1)
    const requestsBefore = workers[0].requests.length
    const mainCallsBefore = mockProcessImageData.mock.calls.length

    await act(async () => {
      result.current.setWatermark({
        position: 'bottomRight',
        customX: 0,
        customY: 0,
        rotation: 0,
        margin: 20,
        tile: false,
        tileSpacingX: 50,
        tileSpacingY: 50,
        image: { path: '/logo.png', width: 120, height: 120, opacity: 80, blendMode: 'normal' }
      })
    })

    // 必须回到主线程出图，且不再向 worker 投递新请求
    await waitUntil(() => mockProcessImageData.mock.calls.length > mainCallsBefore)
    expect(workers[0].requests.length).toBe(requestsBefore)
  })

  it('卸载后终止 worker；握手迟到也不留孤儿线程（边界）', async () => {
    const img = makeLoadedImage()
    const { unmount } = renderHook(() => useImageProcessor({ source: SOURCE }))
    await act(async () => {
      img.dispatchEvent(new Event('load'))
    })
    await waitUntil(() => workers.length > 0)

    // 不等 READY 落地就卸载：模拟「刚进编辑器就退出」的竞态。
    // 此时 hook 还没拿到 handle，必须靠迟到回调里的 disposed 判定回收，否则线程白留。
    await act(async () => {
      unmount()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(workers[0].terminated).toBe(true)
  })

  it('React StrictMode 二次挂载后仍由 worker 出图，而不是把 handle 关掉（异常：开发模式重挂载）', async () => {
    const img = makeLoadedImage()
    renderInStrictMode(() => useImageProcessor({ source: SOURCE }))
    await act(async () => {
      img.dispatchEvent(new Event('load'))
    })
    await waitUntil(() => workers.length > 0)

    // 让「握手决议」落地：接管成功的标志是收到 RENDER，判定不可用的标志是 terminated。
    // 二者必居其一，故轮询到这个分岔点即可断言，不依赖具体微任务数。
    await waitUntil(() => workers[0].terminated || workers[0].requests.length >= 1)
    expect(workers[0].terminated).toBe(false)
    expect(workers[0].requests.length).toBeGreaterThanOrEqual(1)
  })

  // ---------- 放弃 worker 的三条路径都必须 terminate 线程（否则线程活到进程结束） ----------

  it('worker 回 ERROR 后不仅回落主线程，还必须终止该线程（异常）', async () => {
    workerMode = 'error'
    const img = makeLoadedImage()
    const { result } = renderHook(() => useImageProcessor({ source: SOURCE }))
    await act(async () => {
      img.dispatchEvent(new Event('load'))
    })
    await waitUntil(() => mockProcessImageData.mock.calls.length >= 1)
    expect(result.current.previewUrl).toBe('data:image/jpeg;base64,MAIN')
    expect(workers[0].terminated).toBe(true)
  })

  it('worker 单帧超时判定不可用后必须终止该线程（边界）', async () => {
    workerMode = 'silent'
    const img = makeLoadedImage()
    const { result } = renderHook(() => useImageProcessor({ source: SOURCE }))
    await act(async () => {
      img.dispatchEvent(new Event('load'))
    })
    await waitUntil(() => mockProcessImageData.mock.calls.length >= 1, 6000)
    expect(result.current.previewUrl).toBe('data:image/jpeg;base64,MAIN')
    expect(workers[0].terminated).toBe(true)
  })

  it('worker 运行期崩溃时立即回落主线程，不空等 2s 超时，并终止线程（异常）', async () => {
    // silent：让首帧停在 worker 在飞状态，才有「崩溃时该不该立刻放手」可测
    workerMode = 'silent'
    const img = makeLoadedImage()
    const { result } = renderHook(() => useImageProcessor({ source: SOURCE }))
    await act(async () => {
      img.dispatchEvent(new Event('load'))
    })
    await waitUntil(() => workers[0].requests.length >= 1)
    expect(mockProcessImageData.mock.calls.length).toBe(0)

    const startedAt = Date.now()
    await act(async () => {
      workers[0].onerror?.({ message: 'crash' })
    })
    await waitUntil(() => mockProcessImageData.mock.calls.length >= 1, 6000)
    // 回落应当在毫秒级完成；等满 PREVIEW_WORKER_RENDER_TIMEOUT_MS(2000) 即为缺陷
    expect(Date.now() - startedAt).toBeLessThan(1500)
    expect(workers[0].terminated).toBe(true)
    expect(result.current.previewUrl).toBe('data:image/jpeg;base64,MAIN')
  })
})
