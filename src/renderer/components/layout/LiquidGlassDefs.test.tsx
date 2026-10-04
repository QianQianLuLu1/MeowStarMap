// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiquidGlassDefs, REFRACT_FILTER_ID } from './LiquidGlassDefs'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('LiquidGlassDefs', () => {
  it('正常：支持 backdrop-filter SVG 滤镜时渲染折射 defs', () => {
    vi.stubGlobal('CSS', { supports: vi.fn(() => true) })
    const { container } = render(<LiquidGlassDefs />)
    const filter = container.querySelector(`filter#${REFRACT_FILTER_ID}`)
    expect(filter).not.toBeNull()
    // 两次位移：先水平后垂直（feDisplacementMap ×2）
    expect(container.querySelectorAll('feDisplacementMap')).toHaveLength(2)
    expect(container.querySelectorAll('feImage')).toHaveLength(2)
  })

  it('边界：不支持时（如非 Chromium 预览）不渲染任何节点', () => {
    vi.stubGlobal('CSS', { supports: vi.fn(() => false) })
    const { container } = render(<LiquidGlassDefs />)
    expect(container.querySelector(`filter#${REFRACT_FILTER_ID}`)).toBeNull()
  })

  it('异常：CSS API 缺失时不渲染且不抛错', () => {
    vi.stubGlobal('CSS', undefined)
    const { container } = render(<LiquidGlassDefs />)
    expect(container.querySelector(`filter#${REFRACT_FILTER_ID}`)).toBeNull()
  })
})
