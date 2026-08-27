import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MasonryView } from './MasonryView'
import type { MediaFile } from '../../stores/mediaStore'

function makeFile(id: string, w: number, h: number): MediaFile {
  return {
    id,
    file_name: `file-${id}.png`,
    file_path: `/tmp/${id}.png`,
    thumbnail: `/tmp/${id}.png`,
    file_type: 'image',
    width: w,
    height: h,
    is_missing: false,
    is_corrupted: false
  } as unknown as MediaFile
}

const files: MediaFile[] = Array.from({ length: 12 }, (_, i) =>
  makeFile(String(i + 1), 200, [300, 150, 400, 250][i % 4])
)

// jsdom 下 HTMLElement.clientWidth/Height 默认 0，手动注入固定尺寸以驱动布局
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 1200
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 4000
  })
})

afterEach(() => {
  cleanup()
})

describe('MasonryView', () => {
  it('正常渲染且无重复 DOM 节点（无重叠）', () => {
    render(
      <MasonryView files={files} selectedIds={[]} onSelect={() => {}} onContextMenu={() => {}} />
    )
    const nodes = document.querySelectorAll('.media-card')
    expect(nodes.length).toBe(12)
    const ids = Array.from(nodes).map((n) => n.getAttribute('data-media-id'))
    // 每个文件仅渲染一次 → 无重影/重叠
    expect(new Set(ids).size).toBe(12)
  })

  it('空数组渲染空容器', () => {
    render(<MasonryView files={[]} selectedIds={[]} onSelect={() => {}} />)
    expect(document.querySelectorAll('.media-card').length).toBe(0)
    expect(screen.getByRole('feed')).toBeTruthy()
  })

  it('非法 files 兜底：不抛错、渲染空容器、onSelect 未被调用', () => {
    const onSelect = vi.fn()
    expect(() =>
      render(
        <MasonryView files={null as unknown as MediaFile[]} selectedIds={[]} onSelect={onSelect} />
      )
    ).not.toThrow()
    expect(document.querySelectorAll('.media-card').length).toBe(0)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('选中态与点击回调', () => {
    const onSelect = vi.fn()
    render(<MasonryView files={files} selectedIds={['2']} onSelect={onSelect} />)
    const card = document.querySelector('[data-media-id="2"]') as HTMLElement
    expect(card).toBeTruthy()
    fireEvent.click(card)
    expect(onSelect).toHaveBeenCalledWith('2', expect.any(Number), expect.anything())
  })

  it('图片加载失败降级为占位图', () => {
    render(<MasonryView files={files} selectedIds={[]} onSelect={() => {}} />)
    const card = document.querySelector('[data-media-id="1"]') as HTMLElement
    const img = card.querySelector('[data-testid="thumb"]') as HTMLImageElement
    expect(img).toBeTruthy()
    fireEvent.error(img)
    // 该卡片的缩略图被移除，降级为占位图；其余卡片不受影响
    expect(card.querySelector('[data-testid="thumb"]')).toBeNull()
    expect(document.querySelectorAll('[data-testid="thumb"]').length).toBe(11)
  })
})
