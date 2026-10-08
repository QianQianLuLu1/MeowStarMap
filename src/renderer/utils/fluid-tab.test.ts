/**
 * @module src/renderer/utils/fluid-tab
 * @coverage 流体滑块 Tab 指示器的几何/形变纯函数（node 环境，零 DOM 依赖）
 *
 * 覆盖三类：
 *   正常几何 —— 下移/上移的前沿归属、飞行中拉伸、终态收敛
 *   异常状态 —— 非法配置回退、NaN 边值兜底
 *   边界条件 —— 超长距离形变钳制、负拉伸、非有限值
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  clampFluidGap,
  composeFluidFrame,
  resolveFluidGeometry,
  sanitizeFluidConfig,
  type FluidEdges
} from './fluid-tab'
import {
  FLUID_TAB_DURATION,
  FLUID_TAB_MAX_STRETCH,
  fluidTabLead,
  fluidTabTrail
} from './motionPresets'

afterEach(() => {
  vi.restoreAllMocks()
})

// —— 夹具：导航项高 40px、间距 8px，第 1 项 top=0、第 2 项 top=48 ——
const ITEM_H = 40
const FROM: FluidEdges = { top: 0, bottom: ITEM_H }
const TO_DOWN: FluidEdges = { top: 88, bottom: 88 + ITEM_H } // 下移两格
const TO_UP: FluidEdges = { top: 0, bottom: ITEM_H } // 从第 3 格回到第 1 格

describe('resolveFluidGeometry 前沿/后沿判定', () => {
  it('下移：direction=1，前沿归属 bottom（朝运动方向的边）', () => {
    const g = resolveFluidGeometry(FROM, TO_DOWN)
    expect(g.direction).toBe(1)
    expect(g.leadFrom).toBe(FROM.bottom)
    expect(g.leadTo).toBe(TO_DOWN.bottom)
    expect(g.trailFrom).toBe(FROM.top)
    expect(g.trailTo).toBe(TO_DOWN.top)
  })

  it('上移：direction=-1，前沿归属 top', () => {
    const g = resolveFluidGeometry(TO_DOWN, TO_UP)
    expect(g.direction).toBe(-1)
    expect(g.leadFrom).toBe(TO_DOWN.top)
    expect(g.leadTo).toBe(TO_UP.top)
    expect(g.trailFrom).toBe(TO_DOWN.bottom)
    expect(g.trailTo).toBe(TO_UP.bottom)
  })

  it('仅高度变化（top 不变）：按 direction=1 处理，不产生反向抖动', () => {
    const g = resolveFluidGeometry(FROM, { top: 0, bottom: 60 })
    expect(g.direction).toBe(1)
  })
})

describe('composeFluidFrame 帧合成', () => {
  it('飞行中产生拉伸：scaleY > 1，且前沿值不被钳制改写', () => {
    // 前沿已走完 90%（40 + 88*0.9），后沿只走了 40%（88*0.4）
    const frame = composeFluidFrame({
      lead: 40 + 88 * 0.9,
      trail: 88 * 0.4,
      direction: 1,
      baseHeight: ITEM_H,
      maxStretch: FLUID_TAB_MAX_STRETCH
    })
    expect(frame.scaleY).toBeGreaterThan(1)
    // 前沿保持在 119.2，后沿被 gap 反推：119.2 - 68
    expect(frame.top).toBeCloseTo(40 + 88 * 0.9 - (ITEM_H + FLUID_TAB_MAX_STRETCH), 5)
    expect(frame.gap).toBe(ITEM_H + FLUID_TAB_MAX_STRETCH)
  })

  it('上移时保留前沿（top）不动，由后沿补足 gap', () => {
    const lead = 88 - 88 * 0.9 // 前沿（top）已接近终点
    const frame = composeFluidFrame({
      lead,
      trail: 88 + ITEM_H - 88 * 0.4, // 后沿（bottom）滞后
      direction: -1,
      baseHeight: ITEM_H,
      maxStretch: FLUID_TAB_MAX_STRETCH
    })
    expect(frame.top).toBeCloseTo(lead, 5)
    expect(frame.scaleY).toBeGreaterThan(1)
  })

  it('终态收敛：两条边到位后 scaleY=1 且 top 等于目标 top', () => {
    const frame = composeFluidFrame({
      lead: TO_DOWN.bottom,
      trail: TO_DOWN.top,
      direction: 1,
      baseHeight: ITEM_H,
      maxStretch: FLUID_TAB_MAX_STRETCH
    })
    expect(frame.gap).toBe(ITEM_H)
    expect(frame.scaleY).toBe(1)
    expect(frame.top).toBe(TO_DOWN.top)
  })

  it('超长距离（首项→末项约 350px）：形变被钳到上限，不拉出超长条', () => {
    const frame = composeFluidFrame({
      lead: 390,
      trail: 175,
      direction: 1,
      baseHeight: ITEM_H,
      maxStretch: FLUID_TAB_MAX_STRETCH
    })
    expect(frame.gap).toBe(ITEM_H + FLUID_TAB_MAX_STRETCH)
    expect(frame.gap).toBeLessThan(100)
  })

  it('非法输入（NaN / baseHeight<=0）：返回零形变安全帧，不抛异常', () => {
    expect(
      composeFluidFrame({
        lead: Number.NaN,
        trail: 0,
        direction: 1,
        baseHeight: ITEM_H,
        maxStretch: FLUID_TAB_MAX_STRETCH
      })
    ).toEqual({ top: 0, scaleY: 1, gap: 0 })
    expect(
      composeFluidFrame({
        lead: 10,
        trail: 0,
        direction: 1,
        baseHeight: 0,
        maxStretch: FLUID_TAB_MAX_STRETCH
      })
    ).toEqual({ top: 0, scaleY: 1, gap: 0 })
  })
})

describe('clampFluidGap 形变钳制', () => {
  it('超出上限：钳到 baseHeight + maxStretch', () => {
    expect(clampFluidGap(84, ITEM_H, FLUID_TAB_MAX_STRETCH)).toBe(ITEM_H + FLUID_TAB_MAX_STRETCH)
  })

  it('低于下限：不小于自然高度（滑块不会被压扁）', () => {
    expect(clampFluidGap(10, ITEM_H, FLUID_TAB_MAX_STRETCH)).toBe(ITEM_H)
  })

  it('maxStretch 为负：视为 0，仍不小于自然高度', () => {
    expect(clampFluidGap(500, ITEM_H, -5)).toBe(ITEM_H)
  })

  it('非有限值：回退自然高度', () => {
    expect(clampFluidGap(Number.NaN, ITEM_H, FLUID_TAB_MAX_STRETCH)).toBe(ITEM_H)
    expect(clampFluidGap(Number.POSITIVE_INFINITY, ITEM_H, FLUID_TAB_MAX_STRETCH)).toBe(
      ITEM_H + FLUID_TAB_MAX_STRETCH
    )
  })

  it('拉伸上限不得超过 baseHeight 的 3 倍', () => {
    expect(clampFluidGap(9999, 10, 9999)).toBe(10 + 10 * 3)
  })
})

describe('sanitizeFluidConfig 参数校验', () => {
  it('缺省：返回 motionPresets 中的流体预设', () => {
    const cfg = sanitizeFluidConfig()
    expect(cfg.duration).toBe(FLUID_TAB_DURATION)
    expect(cfg.leadEase).toEqual(fluidTabLead)
    expect(cfg.trailEase).toEqual(fluidTabTrail)
    expect(cfg.maxStretch).toBe(FLUID_TAB_MAX_STRETCH)
  })

  it('duration 非法（0 / 负数 / NaN）：回退默认并告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const bad of [0, -1, Number.NaN]) {
      expect(sanitizeFluidConfig({ duration: bad }).duration).toBe(FLUID_TAB_DURATION)
    }
    expect(warn).toHaveBeenCalled()
  })

  it('duration 超过 2s：截断到 2 并告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(sanitizeFluidConfig({ duration: 5 }).duration).toBe(2)
    expect(warn).toHaveBeenCalled()
  })

  it('ease 非 4 元 / 含非有限值：回退对应默认曲线并告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cfg = sanitizeFluidConfig({
      leadEase: [0, 1] as unknown as [number, number, number, number],
      trailEase: [0, 1, Number.NaN, 1]
    })
    expect(cfg.leadEase).toEqual(fluidTabLead)
    expect(cfg.trailEase).toEqual(fluidTabTrail)
    expect(warn).toHaveBeenCalled()
  })

  it('maxStretch 为负或非有限：回退默认并告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(sanitizeFluidConfig({ maxStretch: -3 }).maxStretch).toBe(FLUID_TAB_MAX_STRETCH)
    expect(sanitizeFluidConfig({ maxStretch: Number.NaN }).maxStretch).toBe(FLUID_TAB_MAX_STRETCH)
    expect(warn).toHaveBeenCalled()
  })

  it('合法值原样通过，不告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cfg = sanitizeFluidConfig({ duration: 0.6, maxStretch: 12 })
    expect(cfg.duration).toBe(0.6)
    expect(cfg.maxStretch).toBe(12)
    expect(warn).not.toHaveBeenCalled()
  })
})
