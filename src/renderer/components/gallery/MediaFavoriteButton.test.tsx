/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/components/gallery/MediaFavoriteButton
 * @coverage 卡片收藏按钮：受控收藏态、无障碍属性、点击冒泡隔离（批量模式常驻收藏切换）
 *
 * 测试策略：真实 render + fireEvent，验证正常流程（收藏/取消切换与文案）、
 * 异常流程（点击不得冒泡到卡片容器，避免连带勾选/打开全屏）、
 * 边界条件（不传 label 回退 i18n 文案、自定义 className 透传）。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MediaFavoriteButton } from './MediaFavoriteButton'

describe('MediaFavoriteButton｜正常流程', () => {
  it('应渲染 button 且 aria-pressed 反映未收藏态', () => {
    render(<MediaFavoriteButton isFavorite={false} onToggle={() => {}} />)
    const btn = screen.getByTestId('media-favorite')
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('aria-pressed')).toBe('false')
  })

  it('已收藏态应设置 aria-pressed=true 且 title 为取消收藏', () => {
    render(<MediaFavoriteButton isFavorite={true} onToggle={() => {}} />)
    const btn = screen.getByTestId('media-favorite')
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(btn.getAttribute('title')).toBe('取消收藏')
  })

  it('未收藏态 title 应为收藏', () => {
    render(<MediaFavoriteButton isFavorite={false} onToggle={() => {}} />)
    expect(screen.getByTestId('media-favorite').getAttribute('title')).toBe('收藏')
  })

  it('点击应回调 onToggle 一次', () => {
    const onToggle = vi.fn()
    render(<MediaFavoriteButton isFavorite={false} onToggle={onToggle} />)
    fireEvent.click(screen.getByTestId('media-favorite'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})

describe('MediaFavoriteButton｜异常流程（冒泡隔离）', () => {
  it('点击收藏按钮不应冒泡触发卡片的 onClick（批量模式下卡片裸点是切换勾选）', () => {
    const onCardClick = vi.fn()
    const onToggle = vi.fn()
    render(
      <div onClick={onCardClick}>
        <MediaFavoriteButton isFavorite={false} onToggle={onToggle} />
      </div>
    )
    fireEvent.click(screen.getByTestId('media-favorite'))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(
      onCardClick,
      '收藏点击必须 stopPropagation，否则会连带切换勾选/打开全屏'
    ).not.toHaveBeenCalled()
  })

  it('mousedown / dblclick / contextmenu 同样不应冒泡到卡片', () => {
    const onCardMouseDown = vi.fn()
    const onCardDoubleClick = vi.fn()
    const onCardContextMenu = vi.fn()
    render(
      <div
        onMouseDown={onCardMouseDown}
        onDoubleClick={onCardDoubleClick}
        onContextMenu={onCardContextMenu}
      >
        <MediaFavoriteButton isFavorite={true} onToggle={() => {}} />
      </div>
    )
    const btn = screen.getByTestId('media-favorite')
    fireEvent.mouseDown(btn)
    fireEvent.doubleClick(btn)
    fireEvent.contextMenu(btn)
    expect(onCardMouseDown).not.toHaveBeenCalled()
    expect(onCardDoubleClick).not.toHaveBeenCalled()
    expect(onCardContextMenu).not.toHaveBeenCalled()
  })
})

describe('MediaFavoriteButton｜边界条件', () => {
  it('不传 label 时 aria-label 回退到 i18n 收藏文案，不抛错', () => {
    render(<MediaFavoriteButton isFavorite={false} onToggle={() => {}} />)
    expect(screen.getByTestId('media-favorite').getAttribute('aria-label')).toBe('收藏')
  })

  it('自定义 className 应追加到按钮上（供父级定位）', () => {
    render(
      <MediaFavoriteButton
        isFavorite={false}
        onToggle={() => {}}
        className="absolute top-2 right-2 z-10"
      />
    )
    expect(screen.getByTestId('media-favorite').className).toContain('absolute top-2 right-2')
  })

  it('isFavorite 传入 SQLite 布尔 0/1 数值时按布尔归一化', () => {
    render(<MediaFavoriteButton isFavorite={1 as unknown as boolean} onToggle={() => {}} />)
    expect(screen.getByTestId('media-favorite').getAttribute('aria-pressed')).toBe('true')
  })
})
