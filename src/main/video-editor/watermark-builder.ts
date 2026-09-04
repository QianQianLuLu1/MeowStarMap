/**
 * 视频水印滤镜构建器
 *
 * 把图片编辑器 WatermarkConfig 映射为 ffmpeg 滤镜串。
 * - 文本水印 → drawtext（位置支持 9 宫格 + custom）
 * - 图片水印 → overlay（带额外 -i 输入流，支持 opacity / 平铺 / 旋转）
 *
 * 详见 docs/VIDEO_EDIT_PLAN.md §5。
 *
 * 设计：纯函数、无 electron 依赖，便于单测。
 * 当 watermark 为 null/undefined 或文本与图片均缺失时返回空 filter。
 */
import type { WatermarkConfig, WatermarkText } from '../../shared/types/watermark'

export interface WatermarkFilterGraph {
  /** 滤镜串：调用方按 useFilterComplex 决定走 -vf 还是 -filter_complex */
  filter: string
  /** 额外输入文件列表（图片水印的 -i 参数，按顺序追加） */
  inputs: string[]
  /** true=使用 -filter_complex（图片水印存在时）；false=使用 -vf（仅文本水印时） */
  useFilterComplex: boolean
}

/** 9 宫格位置枚举（与 WatermarkConfig.position 一致） */
type GridPosition =
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

/**
 * 计算 drawtext 的 x 表达式（基于 9 宫格 + margin / custom）。
 * drawtext 内置变量：w=视频宽，text_w=文本宽。
 */
function calcDrawtextX(position: GridPosition, margin: number, customX: number): string {
  switch (position) {
    case 'topLeft':
    case 'centerLeft':
    case 'bottomLeft':
      return String(margin)
    case 'topCenter':
    case 'center':
    case 'bottomCenter':
      return `(w-text_w)/2`
    case 'topRight':
    case 'centerRight':
    case 'bottomRight':
      return `w-text_w-${margin}`
    case 'custom':
      return String(customX)
    default:
      return String(margin)
  }
}

/**
 * 计算 drawtext 的 y 表达式。drawtext 内置变量：h=视频高，text_h=文本高。
 */
function calcDrawtextY(position: GridPosition, margin: number, customY: number): string {
  switch (position) {
    case 'topLeft':
    case 'topCenter':
    case 'topRight':
      return String(margin)
    case 'centerLeft':
    case 'center':
    case 'centerRight':
      return `(h-text_h)/2`
    case 'bottomLeft':
    case 'bottomCenter':
    case 'bottomRight':
      return `h-text_h-${margin}`
    case 'custom':
      return String(customY)
    default:
      return String(margin)
  }
}

/**
 * 计算 overlay 滤镜的 x 表达式（图片水印）。
 * overlay 内置变量：W=主视频宽，w=水印宽。
 */
function calcOverlayX(position: GridPosition, margin: number, customX: number): string {
  switch (position) {
    case 'topLeft':
    case 'centerLeft':
    case 'bottomLeft':
      return String(margin)
    case 'topCenter':
    case 'center':
    case 'bottomCenter':
      return `(W-w)/2`
    case 'topRight':
    case 'centerRight':
    case 'bottomRight':
      return `W-w-${margin}`
    case 'custom':
      return String(customX)
    default:
      return String(margin)
  }
}

/**
 * 计算 overlay 滤镜的 y 表达式。
 * overlay 内置变量：H=主视频高，h=水印高。
 */
function calcOverlayY(position: GridPosition, margin: number, customY: number): string {
  switch (position) {
    case 'topLeft':
    case 'topCenter':
    case 'topRight':
      return String(margin)
    case 'centerLeft':
    case 'center':
    case 'centerRight':
      return `(H-h)/2`
    case 'bottomLeft':
    case 'bottomCenter':
    case 'bottomRight':
      return `H-h-${margin}`
    case 'custom':
      return String(customY)
    default:
      return String(margin)
  }
}

/**
 * 转义 drawtext text 内容的特殊字符：
 * - ffmpeg drawtext 使用 ':' 分隔参数，需要转义
 * - '\' 是转义字符本身
 * - '%' 用于 expansion（如 %{n}），需转义
 * - '\'' 包裹文本时单引号需特殊处理
 *
 * 采用 escape_text 模式：用单引号包裹整体，单引号本身用 '\''\'' 拼接（关闭-转义-重开）。
 */
function escapeDrawtextText(text: string): string {
  if (text.length === 0) return "''"
  // 单引号转义：' -> '\'' (close quote, escaped quote, reopen quote)
  const escapedSingle = text.replace(/'/g, "'\\''")
  // 在单引号内，反斜杠和冒号无需额外转义（drawtext 解析时单引号内为字面量）
  return `'${escapedSingle}'`
}

/**
 * 把颜色 #RRGGBB + opacity(0-1) 转换为 ffmpeg drawtext fontcolor 期望的 0xRRGGBBAA 格式。
 * 支持 #RGB / #RRGGBB / #RRGGBBAA 输入。
 */
function colorWithAlpha(color: string, opacity: number): string {
  let hex = color.replace(/^#/, '').toLowerCase()
  // #RGB 扩展为 #RRGGBB
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('')
  }
  // 输入已带 alpha → 直接使用
  if (hex.length === 8) {
    return `0x${hex}`
  }
  if (hex.length !== 6) {
    // 无法识别的颜色，回退白字
    hex = 'ffffff'
  }
  // opacity 0-1 → alpha 00-FF
  const clamped = Math.max(0, Math.min(1, opacity))
  const alpha = Math.round(clamped * 255)
    .toString(16)
    .padStart(2, '0')
  return `0x${hex}${alpha}`
}

/**
 * 构造 drawtext 滤镜段（不含外层括号）。
 * 返回空串表示文本水印无效（content 为空）。
 */
function buildDrawtextFilter(text: WatermarkText, config: WatermarkConfig): string {
  if (!text.content || text.content.length === 0) return ''
  if (!text.size || text.size <= 0) return ''

  const parts: string[] = []
  parts.push(`text=${escapeDrawtextText(text.content)}`)
  // 字体优先用 fontfile（绝对路径），否则用 font 名称
  if (text.font) {
    if (/^[A-Za-z]:[\\/]/.test(text.font) || text.font.startsWith('/')) {
      parts.push(`fontfile='${text.font.replace(/'/g, "'\\''")}'`)
    } else {
      parts.push(`font='${text.font.replace(/'/g, "'\\''")}'`)
    }
  }
  parts.push(`fontsize=${Math.round(text.size)}`)
  parts.push(`fontcolor=${colorWithAlpha(text.color, text.opacity)}`)
  parts.push(`x=${calcDrawtextX(config.position, config.margin, config.customX)}`)
  parts.push(`y=${calcDrawtextY(config.position, config.margin, config.customY)}`)

  return `drawtext=${parts.join(':')}`
}

/**
 * 构造图片水印的 filter_complex 段。
 *
 * 流程：
 *   [1:v] scale=w:h, format=rgba, colorchannelmixer=aa=opacity, [rotate?] [wm]
 *   平铺模式：[wm] tile=... [tiled]
 *   [0:v][wm/tiled] overlay=x:y [, drawtext=...]
 *
 * @param config 水印配置
 * @param drawtextFilter 文本水印 drawtext 滤镜段（无则空串），追加到 overlay 输出后
 * @returns { filterComplex, inputs } filterComplex 不带 -filter_complex 前缀
 */
function buildImageFilter(
  config: WatermarkConfig,
  drawtextFilter: string
): { filterComplex: string; inputs: string[] } {
  const img = config.image!
  const inputs: string[] = [img.path]

  // 水印流预处理：缩放 + 转rgba + 透明度
  const wmChain: string[] = ['[1:v]']
  if (img.width > 0 && img.height > 0) {
    wmChain.push(`scale=${Math.round(img.width)}:${Math.round(img.height)}`)
  }
  wmChain.push('format=rgba')
  if (img.opacity < 1) {
    const aa = Math.max(0, Math.min(1, img.opacity))
    wmChain.push(`colorchannelmixer=aa=${aa.toFixed(4)}`)
  }
  // 旋转（非 0 时应用）
  if (config.rotation !== 0) {
    const rad = (config.rotation * Math.PI) / 180
    wmChain.push(`rotate=${rad.toFixed(6)}:fillcolor=0x00000000:ow=rotw(iw,ih):oh=roth(iw,ih)`)
  }

  // 平铺模式：tile 滤镜生成铺底水印图后 overlay 到 0:0
  if (config.tile) {
    const tw = Math.round(img.width + config.tileSpacingX)
    const th = Math.round(img.height + config.tileSpacingY)
    wmChain.push(`tile=${tw}:${th}`)
    const tiledChain = `${wmChain.join('')}[wm];[0:v][wm]overlay=0:0`
    const filter = drawtextFilter ? `${tiledChain},${drawtextFilter}` : tiledChain
    return { filterComplex: filter, inputs }
  }

  // 非平铺：常规 overlay 到指定 9 宫格位置
  wmChain.push('[wm]')
  const x = calcOverlayX(config.position, config.margin, config.customX)
  const y = calcOverlayY(config.position, config.margin, config.customY)
  let overlay = `${wmChain.join('')};[0:v][wm]overlay=${x}:${y}`
  if (drawtextFilter) {
    overlay += `,${drawtextFilter}`
  }
  return { filterComplex: overlay, inputs }
}

/**
 * 构建水印 filterGraph 主入口。
 *
 * 行为：
 * - config 为空 → 空 filter，空 inputs，useFilterComplex=false
 * - 仅文本水印 → filter=drawtext=...，useFilterComplex=false（走 -vf）
 * - 仅图片或文本+图片 → filter=[1:v]...overlay=...，useFilterComplex=true（走 -filter_complex）
 * - 文本水印 content 为空 → 跳过文本
 * - 图片水印 path 为空 → 跳过图片
 */
export function buildWatermarkFilter(
  config: WatermarkConfig | null | undefined
): WatermarkFilterGraph {
  if (!config) {
    return { filter: '', inputs: [], useFilterComplex: false }
  }

  const hasText = !!(config.text && config.text.content && config.text.content.length > 0)
  const hasImage = !!(config.image && config.image.path && config.image.path.length > 0)

  if (!hasText && !hasImage) {
    return { filter: '', inputs: [], useFilterComplex: false }
  }

  const drawtextFilter = hasText ? buildDrawtextFilter(config.text!, config) : ''

  // 仅文本水印
  if (hasText && !hasImage) {
    return {
      filter: drawtextFilter,
      inputs: [],
      useFilterComplex: false
    }
  }

  // 图片水印（带或不带文本）
  if (hasImage) {
    const { filterComplex, inputs } = buildImageFilter(config, drawtextFilter)
    return {
      filter: filterComplex,
      inputs,
      useFilterComplex: true
    }
  }

  // 兜底：仅有文本但 drawtext 构造失败（content 为空等）
  return { filter: '', inputs: [], useFilterComplex: false }
}
