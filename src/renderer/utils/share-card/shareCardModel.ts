import { InternalError } from '../../../shared/errors/app-error'

/**
 * 阶段 5 · B1：分享图的载荷与几何模型（纯函数，不碰 DOM、不碰 i18next）。
 *
 * 出处：`NikkiSync/apps/wechat-mini-program/miniprogram/lib/share-card.js`
 * 的 `buildPayload` / `wrap` / `layoutCards` / `parameterPresentation`（上游 commit d4ca7d7）。
 * 尺寸、顺序、行高、分页与单位换算**逐字照抄**，只有两处有意的差异：
 *  1. 上游按**中文 label** 匹配参数行；本实现按**规范字段键**匹配，因此模块内零中文字面量
 *     （渲染层硬 lint 拦 `Literal[value=/[\u4e00-\u9fa5]/]`），文案改由 `shareCardRender` 注入。
 *  2. 上游 `throw new Error('分享图内容过长')`；本实现抛 `InternalError`（约定 2：业务错误
 *     必须用 AppError 家族，渲染层硬 lint 拦 `throw new Error`）。
 *
 * 与参考实现的等价性由 `__tests__/shareCardParity.test.ts` 对拍锁定，不靠目测。
 */

export const SHARE_CARD_WIDTH = 1440
export const SHARE_CARD_MAX_HEIGHT = 4096
export const SHARE_CARD_BODY_LIMIT = 3690

/** 规范参数键：12 项固定顺序，等价上游 `PARAMETER_ORDER`。 */
export const PARAMETER_ORDER = [
  'focalLength',
  'aperture',
  'vignette',
  'bloom',
  'bloomRange',
  'brightness',
  'exposure',
  'contrast',
  'saturation',
  'naturalSaturation',
  'highlights',
  'shadows'
] as const

export type ShareParameterKey = (typeof PARAMETER_ORDER)[number]

/** 相机区可接受的键（上游 `CAMERA` 的规范形式，含 12 项之外的两枚追加键）。 */
export const CAMERA_KEYS: readonly string[] = [
  'focalLength',
  'rotation',
  'aperture',
  'depthOfField',
  'vignette',
  'bloom',
  'bloomRange',
  'exposure',
  'brightness',
  'contrast',
  'saturation',
  'naturalSaturation',
  'highlights',
  'shadows'
]

/** 效果区键（上游 `EFFECTS` = 动作 / 光照 / 滤镜 / 地点）。 */
export const EFFECT_KEYS: readonly string[] = ['action', 'lighting', 'filter', 'location']

/** 上游别名表：`柔光强度 → 柔光`、`鲜艳度 → 自然饱和`，同键只留一行。 */
export const PARAMETER_ALIASES: Readonly<Record<string, string>> = {
  bloomStrength: 'bloom',
  vibrance: 'naturalSaturation'
}

/** 百分比族与有符号族（决定单位后缀与滑轨归一域）。 */
const PERCENT_KEYS: readonly string[] = ['brightness', 'contrast', 'bloom', 'vignette']
const SIGNED_KEYS: readonly string[] = [
  'exposure',
  'saturation',
  'naturalSaturation',
  'highlights',
  'shadows'
]

/** 版本行的键（上游用 `游戏版本` label 提取）。 */
export const VERSION_KEY = 'gameVersion'

/** 度量文本所需的最小 ctx 面：与 CanvasRenderingContext2D 兼容，测试里可换成定宽假件。 */
export interface MeasureContext {
  measureText: (text: string) => { width: number }
}

export interface ShareCardRow {
  key: string
  value: unknown
}

export interface ShareCardOutfitInput {
  name?: unknown
  key?: string
  iconPath?: string
  iconSource?: string
  hasIcon?: boolean
}

export interface ShareCardOutfitItem {
  label: string
  value: string
  iconPath: string
  iconSource: 'category' | 'item'
  key?: string
}

export interface ShareCardPayload {
  date: string
  version: string
  outfit: ShareCardOutfitItem[]
  camera: { key: string; value: string }[]
  effects: { key: string; value: string }[]
}

export interface ParameterRow {
  key?: string
  value: string
  displayValue: string
  /** 滑轨位置 0..1；`null` 表示不参与定位（越界或无单位） */
  ratio: number | null
  missing: boolean
  height: number
}

export interface PlacedOutfit extends ShareCardOutfitItem {
  lines: string[]
  column: number
  row: number
  y: number
}

export type RenderedParameter = ParameterRow & { lines: string[]; effect?: boolean }

export interface ShareCardPage {
  outfit: PlacedOutfit[]
  parameters: RenderedParameter[]
  height: number
}

/** 上游 `clean()`：去控制字符后 trim；非字符串一律视为空。 */
export function clean(value: unknown): string {
  // 字符域必须与上游逐字一致，否则含控制字符的游戏文案会在对拍里产生不同断行结果
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : ''
}

/**
 * 上游 `name()` 的结构化等价：只把「看起来不是名称」的值判空——纯数字、`#` 前缀的兜底串、
 * 以及只由分隔符构成的串。上游靠中文正则识别「名称待解析」等占位，那些占位由字典服务产生，
 * 本 App 走本地 `getClothName(id)`，解析不出来时给 `undefined` / `#id`，不需要中文判据。
 */
export function resolveOutfitName(value: unknown): string {
  const text = clean(value)
  if (!text) return ''
  if (/^\d+$/.test(text)) return ''
  if (/^[#_\-–—\s]+$/.test(text)) return ''
  if (/^#\d+$/.test(text)) return ''
  return text
}

/** 单位换算与滑轨归一（逐字对齐上游 `parameterPresentation`）。 */
export function parameterPresentation(key: string, rawValue: unknown): ParameterRow {
  const raw = clean(rawValue)
  const value = raw === '' ? Number.NaN : Number(raw)
  const percent = PERCENT_KEYS.includes(key)
  let displayValue = raw || '—'
  let ratio: number | null = null
  if (Number.isFinite(value)) {
    if (key === 'focalLength') displayValue = `${raw}mm`
    else if (key === 'aperture') displayValue = `f/${raw}`
    else if (percent) displayValue = `${raw}%`
    // 只支持已知的两个呈现域；未验证的游戏滑块上下限一律不落滑轨，绝不猜值
    if (percent && value >= 0 && value <= 100) ratio = value / 100
    else if (SIGNED_KEYS.includes(key) && value >= -1 && value <= 1) ratio = (value + 1) / 2
  }
  return { key, value: raw, displayValue, ratio, missing: !raw, height: 86 }
}

/** 上游 `wrap()`：逐码点累加，超宽即断行；空串返回一个空行。 */
export function wrapText(ctx: MeasureContext, text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const char of Array.from(text)) {
    if (line && ctx.measureText(line + char).width > width) {
      lines.push(line)
      line = char
    } else {
      line += char
    }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

/** 载荷装配（等价上游 `buildPayload`，键换成规范键）。 */
export function buildShareCardPayload(input: {
  date?: unknown
  rows: readonly ShareCardRow[]
  outfits?: readonly ShareCardOutfitInput[]
}): ShareCardPayload {
  const rows = Array.isArray(input.rows) ? input.rows : []
  const canonical = (key: string): string => PARAMETER_ALIASES[key] ?? key
  // 与上游一致：**不去重、保留输入顺序**。上游 layoutCards 用 find() 取首个匹配行，
  // 若在这里先去重，重复键（例如同时给出柔光强度与柔光）的取舍口径就会不同。
  const pick = (allowed: readonly string[]): { key: string; value: string }[] => {
    const picked: { key: string; value: string }[] = []
    for (const item of rows) {
      const key = canonical(String(item.key))
      if (!allowed.includes(key)) continue
      const value = clean(item.value)
      if (!value) continue
      picked.push({ key, value })
    }
    return picked
  }
  const version = rows.find((item) => item.key === VERSION_KEY)
  const outfits = Array.isArray(input.outfits) ? input.outfits : []
  return {
    date: clean(input.date),
    version: clean(version?.value),
    outfit: outfits.map((item) => ({
      label: '',
      value: resolveOutfitName(item.name),
      iconPath: clean(item.iconPath),
      iconSource: item.iconSource === 'category' ? 'category' : 'item',
      key: item.key
    })),
    camera: pick(CAMERA_KEYS),
    effects: pick(EFFECT_KEYS)
  }
}

/**
 * 分页与行高（逐字对齐上游 `layoutCards`）。
 *
 * 关键几何：穿搭每行高 = `198 + 行数 × 29 (+ 分类示意 25)`，两列一行；
 * 页高 = `max(1740, ceil(400 + max(穿搭总高, 参数总高)))`；参数块恒含 12 项 + 60。
 */
export function layoutShareCards(
  ctx: MeasureContext & { font?: string },
  payload: ShareCardPayload
): ShareCardPage[] {
  // 测量字体必须与绘制字号一致（render 里穿搭名 23px / 效果值 28px）：真实 canvas 默认
  // 10px，漏设会让 wrapText 低估行数、页高失真——上游 layoutCards 同样先设 font（:21/:27）
  ctx.font = '23px sans-serif'
  const outfit: PlacedOutfit[] = payload.outfit.map((item) => ({
    ...item,
    lines: item.value ? wrapText(ctx, item.value, 174) : [],
    column: 0,
    row: 0,
    y: 0
  }))

  const parameters: RenderedParameter[] = PARAMETER_ORDER.map((key): RenderedParameter => ({
    ...parameterPresentation(key, payload.camera.find((row) => row.key === key)?.value),
    lines: []
  }))
  for (const row of payload.camera) {
    if (PARAMETER_ORDER.indexOf(row.key as ShareParameterKey) < 0) {
      parameters.push({ ...parameterPresentation(row.key, row.value), lines: [] })
    }
  }
  for (const row of payload.effects) {
    ctx.font = '28px sans-serif'
    const lines = wrapText(ctx, row.value, 540)
    parameters.push({
      key: row.key,
      value: row.value,
      displayValue: row.value,
      ratio: null,
      missing: false,
      height: Math.max(104, 28 + lines.length * 34),
      effect: true,
      lines
    })
  }

  const parameterHeight = parameters.reduce((sum, row) => sum + row.height, 0) + 60
  const pages: ShareCardPage[] = []
  let items: PlacedOutfit[] = []
  let bodyHeight = 0
  const finish = (): void => {
    pages.push({
      outfit: items,
      parameters,
      height: Math.max(1740, Math.ceil(400 + Math.max(bodyHeight, parameterHeight)))
    })
    items = []
    bodyHeight = 0
  }

  for (let index = 0; index < outfit.length; index += 2) {
    const pair = outfit.slice(index, index + 2)
    const rowHeight = Math.max(
      ...pair.map(
        (item) => 198 + item.lines.length * 29 + (item.iconSource === 'category' ? 25 : 0)
      )
    )
    if (bodyHeight + rowHeight > SHARE_CARD_BODY_LIMIT && items.length) finish()
    const row = items.length / 2
    pair.forEach((item, column) => {
      items.push({ ...item, column, row, y: bodyHeight })
    })
    bodyHeight += rowHeight
  }
  if (items.length || !pages.length) finish()

  if (pages.some((page) => page.height > SHARE_CARD_MAX_HEIGHT)) {
    throw new InternalError('share card content exceeds the maximum page height')
  }
  return pages
}
