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
import { processImageData, imageToDataUrl, defaultFilterParams } from '../utils/imageProcessor'

const mockProcessImageData = processImageData as ReturnType<typeof vi.fn>
const mockImageToDataUrl = imageToDataUrl as ReturnType<typeof vi.fn>

const SOURCE = 'media://file?path=a%2Fb.jpg'

/**
 * 渲染 hook 并让内部 new Image() 立即触发 onload（jsdom 不会真正解码图片），
 * 再推进防抖定时器完成一次预览渲染
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
    vi.advanceTimersByTime(500)
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
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
})
