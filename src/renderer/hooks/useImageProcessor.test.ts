/**
 * @layer L3
 * @module src/renderer/hooks/useImageProcessor
 * @coverage 图片处理流水线 + 防抖预览 + 导出 + 错误处理
 * @dependencies react, utils/imageProcessor, utils/filter
 * @remarks jsdom 环境，mock processImageData/imageToDataUrl/mergeFilterParams
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// vi.mock 必须在 import 之前
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
    exposure: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    vibrance: 0,
    clarity: 0,
    dehaze: 0,
    sharpness: 0,
    vignette: 0,
    grain: 0,
    curves: { rgb: [], r: [], g: [], b: [] },
    hsl: {},
    splitToning: {
      highlightHue: 0,
      highlightSaturation: 0,
      shadowHue: 0,
      shadowSaturation: 0,
      balance: 0
    },
    colorBalance: { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0] }
  }
}))
vi.mock('../utils/filter', () => ({
  mergeFilterParams: vi.fn((params, _filter, _intensity) => params)
}))

import { useImageProcessor } from './useImageProcessor'
import {
  processImageData,
  imageToDataUrl,
  buildPreviewBase,
  defaultFilterParams
} from '../utils/imageProcessor'
import { DRAG_PROXY_MAX_SIZE, FALLBACK_PREVIEW_MAX_SIZE } from '../utils/preview-resolution'

const mockProcessImageData = processImageData as ReturnType<typeof vi.fn>
const mockImageToDataUrl = imageToDataUrl as ReturnType<typeof vi.fn>
const mockBuildPreviewBase = buildPreviewBase as ReturnType<typeof vi.fn>

const SOURCE = 'media://file?path=a%2Fb.jpg'

/**
 * 渲染 hook 并让内部 new Image() 立即触发 onload（jsdom 不会真正解码图片），
 * 再推进定时器完成一次预览渲染。
 *
 * 必须用 `advanceTimersByTimeAsync` 而非同步版：帧调度把一帧拆成
 * 「rAF 回调 → 异步像素处理 → 异步编码 → state」的 Promise 链，
 * 同步推进不会在定时器之间冲刷微任务，渲染的收尾（inFlight 复位）就完不成，
 * 后续帧会被误判为「上一帧仍在飞」而永久合并掉。
 */
async function renderWithLoadedImage(source: string = SOURCE, maxPreviewSize?: number) {
  const OriginalImage = global.Image
  const img = new OriginalImage()
  // vitest 5 起，被 spyOn 的构造器桩必须是可 new 的函数：箭头函数不可构造，
  // 内部 `new Image()` 会抛错并打印 "The Image mock did not use 'function' or 'class'"
  const imgSpy = vi
    .spyOn(global, 'Image')
    .mockImplementation(function mockImageConstructor(): HTMLImageElement {
      return img
    })
  const { result } = renderHook(() =>
    maxPreviewSize === undefined
      ? useImageProcessor({ source })
      : useImageProcessor({ source, maxPreviewSize })
  )
  await act(async () => {
    img.dispatchEvent(new Event('load'))
    await vi.advanceTimersByTimeAsync(500)
  })
  return { result, restore: () => imgSpy.mockRestore() }
}

/** 取得实际传给 processImageData 的 maxSize */
async function capturePreviewMaxSize(maxPreviewSize?: number): Promise<number> {
  const { restore } = await renderWithLoadedImage(SOURCE, maxPreviewSize)
  const options = mockProcessImageData.mock.calls[0]?.[2] as { maxSize: number } | undefined
  restore()
  return options?.maxSize as number
}

describe('useImageProcessor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockProcessImageData.mockReset()
    mockImageToDataUrl.mockReset()
    mockProcessImageData.mockResolvedValue({
      width: 100,
      height: 100,
      data: new Uint8ClampedArray(100)
    })
    mockImageToDataUrl.mockResolvedValue('data:image/jpeg;base64,xxx')
    mockBuildPreviewBase.mockReset()
    // 每次调用都产出新对象：用例靠「对象是否相同」判断底图是否真的被复用
    mockBuildPreviewBase.mockImplementation(async (_source: unknown, maxSize: number) => ({
      width: 8,
      height: 8,
      data: new Uint8ClampedArray(256),
      key: String(maxSize)
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('初始状态', () => {
    it('source=null 时 loading=false, error=null, previewUrl=null', () => {
      const { result } = renderHook(() => useImageProcessor({ source: null }))
      expect(result.current.loading).toBe(false)
      expect(result.current.error).toBeNull()
      expect(result.current.previewUrl).toBeNull()
      expect(result.current.originalUrl).toBeNull()
    })

    it('初始 params 为 defaultFilterParams', () => {
      const { result } = renderHook(() => useImageProcessor({ source: null }))
      expect(result.current.params).toEqual(defaultFilterParams)
    })

    it('初始 filter=null, filterIntensity=100, watermark=null', () => {
      const { result } = renderHook(() => useImageProcessor({ source: null }))
      expect(result.current.filter).toBeNull()
      expect(result.current.filterIntensity).toBe(100)
      expect(result.current.watermark).toBeNull()
    })
  })

  describe('source 加载', () => {
    it('source 变化时设置 loading=true 并加载图片', async () => {
      const { result } = renderHook(({ source }) => useImageProcessor({ source }), {
        initialProps: { source: null as string | null }
      })
      // 重新 render 触发 source 变化
      const newImage = new Image()
      // vitest 5：构造器桩必须可 new，箭头函数会让 hook 内 `new Image()` 抛 TypeError
      vi.spyOn(global, 'Image').mockImplementation(
        function mockImageConstructor(): HTMLImageElement {
          return newImage
        }
      )
      act(() => {
        // 触发渲染：访问 result.current 触发 React 重新渲染
        void result.current
      })
    })
  })

  describe('updateParam', () => {
    it('部分更新指定 key', () => {
      const { result } = renderHook(() => useImageProcessor({ source: null }))
      act(() => {
        result.current.updateParam('brightness', 50)
      })
      expect(result.current.params.brightness).toBe(50)
    })

    it('不影响其他参数', () => {
      const { result } = renderHook(() => useImageProcessor({ source: null }))
      act(() => {
        result.current.updateParam('brightness', 50)
      })
      expect(result.current.params.contrast).toBe(defaultFilterParams.contrast)
    })
  })

  describe('updateCurve', () => {
    it('更新指定 channel 的曲线点', () => {
      const { result } = renderHook(() => useImageProcessor({ source: null }))
      const points = [
        { x: 0, y: 0 },
        { x: 255, y: 255 }
      ]
      act(() => {
        result.current.updateCurve('r', points)
      })
      expect(result.current.params.curves.r).toEqual(points)
    })

    it('不影响其他 channel', () => {
      const { result } = renderHook(() => useImageProcessor({ source: null }))
      act(() => {
        result.current.updateCurve('r', [{ x: 1, y: 2 }])
      })
      expect(result.current.params.curves.g).toEqual([])
    })
  })

  describe('updateHSL', () => {
    it('更新指定 HSL key 的 field', () => {
      const { result } = renderHook(() => useImageProcessor({ source: null }))
      act(() => {
        result.current.updateHSL('red', 'hue', 30)
      })
      expect(result.current.params.hsl.red.hue).toBe(30)
    })
  })

  describe('applyFilterPreset', () => {
    it('设置 filter 并重置 intensity 为 100', () => {
      const { result } = renderHook(() => useImageProcessor({ source: null }))
      act(() => {
        result.current.setFilterIntensity(50)
        result.current.applyFilterPreset({ id: 'warm', name: 'Warm' } as never)
      })
      expect(result.current.filter).toEqual({ id: 'warm', name: 'Warm' })
      expect(result.current.filterIntensity).toBe(100)
    })
  })

  describe('setFilter / setFilterIntensity / setWatermark', () => {
    it('setFilter 直接设置 filter', () => {
      const { result } = renderHook(() => useImageProcessor({ source: null }))
      const preset = { id: 'cool', name: 'Cool' } as never
      act(() => {
        result.current.setFilter(preset)
      })
      expect(result.current.filter).toEqual(preset)
    })

    it('setFilter 传 null 清空 filter', () => {
      const { result } = renderHook(() => useImageProcessor({ source: null }))
      act(() => {
        result.current.setFilter(null)
      })
      expect(result.current.filter).toBeNull()
    })

    it('setFilterIntensity 设置强度', () => {
      const { result } = renderHook(() => useImageProcessor({ source: null }))
      act(() => {
        result.current.setFilterIntensity(75)
      })
      expect(result.current.filterIntensity).toBe(75)
    })

    it('setWatermark 设置水印', () => {
      const { result } = renderHook(() => useImageProcessor({ source: null }))
      const wm = {
        position: 'center' as const,
        customX: 0,
        customY: 0,
        rotation: 0,
        margin: 10,
        tile: false,
        tileSpacingX: 100,
        tileSpacingY: 100
      }
      act(() => {
        result.current.setWatermark(wm)
      })
      expect(result.current.watermark).toEqual(wm)
    })
  })

  describe('setParams', () => {
    it('直接替换整个 params', () => {
      const { result } = renderHook(() => useImageProcessor({ source: null }))
      const newParams = { ...defaultFilterParams, brightness: 100, contrast: 50 }
      act(() => {
        result.current.setParams(newParams)
      })
      expect(result.current.params.brightness).toBe(100)
      expect(result.current.params.contrast).toBe(50)
    })
  })

  describe('reset', () => {
    it('重置所有参数到默认', () => {
      const { result } = renderHook(() => useImageProcessor({ source: null }))
      act(() => {
        result.current.updateParam('brightness', 99)
        result.current.applyFilterPreset({ id: 'x' } as never)
        result.current.setFilterIntensity(50)
        result.current.setWatermark({
          position: 'center',
          customX: 0,
          customY: 0,
          rotation: 0,
          margin: 0,
          tile: false,
          tileSpacingX: 0,
          tileSpacingY: 0
        })
        result.current.reset()
      })
      expect(result.current.params).toEqual(defaultFilterParams)
      expect(result.current.filter).toBeNull()
      expect(result.current.filterIntensity).toBe(100)
      expect(result.current.watermark).toBeNull()
    })
  })

  describe('exportDataUrl', () => {
    it('imageRef 为 null 时返回 null', async () => {
      const { result } = renderHook(() => useImageProcessor({ source: null }))
      const dataUrl = await result.current.exportDataUrl()
      expect(dataUrl).toBeNull()
    })
  })

  describe('source 加载与错误处理', () => {
    it('source 设置时设置 originalUrl', () => {
      const { result } = renderHook(({ source }) => useImageProcessor({ source }), {
        initialProps: { source: 'http://example.com/a.jpg' }
      })
      expect(result.current.originalUrl).toBe('http://example.com/a.jpg')
      expect(result.current.loading).toBe(true)
    })

    it('source 为 null 时清空 originalUrl 和 previewUrl', () => {
      const { result } = renderHook(({ source }) => useImageProcessor({ source }), {
        initialProps: { source: null as string | null }
      })
      expect(result.current.originalUrl).toBeNull()
      expect(result.current.previewUrl).toBeNull()
    })

    it('http(s) source 设置 crossOrigin', () => {
      // 保存原始 Image 引用，避免 mock 内 new Image() 递归调用 mockImplementation
      const OriginalImage = global.Image
      let capturedCrossOrigin: string | undefined
      const imgSpy = vi
        .spyOn(global, 'Image')
        // vitest 5：构造器桩必须可 new（箭头函数不可构造）
        .mockImplementation(function mockImageConstructor(): HTMLImageElement {
          const img = new OriginalImage()
          // 拦截 crossOrigin setter 以验证被赋值为 'anonymous'
          let _crossOrigin: string | undefined
          Object.defineProperty(img, 'crossOrigin', {
            get() {
              return _crossOrigin
            },
            set(v: string) {
              capturedCrossOrigin = v
              _crossOrigin = v
            },
            configurable: true
          })
          return img
        })
      renderHook(({ source }) => useImageProcessor({ source }), {
        initialProps: { source: 'https://example.com/a.jpg' }
      })
      expect(imgSpy).toHaveBeenCalled()
      expect(capturedCrossOrigin).toBe('anonymous')
      imgSpy.mockRestore()
    })

    it('media:// source 设置 crossOrigin=anonymous（独立 origin，防 canvas tainted 回归）', () => {
      // media:// scheme 注册为 standard，相对页面为跨源，必须以 anonymous CORS 模式加载
      const OriginalImage = global.Image
      let capturedCrossOrigin: string | undefined
      const imgSpy = vi
        .spyOn(global, 'Image')
        // vitest 5：构造器桩必须可 new（箭头函数不可构造）
        .mockImplementation(function mockImageConstructor(): HTMLImageElement {
          const img = new OriginalImage()
          // 拦截 crossOrigin setter 以验证被赋值为 'anonymous'
          let _crossOrigin: string | undefined
          Object.defineProperty(img, 'crossOrigin', {
            get() {
              return _crossOrigin
            },
            set(v: string) {
              capturedCrossOrigin = v
              _crossOrigin = v
            },
            configurable: true
          })
          return img
        })
      renderHook(({ source }) => useImageProcessor({ source }), {
        initialProps: { source: 'media://file?path=a%2Fb.jpg' }
      })
      expect(imgSpy).toHaveBeenCalled()
      expect(capturedCrossOrigin).toBe('anonymous')
      imgSpy.mockRestore()
    })
  })

  describe('预览尺寸预算（预览模糊回归）', () => {
    // 复现 Bug：修复前默认把预览长边硬钳到 1400，2x 屏或放大查看时位图被浏览器
    // 上采样而发虚。修复后预览尺寸由调用方按「显示区 × DPR × 缩放」给定。
    it('默认不限制预览尺寸（Infinity），不再钳到 1400', async () => {
      const maxSize = await capturePreviewMaxSize(undefined)
      expect(maxSize).toBe(Number.POSITIVE_INFINITY)
    })

    it('显式传入的预算原样透传（如 2600）', async () => {
      const maxSize = await capturePreviewMaxSize(2600)
      expect(maxSize).toBe(2600)
    })

    it.each([
      ['0', 0],
      ['负数', -5],
      ['NaN', NaN]
    ])('非法预算 %s 回落为不限制，而非静默降级', async (_name, value) => {
      const maxSize = await capturePreviewMaxSize(value)
      expect(maxSize).toBe(Number.POSITIVE_INFINITY)
    })
  })

  describe('exportDataUrl 编码质量（导出降质回归）', () => {
    it('jpg 源 fullSize 导出：分辨率不限制 + 最高质量 1', async () => {
      const { result, restore } = await renderWithLoadedImage()
      mockImageToDataUrl.mockClear()

      await act(async () => {
        await result.current.exportDataUrl(true)
      })

      const lastOptions = mockProcessImageData.mock.calls[
        mockProcessImageData.mock.calls.length - 1
      ][2] as { maxSize: number }
      expect(lastOptions.maxSize).toBe(Number.POSITIVE_INFINITY)
      expect(mockImageToDataUrl).toHaveBeenCalledWith(expect.anything(), 'image/jpeg', 1)
      restore()
    })

    it('png 源 fullSize 导出：使用 image/png 且质量 1', async () => {
      const { result, restore } = await renderWithLoadedImage('media://file?path=a%2Fb.png')
      mockImageToDataUrl.mockClear()

      await act(async () => {
        await result.current.exportDataUrl(true)
      })

      expect(mockImageToDataUrl).toHaveBeenCalledWith(expect.anything(), 'image/png', 1)
      restore()
    })

    it('mimeTypeOverride 生效（另存为 jpg 场景）', async () => {
      const { result, restore } = await renderWithLoadedImage('media://file?path=a%2Fb.png')
      mockImageToDataUrl.mockClear()

      await act(async () => {
        await result.current.exportDataUrl(true, 'image/jpeg')
      })

      expect(mockImageToDataUrl).toHaveBeenCalledWith(expect.anything(), 'image/jpeg', 1)
      restore()
    })

    it('非法 mimeTypeOverride 回落 image/jpeg', async () => {
      const { result, restore } = await renderWithLoadedImage()
      mockImageToDataUrl.mockClear()

      await act(async () => {
        await result.current.exportDataUrl(true, 'text/plain')
      })

      expect(mockImageToDataUrl).toHaveBeenCalledWith(expect.anything(), 'image/jpeg', 1)
      restore()
    })
  })

  /**
   * 图片水印失败可见（docs/plans/2026-10-17-fix-image-watermark-media-auth.md §5 N2）
   * logo 经 media:// 被拒时，hook 必须把 message 暴露成 watermarkError 供 UI 提示；
   * 与 error 分列，因为 EditorPage 的 error 只在「无预览」时渲染。
   */
  describe('watermarkError（图片水印失败透传）', () => {
    it('把 onWatermarkImageError 传给 processImageData，回调后暴露 watermarkError', async () => {
      const { result, restore } = await renderWithLoadedImage()

      const options = mockProcessImageData.mock.calls[0]?.[2] as {
        onWatermarkImageError?: (message: string) => void
      }
      expect(typeof options.onWatermarkImageError).toBe('function')
      expect(result.current.watermarkError).toBeNull()

      await act(async () => {
        options.onWatermarkImageError?.('加载图片失败: /logo.png')
        await Promise.resolve()
      })
      expect(result.current.watermarkError).toBe('加载图片失败: /logo.png')
      restore()
    })

    it('预览成功路径不得凭空产生 watermarkError', async () => {
      const { result, restore } = await renderWithLoadedImage()
      expect(result.current.watermarkError).toBeNull()
      restore()
    })
  })

  /**
   * 拖动期间的实时帧产出（docs/plans/2026-10-18-fix-editor-preview-realtime.md N1）
   *
   * 复现主缺陷：修复前 `PREVIEW_DEBOUNCE_MS` 是纯尾沿防抖，且每次参数变更都会重建
   * `renderPreview` 身份（useCallback deps）→ 依赖它的 effect 重跑 → clearTimeout 再挂表。
   * 连续拖动时定时器被无限重置，**拖动期间 0 帧**，画面只在指针停下后才变化一次。
   */
  describe('拖动期间的帧产出（实时预览回归）', () => {
    it('连续 20 次参数变更应持续出帧，而非拖动结束后才出一帧', async () => {
      const { result, restore } = await renderWithLoadedImage()
      const baseline = mockProcessImageData.mock.calls.length

      for (let i = 1; i <= 20; i++) {
        // 状态变更与推进时钟分两次 act（React 到 act 收尾才 flush effect，
        // 合并写会让帧排队落在时钟推进之后）
        await act(async () => {
          result.current.updateParam('brightness', i)
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20)
        })
      }

      const framesDuringDrag = mockProcessImageData.mock.calls.length - baseline
      restore()
      expect(framesDuringDrag).toBeGreaterThanOrEqual(8)
    })

    it('单帧未完成时不并发起第二帧，完成后补渲最新参数', async () => {
      const { result, restore } = await renderWithLoadedImage()
      const baseline = mockProcessImageData.mock.calls.length

      let release!: (value: { width: number; height: number; data: Uint8ClampedArray }) => void
      mockProcessImageData.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve
          })
      )

      for (let i = 1; i <= 5; i++) {
        await act(async () => {
          result.current.updateParam('brightness', i)
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20)
        })
      }
      // 在飞守卫：5 次变更只允许 1 帧真正开始渲染，其余合并
      expect(mockProcessImageData.mock.calls.length).toBe(baseline + 1)

      await act(async () => {
        release({ width: 100, height: 100, data: new Uint8ClampedArray(100) })
        await vi.advanceTimersByTimeAsync(40)
      })

      const lastCall = mockProcessImageData.mock.calls[mockProcessImageData.mock.calls.length - 1]
      // 补渲的那一帧必须用最新参数，不能被过期闭包取代
      expect((lastCall[1] as { brightness: number }).brightness).toBe(5)
      restore()
    })

    it('渲染失败上报 error，随后成功渲染必须清除它', async () => {
      const { result, restore } = await renderWithLoadedImage()
      // 必须让所有调用都失败：单次失败会走 :132-149 的降级重试（改用兜底预算再渲一次），
      // 重试成功时按设计不应报错，error 只在兜底也失败时才浮现
      mockProcessImageData.mockRejectedValue(new Error('boom'))

      // 状态变更与推进时钟必须分两次 act：React 要到 act 回调收尾才 flush effect，
      // 若在同一个回调里连着做，帧排队发生在时钟推进之后，这一帧永远等不到触发
      await act(async () => {
        result.current.updateParam('contrast', 20)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60)
      })
      expect(result.current.error).toContain('boom')

      mockProcessImageData.mockReset()
      mockProcessImageData.mockResolvedValue({
        width: 100,
        height: 100,
        data: new Uint8ClampedArray(100)
      })
      await act(async () => {
        result.current.updateParam('contrast', 25)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60)
      })
      expect(result.current.error).toBeNull()
      restore()
    })
  })

  /**
   * 两档预算（docs/plans/2026-10-18-fix-editor-preview-realtime.md N2）
   *
   * 复现第二项根因：修复前预览长边由「显示区 × DPR × 缩放」推导，8× 缩放时按原图分辨率
   * 逐像素循环，单帧秒级；且拖动帧与静止帧用同一预算，画质与流畅度无法两全。
   * 现按事件时间自动判档：连续变更（拖动）走代理档，停止后补一帧真实预算。
   */
  describe('两档预算（拖动降档 / 停止补帧）', () => {
    const maxSizeSequence = (from: number): number[] =>
      mockProcessImageData.mock.calls
        .slice(from)
        .map((call) => (call[2] as { maxSize: number }).maxSize)

    it('连续变更走代理档，停止输入后补一帧真实预算', async () => {
      const { result, restore } = await renderWithLoadedImage()
      // 先让时钟静默，模拟「停顿后重新开始拖动」——首次变更不应被判为拖动中
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      const baseline = mockProcessImageData.mock.calls.length

      for (let i = 1; i <= 5; i++) {
        await act(async () => {
          result.current.updateParam('brightness', i)
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20)
        })
      }

      const duringDrag = maxSizeSequence(baseline)
      expect(duringDrag.length).toBeGreaterThanOrEqual(3)
      expect(duringDrag[0]).toBe(Number.POSITIVE_INFINITY)
      expect(duringDrag.slice(1)).toEqual(
        new Array(duringDrag.length - 1).fill(DRAG_PROXY_MAX_SIZE)
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      const afterSettle = maxSizeSequence(baseline)
      expect(afterSettle.length).toBeGreaterThan(duringDrag.length)
      expect(afterSettle[afterSettle.length - 1]).toBe(Number.POSITIVE_INFINITY)
      restore()
    })

    it('变更间隔超过突发窗口时不降档（离散点击与方向键保持画质）', async () => {
      const { result, restore } = await renderWithLoadedImage()
      const baseline = mockProcessImageData.mock.calls.length

      for (let i = 1; i <= 3; i++) {
        await act(async () => {
          result.current.updateParam('brightness', i)
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(400)
        })
      }

      expect(maxSizeSequence(baseline)).toEqual([
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY
      ])
      restore()
    })

    it('显式预算小于代理档时拖动帧沿用该预算，只降不升', async () => {
      const { result, restore } = await renderWithLoadedImage(undefined, 512)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      const baseline = mockProcessImageData.mock.calls.length

      for (let i = 1; i <= 3; i++) {
        await act(async () => {
          result.current.updateParam('brightness', i)
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20)
        })
      }
      const sizes = maxSizeSequence(baseline).slice(1)
      expect(sizes.length).toBeGreaterThan(0)
      expect(sizes.every((v) => v === 512)).toBe(true)
      restore()
    })

    /**
     * FIX(实时预览审查)：代理档失败的「降级重试」是缺陷而非保护。
     * proxy 预算恒 ≤ DRAG_PROXY_MAX_SIZE(1024)，而兜底档 FALLBACK_PREVIEW_MAX_SIZE(1400) 比它**更大**，
     * 于是拖动中每失败一帧就立刻用更大的画布再绘一次，与「降级」恰好相反；
     * 同时无条件 setError 会在拖动期反复写错误态。
     * 计划 §5 的约定是：降级重试与 setError 只由 final 帧触发，proxy 帧失败仅记一条 warn，
     * 由 140ms 尾沿补帧拿真实预算重试。
     */
    it('代理档失败不得触发兜底放大重试，也不得写 error（异常：降级重试实为放大）', async () => {
      const { result, restore } = await renderWithLoadedImage()
      // 时钟静默 → 第一次变更判为 final，60ms 后的第二次落在突发窗口内判为 proxy
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      const beforeFinal = mockProcessImageData.mock.calls.length
      await act(async () => {
        result.current.updateParam('brightness', 10)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60)
      })
      // 先确认这一帧确实产出且走真实预算，否则下面的 proxy 断言无从判定
      expect(maxSizeSequence(beforeFinal)).toEqual([Number.POSITIVE_INFINITY])
      const beforeProxy = mockProcessImageData.mock.calls.length

      mockProcessImageData.mockRejectedValue(new Error('boom'))
      await act(async () => {
        result.current.updateParam('brightness', 20)
      })
      await act(async () => {
        // 只推进 60ms：仍在突发窗口内，且尚未到 140ms 尾沿补帧
        await vi.advanceTimersByTimeAsync(60)
      })

      const proxyAttempts = maxSizeSequence(beforeProxy)
      expect(proxyAttempts).toEqual([DRAG_PROXY_MAX_SIZE])
      expect(proxyAttempts).not.toContain(FALLBACK_PREVIEW_MAX_SIZE)
      expect(result.current.error).toBeNull()
      restore()
    })
  })

  /**
   * 底图缓存（docs/plans/2026-10-18-fix-editor-preview-realtime.md N3，hook 侧）
   *
   * 复现根因：修复前每帧都重新做一次「全分辨率高质量重采样」，而它与调节参数无关。
   * hook 必须按「档位尺寸」缓存底图：同尺寸帧复用同一对象，只在尺寸变化时重建。
   */
  describe('底图缓存复用', () => {
    it('同尺寸连续帧复用同一份底图，重建次数等于档位种类数', async () => {
      const { result, restore } = await renderWithLoadedImage()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })
      const baseline = mockProcessImageData.mock.calls.length

      for (let i = 1; i <= 3; i++) {
        await act(async () => {
          result.current.updateParam('brightness', i)
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20)
        })
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })

      const bases = mockProcessImageData.mock.calls
        .slice(baseline)
        .map((call) => (call[2] as { base?: unknown }).base)
      expect(bases.length).toBeGreaterThanOrEqual(4)
      expect(bases.every((base) => base !== undefined && base !== null)).toBe(true)

      // 拖动帧（1024）与静止帧（不限制）各建一次，其余全部复用
      const distinctBases = new Set(bases)
      expect(mockBuildPreviewBase).toHaveBeenCalledTimes(distinctBases.size)
      expect(distinctBases.size).toBe(2)
      restore()
    })

    it('代理档底图按 1024 建，真实档按调用方预算建', async () => {
      const { result, restore } = await renderWithLoadedImage(undefined, 4096)
      // 首帧（真实档）已按 4096 建过一次底图
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })

      await act(async () => {
        result.current.updateParam('brightness', 10)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20)
      })
      await act(async () => {
        result.current.updateParam('brightness', 20)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })

      // 真实档命中缓存不再重建，只有代理档新建一次
      const builtSizes = mockBuildPreviewBase.mock.calls.map((call) => call[1] as number)
      expect(builtSizes).toEqual([4096, DRAG_PROXY_MAX_SIZE])
      restore()
    })
  })
})
