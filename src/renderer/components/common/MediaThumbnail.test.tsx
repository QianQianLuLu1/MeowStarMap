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

/**
 * 可选 fallbackSrc 低清回退（fix-thumbnail-loading-latency 节点4）：
 * src 加载失败且提供 fallbackSrc 时切换显示一次（重复文件页 standard 404 时回退 64px 低清，
 * 不再死胡同警告图标）；fallback 再失败才终止为占位；未提供时保持既有行为不变。
 */
describe('MediaThumbnail｜fallbackSrc 低清回退', () => {
  it('src 加载失败且有 fallbackSrc → 切换到 fallbackSrc（不死胡同警告图标）', () => {
    render(
      <MediaThumbnail
        src="media://std.jpg"
        alt="x"
        fileType="image"
        fallbackSrc="media://low.jpg"
      />
    )
    expect(screen.getByAltText('x').getAttribute('src')).toBe('media://std.jpg')
    fireEvent.error(screen.getByAltText('x'))
    expect(screen.getByAltText('x').getAttribute('src')).toBe('media://low.jpg')
    // 未终止为失败占位
    expect(screen.queryByTestId('placeholder')).toBeNull()
  })

  it('fallbackSrc 也加载失败 → 移除 img 显示失败占位（防循环，仅切换一次）', () => {
    render(
      <MediaThumbnail
        src="media://std.jpg"
        alt="x"
        fileType="image"
        fallbackSrc="media://low.jpg"
      />
    )
    fireEvent.error(screen.getByAltText('x'))
    expect(screen.getByAltText('x').getAttribute('src')).toBe('media://low.jpg')
    fireEvent.error(screen.getByAltText('x'))
    expect(screen.queryByAltText('x')).toBeNull()
    expect(screen.getByTestId('placeholder').getAttribute('data-has-error')).toBe('true')
  })

  it('fallbackSrc 为 null → 等价于未提供，onError 直接显示失败占位（游戏原生缩略图无 _low 场景）', () => {
    render(<MediaThumbnail src="media://std.jpg" alt="x" fileType="image" fallbackSrc={null} />)
    fireEvent.error(screen.getByAltText('x'))
    expect(screen.queryByAltText('x')).toBeNull()
    expect(screen.getByTestId('placeholder').getAttribute('data-has-error')).toBe('true')
  })
})

/**
 * 骨架门控直显（fix-thumbnail-skeleton-reveal N5）：
 * img onLoad 完成前保持透明并显示骨架动画层（"加载中"≠"失败"）；onLoad 后骨架卸载、
 * img 200ms 淡入直显——消灭"渐进加载可见过程"。失败仍走占位图标（错误态，非加载态）。
 */
describe('MediaThumbnail｜骨架门控直显（fix-thumbnail-skeleton-reveal N5）', () => {
  it('未 onLoad 前：img 透明（opacity-0）+ 骨架层显示，占位图标不显示', () => {
    render(<MediaThumbnail src="media://std.jpg" alt="x" fileType="image" />)
    expect(screen.getByAltText('x').className).toContain('opacity-0')
    expect(screen.getByAltText('x').className).not.toContain('opacity-100')
    expect(screen.getByTestId('media-thumbnail-skeleton')).toBeTruthy()
    expect(screen.queryByTestId('placeholder')).toBeNull()
  })

  it('onLoad 后：骨架卸载、img 淡入为 opacity-100', () => {
    render(<MediaThumbnail src="media://std.jpg" alt="x" fileType="image" />)
    fireEvent.load(screen.getByAltText('x'))
    expect(screen.getByAltText('x').className).toContain('opacity-100')
    expect(screen.getByAltText('x').className).not.toContain('opacity-0')
    expect(screen.queryByTestId('media-thumbnail-skeleton')).toBeNull()
  })

  it('onError 后：骨架卸载、显示失败占位（错误终态 ≠ 加载态）', () => {
    render(<MediaThumbnail src="bad.jpg" alt="x" fileType="image" />)
    fireEvent.error(screen.getByAltText('x'))
    expect(screen.queryByTestId('media-thumbnail-skeleton')).toBeNull()
    expect(screen.getByTestId('placeholder')).toBeTruthy()
  })

  it('src 变化（含 fallbackSrc 切换）：重置回未加载骨架态', () => {
    const { rerender } = render(<MediaThumbnail src="media://a.jpg" alt="x" fileType="image" />)
    fireEvent.load(screen.getByAltText('x'))
    expect(screen.queryByTestId('media-thumbnail-skeleton')).toBeNull()
    rerender(<MediaThumbnail src="media://b.jpg" alt="x" fileType="image" />)
    expect(screen.getByTestId('media-thumbnail-skeleton')).toBeTruthy()
    expect(screen.getByAltText('x').className).toContain('opacity-0')
  })

  it('竞态（审查修复 T3）：换源后旧源的迟到 load 不得撤掉新源骨架', () => {
    const { rerender, container } = render(
      <MediaThumbnail src="media://a.jpg" alt="x" fileType="image" />
    )
    const firstImg = screen.getByAltText('x')
    fireEvent.load(firstImg)
    expect(screen.queryByTestId('media-thumbnail-skeleton')).toBeNull()

    rerender(<MediaThumbnail src="media://b.jpg" alt="x" fileType="image" />)
    expect(screen.getByTestId('media-thumbnail-skeleton')).toBeTruthy()
    // 旧源 A 的 load 事件迟到（换源前已入队，目标为换源前的 img 元素）：
    // 不得让尚未加载完成的新源 B 提前撤骨架露出空白/旧像素
    fireEvent.load(firstImg)
    expect(screen.getByTestId('media-thumbnail-skeleton')).toBeTruthy()
    expect(screen.getByAltText('x').className).toContain('opacity-0')
    // 迟到事件的目标元素已被新 src 的元素替换（换源即重挂载）
    expect(container.querySelector('img')).not.toBe(firstImg)
  })
})
