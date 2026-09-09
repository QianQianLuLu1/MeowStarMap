import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  processImageData,
  imageToDataUrl,
  defaultFilterParams,
  type FilterParams,
  type FilterPreset,
  type WatermarkConfig,
  type CurvePoint,
  type HSLColorKey
} from '../utils/imageProcessor'
import { mergeFilterParams } from '../utils/filter'
import { needsAnonymousCors } from '../utils/file'
import { resolveExportEncoding } from '../utils/export-encoding'
import { FALLBACK_PREVIEW_MAX_SIZE } from '../utils/preview-resolution'

// C-G3：命名常量取代魔法数字
/**
 * 预览长边预算默认值：不限制。
 *
 * FIX(预览清晰度)：原为固定 1400 —— 3840×2160 只剩 34% 像素、6000×4000 只剩 12%，
 * 再被预览容器 object-contain + scale(≤8) 上采样到全屏，是预览发虚的根因。
 * 现在由调用方按「显示区 × DPR × 缩放」计算预算传入；缺省表示按原图分辨率渲染。
 */
const DEFAULT_MAX_PREVIEW_SIZE = Number.POSITIVE_INFINITY
/** 预览渲染防抖延迟（毫秒），滑块拖动时避免频繁渲染 */
const PREVIEW_DEBOUNCE_MS = 80
/** JPEG 预览质量（0-1）；预览仅供显示，0.95 已无明显编码痕迹 */
const PREVIEW_JPEG_QUALITY = 0.95

/**
 * 归一化预览长边预算：仅有限正数有效，其余（undefined/0/负数/NaN/Infinity）视为不限制。
 * 此前 0/NaN 会被下游 `options.maxSize || 1600` 静默改成 1600，造成意外降分辨率。
 */
function normalizeMaxPreviewSize(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : Number.POSITIVE_INFINITY
}

interface UseImageProcessorOptions {
  source: string | null
  maxPreviewSize?: number
}

interface UseImageProcessorReturn {
  loading: boolean
  error: string | null
  params: FilterParams
  setParams: (params: FilterParams) => void
  updateParam: <K extends keyof FilterParams>(key: K, value: FilterParams[K]) => void
  updateCurve: (channel: 'rgb' | 'r' | 'g' | 'b', points: CurvePoint[]) => void
  updateHSL: (
    key: HSLColorKey,
    field: keyof FilterParams['hsl'][HSLColorKey],
    value: number
  ) => void
  filter: FilterPreset | null
  setFilter: (filter: FilterPreset | null) => void
  applyFilterPreset: (preset: FilterPreset) => void
  filterIntensity: number
  setFilterIntensity: (v: number) => void
  watermark: WatermarkConfig | null
  setWatermark: (w: WatermarkConfig | null) => void
  previewUrl: string | null
  originalUrl: string | null
  reset: () => void
  exportDataUrl: (fullSize?: boolean, mimeTypeOverride?: string) => Promise<string | null>
}

export function useImageProcessor({
  source,
  maxPreviewSize = DEFAULT_MAX_PREVIEW_SIZE
}: UseImageProcessorOptions): UseImageProcessorReturn {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  // C-O15：暴露错误状态给 UI，便于显示加载/渲染失败提示
  const [error, setError] = useState<string | null>(null)
  const [params, setParams] = useState<FilterParams>(defaultFilterParams)
  const [filter, setFilter] = useState<FilterPreset | null>(null)
  const [filterIntensity, setFilterIntensity] = useState(100)
  const [watermark, setWatermark] = useState<WatermarkConfig | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const pendingRef = useRef(0)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const mergedParams = useMemo(
    () => mergeFilterParams(params, filter, filterIntensity),
    [params, filter, filterIntensity]
  )

  const renderPreview = useCallback(() => {
    const img = imageRef.current
    if (!img) return

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    debounceTimerRef.current = setTimeout(async () => {
      const token = ++pendingRef.current
      const maxSize = normalizeMaxPreviewSize(maxPreviewSize)
      try {
        const imageData = await processImageData(img, mergedParams, {
          maxSize,
          watermark
        })
        if (token !== pendingRef.current) return
        const dataUrl = await imageToDataUrl(imageData, 'image/jpeg', PREVIEW_JPEG_QUALITY)
        if (token !== pendingRef.current) return
        setPreviewUrl(dataUrl)
        setError(null)
      } catch (err) {
        // 兜底：超大图按原图分辨率渲染可能因内存/画布上限失败，降级到兜底预算重试一次
        if (maxSize !== FALLBACK_PREVIEW_MAX_SIZE) {
          try {
            const fallbackData = await processImageData(img, mergedParams, {
              maxSize: FALLBACK_PREVIEW_MAX_SIZE,
              watermark
            })
            if (token !== pendingRef.current) return
            const dataUrl = await imageToDataUrl(fallbackData, 'image/jpeg', PREVIEW_JPEG_QUALITY)
            if (token !== pendingRef.current) return
            console.warn('[useImageProcessor] preview render degraded to fallback size', err)
            setPreviewUrl(dataUrl)
            setError(null)
            return
          } catch (fallbackErr) {
            console.error(t('toast.previewRenderFailed'), fallbackErr)
          }
        } else {
          console.error(t('toast.previewRenderFailed'), err)
        }
        if (token === pendingRef.current) {
          setError(err instanceof Error ? err.message : t('toast.previewRenderFailed'))
        }
      }
    }, PREVIEW_DEBOUNCE_MS)
  }, [mergedParams, watermark, maxPreviewSize, t])

  // C-S9：用 ref 持有最新的 renderPreview，避免 source 加载完成时调用过期闭包
  // 原实现 useEffect([source]) 内直接调 renderPreview()，但 renderPreview 是后续
  // useCallback 定义的，effect 闭包捕获的是首次渲染的版本（mergedParams 为默认值），
  // 导致首次预览短暂错误。现在通过 ref 始终调用最新版本。
  const renderPreviewRef = useRef(renderPreview)
  useEffect(() => {
    renderPreviewRef.current = renderPreview
  }, [renderPreview])

  // 持有最新的 t：onerror 使用翻译函数但不列入 [source] 依赖，
  // 避免语言切换触发图片重新加载
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  useEffect(() => {
    if (!source) {
      setPreviewUrl(null)
      setOriginalUrl(null)
      imageRef.current = null
      setError(null)
      return
    }

    setLoading(true)
    setError(null)
    setOriginalUrl(source)
    const img = new Image()
    // media:// 注册为 standard scheme 具有独立 origin，绘制进 canvas 前需以 anonymous CORS 模式加载
    if (needsAnonymousCors(source)) {
      img.crossOrigin = 'anonymous'
    }
    img.onload = () => {
      imageRef.current = img
      // 通过 ref 调用最新的 renderPreview，避免过期闭包
      renderPreviewRef.current()
      setLoading(false)
    }
    img.onerror = () => {
      setLoading(false)
      setError(tRef.current('toast.imageLoadFailed'))
    }
    img.src = source

    return () => {
      img.onload = null
      img.onerror = null
      img.src = ''
      // P2-C17：source 切换时置空 imageRef，避免 renderPreview 访问旧图片
      imageRef.current = null
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [source])

  useEffect(() => {
    if (!imageRef.current) return
    renderPreview()
  }, [renderPreview])

  // P2-C7：组件卸载时确保清理 debounce timer，避免 setTimeout 回调访问已卸载组件状态
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [])

  const updateParam = useCallback(
    <K extends keyof FilterParams>(key: K, value: FilterParams[K]) => {
      setParams((prev) => ({ ...prev, [key]: value }))
    },
    []
  )

  const updateCurve = useCallback((channel: 'rgb' | 'r' | 'g' | 'b', points: CurvePoint[]) => {
    setParams((prev) => ({
      ...prev,
      curves: { ...prev.curves, [channel]: points }
    }))
  }, [])

  const updateHSL = useCallback(
    (key: HSLColorKey, field: keyof FilterParams['hsl'][HSLColorKey], value: number) => {
      setParams((prev) => ({
        ...prev,
        hsl: {
          ...prev.hsl,
          [key]: { ...prev.hsl[key], [field]: value }
        }
      }))
    },
    []
  )

  const applyFilterPreset = useCallback((preset: FilterPreset) => {
    setFilter(preset)
    setFilterIntensity(100)
  }, [])

  const reset = useCallback(() => {
    setParams(defaultFilterParams)
    setFilter(null)
    setFilterIntensity(100)
    setWatermark(null)
  }, [])

  const exportDataUrl = useCallback(
    async (fullSize = false, mimeTypeOverride?: string): Promise<string | null> => {
      const img = imageRef.current
      if (!img) return null
      try {
        const imageData = await processImageData(img, mergedParams, {
          // FIX(组23-1): fullSize 导出（保存覆盖原图/另存为）不再钳制到 4096——
          // 长边超过 4096 的相机原片（如 6000×4000）会被静默降采样后写回原路径，
          // 用户无从知晓分辨率已损失。原图经 Image 解码时完整位图已驻留内存，
          // 同尺寸 canvas 输出不改变内存量级；预览路径仍由 maxPreviewSize 限制
          maxSize: fullSize ? Number.POSITIVE_INFINITY : normalizeMaxPreviewSize(maxPreviewSize),
          watermark
        })
        // P2-C11：优先使用调用方传入的 mimeTypeOverride；否则从 source URL 解析扩展名。
        // blob:/data: URL 无可靠扩展名，解析会误判为 jpeg，调用方可通过 mimeTypeOverride 显式指定。
        // 编码参数统一由 resolveExportEncoding 决定，非法值回落 image/jpeg
        const extFromSource = source ? (source.split('.').pop() ?? '') : ''
        const { mimeType, quality } = resolveExportEncoding(mimeTypeOverride ?? extFromSource)
        const dataUrl = await imageToDataUrl(imageData, mimeType, quality)
        setError(null)
        return dataUrl
      } catch (err) {
        console.error(t('toast.exportFailed'), err)
        setError(err instanceof Error ? err.message : t('toast.exportFailed'))
        return null
      }
    },
    [mergedParams, watermark, maxPreviewSize, source, t]
  )

  return {
    loading,
    error,
    params,
    setParams,
    updateParam,
    updateCurve,
    updateHSL,
    filter,
    setFilter,
    applyFilterPreset,
    filterIntensity,
    setFilterIntensity,
    watermark,
    setWatermark,
    previewUrl,
    originalUrl,
    reset,
    exportDataUrl
  }
}
