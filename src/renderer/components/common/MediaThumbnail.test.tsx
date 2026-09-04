/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('./MissingBadge', () => ({
  MissingBadge: ({ size }: { size?: 'md' | 'sm' }) => (
    <div data-testid="missing-badge" data-size={size}>
      丢失
    </div>
  )
}))

vi.mock('../gallery/MediaThumbPlaceholder', () => ({
  MediaThumbPlaceholder: ({
    fileType,
    hasError,
    visible
  }: {
    fileType?: 'image' | 'video'
    hasError?: boolean
    visible?: boolean
  }) =>
    visible ? (
      <div
        data-testid="placeholder"
        data-file-type={fileType}
        data-has-error={hasError ? 'true' : 'false'}
      >
        占位
      </div>
    ) : null
}))

import { MediaThumbnail } from './MediaThumbnail'

describe('MediaThumbnail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('src 非空且未出错时渲染 img', () => {
    render(<MediaThumbnail src="http://example.com/thumb.jpg" alt="test" fileType="image" />)
    const img = screen.getByAltText('test')
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe('http://example.com/thumb.jpg')
  })

  it('img 默认带 loading=lazy 属性', () => {
    render(<MediaThumbnail src="x.jpg" alt="x" fileType="image" />)
    expect(screen.getByAltText('x').getAttribute('loading')).toBe('lazy')
  })

  it('src=null 时不渲染 img，渲染 placeholder', () => {
    render(<MediaThumbnail src={null} alt="x" fileType="image" />)
    expect(screen.queryByAltText('x')).toBeNull()
    expect(screen.getByTestId('placeholder')).toBeTruthy()
  })

  it('src=undefined 时不渲染 img', () => {
    render(<MediaThumbnail src={undefined} alt="x" fileType="image" />)
    expect(screen.queryByAltText('x')).toBeNull()
    expect(screen.getByTestId('placeholder')).toBeTruthy()
  })

  it('img onError 触发后渲染 placeholder 并隐藏 img', () => {
    render(<MediaThumbnail src="bad.jpg" alt="x" fileType="image" />)
    fireEvent.error(screen.getByAltText('x'))
    expect(screen.queryByAltText('x')).toBeNull()
    expect(screen.getByTestId('placeholder').getAttribute('data-has-error')).toBe('true')
  })

  it('placeholder 的 fileType 透传', () => {
    render(<MediaThumbnail src={null} alt="x" fileType="video" />)
    expect(screen.getByTestId('placeholder').getAttribute('data-file-type')).toBe('video')
  })

  it('isMissing=true 时渲染 MissingBadge', () => {
    render(<MediaThumbnail src="x.jpg" alt="x" fileType="image" isMissing={true} />)
    expect(screen.getByTestId('missing-badge')).toBeTruthy()
  })

  it('isMissing=false 时不渲染 MissingBadge', () => {
    render(<MediaThumbnail src="x.jpg" alt="x" fileType="image" isMissing={false} />)
    expect(screen.queryByTestId('missing-badge')).toBeNull()
  })

  it('badgeSize 默认 md', () => {
    render(<MediaThumbnail src="x.jpg" alt="x" fileType="image" isMissing={true} />)
    expect(screen.getByTestId('missing-badge').getAttribute('data-size')).toBe('md')
  })

  it('badgeSize=sm 透传到 MissingBadge', () => {
    render(<MediaThumbnail src="x.jpg" alt="x" fileType="image" isMissing={true} badgeSize="sm" />)
    expect(screen.getByTestId('missing-badge').getAttribute('data-size')).toBe('sm')
  })

  it('点击容器触发 onClick', () => {
    const onClick = vi.fn()
    const { container } = render(
      <MediaThumbnail src="x.jpg" alt="x" fileType="image" onClick={onClick} />
    )
    fireEvent.click(container.firstChild as Element)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('未传 onClick 时点击不报错', () => {
    expect(() => {
      const { container } = render(<MediaThumbnail src="x.jpg" alt="x" fileType="image" />)
      fireEvent.click(container.firstChild as Element)
    }).not.toThrow()
  })

  it('右键容器触发 onContextMenu', () => {
    const onContextMenu = vi.fn()
    const { container } = render(
      <MediaThumbnail src="x.jpg" alt="x" fileType="image" onContextMenu={onContextMenu} />
    )
    fireEvent.contextMenu(container.firstChild as Element)
    expect(onContextMenu).toHaveBeenCalledTimes(1)
  })

  it('className 透传到外层容器', () => {
    const { container } = render(
      <MediaThumbnail src="x.jpg" alt="x" fileType="image" className="custom" />
    )
    expect((container.firstChild as HTMLElement).className).toContain('custom')
  })

  it('imgClassName 透传到 img 元素', () => {
    render(<MediaThumbnail src="x.jpg" alt="x" fileType="image" imgClassName="my-img-class" />)
    expect(screen.getByAltText('x').className).toContain('my-img-class')
  })

  it('imgClassName 默认为 absolute inset-0 w-full h-full object-cover', () => {
    render(<MediaThumbnail src="x.jpg" alt="x" fileType="image" />)
    const cls = screen.getByAltText('x').className
    expect(cls).toContain('absolute')
    expect(cls).toContain('inset-0')
    expect(cls).toContain('w-full')
    expect(cls).toContain('h-full')
    expect(cls).toContain('object-cover')
  })
})
