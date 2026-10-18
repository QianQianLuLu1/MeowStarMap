import { describe, it, expect } from 'vitest'
import {
  computePreviewMaxSize,
  computeDragProxyMaxSize,
  DRAG_PROXY_MAX_SIZE,
  estimateInitialPreviewMaxSize,
  PREVIEW_SIZE_QUANTUM,
  FALLBACK_PREVIEW_MAX_SIZE,
  MIN_PREVIEW_MAX_SIZE,
  MAX_PREVIEW_MAX_SIZE
} from './preview-resolution'

/**
 * @layer L3
 * @module src/renderer/utils/preview-resolution
 * @coverage 编辑器预览长边预算计算（显示区 × DPR × 缩放）+ 参数校验兜底
 * @dependencies 无（纯函数）
 * @remarks node 环境；不依赖 DOM
 */

describe('preview-resolution', () => {
  describe('computePreviewMaxSize 正常流程', () => {
    it('1200x800 显示区 / dpr=1 / scale=1 → 长边预算向上量化到 1280', () => {
      expect(computePreviewMaxSize(1200, 800, 1, 1)).toBe(1280)
    })

    it('dpr=2 时预算翻倍（2x 屏不再被 1400 截断）', () => {
      expect(computePreviewMaxSize(1200, 800, 2, 1)).toBe(2560)
    })

    it('放大到 scale=4 时预算随之增长', () => {
      expect(computePreviewMaxSize(1200, 800, 1, 4)).toBe(4864)
    })

    it('取显示区较长边计算，竖构图同样清晰', () => {
      // 竖排显示区 800x1200：长边 1200
      expect(computePreviewMaxSize(800, 1200, 1, 1)).toBe(1280)
    })

    it('超宽显示区（全景）以宽度为准', () => {
      expect(computePreviewMaxSize(2000, 300, 1, 1)).toBe(2048)
    })

    it('预算恒为 256 的整数倍（抑制滚轮缩放导致的重渲染抖动）', () => {
      const sizes = [1200, 1500, 1601, 999, 2048, 3333]
      for (const size of sizes) {
        expect(computePreviewMaxSize(size, size, 1, 1) % PREVIEW_SIZE_QUANTUM).toBe(0)
      }
    })

    it('预算不小于显示需求（只多不少，避免上采样模糊）', () => {
      const need = 1200 * 2 * 2 // box 长边 1200 × dpr2 × scale2
      expect(computePreviewMaxSize(1200, 800, 2, 2)).toBeGreaterThanOrEqual(need)
    })
  })

  describe('computePreviewMaxSize 边界与非法值', () => {
    it('scale 超过 8 被夹持到 8', () => {
      expect(computePreviewMaxSize(1200, 800, 1, 20)).toBe(computePreviewMaxSize(1200, 800, 1, 8))
    })

    it('dpr 超过 4 被夹持到 4', () => {
      expect(computePreviewMaxSize(1200, 800, 8, 1)).toBe(computePreviewMaxSize(1200, 800, 4, 1))
    })

    it('scale 小于 1 被夹持到 1', () => {
      expect(computePreviewMaxSize(1200, 800, 1, 0.5)).toBe(computePreviewMaxSize(1200, 800, 1, 1))
    })

    it('显示区未测量（0x0）时回落兜底值', () => {
      expect(computePreviewMaxSize(0, 0, 1, 1)).toBe(FALLBACK_PREVIEW_MAX_SIZE)
    })

    it.each([
      ['NaN 宽度', NaN, 800, 1, 1],
      ['NaN 高度', 1200, NaN, 1, 1],
      ['NaN dpr', 1200, 800, NaN, 1],
      ['NaN scale', 1200, 800, 1, NaN],
      ['负数宽度', -1200, 800, 1, 1],
      ['零 dpr', 1200, 800, 0, 1],
      ['Infinity 宽度', Infinity, 800, 1, 1]
    ])('%s → 回落兜底值 %i', (_name, w, h, dpr, scale) => {
      expect(computePreviewMaxSize(w, h, dpr, scale)).toBe(FALLBACK_PREVIEW_MAX_SIZE)
    })

    it('极小显示区被夹持到下限', () => {
      expect(computePreviewMaxSize(10, 10, 1, 1)).toBe(MIN_PREVIEW_MAX_SIZE)
    })

    it('超大显示区 + 高 DPR + 高缩放被夹持到 canvas 边长上限内', () => {
      const result = computePreviewMaxSize(60000, 60000, 4, 8)
      expect(result).toBeLessThanOrEqual(MAX_PREVIEW_MAX_SIZE)
    })
  })

  describe('estimateInitialPreviewMaxSize', () => {
    it('依据窗口尺寸与 DPR 估算首帧预算', () => {
      expect(
        estimateInitialPreviewMaxSize({ innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1 })
      ).toBe(2048)
    })

    it('2x 屏首帧预算翻倍', () => {
      expect(
        estimateInitialPreviewMaxSize({ innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 2 })
      ).toBe(3840)
    })

    it('window 不可用时回落兜底值', () => {
      expect(estimateInitialPreviewMaxSize(null)).toBe(FALLBACK_PREVIEW_MAX_SIZE)
      expect(estimateInitialPreviewMaxSize(undefined)).toBe(FALLBACK_PREVIEW_MAX_SIZE)
    })

    it('窗口尺寸非法时回落兜底值', () => {
      expect(
        estimateInitialPreviewMaxSize({ innerWidth: NaN, innerHeight: 0, devicePixelRatio: 1 })
      ).toBe(FALLBACK_PREVIEW_MAX_SIZE)
    })
  })

  /**
   * 拖动代理档（docs/plans/2026-10-18-fix-editor-preview-realtime.md N2）
   * 拖动中的帧只需要「看得出在变」，不需要满分辨率；真实预算由停止输入后的尾随帧补足。
   */
  describe('computeDragProxyMaxSize 拖动代理档', () => {
    it('超出代理档的预算被钳到代理档（正常）', () => {
      expect(computeDragProxyMaxSize(MAX_PREVIEW_MAX_SIZE)).toBe(DRAG_PROXY_MAX_SIZE)
      expect(computeDragProxyMaxSize(2048)).toBe(DRAG_PROXY_MAX_SIZE)
    })

    it('已小于代理档的预算原样返回——只降不升（边界）', () => {
      expect(computeDragProxyMaxSize(DRAG_PROXY_MAX_SIZE)).toBe(DRAG_PROXY_MAX_SIZE)
      expect(computeDragProxyMaxSize(512)).toBe(512)
      expect(computeDragProxyMaxSize(MIN_PREVIEW_MAX_SIZE)).toBe(MIN_PREVIEW_MAX_SIZE)
    })

    it('正无穷（不限制）在拖动态仍被钳制——这正是 8× 缩放时逐像素跑原图的失控入口', () => {
      expect(computeDragProxyMaxSize(Number.POSITIVE_INFINITY)).toBe(DRAG_PROXY_MAX_SIZE)
    })

    it('非法预算原样透传，由下游按「不限制」口径处理，不静默降分辨率（异常）', () => {
      expect(computeDragProxyMaxSize(NaN)).toBe(NaN)
      expect(computeDragProxyMaxSize(0)).toBe(0)
      expect(computeDragProxyMaxSize(-5)).toBe(-5)
    })
  })
})
