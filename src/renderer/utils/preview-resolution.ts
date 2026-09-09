/**
 * 编辑器预览「长边预算」计算（纯函数，无 DOM 依赖）
 *
 * 背景：预览分辨率此前被硬编码为长边 1400（`useImageProcessor` 的 DEFAULT_MAX_PREVIEW_SIZE），
 * 导致 2x 屏或放大查看时位图被浏览器上采样而发虚。现改为按「实际显示需求」推导预算：
 *
 *   预算 = max(显示区宽, 显示区高) × devicePixelRatio × 当前缩放倍数
 *
 * 预算再交给 `processImageData` 的 maxSize：由于它只在原图超出 maxSize 时才缩小，
 * 预算 ≥ 原图长边时会自动回到 1:1 原图分辨率，预算不足时恰好按显示需求采样，
 * 因此调用方无需知道原图宽高。
 */

/** 预算量化步长：抑制滚轮连续缩放触发的频繁重渲染（只多不少，不影响清晰度） */
export const PREVIEW_SIZE_QUANTUM = 256
/** 显示区尚未测量 / 入参非法时的兜底长边（与修复前的固定值一致，保证不会更差） */
export const FALLBACK_PREVIEW_MAX_SIZE = 1400
/** 预算下限 */
export const MIN_PREVIEW_MAX_SIZE = 256
/** 预算上限：Chromium canvas 单边上限 */
export const MAX_PREVIEW_MAX_SIZE = 65535

/** devicePixelRatio 上限，防止异常缩放比例导致预算爆炸 */
const MAX_DEVICE_PIXEL_RATIO = 4
/** 缩放倍数上限，与 ZoomableContainer 的 maxZoom=8 对齐 */
const MAX_PREVIEW_SCALE = 8

/** 窗口尺寸的最小抽象，便于在 node 环境单测中注入 */
export interface PreviewWindowLike {
  innerWidth?: number
  innerHeight?: number
  devicePixelRatio?: number
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 计算预览渲染的长边预算（像素）
 *
 * @param boxWidth 预览容器 CSS 宽度（未测量时为 0）
 * @param boxHeight 预览容器 CSS 高度（未测量时为 0）
 * @param dpr devicePixelRatio，夹持到 [1, 4]
 * @param scale 当前缩放倍数，夹持到 [1, 8]
 * @returns 长边预算；已向上量化到 256 的倍数并夹在 [256, 65535]。
 *          任一入参非有限正数时返回 FALLBACK_PREVIEW_MAX_SIZE
 */
export function computePreviewMaxSize(
  boxWidth: number,
  boxHeight: number,
  dpr: number,
  scale: number
): number {
  if (
    !isPositiveFinite(boxWidth) ||
    !isPositiveFinite(boxHeight) ||
    !isPositiveFinite(dpr) ||
    !isPositiveFinite(scale)
  ) {
    return FALLBACK_PREVIEW_MAX_SIZE
  }

  const boxLongEdge = Math.max(boxWidth, boxHeight)
  const effectiveDpr = clamp(dpr, 1, MAX_DEVICE_PIXEL_RATIO)
  const effectiveScale = clamp(scale, 1, MAX_PREVIEW_SCALE)
  const raw = boxLongEdge * effectiveDpr * effectiveScale

  if (!Number.isFinite(raw) || raw <= 0) {
    return FALLBACK_PREVIEW_MAX_SIZE
  }

  const quantized = Math.ceil(raw / PREVIEW_SIZE_QUANTUM) * PREVIEW_SIZE_QUANTUM
  return clamp(quantized, MIN_PREVIEW_MAX_SIZE, MAX_PREVIEW_MAX_SIZE)
}

/**
 * 首帧（容器尚未测量）时的预算估算
 *
 * @param win 窗口对象；缺失或尺寸非法时回落 FALLBACK_PREVIEW_MAX_SIZE
 * @returns 长边预算
 */
export function estimateInitialPreviewMaxSize(win?: PreviewWindowLike | null): number {
  if (!win) return FALLBACK_PREVIEW_MAX_SIZE
  return computePreviewMaxSize(
    win.innerWidth ?? 0,
    win.innerHeight ?? 0,
    win.devicePixelRatio ?? 0,
    1
  )
}
