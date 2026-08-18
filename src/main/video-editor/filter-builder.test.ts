/**
 * @layer L1
 * @module src/main/video-editor/filter-builder
 * @coverage buildColorFilter
 * @remarks 纯函数单测：验证基础调色 4 项 + temperature/tint 的 ffmpeg 滤镜串构造
 */
import { describe, it, expect } from 'vitest'
import { buildColorFilter } from './filter-builder'
import type { FilterParams } from '../../shared/types/editor'

/**
 * 构造测试用 FilterParams（全 0 默认值，与图片编辑器 defaultFilterParams 一致）。
 * 直接内联以避免从 renderer 导入（main 进程 tsconfig 不包含 renderer 文件）。
 */
function makeDefaultFilterParams(): FilterParams {
  return {
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
    hsl: {
      red: { hue: 0, saturation: 0, lightness: 0 },
      orange: { hue: 0, saturation: 0, lightness: 0 },
      yellow: { hue: 0, saturation: 0, lightness: 0 },
      yellowGreen: { hue: 0, saturation: 0, lightness: 0 },
      green: { hue: 0, saturation: 0, lightness: 0 },
      cyan: { hue: 0, saturation: 0, lightness: 0 },
      blue: { hue: 0, saturation: 0, lightness: 0 },
      purple: { hue: 0, saturation: 0, lightness: 0 },
      magenta: { hue: 0, saturation: 0, lightness: 0 },
      skin: { hue: 0, saturation: 0, lightness: 0 },
      bluePurple: { hue: 0, saturation: 0, lightness: 0 },
      warm: { hue: 0, saturation: 0, lightness: 0 }
    },
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
}

const defaultFilterParams = makeDefaultFilterParams()

/** 构造测试用 FilterParams（基于默认值覆盖指定字段） */
function makeParams(overrides: Partial<FilterParams>): FilterParams {
  return { ...defaultFilterParams, ...overrides }
}

describe('filter-builder - buildColorFilter', () => {
  describe('空值与默认场景', () => {
    it('全 0 时返回空串', () => {
      expect(buildColorFilter(makeParams({}))).toBe('')
    })

    it('默认 FilterParams 返回空串', () => {
      expect(buildColorFilter(defaultFilterParams)).toBe('')
    })
  })

  describe('brightness 映射', () => {
    it('brightness=20 → eq.brightness=0.1', () => {
      const result = buildColorFilter(makeParams({ brightness: 20 }))
      expect(result).toBe('eq=brightness=0.1000')
    })

    it('brightness=-50 → eq.brightness=-0.25', () => {
      const result = buildColorFilter(makeParams({ brightness: -50 }))
      expect(result).toBe('eq=brightness=-0.2500')
    })

    it('brightness=100 边界值 → eq.brightness=0.5', () => {
      const result = buildColorFilter(makeParams({ brightness: 100 }))
      expect(result).toBe('eq=brightness=0.5000')
    })

    it('brightness=-100 边界值 → eq.brightness=-0.5', () => {
      const result = buildColorFilter(makeParams({ brightness: -100 }))
      expect(result).toBe('eq=brightness=-0.5000')
    })
  })

  describe('contrast 映射', () => {
    it('contrast=-15 → eq.contrast=0.85', () => {
      const result = buildColorFilter(makeParams({ contrast: -15 }))
      expect(result).toBe('eq=contrast=0.8500')
    })

    it('contrast=100 → eq.contrast=2.0', () => {
      const result = buildColorFilter(makeParams({ contrast: 100 }))
      expect(result).toBe('eq=contrast=2.0000')
    })

    it('contrast=-100 → eq.contrast=0.0', () => {
      const result = buildColorFilter(makeParams({ contrast: -100 }))
      expect(result).toBe('eq=contrast=0.0000')
    })
  })

  describe('saturation 映射', () => {
    it('saturation=30 → eq.saturation=1.3', () => {
      const result = buildColorFilter(makeParams({ saturation: 30 }))
      expect(result).toBe('eq=saturation=1.3000')
    })

    it('saturation=-100 → eq.saturation=0.0', () => {
      const result = buildColorFilter(makeParams({ saturation: -100 }))
      expect(result).toBe('eq=saturation=0.0000')
    })
  })

  describe('eq 滤镜合并', () => {
    it('brightness + contrast + saturation 同时非零 → 合并到同一 eq 段', () => {
      const result = buildColorFilter(makeParams({ brightness: 20, contrast: -15, saturation: 30 }))
      expect(result).toBe('eq=brightness=0.1000:contrast=0.8500:saturation=1.3000')
    })

    it('只 brightness 非零 → 单字段 eq', () => {
      const result = buildColorFilter(makeParams({ brightness: 10 }))
      expect(result).toBe('eq=brightness=0.0500')
    })
  })

  describe('temperature 映射（colorbalance）', () => {
    it('temperature=40 → colorbalance rs=0.2, mb=-0.2', () => {
      const result = buildColorFilter(makeParams({ temperature: 40 }))
      expect(result).toBe('colorbalance=rs=0.2000:mb=-0.2000')
    })

    it('temperature=-60 暖值负向 → rs=-0.3, mb=0.3', () => {
      const result = buildColorFilter(makeParams({ temperature: -60 }))
      expect(result).toBe('colorbalance=rs=-0.3000:mb=0.3000')
    })

    it('temperature=100 边界 → rs=0.5, mb=-0.5', () => {
      const result = buildColorFilter(makeParams({ temperature: 100 }))
      expect(result).toBe('colorbalance=rs=0.5000:mb=-0.5000')
    })
  })

  describe('tint 映射（colorbalance）', () => {
    it('tint=30 → colorbalance gs=-0.1（正值减绿→品红）', () => {
      const result = buildColorFilter(makeParams({ tint: 30 }))
      expect(result).toBe('colorbalance=gs=-0.1000')
    })

    it('tint=-30 → gs=0.1（负值加绿）', () => {
      const result = buildColorFilter(makeParams({ tint: -30 }))
      expect(result).toBe('colorbalance=gs=0.1000')
    })

    it('tint=100 边界 → gs=-0.3333', () => {
      const result = buildColorFilter(makeParams({ tint: 100 }))
      expect(result).toBe('colorbalance=gs=-0.3333')
    })
  })

  describe('colorbalance 合并', () => {
    it('temperature + tint 同时非零 → 合并到同一 colorbalance 段', () => {
      const result = buildColorFilter(makeParams({ temperature: 40, tint: 30 }))
      expect(result).toBe('colorbalance=rs=0.2000:mb=-0.2000:gs=-0.1000')
    })
  })

  describe('多滤镜串联', () => {
    it('实例：brightness=20, contrast=-15, saturation=30, temperature=40, tint=0', () => {
      const result = buildColorFilter(
        makeParams({
          brightness: 20,
          contrast: -15,
          saturation: 30,
          temperature: 40,
          tint: 0
        })
      )
      expect(result).toBe(
        'eq=brightness=0.1000:contrast=0.8500:saturation=1.3000,colorbalance=rs=0.2000:mb=-0.2000'
      )
    })

    it('五项全开', () => {
      const result = buildColorFilter(
        makeParams({
          brightness: 20,
          contrast: -15,
          saturation: 30,
          temperature: 40,
          tint: 30
        })
      )
      expect(result).toBe(
        'eq=brightness=0.1000:contrast=0.8500:saturation=1.3000,colorbalance=rs=0.2000:mb=-0.2000:gs=-0.1000'
      )
    })

    it('只 temperature 非零 → 仅 colorbalance 段', () => {
      const result = buildColorFilter(makeParams({ temperature: 25 }))
      expect(result).toBe('colorbalance=rs=0.1250:mb=-0.1250')
    })
  })

  describe('未实现扩展项不参与滤镜', () => {
    it('vibrance 非零不影响输出（本期不实现）', () => {
      const result = buildColorFilter(makeParams({ vibrance: 50 }))
      expect(result).toBe('')
    })

    it('highlights / shadows / clarity 非零不影响输出', () => {
      const result = buildColorFilter(makeParams({ highlights: 30, shadows: -20, clarity: 40 }))
      expect(result).toBe('')
    })

    it('扩展项非零但 brightness 也非零 → 仅 brightness 生效', () => {
      const result = buildColorFilter(makeParams({ brightness: 10, highlights: 30, clarity: 40 }))
      expect(result).toBe('eq=brightness=0.0500')
    })
  })
})
