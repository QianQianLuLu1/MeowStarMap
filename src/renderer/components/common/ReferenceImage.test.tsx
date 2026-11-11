/**
 * @vitest-environment jsdom
 *
 * ReferenceImage 契约：按需展示一张参考图片。
 * - 无 src（未授权/失败/预览/桥缺失）→ 同尺寸占位，不渲染 img；
 * - 有 src → <img loading="lazy" decoding="async">（懒加载、不预取）；
 * - img onError → 回退占位，不影响其余内容。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ReferenceImage } from './ReferenceImage'

const mockUseReferenceImage = vi.fn()

vi.mock('../../hooks/useReferenceImage', () => ({
  useReferenceImage: (...args: unknown[]) => mockUseReferenceImage(...args)
}))

beforeEach(() => {
  mockUseReferenceImage.mockReset()
})

describe('ReferenceImage — 正常', () => {
  it('有 src → 渲染 lazy img，尺寸与 alt 生效，hook 按 (kind,id) 调用', () => {
    mockUseReferenceImage.mockReturnValue({ src: 'media://file?path=%2Ftmp%2Fa.png' })
    render(<ReferenceImage kind="nikkiPose" id={42} size={32} alt="暖暖动作" />)
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('src', 'media://file?path=%2Ftmp%2Fa.png')
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(img).toHaveAttribute('decoding', 'async')
    expect(img).toHaveAttribute('width', '32')
    expect(img).toHaveAttribute('height', '32')
    expect(img).toHaveAttribute('alt', '暖暖动作')
    expect(mockUseReferenceImage).toHaveBeenCalledWith('nikkiPose', 42)
  })

  it('默认尺寸 24', () => {
    mockUseReferenceImage.mockReturnValue({ src: 'media://file?path=%2Ftmp%2Fa.png' })
    const { container } = render(<ReferenceImage kind="momoPose" id={7} />)
    expect(container.querySelector('img')).toHaveAttribute('width', '24')
  })
})

describe('ReferenceImage — 异常', () => {
  it('src=null → 仅占位、不渲染 img', () => {
    mockUseReferenceImage.mockReturnValue({ src: null })
    const { container } = render(<ReferenceImage kind="nikkiPose" id={42} />)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByTestId('reference-image-placeholder')).toBeInTheDocument()
  })

  it('img onError → 回退占位', () => {
    mockUseReferenceImage.mockReturnValue({ src: 'media://file?path=%2Ftmp%2Fa.png' })
    const { container } = render(<ReferenceImage kind="nikkiPose" id={42} />)
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByTestId('reference-image-placeholder')).toBeInTheDocument()
  })
})

describe('ReferenceImage — 边界', () => {
  it('占位与自定义尺寸一致（不破坏行布局）', () => {
    mockUseReferenceImage.mockReturnValue({ src: null })
    render(<ReferenceImage kind="nikkiPose" id={42} size={40} />)
    const placeholder = screen.getByTestId('reference-image-placeholder')
    expect(placeholder.style.width).toBe('40px')
    expect(placeholder.style.height).toBe('40px')
  })

  it('kind/id 变化时重置失败态（新图重新尝试渲染）', () => {
    mockUseReferenceImage.mockReturnValue({ src: 'media://file?path=%2Ftmp%2Fa.png' })
    const { rerender, container } = render(<ReferenceImage kind="nikkiPose" id={1} />)
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()
    mockUseReferenceImage.mockReturnValue({ src: 'media://file?path=%2Ftmp%2Fb.png' })
    rerender(<ReferenceImage kind="nikkiPose" id={2} />)
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'media://file?path=%2Ftmp%2Fb.png'
    )
  })
})
