import { describe, expect, it } from 'vitest'
import { luminanceToTone, parseRgbLuminance, progressFromScroll } from './liquidGlass'

describe('progressFromScroll', () => {
  it('正常：按可滚动区间换算进度', () => {
    expect(progressFromScroll(100, 1000, 200)).toBe(0.125)
    expect(progressFromScroll(0, 1000, 200)).toBe(0)
    expect(progressFromScroll(800, 1000, 200)).toBe(1)
  })

  it('边界：无可滚动区间时归零', () => {
    expect(progressFromScroll(50, 200, 200)).toBe(0)
    expect(progressFromScroll(50, 100, 200)).toBe(0)
    expect(progressFromScroll(0, 0, 0)).toBe(0)
  })

  it('异常：非有限数值返回 0 且不抛错', () => {
    expect(progressFromScroll(NaN, 1000, 200)).toBe(0)
    expect(progressFromScroll(100, Infinity, 200)).toBe(0)
    expect(progressFromScroll(100, 1000, -Infinity)).toBe(0)
    // @ts-expect-error 非法入参防御
    expect(progressFromScroll('x', 1000, 200)).toBe(0)
  })
})

describe('parseRgbLuminance', () => {
  it('正常：解析 rgb/rgba 计算串（逗号与空格两种序列化）', () => {
    expect(parseRgbLuminance('rgb(255, 255, 255)')).toBeCloseTo(1, 5)
    expect(parseRgbLuminance('rgb(0, 0, 0)')).toBe(0)
    expect(parseRgbLuminance('rgb(245 245 245)')).toBeCloseTo(0.9608, 3)
    expect(parseRgbLuminance('rgba(255, 0, 0, 0.72)')).toBeCloseTo(0.299, 3)
  })

  it('边界：全透明返回 null', () => {
    expect(parseRgbLuminance('rgba(0, 0, 0, 0)')).toBeNull()
  })

  it('异常：非 rgb 串与垃圾输入返回 null', () => {
    expect(parseRgbLuminance('transparent')).toBeNull()
    expect(parseRgbLuminance('color-mix(in srgb, red 10%, blue)')).toBeNull()
    expect(parseRgbLuminance('')).toBeNull()
    expect(parseRgbLuminance('rgb(1, 2)')).toBeNull()
  })
})

describe('luminanceToTone', () => {
  it('正常：亮背景 light / 暗背景 dim', () => {
    expect(luminanceToTone(0.96)).toBe('light')
    expect(luminanceToTone(0.2)).toBe('dim')
  })

  it('边界：阈值 0.5 归为 light（保守）', () => {
    expect(luminanceToTone(0.5)).toBe('light')
    expect(luminanceToTone(0.4999)).toBe('dim')
  })

  it('异常：非有限值保守取 light', () => {
    expect(luminanceToTone(NaN)).toBe('light')
  })
})
