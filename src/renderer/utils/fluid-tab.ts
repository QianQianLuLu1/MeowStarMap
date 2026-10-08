/**
 * 流体滑块 Tab 指示器 —— 几何与形变纯函数
 *
 * 模型：滑块状态 = `{ top, bottom }` 两条边（px，相对导航容器）。
 * 切换时两条边各自独立补间：朝运动方向的那条边（前沿）走快出曲线，另一条边（后沿）
 * 走慢入慢出曲线，飞行中两条边拉开差距即产生拉伸；终态同时收敛回自然高度。
 *
 * 本模块零 DOM 依赖、不引用 React 与 motion，可在 node 环境直接单测。
 * 曲线与时长常量来自 `./motionPresets`（全仓 easing 唯一硬编码点）。
 */

import {
  FLUID_TAB_DURATION,
  FLUID_TAB_MAX_STRETCH,
  fluidTabLead,
  fluidTabTrail
} from './motionPresets'

/** 滑块两条边（px，相对导航容器顶边） */
export interface FluidEdges {
  top: number
  bottom: number
}

/** 单个导航项相对容器的矩形 */
export interface FluidRect {
  top: number
  height: number
}

/** cubic-bezier 4 元定义（与 framer-motion BezierDefinition 同形） */
export type FluidEase = [number, number, number, number]

/** 流体滑块可配置参数 */
export interface FluidConfig {
  /** 单次切换时长（秒），(0, 2] */
  duration: number
  /** 前沿曲线：快出 */
  leadEase: FluidEase
  /** 后沿曲线：慢入慢出 */
  trailEase: FluidEase
  /** 最大拉伸量（px），>= 0 */
  maxStretch: number
}

/** 每帧输出：直接映射为 transform: translateY(top) scaleY(scaleY) */
export interface FluidFrame {
  top: number
  scaleY: number
  /** 形变后的实际高度（px），scaleY * baseHeight */
  gap: number
}

/** 运动方向与前沿/后沿归属 */
export interface FluidGeometry {
  /** 1 = 下移（前沿为 bottom）；-1 = 上移（前沿为 top） */
  direction: 1 | -1
  leadFrom: number
  leadTo: number
  trailFrom: number
  trailTo: number
}

/** duration 硬上限（秒）：超过则截断，避免误配导致长时间卡顿感 */
const MAX_FLUID_DURATION = 2
/** 拉伸量不超过自然高度的倍数：即使 maxStretch 配错也不会拉出怪条 */
const MAX_STRETCH_RATIO = 3

function warnInvalid(field: string, value: unknown): void {
  console.warn(`[fluid-tab-indicator] invalid config ${field}:`, value)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isValidEase(v: unknown): v is FluidEase {
  return Array.isArray(v) && v.length === 4 && v.every((n) => isFiniteNumber(n))
}

/** 矩形 → 两条边 */
export function rectToEdges(rect: FluidRect): FluidEdges {
  return { top: rect.top, bottom: rect.top + rect.height }
}

/**
 * 判定运动方向与前沿/后沿归属。
 * 下移时朝运动方向的边是 bottom（前沿），上移时是 top。
 * top 相同（仅高度变化）按 1 处理，避免方向抖动。
 */
export function resolveFluidGeometry(from: FluidEdges, to: FluidEdges): FluidGeometry {
  const direction: 1 | -1 = to.top - from.top >= 0 ? 1 : -1
  return direction === 1
    ? {
        direction,
        leadFrom: from.bottom,
        leadTo: to.bottom,
        trailFrom: from.top,
        trailTo: to.top
      }
    : {
        direction,
        leadFrom: from.top,
        leadTo: to.top,
        trailFrom: from.bottom,
        trailTo: to.bottom
      }
}

/**
 * 形变钳制：滑块高度不得低于自然高度（不压扁）、不得高于自然高度 + maxStretch。
 * maxStretch 为负或非有限时视为 0；再叠加 baseHeight * 3 的硬上限兜底。
 */
export function clampFluidGap(gap: number, baseHeight: number, maxStretch: number): number {
  if (Number.isNaN(gap)) return baseHeight
  const min = isFiniteNumber(baseHeight) && baseHeight > 0 ? baseHeight : 0
  const stretch = isFiniteNumber(maxStretch) && maxStretch > 0 ? maxStretch : 0
  const upper = min + Math.min(stretch, min * MAX_STRETCH_RATIO)
  return Math.min(Math.max(gap, min), upper)
}

/**
 * 每帧合成：保留前沿值不动，用钳制后的 gap 反推后沿。
 * 这样钳制只作用于后沿，前沿速度不受损 —— 长距离跳转时视觉上是「前沿先冲、后沿被拖住」。
 *
 * @returns 非法输入（非有限值 / baseHeight <= 0）时返回零形变安全帧，不抛异常
 */
export function composeFluidFrame(input: {
  lead: number
  trail: number
  direction: 1 | -1
  baseHeight: number
  maxStretch: number
}): FluidFrame {
  const { lead, trail, direction, baseHeight, maxStretch } = input
  const safeFrame: FluidFrame = { top: 0, scaleY: 1, gap: 0 }
  if (!isFiniteNumber(lead) || !isFiniteNumber(trail)) return safeFrame
  if (!isFiniteNumber(baseHeight) || baseHeight <= 0) return safeFrame

  // dir=1：前沿是 bottom，gap = bottom - top；dir=-1：前沿是 top，gap = bottom - top 由后沿减前沿
  const rawGap = direction === 1 ? lead - trail : trail - lead
  const gap = clampFluidGap(rawGap, baseHeight, maxStretch)
  const top = direction === 1 ? lead - gap : lead
  return { top, scaleY: gap / baseHeight, gap }
}

/**
 * 参数校验：逐项校验，非法项回退默认值并 `console.warn`，永不抛出。
 * 保证动画在最坏配置下仍可运行（降级为默认曲线），不会因配置错误卡死 UI。
 */
export function sanitizeFluidConfig(cfg?: Partial<FluidConfig>): FluidConfig {
  let duration = cfg?.duration ?? FLUID_TAB_DURATION
  if (!isFiniteNumber(duration) || duration <= 0) {
    warnInvalid('duration', duration)
    duration = FLUID_TAB_DURATION
  } else if (duration > MAX_FLUID_DURATION) {
    warnInvalid('duration', duration)
    duration = MAX_FLUID_DURATION
  }

  let leadEase = cfg?.leadEase ?? fluidTabLead
  if (!isValidEase(leadEase)) {
    warnInvalid('leadEase', leadEase)
    leadEase = fluidTabLead
  }

  let trailEase = cfg?.trailEase ?? fluidTabTrail
  if (!isValidEase(trailEase)) {
    warnInvalid('trailEase', trailEase)
    trailEase = fluidTabTrail
  }

  let maxStretch = cfg?.maxStretch ?? FLUID_TAB_MAX_STRETCH
  if (!isFiniteNumber(maxStretch) || maxStretch < 0) {
    warnInvalid('maxStretch', maxStretch)
    maxStretch = FLUID_TAB_MAX_STRETCH
  }

  return { duration, leadEase, trailEase, maxStretch }
}
