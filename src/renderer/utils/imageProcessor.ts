import i18n from '../i18n'
import { InternalError } from '../../shared/errors/app-error'

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
  hsl: Record<HSLColorKey, HSLAdjustment>
): [number, number, number] {
  const [h] = rgbToHsl(r, g, b)
  const hueDeg = h * 360
  let or = r,
    og = g,
    ob = b

  for (const key of hslColorKeys) {
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

export async function processImageData(
  source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
  params: FilterParams,
  options: ProcessOptions = {}
): Promise<ImageData> {
  const canvas = document.createElement('canvas')
  // FIX(预览清晰度)：maxSize 仅接受有限正数。原实现 `options.maxSize || 1600` 会把
  // undefined/0/负数/NaN 静默改成 1600，是预览分辨率被意外降级的隐藏入口；
  // 现在这些值一律视为「不限制」，是否限制由调用方显式决定。
  const requestedMaxSize = options.maxSize
  const maxSize =
    typeof requestedMaxSize === 'number' &&
    Number.isFinite(requestedMaxSize) &&
    requestedMaxSize > 0
      ? requestedMaxSize
      : Number.POSITIVE_INFINITY
  interface SizableSource {
    width: number
    height: number
    videoWidth?: number
    videoHeight?: number
  }

  const src = source as SizableSource
  const naturalWidth = src.width || src.videoWidth || 0
  const naturalHeight = src.height || src.videoHeight || 0
  let width = naturalWidth
  let height = naturalHeight

  if (width > maxSize || height > maxSize) {
    const ratio = Math.min(maxSize / width, maxSize / height)
    width = Math.round(width * ratio)
    height = Math.round(height * ratio)
  }

  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  // P1-C4：移除非空断言，GPU 进程崩溃或硬件加速禁用时 getContext 返回 null
  if (!ctx) throw new InternalError(i18n.t('toast.imageProcessorCanvasFailed'))
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

  let imageData = ctx.getImageData(0, 0, width, height)
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
    ;[r, g, b] = applyTemperature(r, g, b, params.temperature, params.tint)

    // 饱和度
    const avg = (r + g + b) / 3
    r = avg + (r - avg) * saturation
    g = avg + (g - avg) * saturation
    b = avg + (b - avg) * saturation

    // 自然饱和度
    ;[r, g, b] = applyVibrance(r, g, b, params.vibrance)

    // HSL 调整
    ;[r, g, b] = applyHSL(r, g, b, params.hsl)

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
    const newLum = 0.299 * r + 0.587 * g + 0.114 * b
    ;[r, g, b] = applySplitTone(r, g, b, newLum, params)

    // 去雾
    ;[r, g, b] = applyDehaze(r, g, b, params.dehaze)

    data[i] = clamp(r)
    data[i + 1] = clamp(g)
    data[i + 2] = clamp(b)
  }

  // LUT 色彩查找表
  if (params.lut) {
    // builtInLuts 已在顶部静态 import，此处直接使用，避免"既静态又动态 import"阻止拆包
    const lut = builtInLuts.find((l) => l.id === params.lut)
    if (lut) {
      imageData = applyLut3D(imageData, lut)
    }
  }

  // P1-C5：清晰度/锐化/降噪三个卷积操作共享工作缓冲区（ping-pong）
  // 原实现各自 new Uint8ClampedArray(src) + new Uint8ClampedArray(dst)，4096² 峰值 448MB
  // 改为预分配 2 个缓冲区交替使用，峰值降至 192MB（原始 64MB + bufA 64MB + bufB 64MB）
  if (params.clarity !== 0 || params.sharpen !== 0 || params.denoise !== 0) {
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
  if (params.vignette > 0) {
    applyVignette(imageData, params.vignette)
  }

  // 颗粒
  if (params.grain > 0) {
    applyGrain(imageData, params.grain)
  }

  // 褪色
  if (params.fade > 0) {
    applyFade(imageData, params.fade)
  }

  // 水印
  if (options.watermark) {
    imageData = await applyWatermark(imageData, options.watermark, options.onWatermarkImageError)
  }

  return imageData
}

function applyVignette(imageData: ImageData, amount: number): void {
  const { width, height, data } = imageData
  const cx = width / 2
  const cy = height / 2
  const maxDist = Math.sqrt(cx * cx + cy * cy)
  const strength = (amount / 100) * 0.8

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
      const factor = 1 - (dist / maxDist) * strength
      const idx = (y * width + x) * 4
      for (let c = 0; c < 3; c++) {
        data[idx + c] = clamp(data[idx + c] * factor)
      }
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
    img.onerror = () => reject(new Error(i18n.t('toast.imageProcessorLoadFailed', { src })))
    img.src = url
  })
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
  onImageError?: (message: string) => void
): Promise<void> {
  const imgCfg = config.image
  if (!imgCfg?.path) return

  let img: HTMLImageElement
  try {
    img = await loadImage(imgCfg.path)
  } catch (err) {
    // 跳过图片水印、继续合成（文字水印与滤镜结果不受影响），但必须把失败报给调用方：
    // 此前这里是无日志无提示的 `catch { return }`，用户只看到「水印没出来」
    onImageError?.(err instanceof Error ? err.message : String(err))
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
  onWatermarkImageError?: (message: string) => void
): Promise<ImageData> {
  const canvas = document.createElement('canvas')
  canvas.width = imageData.width
  canvas.height = imageData.height
  const ctx = canvas.getContext('2d')
  // P1-C4：移除非空断言，GPU 进程崩溃或硬件加速禁用时 getContext 返回 null
  if (!ctx) throw new InternalError(i18n.t('toast.imageProcessorCanvasFailed'))
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
    await drawImageWatermark(ctx, config, cw, ch, onWatermarkImageError)
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
  if (!ctx) throw new InternalError(i18n.t('toast.imageProcessorCanvasFailed'))
  ctx.putImageData(imageData, 0, 0)
  return canvas.toDataURL(format, quality)
}
