/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/components/gallery/TieredCardImage
 * @coverage 低清→standard 交叉淡入（THUMBNAIL_OPTIMIZATION_PLAN 节点3）：
 *   standard onLoad 前双图并存、onLoad 后淡入并卸载低清底图；无低清档时不淡入直接显示；
 *   onError 透传父组件保持既有回退链（low 失败升级 / standard 失败回退）。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TieredCardImage } from './TieredCardImage'

const LOW = 'media://file?path=abc_low.jpg'
const STD = 'media://file?path=abc.jpg'

describe('TieredCardImage 交叉淡入', () => {
  it('正常：showStandard 且 standard onLoad → 淡入完成且低清底图卸载', () => {
    const { container } = render(
      <TieredCardImage
        lowUrl={LOW}
        standardUrl={STD}
        showStandard
        alt="a"
        onLowError={() => {}}
        onStandardError={() => {}}
      />
    )
    // 加载完成前：低清底图 + standard（opacity-0 待淡入）
    expect(container.querySelectorAll('img')).toHaveLength(2)
    const standard = screen.getByAltText('a')
    expect(standard.getAttribute('src')).toBe(STD)
    expect(standard.className).toContain('opacity-0')
    fireEvent.load(standard)
    expect(standard.className).toContain('opacity-100')
    expect(container.querySelectorAll('img')).toHaveLength(1)
  })

  it('正常：showStandard 且 standard 未加载 → 双图并存（standard opacity-0）', () => {
    const { container } = render(
      <TieredCardImage
        lowUrl={LOW}
        standardUrl={STD}
        showStandard
        alt="a"
        onLowError={() => {}}
        onStandardError={() => {}}
      />
    )
    expect(container.querySelectorAll('img')).toHaveLength(2)
    expect(screen.getByAltText('a').className).toContain('opacity-0')
  })

  it('正常：无低清档（lowUrl=null）→ standard 直接完整显示，不淡入', () => {
    const { container } = render(
      <TieredCardImage
        lowUrl={null}
        standardUrl={STD}
        showStandard
        alt="a"
        onLowError={() => {}}
        onStandardError={() => {}}
      />
    )
    const standard = screen.getByAltText('a')
    expect(standard.className).toContain('opacity-100')
    expect(container.querySelectorAll('img')).toHaveLength(1)
  })

  it('异常：standard onError → onStandardError 被调用（回退链交由父组件）', () => {
    const onStandardError = vi.fn()
    const onLowError = vi.fn()
    render(
      <TieredCardImage
        lowUrl={LOW}
        standardUrl={STD}
        showStandard
        alt="a"
        onLowError={onLowError}
        onStandardError={onStandardError}
      />
    )
    fireEvent.error(screen.getByAltText('a'))
    expect(onStandardError).toHaveBeenCalledTimes(1)
    expect(onLowError).not.toHaveBeenCalled()
  })

  it('异常：仅低清（showStandard=false）onError → onLowError 被调用', () => {
    const onStandardError = vi.fn()
    const onLowError = vi.fn()
    render(
      <TieredCardImage
        lowUrl={LOW}
        standardUrl={STD}
        showStandard={false}
        alt="a"
        onLowError={onLowError}
        onStandardError={onStandardError}
      />
    )
    fireEvent.error(screen.getByAltText('a'))
    expect(onLowError).toHaveBeenCalledTimes(1)
    expect(onStandardError).not.toHaveBeenCalled()
  })

  it('边界：showStandard=false → 仅渲染低清单图', () => {
    const { container } = render(
      <TieredCardImage
        lowUrl={LOW}
        standardUrl={STD}
        showStandard={false}
        alt="a"
        onLowError={() => {}}
        onStandardError={() => {}}
      />
    )
    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(screen.getByAltText('a').getAttribute('src')).toBe(LOW)
  })

  it('边界：standardUrl 为空字符串 → 不渲染任何 img', () => {
    const { container } = render(
      <TieredCardImage
        lowUrl={LOW}
        standardUrl=""
        showStandard
        alt="a"
        onLowError={() => {}}
        onStandardError={() => {}}
      />
    )
    expect(container.querySelectorAll('img')).toHaveLength(0)
  })
})
