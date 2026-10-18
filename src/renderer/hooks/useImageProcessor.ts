import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  processImageData,
  imageToDataUrl,
  buildPreviewBase,
  clearWatermarkLogoCache,
  defaultFilterParams,
  type FilterParams,
  type FilterPreset,
  type PreviewBase,
  type WatermarkConfig,
  type CurvePoint,
  type HSLColorKey
} from '../utils/imageProcessor'
import { mergeFilterParams } from '../utils/filter'
import { needsAnonymousCors } from '../utils/file'
import { openPreviewWorker, type PreviewWorkerHandle } from '../utils/preview-worker-bridge'
import { resolveExportEncoding } from '../utils/export-encoding'
import { FALLBACK_PREVIEW_MAX_SIZE, computeDragProxyMaxSize } from '../utils/preview-resolution'

// C-G3：命名常量取代魔法数字
/**
 * 预览长边预算默认值：不限制。
 *
 * FIX(预览清晰度)：原为固定 1400 —— 3840×2160 只剩 34% 像素、6000×4000 只剩 12%，
 * 再被预览容器 object-contain + scale(≤8) 上采样到全屏，是预览发虚的根因。
 * 现在由调用方按「显示区 × DPR × 缩放」计算预算传入；缺省表示按原图分辨率渲染。
 */
const DEFAULT_MAX_PREVIEW_SIZE = Number.POSITIVE_INFINITY
/**
 * 帧调度兜底间隔（毫秒）：仅在环境无 requestAnimationFrame 时用作 setTimeout 节奏。
 *
 * FIX(实时预览)：此前是纯尾沿 `setTimeout(PREVIEW_DEBOUNCE_MS)`，且每次参数变更都会重建
 * `renderPreview` 身份 → 依赖它的 effect 重跑 → clearTimeout 再挂表。连续拖动时定时器被
 * 无限重置，**拖动期间一帧都不产出**，预览只在指针停止 80ms 后才变化一次。
 * 现改为 rAF 合并调度：每帧最多一次、恒用最新参数、在飞期间合并而非丢弃。
 */
const PREVIEW_FRAME_FALLBACK_MS = 16
/**
 * 突发窗口（毫秒）：与上一次参数变更的间隔小于它即判定为「拖动中」。
 * 判档只看事件时间，不需要 SliderControl / EditorTabs 传「开始/结束拖动」信号，
 * 因此零改动面；离散操作（点击、方向键、双击复位）间隔天然大于该窗口，走真实预算。
 */
const PREVIEW_BURST_WINDOW_MS = 200
/** 尾沿补帧延迟（毫秒）：停止输入后补一帧真实预算，把拖动的模糊换回清晰 */
const PREVIEW_SETTLE_MS = 140
/** worker 出图超时（毫秒）：超时即判定 worker 不可用并永久回落主线程 */
const PREVIEW_WORKER_RENDER_TIMEOUT_MS = 2000
/** 预览档位：proxy = 拖动代理档，final = 真实显示预算 */
type PreviewTier = 'proxy' | 'final'
/** JPEG 预览质量（0-1）；预览仅供显示，0.95 已无明显编码痕迹 */
const PREVIEW_JPEG_QUALITY = 0.95
/** 底图缓存条目数：恰好容纳「拖动档 + 真实档」两种尺寸 */
const PREVIEW_BASE_CACHE_MAX_ENTRIES = 2
/** 超过该像素量的底图不入缓存，避免高缩放时几十 MB 常驻内存 */
const PREVIEW_BASE_CACHE_MAX_PIXELS = 4_000_000
/** 单帧渲染耗时观测用的 measure 名与保留窗口（超窗即清空，避免长会话无界增长） */
const PERF_MEASURE_NAME = 'wxnn:preview'
const PERF_MARK_START = 'wxnn:preview:start'
const PERF_MARK_END = 'wxnn:preview:end'
const PERF_ENTRY_WINDOW = 256

/**
 * 记录单帧渲染耗时供 DevTools 时间线读取。
 * 纯观测：任何异常都必须吞掉，不得影响预览出图。
 */
function markPreviewStart(): void {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return
  try {
    performance.mark(PERF_MARK_START)
  } catch {
    // 观测失败不影响渲染
  }
}

function measurePreviewRender(): void {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return
  try {
    if (performance.getEntriesByName(PERF_MEASURE_NAME).length >= PERF_ENTRY_WINDOW) {
      // 只按名清自己这一组：无参 clearMarks() 会把本帧刚打的 start mark 一并抹掉，
      // 紧接着的 measure(name, start, end) 便因起点不存在而抛错、被下面的 catch 吞掉，白丢样本；
      // start/end 两个 mark 本来就在每次 measure 后按名清除，不会无界增长。
      performance.clearMeasures(PERF_MEASURE_NAME)
    }
    performance.mark(PERF_MARK_END)
    performance.measure(PERF_MEASURE_NAME, PERF_MARK_START, PERF_MARK_END)
    performance.clearMarks(PERF_MARK_START)
    performance.clearMarks(PERF_MARK_END)
  } catch {
    // 观测失败不影响渲染
  }
}

/** 一帧渲染所需的全部输入；由参数变更写入，帧回调只读，避免过期闭包 */
interface PreviewSnapshot {
  img: HTMLImageElement
  params: FilterParams
  watermark: WatermarkConfig | null
  /** 真实显示预算（未降档）；代理档由它折算，尾随帧直接用它 */
  finalMaxSize: number
  tier: PreviewTier
}

/** worker 在飞请求：本 hook 同帧只允许一个，故无需请求表 */
interface WorkerPendingRender {
  reqId: number
  resolve: (blob: Blob | null) => void
}

/** Blob → dataURL。编码已在 worker 完成，这里只是一次异步读取，不占主线程像素时间 */
function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('preview blob read failed'))
    reader.readAsDataURL(blob)
  })
}

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
  /** 图片水印 logo 加载失败的可读提示；null 表示无失败 */
  watermarkError: string | null
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
  // 图片水印 logo 加载失败的可读提示。刻意与 `error` 分开：`error` 在 EditorPage 只在
  // 「无预览」时渲染，而 logo 读失败时预览仍在，复用 error 等于什么都不显示。
  const [watermarkError, setWatermarkError] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const pendingRef = useRef(0)
  /** 待渲染输入快照；帧回调只读它，因此永远不会用过期参数出图 */
  const snapshotRef = useRef<PreviewSnapshot | null>(null)
  /** 已排队但未执行的帧句柄；null 表示当前无排队 */
  const frameHandleRef = useRef<number | null>(null)
  const frameViaRafRef = useRef(false)
  /** 当前是否有渲染正在执行（用于把后续变更合并到下一帧，而不是并发挤进主线程） */
  const inFlightRef = useRef(false)
  /** 在飞期间又收到变更；本轮渲染结束后必须补渲 */
  const dirtyRef = useRef(false)
  /** 上一次参数变更的时刻，用于「拖动中」突发判定。初值 0 ⇒ 首次变更必判为静止 */
  const lastChangeAtRef = useRef(0)
  /** 尾沿补帧定时器（window.setTimeout 返回 number，与帧句柄同口径避免类型分叉） */
  const settleTimerRef = useRef<number | null>(null)
  /** 跨帧复用的底图缓存：键为本帧实际预算（长边像素），值绑定产出它的那张图源 */
  const baseCacheRef = useRef<Map<number, { img: HTMLImageElement; base: PreviewBase }>>(new Map())

  /**
   * 取（或建）当前预算下的底图。
   *
   * 命中除了比预算，还必须核验**图源对象身份**：同一张图重新加载后 URL 不变、位图已换，
   * 只比尺寸会把陈旧像素当成新图的底图。
   */
  const acquireBase = useCallback(
    async (img: HTMLImageElement, maxSize: number): Promise<PreviewBase | undefined> => {
      if (!(maxSize > 0)) return undefined
      const cache = baseCacheRef.current
      const cached = cache.get(maxSize)
      if (cached && cached.img === img) return cached.base

      const base = await buildPreviewBase(img, maxSize)
      if (base.width * base.height <= PREVIEW_BASE_CACHE_MAX_PIXELS) {
        // delete + set 把条目移到队尾，超限时从队首淘汰（Map 迭代序即插入序）
        cache.delete(maxSize)
        cache.set(maxSize, { img, base })
        while (cache.size > PREVIEW_BASE_CACHE_MAX_ENTRIES) {
          const oldest = cache.keys().next().value
          if (oldest === undefined) break
          cache.delete(oldest)
        }
      }
      return base
    },
    []
  )

  const mergedParams = useMemo(
    () => mergeFilterParams(params, filter, filterIntensity),
    [params, filter, filterIntensity]
  )

  // 换水印（含改 logo 路径）即清除上一次失败提示，避免旧错误常驻
  useEffect(() => {
    setWatermarkError(null)
  }, [watermark])

  const handleWatermarkImageError = useCallback((message: string) => {
    setWatermarkError(message)
  }, [])

  /**
   * 预览像素 worker（B2 管线卸载）。
   * undefined = 尚未尝试；null = 没试过或已判定不可用。任一种都只 spawn 一次。
   * 不可用时渲染**继续走主线程**——worker 是加速手段，不是渲染前提。
   */
  const previewWorkerRef = useRef<PreviewWorkerHandle | null | undefined>(undefined)
  /** 本实例是否已卸载：握手迟到时据此回收，避免留下无人终止的线程 */
  const workerDisposedRef = useRef(false)
  const workerPendingRef = useRef<WorkerPendingRender | null>(null)
  const workerReqRef = useRef(0)
  const workerTimerRef = useRef<number | null>(null)

  const settleWorkerPending = useCallback((reqId: number, blob: Blob | null): void => {
    const pending = workerPendingRef.current
    if (!pending || pending.reqId !== reqId) return
    workerPendingRef.current = null
    if (workerTimerRef.current !== null) {
      window.clearTimeout(workerTimerRef.current)
      workerTimerRef.current = null
    }
    pending.resolve(blob)
  }, [])

  /**
   * 判定 worker 不可用并彻底放手：置空引用（此后不再重建，保持「永久回落主线程」语义）→
   * 立刻释放该线程的在飞请求（否则那一帧要空等满 2s 超时）→ terminate。
   *
   * FIX(实时预览审查)：三条放弃路径此前只写 `previewWorkerRef.current = null` 而不 terminate，
   * 而 releaseWorker 卸载时读到的已是 null，无从回收——线程带着 imageProcessor 模块
   * 与其 logo 缓存存活到进程结束。
   */
  const discardPreviewWorker = useCallback(
    (reason: string): void => {
      console.warn('[useImageProcessor] preview worker disabled', reason)
      const handle = previewWorkerRef.current
      previewWorkerRef.current = null
      const pending = workerPendingRef.current
      if (pending) settleWorkerPending(pending.reqId, null)
      handle?.terminate()
    },
    [settleWorkerPending]
  )

  const ensurePreviewWorker = useCallback((): void => {
    if (previewWorkerRef.current !== undefined) return
    previewWorkerRef.current = null
    void openPreviewWorker().then((handle) => {
      if (!handle) return
      if (workerDisposedRef.current) {
        // 组件已卸载而握手刚到：直接回收，否则这条线程没人负责关
        handle.terminate()
        return
      }
      handle.worker.onmessage = (event: MessageEvent): void => {
        const data = event.data as {
          type?: string
          reqId?: number
          blob?: Blob
          message?: string
        } | null
        if (!data || typeof data !== 'object') return
        if (data.type === 'RESULT') {
          settleWorkerPending(data.reqId ?? -1, data.blob ?? null)
        } else if (data.type === 'ERROR') {
          // 出图失败不再给第二次机会：永久回落主线程，保证预览始终能出图
          discardPreviewWorker(`render error: ${data.message ?? ''}`)
        }
      }
      handle.attachErrorWatcher((message) => {
        discardPreviewWorker(`runtime error: ${message}`)
      })
      previewWorkerRef.current = handle
    })
  }, [settleWorkerPending, discardPreviewWorker])

  /**
   * 请 worker 出一帧，返回 dataURL；返回 null 表示「这帧别用 worker」或 worker 出了问题，
   * 调用方照常走主线程。
   *
   * 带**图片水印**的帧必须留在主线程：logo 只能由主线程经 media:// 取——
   * worker 内 `fetch('media://…')` 会撞 CSP（`media:` 只在 img-src/media-src 白名单里，
   * 不在 connect-src），而把 logo 位图再传进 worker 会让失败可见性（2026-10-17 的修复）
   * 变得难以保持。图片水印是低频场景，不值得为此牺牲那条契约。
   */
  const renderViaWorker = useCallback(
    async (
      img: HTMLImageElement,
      params: FilterParams,
      watermark: WatermarkConfig | null,
      maxSize: number
    ): Promise<string | null> => {
      const handle = previewWorkerRef.current
      if (!handle || workerPendingRef.current) return null
      if (watermark?.image?.path) return null

      const base = await acquireBase(img, maxSize)
      if (!base) return null

      // 复制一份再 transfer：底图本体留在缓存里还要继续用，被 transfer 走就废了
      const copy = new Uint8ClampedArray(base.data)
      const reqId = ++workerReqRef.current

      const blob = await new Promise<Blob | null>((resolve) => {
        workerPendingRef.current = { reqId, resolve }
        workerTimerRef.current = window.setTimeout(() => {
          discardPreviewWorker(`render timeout after ${PREVIEW_WORKER_RENDER_TIMEOUT_MS}ms`)
        }, PREVIEW_WORKER_RENDER_TIMEOUT_MS)
        handle?.worker.postMessage(
          {
            type: 'RENDER',
            reqId,
            buffer: copy.buffer,
            width: base.width,
            height: base.height,
            params,
            watermark: watermark ?? null,
            mime: 'image/jpeg',
            quality: PREVIEW_JPEG_QUALITY
          },
          [copy.buffer]
        )
      })

      if (!blob) return null
      return readBlobAsDataUrl(blob)
    },
    [acquireBase, discardPreviewWorker]
  )

  /** 真正执行一帧：像素处理 → 编码 → 落 state。输入全部取自快照，不会用过期参数出图 */
  const doRender = useCallback(
    async (snapshot: PreviewSnapshot): Promise<void> => {
      const token = ++pendingRef.current
      const { img, params, watermark: snapshotWatermark, finalMaxSize, tier } = snapshot
      // 拖动帧降档、静止帧满预算：代理档只降不升，非法预算原样透传给下游处理
      const maxSize = tier === 'proxy' ? computeDragProxyMaxSize(finalMaxSize) : finalMaxSize
      try {
        // 优先让 worker 出图：像素循环与 JPEG 编码都离开主线程。返回 null 即回落主线程路径。
        const workerDataUrl = await renderViaWorker(img, params, snapshotWatermark, maxSize)
        if (workerDataUrl !== null) {
          if (token !== pendingRef.current) return
          setPreviewUrl(workerDataUrl)
          setError(null)
          return
        }
        const base = await acquireBase(img, maxSize)
        const imageData = await processImageData(img, params, {
          maxSize,
          base,
          // 预览是高频重复合成，logo 缓存起来；导出仍每次取最新文件
          cacheLogo: true,
          watermark: snapshotWatermark,
          onWatermarkImageError: handleWatermarkImageError
        })
        if (token !== pendingRef.current) return
        const dataUrl = await imageToDataUrl(imageData, 'image/jpeg', PREVIEW_JPEG_QUALITY)
        if (token !== pendingRef.current) return
        setPreviewUrl(dataUrl)
        setError(null)
      } catch (err) {
        // FIX(实时预览审查)：拖动代理档失败只记一条 warn 后收手。两条理由：
        // ① 兜底档 FALLBACK_PREVIEW_MAX_SIZE(1400) 恒大于代理档（≤ DRAG_PROXY_MAX_SIZE 1024），
        //    在这里重试等于「降级不成反放大」，把刚失败的帧换成更贵的帧；
        // ② 拖动期反复写 error 态毫无意义——停止输入后 PREVIEW_SETTLE_MS 尾沿一定会补一帧 final，
        //    由那一帧走完整的「降级重试 + 上报错误」链路。
        if (tier === 'proxy') {
          console.warn('[useImageProcessor] proxy frame failed, waiting for settle frame', err)
          return
        }
        // 兜底：超大图按原图分辨率渲染可能因内存/画布上限失败，降级到兜底预算重试一次
        if (maxSize !== FALLBACK_PREVIEW_MAX_SIZE) {
          try {
            const fallbackData = await processImageData(img, params, {
              maxSize: FALLBACK_PREVIEW_MAX_SIZE,
              cacheLogo: true,
              watermark: snapshotWatermark,
              onWatermarkImageError: handleWatermarkImageError
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
    },
    [handleWatermarkImageError, acquireBase, renderViaWorker, t]
  )

  // 帧回调用 ref 持有最新版本：ensureFrame 只经它调用，避免与 pump 相互引用成环
  const pumpRef = useRef<() => void>(() => {})

  /** 排队一帧：同一帧内多次变更只排队一次；无 rAF 环境退化为 16ms 定时器 */
  const ensureFrame = useCallback(() => {
    if (frameHandleRef.current !== null) return
    const run = () => pumpRef.current()
    if (typeof requestAnimationFrame === 'function') {
      frameViaRafRef.current = true
      frameHandleRef.current = requestAnimationFrame(run)
    } else {
      frameViaRafRef.current = false
      frameHandleRef.current = window.setTimeout(run, PREVIEW_FRAME_FALLBACK_MS)
    }
  }, [])

  /** 撤销所有已排队的渲染：帧句柄 + 尾沿补帧定时器（卸载与换图都必须调用） */
  const cancelScheduledRender = useCallback(() => {
    const handle = frameHandleRef.current
    if (handle !== null) {
      frameHandleRef.current = null
      if (frameViaRafRef.current) {
        cancelAnimationFrame(handle)
      } else {
        window.clearTimeout(handle)
      }
    }
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
  }, [])

  /** 帧回调：在飞则合并到下一帧，否则用最新快照渲染一帧 */
  const pump = useCallback(() => {
    frameHandleRef.current = null
    if (inFlightRef.current) {
      // 上一帧还没画完：不并发挤占主线程，标记脏位，结束后补渲最新参数
      dirtyRef.current = true
      return
    }
    const snapshot = snapshotRef.current
    if (!snapshot) return

    const settle = () => {
      measurePreviewRender()
      inFlightRef.current = false
      if (dirtyRef.current) {
        dirtyRef.current = false
        ensureFrame()
      }
    }
    inFlightRef.current = true
    markPreviewStart()
    void doRender(snapshot).then(settle, settle)
  }, [doRender, ensureFrame])

  // 与 renderPreviewRef 同理：排队的帧回调始终执行最新版本的 pump
  useEffect(() => {
    pumpRef.current = pump
  }, [pump])

  /** 释放 worker：清在飞请求与超时器并终止线程（卸载时调用） */
  const releaseWorker = useCallback((): void => {
    workerDisposedRef.current = true
    if (workerTimerRef.current !== null) {
      window.clearTimeout(workerTimerRef.current)
      workerTimerRef.current = null
    }
    workerPendingRef.current = null
    const handle = previewWorkerRef.current
    if (handle) {
      handle.terminate()
      // 置回 undefined：下次挂载允许重新 spawn（严格模式双挂载后仍能有 worker 可用）
      previewWorkerRef.current = undefined
    }
  }, [])

  const renderPreview = useCallback(() => {
    const img = imageRef.current
    if (!img) return
    ensurePreviewWorker()
    const now = Date.now()
    const dragging = now - lastChangeAtRef.current < PREVIEW_BURST_WINDOW_MS
    lastChangeAtRef.current = now
    snapshotRef.current = {
      img,
      params: mergedParams,
      watermark,
      finalMaxSize: normalizeMaxPreviewSize(maxPreviewSize),
      tier: dragging ? 'proxy' : 'final'
    }
    ensureFrame()

    // 每次变更都重挂尾沿定时器：输入一旦停止，最后一帧若是代理档必须补一帧真实预算，
    // 否则画面会停在模糊态
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current)
    }
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null
      const snapshot = snapshotRef.current
      if (!snapshot || snapshot.tier === 'final') return
      snapshot.tier = 'final'
      ensureFrame()
    }, PREVIEW_SETTLE_MS)
  }, [mergedParams, watermark, maxPreviewSize, ensureFrame, ensurePreviewWorker])

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
    // effect 体内先取引用：cleanup 运行时 ref.current 可能已被替换（react-hooks 规则）
    const baseCache = baseCacheRef.current
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
      // 切换瞬间可能已有帧在飞：清排队、清快照，并推进 token 让在飞渲染放弃写 state
      cancelScheduledRender()
      snapshotRef.current = null
      dirtyRef.current = false
      lastChangeAtRef.current = 0
      // 换图即弃底图：缓存项持有旧图的大块像素，留着既错又吃内存
      baseCache.clear()
      pendingRef.current += 1
    }
  }, [source, cancelScheduledRender])

  useEffect(() => {
    if (!imageRef.current) return
    renderPreview()
  }, [renderPreview])

  // P2-C7：组件卸载时确保清理排队的帧与尾沿补帧定时器，避免回调访问已卸载组件状态
  useEffect(() => {
    const baseCache = baseCacheRef.current
    // 开发模式 React.StrictMode 会跑「挂载 → 执行清理 → 再挂载」，而 ref 对象跨这两次挂载是同一个。
    // 不在挂载时清掉这个标志，第二次挂载里迟到的握手会被 releaseWorker 留下的 true 判成
    // 「组件已死」而 terminate，预览 worker 于是在 dev 永远接管不上（生产入口 main.tsx 套着 StrictMode）。
    workerDisposedRef.current = false
    return () => {
      cancelScheduledRender()
      baseCache.clear()
      // 退出编辑器即弃 logo 缓存：缓存按路径键控且无失效通知，留着跨会话只会读到陈旧位图
      clearWatermarkLogoCache()
      releaseWorker()
    }
  }, [cancelScheduledRender, releaseWorker])

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
          watermark,
          onWatermarkImageError: handleWatermarkImageError
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
    [mergedParams, watermark, maxPreviewSize, source, handleWatermarkImageError, t]
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
    watermarkError,
    previewUrl,
    originalUrl,
    reset,
    exportDataUrl
  }
}
