type TranslateFn = (key: string, options?: Record<string, unknown>) => string

/**
 * 译文注入点（与 `shared/errors` 的 setAppErrorTranslator 同一模式）。
 *
 * 为什么不让本模块直接 `import i18n from '../i18n'`：那条链会拖进 react-i18next 与
 * 语言包 JSON，而本模块要被预览 worker 原样 import——worker 里既没有 DOM 也不需要 UI。
 * 未注入时回落为「返回 key 本身」，与 AppError 的默认翻译口径一致。
 */
let translateMessage: TranslateFn = (key) => key

export function setImageProcessorTranslator(fn: TranslateFn): void {
  translateMessage = fn
}
import { FileSystemError, InternalError } from '../../shared/errors/app-error'

export type HSLColorKey =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'yellowGreen'
  | 'green'
  | 'cyan'
  | 'blue'
  | 'purple'
  | 'magenta'
  | 'skin'
  | 'bluePurple'
  | 'warm'

export const hslColorKeys: HSLColorKey[] = [
  'red',
  'orange',
  'yellow',
  'yellowGreen',
  'green',
  'cyan',
  'blue',
  'purple',
  'magenta',
  'skin',
  'bluePurple',
  'warm'
]

export interface HSLAdjustment {
  hue: number
  saturation: number
  lightness: number
}

export interface CurvePoint {
  x: number
  y: number
}

import { applyLut3D, builtInLuts } from './lut'
import { toFileUrl, needsAnonymousCors } from './file'
import { formatWatermarkText } from '../../shared/utils/watermark-text'
// 仅类型 re-export；builtInLuts 需本地绑定（612 行直接使用），改为顶部 import
// （原 `export { builtInLuts, parseCube } from './lut'` 是 re-export 非 import，
// 导致 TS2304 Cannot find name 'builtInLuts'；parseCube 无外部依赖此转发，直接移除）
export type { Lut3D } from './lut'

export interface SplitToning {
  highlightHue: number
  highlightSaturation: number
  shadowHue: number
  shadowSaturation: number
  balance: number
}

export interface WatermarkText {
  content: string
  font: string
  size: number
  color: string
  opacity: number
  bold: boolean
  italic: boolean
  underline: boolean
}

export interface WatermarkImage {
  path: string
  width: number
  height: number
  opacity: number
  blendMode: string
}

export type WatermarkStyle = 'normal' | 'polaroid' | 'date-label' | 'signature' | 'copyright'

export interface WatermarkConfig {
  text?: WatermarkText
  image?: WatermarkImage
  position:
    | 'topLeft'
    | 'topCenter'
    | 'topRight'
    | 'centerLeft'
    | 'center'
    | 'centerRight'
    | 'bottomLeft'
    | 'bottomCenter'
    | 'bottomRight'
    | 'custom'
  customX: number
  customY: number
  rotation: number
  margin: number
  tile: boolean
  tileSpacingX: number
  tileSpacingY: number
  style?: WatermarkStyle
}

export interface FilterParams {
  brightness: number
  contrast: number
  saturation: number
  vibrance: number
  temperature: number
  tint: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  clarity: number
  dehaze: number
  sharpen: number
  denoise: number
  hsl: Record<HSLColorKey, HSLAdjustment>
  curves: { rgb: CurvePoint[]; r: CurvePoint[]; g: CurvePoint[]; b: CurvePoint[] }
  highlightHue: number
  highlightSaturation: number
  shadowHue: number
  shadowSaturation: number
  splitBalance: number
  grain: number
  vignette: number
  fade: number
  lut: string | null
}

export const defaultFilterParams: FilterParams = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  vibrance: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  clarity: 0,
  dehaze: 0,
  sharpen: 0,
  denoise: 0,
  hsl: Object.fromEntries(
    hslColorKeys.map((k) => [k, { hue: 0, saturation: 0, lightness: 0 }])
  ) as Record<HSLColorKey, HSLAdjustment>,
  curves: {
    rgb: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 }
    ],
    r: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 }
    ],
    g: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 }
    ],
    b: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 }
    ]
  },
  highlightHue: 0,
  highlightSaturation: 0,
  shadowHue: 0,
  shadowSaturation: 0,
  splitBalance: 0,
  grain: 0,
  vignette: 0,
  fade: 0,
  lut: null
}

export interface FilterPreset {
  id: string
  name: string
  category: string
  params: Partial<Omit<FilterParams, 'hsl'>> & { hsl?: Partial<Record<HSLColorKey, HSLAdjustment>> }
}

export interface ProcessOptions {
  maxSize?: number
  watermark?: WatermarkConfig | null
  /**
   * 已重采样的底图（见 `buildPreviewBase`）。拖动帧的参数变了、底图没变，
   * 传入即可跳过「高质量重采样 + getImageData」这两步与参数无关的开销。
   * 尺寸与本次目标不符时自动回退完整路径，不会越界读写。
   */
  base?: PreviewBase
  /**
   * 缓存图片水印 logo。预览路径传 true（拖动时每秒可能几十帧，每帧重新经 media://
   * 取图并解码一次 logo 纯属白做）；导出路径不传，保持「每次取最新文件」的既有语义。
   */
  cacheLogo?: boolean
  /**
   * 图片水印的 logo 加载失败时的旁路通知（message 已是用户可读译文）。
   * 刻意不抛错：抛错会被 useImageProcessor 的降级重渲染捕获，导致整张预览消失——
   * 「水印没出来」升级为「图片打不开」。调用方据此提示用户重选图片。
   */
  onWatermarkImageError?: (message: string) => void
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0,
    s = 0
  const l = (max + min) / 2

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6
        break
      case g:
        h = ((b - r) / d + 2) / 6
        break
      case b:
        h = ((r - g) / d + 4) / 6
        break
    }
  }
  return [h, s, l]
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r: number, g: number, b: number
  if (s === 0) {
    r = g = b = l
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1
      if (t > 1) t -= 1
      if (t < 1 / 6) return p + (q - p) * 6 * t
      if (t < 1 / 2) return q
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
      return p
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1 / 3)
  }
  return [r * 255, g * 255, b * 255]
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}

export function buildCurveMap(points: CurvePoint[]): number[] {
  const sorted = [...points].sort((a, b) => a.x - b.x)
  const map = new Array(256)
  for (let i = 0; i < 256; i++) {
    const x = i / 255
    let y = x
    for (let j = 0; j < sorted.length - 1; j++) {
      const p1 = sorted[j]
      const p2 = sorted[j + 1]
      if (x >= p1.x && x <= p2.x) {
        const t = p2.x === p1.x ? 0 : (x - p1.x) / (p2.x - p1.x)
        y = p1.y + (p2.y - p1.y) * t
        break
      }
    }
    map[i] = clamp(y * 255)
  }
  return map
}

export function getHSLTargetHue(key: HSLColorKey): number {
  const map: Record<HSLColorKey, number> = {
    red: 0,
    orange: 30,
    yellow: 60,
    yellowGreen: 90,
    green: 120,
    cyan: 180,
    blue: 240,
    purple: 270,
    magenta: 300,
    skin: 25,
    bluePurple: 255,
    warm: 45
  }
  return map[key]
}

export function applyHSL(
  r: number,
  g: number,
  b: number,
  hsl: Record<HSLColorKey, HSLAdjustment>,
  keys: HSLColorKey[] = hslColorKeys
): [number, number, number] {
  if (keys.length === 0) return [r, g, b]
  const [h] = rgbToHsl(r, g, b)
  const hueDeg = h * 360
  let or = r,
    og = g,
    ob = b

  for (const key of keys) {
    const adj = hsl[key]
    if (adj.hue === 0 && adj.saturation === 0 && adj.lightness === 0) continue
    const target = getHSLTargetHue(key)
    const diff = Math.abs(((hueDeg - target + 540) % 360) - 180)
    const range = key === 'skin' || key === 'warm' ? 40 : 30
    const factor = Math.max(0, 1 - diff / range)
    if (factor <= 0) continue

    let [nh, ns, nl] = rgbToHsl(or, og, ob)
    nh = (nh + (adj.hue / 360) * factor + 1) % 1
    ns = Math.max(0, Math.min(1, ns * (1 + (adj.saturation / 100) * factor)))
    nl = Math.max(0, Math.min(1, nl + (adj.lightness / 100) * factor))
    const [nr, ng, nb] = hslToRgb(nh, ns, nl)
    const blend = factor * 0.7
    or = or * (1 - blend) + nr * blend
    og = og * (1 - blend) + ng * blend
    ob = ob * (1 - blend) + nb * blend
  }

  return [or, og, ob]
}

export function applyTemperature(
  r: number,
  g: number,
  b: number,
  temp: number,
  tint: number
): [number, number, number] {
  const t = temp / 100
  const warmR = r * (1 + t * 0.15)
  const warmB = b * (1 - t * 0.15)
  const tintG = g * (1 + (tint / 100) * 0.1)
  const tintM = b * (1 - (tint / 100) * 0.1)
  return [warmR, tintG, warmB * 0.5 + tintM * 0.5]
}

export function applyVibrance(
  r: number,
  g: number,
  b: number,
  vibrance: number
): [number, number, number] {
  if (vibrance === 0) return [r, g, b]
  const max = Math.max(r, g, b)
  const avg = (r + g + b) / 3
  const amt = ((max - avg) / 255) * 2 * (vibrance / 100)
  const nr = r + (r - avg) * amt
  const ng = g + (g - avg) * amt
  const nb = b + (b - avg) * amt
  return [nr, ng, nb]
}

// P1-C5：三个卷积类函数改为接收预分配的 src/dst 缓冲区，避免各自 new Uint8ClampedArray
// 调用方通过 ping-pong 交替使用两个工作缓冲区，峰值内存从 448MB 降至 192MB（4096² 场景）
function applyClarity(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  w: number,
  h: number,
  clarity: number
): void {
  const amount = (clarity / 100) * 1.5

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4
      for (let c = 0; c < 3; c++) {
        const center = src[idx + c]
        const blur =
          (src[(y - 1) * w * 4 + (x - 1) * 4 + c] +
            src[(y - 1) * w * 4 + x * 4 + c] +
            src[(y - 1) * w * 4 + (x + 1) * 4 + c] +
            src[y * w * 4 + (x - 1) * 4 + c] +
            src[y * w * 4 + (x + 1) * 4 + c] +
            src[(y + 1) * w * 4 + (x - 1) * 4 + c] +
            src[(y + 1) * w * 4 + x * 4 + c] +
            src[(y + 1) * w * 4 + (x + 1) * 4 + c]) /
          8
        dst[idx + c] = clamp(center + (center - blur) * amount)
      }
    }
  }
}

function applySharpen(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  w: number,
  h: number,
  sharpen: number
): void {
  const amount = (sharpen / 100) * 1.2
  const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0]

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4
      for (let c = 0; c < 3; c++) {
        let sum = 0
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const pidx = ((y + ky) * w + (x + kx)) * 4 + c
            sum += src[pidx] * kernel[(ky + 1) * 3 + (kx + 1)]
          }
        }
        const center = src[idx + c]
        dst[idx + c] = clamp(center + (sum - center) * amount)
      }
    }
  }
}

function applyDenoise(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  w: number,
  h: number,
  denoise: number
): void {
  const strength = denoise / 100

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4
      for (let c = 0; c < 3; c++) {
        const center = src[idx + c]
        let sum = 0
        let count = 0
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            if (ky === 0 && kx === 0) continue
            sum += src[((y + ky) * w + (x + kx)) * 4 + c]
            count++
          }
        }
        const avg = sum / count
        dst[idx + c] = clamp(center + (avg - center) * strength * 0.5)
      }
    }
  }
}

export function applyDehaze(
  r: number,
  g: number,
  b: number,
  dehaze: number
): [number, number, number] {
  if (dehaze === 0) return [r, g, b]
  const factor = (dehaze / 100) * 0.5
  const haze = 255 * factor
  return [
    r * (1 - factor) + (r - haze * (1 - r / 255)) * factor,
    g * (1 - factor) + (g - haze * (1 - g / 255)) * factor,
    b * (1 - factor) + (b - haze * (1 - b / 255)) * factor
  ]
}

export function applySplitTone(
  r: number,
  g: number,
  b: number,
  lum: number,
  params: FilterParams
): [number, number, number] {
  if (
    params.highlightHue === 0 &&
    params.highlightSaturation === 0 &&
    params.shadowHue === 0 &&
    params.shadowSaturation === 0
  ) {
    return [r, g, b]
  }
  const balance = (params.splitBalance + 100) / 200
  const shadowWeight = Math.max(0, 1 - lum / 255 - balance + 0.5)
  const highlightWeight = Math.max(0, lum / 255 - (1 - balance) + 0.5)

  const hsl = rgbToHsl(r, g, b)
  let h = hsl[0]
  let s = hsl[1]
  const l = hsl[2]

  if (shadowWeight > 0 && params.shadowSaturation > 0) {
    const targetH = params.shadowHue / 360
    const blend = shadowWeight * (params.shadowSaturation / 100) * 0.6
    h = h * (1 - blend) + targetH * blend
    s = Math.min(1, s + blend * 0.3)
  }

  if (highlightWeight > 0 && params.highlightSaturation > 0) {
    const targetH = params.highlightHue / 360
    const blend = highlightWeight * (params.highlightSaturation / 100) * 0.6
    h = h * (1 - blend) + targetH * blend
    s = Math.min(1, s + blend * 0.3)
  }

  return hslToRgb(h, s, l)
}

/**
 * 用 createImageBitmap 做高质量重采样；环境不支持或失败时返回 null，由调用方回退 drawImage
 */
async function createResampledBitmap(
  source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  width: number,
  height: number
): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== 'function') return null
  try {
    return await createImageBitmap(source as ImageBitmapSource, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high'
    })
  } catch (error) {
    console.warn('[imageProcessor] createImageBitmap resample failed, fallback to drawImage', error)
    return null
  }
}

/**
 * 预览底图：源图按目标尺寸重采样后的裸像素。
 * `data` 由调用方持有并跨帧复用，`processImageData` 取用时先复制再原地加工，不会污染它。
 */
export interface PreviewBase {
  width: number
  height: number
  /** 显式绑定 ArrayBuffer：DOM lib 的 ImageData 构造器不接受 ArrayBufferLike */
  data: Uint8ClampedArray<ArrayBuffer>
}

/** 可带尺寸信息的图源 */
interface SizableSource {
  width: number
  height: number
  videoWidth?: number
  videoHeight?: number
}

/** maxSize 仅接受有限正数；undefined/0/负数/NaN 一律视为「不限制」 */
function normalizeMaxSize(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : Number.POSITIVE_INFINITY
}

/** 目标尺寸：长边超出预算才等比缩小，否则 1:1 */
function computeTargetSize(
  naturalWidth: number,
  naturalHeight: number,
  maxSize: number
): { width: number; height: number } {
  if (naturalWidth <= maxSize && naturalHeight <= maxSize) {
    return { width: naturalWidth, height: naturalHeight }
  }
  const ratio = Math.min(maxSize / naturalWidth, maxSize / naturalHeight)
  return { width: Math.round(naturalWidth * ratio), height: Math.round(naturalHeight * ratio) }
}

/**
 * 创建离屏绘制面。
 *
 * worker 里没有 `document`，只有 `OffscreenCanvas`；主线程与 jsdom（无 OffscreenCanvas 实现）
 * 继续用 HTMLCanvasElement。二者 2D 上下文成员一致，但 TS 类型不同，故在取值处做一次
 * 集中转型，避免每个绘制点都写联合类型。
 */
function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height)
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function get2dContext(
  canvas: HTMLCanvasElement | OffscreenCanvas
): CanvasRenderingContext2D | null {
  return canvas.getContext('2d') as CanvasRenderingContext2D | null
}

/** 把图源重采样到目标尺寸并回读为 ImageData */
async function rasterizeToTarget(
  source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  maxSize: number
): Promise<ImageData> {
  const src = source as SizableSource
  const naturalWidth = src.width || src.videoWidth || 0
  const naturalHeight = src.height || src.videoHeight || 0
  const { width, height } = computeTargetSize(naturalWidth, naturalHeight, maxSize)

  const canvas = createCanvas(width, height)
  const ctx = get2dContext(canvas)
  // P1-C4：移除非空断言，GPU 进程崩溃或硬件加速禁用时 getContext 返回 null
  if (!ctx) throw new InternalError(translateMessage('toast.imageProcessorCanvasFailed'))
  // FIX(预览清晰度)：开启高质量重采样。此前未设置任何平滑参数，浏览器默认低质量
  // 滤波在大比例缩小时会明显软化并产生锯齿。
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  if (width !== naturalWidth || height !== naturalHeight) {
    // 需要重采样：优先 createImageBitmap 的高质量缩放（Chromium 内置实现，可脱离主线程）；
    // 环境不支持或失败时回退 drawImage（已开启 imageSmoothingQuality=high）
    const bitmap = await createResampledBitmap(source, width, height)
    if (bitmap) {
      try {
        ctx.drawImage(bitmap, 0, 0)
      } finally {
        bitmap.close?.()
      }
    } else {
      ctx.drawImage(source, 0, 0, width, height)
    }
  } else {
    // 1:1 直绘：不传目标宽高，完全跳过重采样，保证与原图逐像素一致
    ctx.drawImage(source, 0, 0)
  }

  return ctx.getImageData(0, 0, width, height)
}

/**
 * 产出一份可跨帧复用的预览底图。
 *
 * 拖动滑块时只有调节参数在变、重采样结果不变：底图建一次，之后每帧只剩纯像素运算。
 */
export async function buildPreviewBase(
  source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  maxSize: number = Number.POSITIVE_INFINITY
): Promise<PreviewBase> {
  const imageData = await rasterizeToTarget(source, normalizeMaxSize(maxSize))
  return { width: imageData.width, height: imageData.height, data: imageData.data }
}

/** 单个数值调节是否「动了」：非 0 且非 NaN；缺字段/非数值一律视为未动 */
function isAdjusted(value: unknown): boolean {
  return typeof value === 'number' && !Number.isNaN(value) && value !== 0
}

/**
 * 像素循环的 pass 激活表：把「哪些调节真的非零」提到逐像素循环之外只算一次。
 *
 * 拖动时通常只有一两个参数在变，而未激活的 pass 也要为每个像素分配一个元组数组；
 * 有了这张表就能整段跳过。判定口径与各 pass 自身的早退条件逐字对齐
 * （例如分离色调只看四个 hue/saturation，不看 balance），等价性由
 * imageProcessor.pixels.test.ts 的逐像素校验和守住。
 */
export interface PreviewPassPlan {
  temperature: boolean
  vibrance: boolean
  hsl: boolean
  activeHslKeys: HSLColorKey[]
  splitTone: boolean
  dehaze: boolean
  convolution: boolean
  vignette: boolean
  grain: boolean
  fade: boolean
  lut: boolean
}

export function planPasses(params: FilterParams): PreviewPassPlan {
  const activeHslKeys = hslColorKeys.filter((key) => {
    const adj = params.hsl?.[key]
    if (!adj) return false
    return isAdjusted(adj.hue) || isAdjusted(adj.saturation) || isAdjusted(adj.lightness)
  })

  return {
    temperature: isAdjusted(params.temperature) || isAdjusted(params.tint),
    vibrance: isAdjusted(params.vibrance),
    hsl: activeHslKeys.length > 0,
    activeHslKeys,
    // 与 applySplitTone 的早退条件逐字一致：只有 splitBalance 非零不算激活
    splitTone:
      isAdjusted(params.highlightHue) ||
      isAdjusted(params.highlightSaturation) ||
      isAdjusted(params.shadowHue) ||
      isAdjusted(params.shadowSaturation),
    dehaze: isAdjusted(params.dehaze),
    convolution:
      isAdjusted(params.clarity) || isAdjusted(params.sharpen) || isAdjusted(params.denoise),
    vignette: params.vignette > 0,
    grain: params.grain > 0,
    fade: params.fade > 0,
    lut: !!params.lut
  }
}

export async function processImageData(
  source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  params: FilterParams,
  options: ProcessOptions = {}
): Promise<ImageData> {
  // FIX(预览清晰度)：maxSize 仅接受有限正数。原实现 `options.maxSize || 1600` 会把
  // undefined/0/负数/NaN 静默改成 1600，是预览分辨率被意外降级的隐藏入口；
  // 现在这些值一律视为「不限制」，是否限制由调用方显式决定。
  const maxSize = normalizeMaxSize(options.maxSize)
  const src = source as SizableSource
  const naturalWidth = src.width || src.videoWidth || 0
  const naturalHeight = src.height || src.videoHeight || 0
  const target = computeTargetSize(naturalWidth, naturalHeight, maxSize)
  const base = options.base

  // FIX(实时预览)：拖动帧只有参数在变，底图不变。命中底图时跳过重采样与回读；
  // 尺寸不符（换图、换档位、缓存陈旧）则回退完整光栅化路径，绝不越界读写。
  // ImageData 构造器按规范会复制传入数组，因此下面的原地循环不会污染底图本体。
  const imageData =
    base && base.width === target.width && base.height === target.height
      ? new ImageData(base.data, base.width, base.height)
      : await rasterizeToTarget(source, maxSize)

  return applyImagePasses(imageData, params, options)
}

/**
 * 从已就绪的像素起跑完整调色链：主循环 → LUT → 卷积 → 暗角/颗粒/褪色 → 水印。
 *
 * 从 `processImageData` 拆出来，是为了让 worker 能直接从底图进入这一步——
 * 它手上只有像素，没有也拿不到 DOM 图源。
 */
export async function applyImagePasses(
  imageData: ImageData,
  params: FilterParams,
  options: ProcessOptions = {}
): Promise<ImageData> {
  const plan = planPasses(params)
  const data = imageData.data

  const rgbCurve = buildCurveMap(params.curves.rgb)
  const rCurve = buildCurveMap(params.curves.r)
  const gCurve = buildCurveMap(params.curves.g)
  const bCurve = buildCurveMap(params.curves.b)

  const brightness = (params.brightness / 100) * 80
  const contrast = (params.contrast + 100) / 100
  const saturation = (params.saturation + 100) / 100
  const highlights = params.highlights / 100
  const shadows = params.shadows / 100
  const whites = (params.whites / 100) * 80
  const blacks = (params.blacks / 100) * 80

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i]
    let g = data[i + 1]
    let b = data[i + 2]

    // 亮度/对比度
    r = (r - 128) * contrast + 128 + brightness
    g = (g - 128) * contrast + 128 + brightness
    b = (b - 128) * contrast + 128 + brightness

    // 高光/阴影
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    if (lum > 128) {
      const f = (lum - 128) / 128
      r += highlights * f * 60
      g += highlights * f * 60
      b += highlights * f * 60
    } else {
      const f = (128 - lum) / 128
      r += shadows * f * 60
      g += shadows * f * 60
      b += shadows * f * 60
    }

    // 白色/黑色色阶
    r += whites - blacks
    g += whites - blacks
    b += whites - blacks

    // 色温/色调
    if (plan.temperature) {
      const mixed = applyTemperature(r, g, b, params.temperature, params.tint)
      r = mixed[0]
      g = mixed[1]
      b = mixed[2]
    }

    // 饱和度
    const avg = (r + g + b) / 3
    r = avg + (r - avg) * saturation
    g = avg + (g - avg) * saturation
    b = avg + (b - avg) * saturation

    // 自然饱和度
    if (plan.vibrance) {
      const vib = applyVibrance(r, g, b, params.vibrance)
      r = vib[0]
      g = vib[1]
      b = vib[2]
    }

    // HSL 调整（只遍历非零的键）
    if (plan.hsl) {
      const adj = applyHSL(r, g, b, params.hsl, plan.activeHslKeys)
      r = adj[0]
      g = adj[1]
      b = adj[2]
    }

    // 曲线
    r = rCurve[clamp(r)]
    g = gCurve[clamp(g)]
    b = bCurve[clamp(b)]
    const l = 0.299 * r + 0.587 * g + 0.114 * b
    const rgbL = rgbCurve[clamp(l)]
    const factor = rgbL / (l || 1)
    r *= factor
    g *= factor
    b *= factor

    // 色调分离
    if (plan.splitTone) {
      const newLum = 0.299 * r + 0.587 * g + 0.114 * b
      const toned = applySplitTone(r, g, b, newLum, params)
      r = toned[0]
      g = toned[1]
      b = toned[2]
    }

    // 去雾
    if (plan.dehaze) {
      const clear = applyDehaze(r, g, b, params.dehaze)
      r = clear[0]
      g = clear[1]
      b = clear[2]
    }

    data[i] = clamp(r)
    data[i + 1] = clamp(g)
    data[i + 2] = clamp(b)
  }

  // LUT 色彩查找表
  if (plan.lut) {
    // builtInLuts 已在顶部静态 import，此处直接使用，避免"既静态又动态 import"阻止拆包
    const lut = builtInLuts.find((l) => l.id === params.lut)
    if (lut) {
      imageData = applyLut3D(imageData, lut)
    }
  }

  // P1-C5：清晰度/锐化/降噪三个卷积操作共享工作缓冲区（ping-pong）
  // 原实现各自 new Uint8ClampedArray(src) + new Uint8ClampedArray(dst)，4096² 峰值 448MB
  // 改为预分配 2 个缓冲区交替使用，峰值降至 192MB（原始 64MB + bufA 64MB + bufB 64MB）
  if (plan.convolution) {
    const w = imageData.width
    const h = imageData.height
    const bufA = new Uint8ClampedArray(imageData.data)
    const bufB = new Uint8ClampedArray(imageData.data)
    let src = bufA
    let dst = bufB

    if (params.clarity !== 0) {
      applyClarity(src, dst, w, h, params.clarity)
      ;[src, dst] = [dst, src]
    }
    if (params.sharpen !== 0) {
      applySharpen(src, dst, w, h, params.sharpen)
      ;[src, dst] = [dst, src]
    }
    if (params.denoise !== 0) {
      applyDenoise(src, dst, w, h, params.denoise)
      ;[src, dst] = [dst, src]
    }
    // 最终结果在 src 中（最后一次写入 dst 后交换，src 指向结果）
    imageData = new ImageData(src, w, h)
  }

  // 暗角
  if (plan.vignette) {
    applyVignette(imageData, params.vignette)
  }

  // 颗粒
  if (plan.grain) {
    applyGrain(imageData, params.grain)
  }

  // 褪色
  if (plan.fade) {
    applyFade(imageData, params.fade)
  }

  // 水印
  if (options.watermark) {
    imageData = await applyWatermark(imageData, options.watermark, options)
  }

  return imageData
}

/**
 * 供预览 worker 使用：从底图直接产出成品像素，不触碰 DOM 图源。
 * `processImageData` 命中底图分支后等价于它。
 */
export async function processPreviewBase(
  base: PreviewBase,
  params: FilterParams,
  options: ProcessOptions = {}
): Promise<ImageData> {
  return applyImagePasses(new ImageData(base.data, base.width, base.height), params, options)
}

/**
 * 像素 → JPEG/PNG/WebP Blob。
 *
 * 与 `imageToDataUrl` 的分工：后者用同步 `toDataURL`，只有主线程能用（导出路径保留它，
 * 因为 IPC 契约要 dataURL）；本函数用异步 `convertToBlob`/`toBlob`，让编码离开主线程，
 * 调用方再自行决定是否转成 dataURL。
 */
export async function imageDataToBlob(
  imageData: ImageData,
  format: 'image/jpeg' | 'image/png' | 'image/webp' = 'image/jpeg',
  quality = 0.95
): Promise<Blob> {
  const canvas = createCanvas(imageData.width, imageData.height)
  const ctx = get2dContext(canvas)
  if (!ctx) throw new InternalError(translateMessage('toast.imageProcessorCanvasFailed'))
  ctx.putImageData(imageData, 0, 0)
  // 必须先 typeof 再 instanceof：全局不存在 OffscreenCanvas 时（jsdom/node），
  // 直接 `canvas instanceof OffscreenCanvas` 会抛 ReferenceError 而不是返回 false
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: format, quality })
  }
  // 全局没有 OffscreenCanvas 时上面的 instanceof 不可判定，TS 也排除不掉该分支，
  // 这里按 DOM 画布显式收口（运行时只会走到 HTMLCanvasElement）
  const domCanvas = canvas as HTMLCanvasElement
  return new Promise<Blob>((resolve, reject) => {
    domCanvas.toBlob(
      (blob: Blob | null) =>
        blob ? resolve(blob) : reject(new InternalError('preview encode produced null blob')),
      format,
      quality
    )
  })
}

function applyVignette(imageData: ImageData, amount: number): void {
  const { width, height, data } = imageData
  const cx = width / 2
  const cy = height / 2
  const maxDist = Math.sqrt(cx * cx + cy * cy)
  const strength = (amount / 100) * 0.8

  // 逐列预存 (x-cx)²（逐行预存 (y-cy)²）：原本每像素要算两次幂运算，
  // 而 a**2 与 a*a 在 V8 里结果逐位相同，故只省算力不改输出。
  const dxSquared = new Float64Array(width)
  for (let x = 0; x < width; x++) {
    const dx = x - cx
    dxSquared[x] = dx * dx
  }

  for (let y = 0; y < height; y++) {
    const dy = y - cy
    const dySquared = dy * dy
    const rowOffset = y * width * 4
    for (let x = 0; x < width; x++) {
      const dist = Math.sqrt(dxSquared[x] + dySquared)
      const factor = 1 - (dist / maxDist) * strength
      const idx = rowOffset + x * 4
      data[idx] = clamp(data[idx] * factor)
      data[idx + 1] = clamp(data[idx + 1] * factor)
      data[idx + 2] = clamp(data[idx + 2] * factor)
    }
  }
}

function applyGrain(imageData: ImageData, amount: number): void {
  const { data } = imageData
  const strength = (amount / 100) * 30
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * strength
    for (let c = 0; c < 3; c++) {
      data[i + c] = clamp(data[i + c] + noise)
    }
  }
}

function applyFade(imageData: ImageData, amount: number): void {
  const { data } = imageData
  const strength = amount / 100
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      data[i + c] = clamp(data[i + c] * (1 - strength * 0.4) + 255 * strength * 0.25)
    }
  }
}

export function getWatermarkPosition(
  position: WatermarkConfig['position'],
  cw: number,
  ch: number,
  ww: number,
  wh: number,
  margin: number,
  customX: number,
  customY: number
): { x: number; y: number } {
  switch (position) {
    case 'topLeft':
      return { x: margin, y: margin }
    case 'topCenter':
      return { x: (cw - ww) / 2, y: margin }
    case 'topRight':
      return { x: cw - ww - margin, y: margin }
    case 'centerLeft':
      return { x: margin, y: (ch - wh) / 2 }
    case 'center':
      return { x: (cw - ww) / 2, y: (ch - wh) / 2 }
    case 'centerRight':
      return { x: cw - ww - margin, y: (ch - wh) / 2 }
    case 'bottomLeft':
      return { x: margin, y: ch - wh - margin }
    case 'bottomCenter':
      return { x: (cw - ww) / 2, y: ch - wh - margin }
    case 'bottomRight':
      return { x: cw - ww - margin, y: ch - wh - margin }
    case 'custom':
      return { x: customX, y: customY }
    default:
      return { x: cw - ww - margin, y: ch - wh - margin }
  }
}

function toMediaUrl(filePath: string): string {
  return toFileUrl(filePath) || ''
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = toMediaUrl(src)
    // media:// 注册为 standard scheme 具有独立 origin，绘制进 canvas 前需以 anonymous CORS 模式加载
    if (needsAnonymousCors(url)) {
      img.crossOrigin = 'anonymous'
    }
    img.onload = () => resolve(img)
    img.onerror = () =>
      reject(new FileSystemError(translateMessage('toast.imageProcessorLoadFailed', { src })))
    img.src = url
  })
}

/** 预览 logo 缓存条目上限：一次编辑会话通常只用一两个 logo，留一点余量即可 */
const LOGO_CACHE_MAX_ENTRIES = 4
const watermarkLogoCache = new Map<string, Promise<HTMLImageElement>>()

/**
 * 预览专用的 logo 加载：缓存**成功**结果并按 LRU 限量。
 *
 * 失败刻意不入缓存——否则 2026-10-17 刚修好的「图片水印加载失败必须可见」会退化成
 * 永久静默：后续帧命中失败缓存，连 onWatermarkImageError 都不会再触发。
 * 缓存 Promise 而非图片本身，顺带把并发帧的重复请求也合并掉。
 */
async function loadWatermarkLogo(path: string): Promise<HTMLImageElement> {
  const cached = watermarkLogoCache.get(path)
  if (cached) return cached

  const pending = loadImage(path)
  watermarkLogoCache.set(path, pending)
  pending.catch(() => {
    if (watermarkLogoCache.get(path) === pending) watermarkLogoCache.delete(path)
  })
  while (watermarkLogoCache.size > LOGO_CACHE_MAX_ENTRIES) {
    const oldest = watermarkLogoCache.keys().next().value
    if (oldest === undefined) break
    watermarkLogoCache.delete(oldest)
  }
  return pending
}

/** 清空 logo 缓存：切换源图时由调用方触发，避免跨图片残留 */
export function clearWatermarkLogoCache(): void {
  watermarkLogoCache.clear()
}

/**
 * `{date}`/`{time}` 展开——实现已抽到 shared（主进程批量导出共用同一份，避免漂移），
 * 此处仅按原对外名再导出，`imageProcessor.test.ts` 的既有用例即为「迁移无损」证据。
 */
export { formatWatermarkText }

function drawTextWatermark(
  ctx: CanvasRenderingContext2D,
  config: WatermarkConfig,
  cw: number,
  ch: number
): void {
  const text = config.text
  if (!text?.content) return

  const displayContent = formatWatermarkText(text.content)

  const fontStyle = `${text.italic ? 'italic' : ''} ${text.bold ? 'bold' : 'normal'} ${text.size}px ${text.font || 'sans-serif'}`
  ctx.font = fontStyle.trim()
  ctx.fillStyle = text.color
  ctx.textBaseline = 'top'

  const metrics = ctx.measureText(displayContent)
  const ww = metrics.width
  const wh = text.size * 1.2
  const pos = getWatermarkPosition(
    config.position,
    cw,
    ch,
    ww,
    wh,
    config.margin,
    config.customX,
    config.customY
  )

  const drawOne = (x: number, y: number) => {
    ctx.save()
    ctx.translate(x + ww / 2, y + wh / 2)
    ctx.rotate((config.rotation * Math.PI) / 180)
    if (config.style === 'date-label') {
      const pad = text.size * 0.3
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.beginPath()
      ctx.roundRect(-ww / 2 - pad, -wh / 2 - pad * 0.5, ww + pad * 2, wh + pad, text.size * 0.25)
      ctx.fill()
      ctx.fillStyle = text.color
    }
    ctx.fillText(displayContent, -ww / 2, -wh / 2 + text.size * 0.1)
    if (text.underline && config.style !== 'date-label') {
      ctx.fillRect(-ww / 2, text.size * 0.6, ww, Math.max(1, text.size / 12))
    }
    ctx.restore()
  }

  if (config.tile) {
    for (let y = pos.y % config.tileSpacingY; y < ch; y += config.tileSpacingY) {
      for (let x = pos.x % config.tileSpacingX; x < cw; x += config.tileSpacingX) {
        drawOne(x, y)
      }
    }
  } else {
    drawOne(pos.x, pos.y)
  }
}

async function drawImageWatermark(
  ctx: CanvasRenderingContext2D,
  config: WatermarkConfig,
  cw: number,
  ch: number,
  options: ProcessOptions
): Promise<void> {
  const imgCfg = config.image
  if (!imgCfg?.path) return

  // 带图片水印的帧不进 worker（logo 只能由主线程经 media:// 取），因此这里只有主线程一种形态
  let img: HTMLImageElement
  try {
    img = await (options.cacheLogo ? loadWatermarkLogo(imgCfg.path) : loadImage(imgCfg.path))
  } catch (err) {
    // 跳过图片水印、继续合成（文字水印与滤镜结果不受影响），但必须把失败报给调用方：
    // 此前这里是无日志无提示的 `catch { return }`，用户只看到「水印没出来」
    options.onWatermarkImageError?.(err instanceof Error ? err.message : String(err))
    return
  }

  const ww = imgCfg.width || img.width || 120
  const wh = imgCfg.height || img.height || 120
  const pos = getWatermarkPosition(
    config.position,
    cw,
    ch,
    ww,
    wh,
    config.margin,
    config.customX,
    config.customY
  )

  const blendMap: Record<string, GlobalCompositeOperation> = {
    normal: 'source-over',
    multiply: 'multiply',
    screen: 'screen',
    overlay: 'overlay',
    'soft-light': 'soft-light'
  }

  const drawOne = (x: number, y: number) => {
    ctx.save()
    ctx.globalAlpha = (imgCfg.opacity ?? 80) / 100
    ctx.globalCompositeOperation = blendMap[imgCfg.blendMode] || 'source-over'
    ctx.translate(x + ww / 2, y + wh / 2)
    ctx.rotate((config.rotation * Math.PI) / 180)
    ctx.drawImage(img, -ww / 2, -wh / 2, ww, wh)
    ctx.restore()
  }

  if (config.tile) {
    for (let y = pos.y % config.tileSpacingY; y < ch; y += config.tileSpacingY) {
      for (let x = pos.x % config.tileSpacingX; x < cw; x += config.tileSpacingX) {
        drawOne(x, y)
      }
    }
  } else {
    drawOne(pos.x, pos.y)
  }
}

async function applyWatermark(
  imageData: ImageData,
  config: WatermarkConfig,
  options: ProcessOptions
): Promise<ImageData> {
  const canvas = createCanvas(imageData.width, imageData.height)
  const ctx = get2dContext(canvas)
  // P1-C4：移除非空断言，GPU 进程崩溃或硬件加速禁用时 getContext 返回 null
  if (!ctx) throw new InternalError(translateMessage('toast.imageProcessorCanvasFailed'))
  ctx.putImageData(imageData, 0, 0)

  const cw = imageData.width
  const ch = imageData.height

  if (config.style === 'polaroid') {
    drawPolaroidFrame(ctx, config, cw, ch)
  }

  // polaroid 的标签已由 drawPolaroidFrame 画在白带内，这里必须跳过，
  // 否则按 position 再叠一份（预设是 bottomCenter + margin:0 → 两串字重叠在框内），
  // 且与批量导出的 SVG 单次绘制口径不一致
  if (config.text?.content && config.style !== 'polaroid') {
    ctx.save()
    ctx.globalAlpha = (config.text.opacity ?? 80) / 100
    drawTextWatermark(ctx, config, cw, ch)
    ctx.restore()
  }

  if (config.image?.path) {
    await drawImageWatermark(ctx, config, cw, ch, options)
  }

  return ctx.getImageData(0, 0, cw, ch)
}

function drawPolaroidFrame(
  ctx: CanvasRenderingContext2D,
  config: WatermarkConfig,
  cw: number,
  ch: number
): void {
  const frameColor = '#ffffff'
  const frameRatio = 0.16
  const frameHeight = Math.max(1, Math.round(ch * frameRatio))
  ctx.save()
  ctx.fillStyle = frameColor
  ctx.fillRect(0, ch - frameHeight, cw, frameHeight)
  if (config.text?.content) {
    ctx.fillStyle = config.text.color || '#333333'
    ctx.font = `${config.text.italic ? 'italic' : ''} ${config.text.bold ? 'bold' : 'normal'} ${Math.min(config.text.size, frameHeight * 0.4)}px ${config.text.font || 'sans-serif'}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.globalAlpha = (config.text.opacity ?? 80) / 100
    // 与 drawTextWatermark 同口径展开占位符——修复前这里画的是未展开的原始 content，
    // 于是 date-label 之外的 polaroid 框里会露出字面量 `{date}`
    ctx.fillText(formatWatermarkText(config.text.content), cw / 2, ch - frameHeight / 2)
  }
  ctx.restore()
}

export async function imageToDataUrl(
  imageData: ImageData,
  format: 'image/jpeg' | 'image/png' | 'image/webp' = 'image/jpeg',
  quality = 0.95
): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = imageData.width
  canvas.height = imageData.height
  const ctx = canvas.getContext('2d')
  // P1-C4：移除非空断言，GPU 进程崩溃或硬件加速禁用时 getContext 返回 null
  if (!ctx) throw new InternalError(translateMessage('toast.imageProcessorCanvasFailed'))
  ctx.putImageData(imageData, 0, 0)
  return canvas.toDataURL(format, quality)
}
