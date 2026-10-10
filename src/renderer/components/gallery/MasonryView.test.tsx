import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import fs from 'fs'
import path from 'path'
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

/**
 * 缩略图源统一（fix-thumbnail-display-and-latency N1）。
 * 缺陷：`toFileUrl(file.thumbnail || file.file_path)` 对 thumbnail 为空的视频回退用
 * 「原视频文件」作 <img> 源 → 浏览器无法解码视频必裂图（网格视图已有同类修复，
 * 本组用例同步防护瀑布流视图）。
 */
describe('MasonryView 缩略图源（N1）', () => {
  const makeVideo = (overrides: Record<string, unknown>): MediaFile =>
    ({
      ...makeFile('v1', 200, 300),
      file_name: 'clip01.mp4',
      file_path: '/tmp/v1.mp4',
      file_type: 'video',
      ...overrides
    }) as unknown as MediaFile

  it('异常：视频无缩略图 → 不得以视频文件作 <img> 源（裂图根因）', () => {
    render(
      <MasonryView
        files={[makeVideo({ thumbnail: undefined })]}
        selectedIds={[]}
        onSelect={() => {}}
      />
    )
    expect(document.querySelector('[data-testid="thumb"]')).toBeNull()
  })

  it('正常：视频有缩略图 → img 正常渲染', () => {
    render(
      <MasonryView
        files={[makeVideo({ thumbnail: '/cache/abc.jpg' })]}
        selectedIds={[]}
        onSelect={() => {}}
      />
    )
    expect(document.querySelector('[data-testid="thumb"]')).toBeTruthy()
  })

  it('正常：可见图片无缩略图 → 按需生成后显示缩略图', async () => {
    const filePath = `/tmp/masonry-${Date.now()}.jpg`
    const generatedPath = '/cache/masonry-generated.jpg'
    const generate = vi.fn().mockResolvedValue(generatedPath)
    const originalElectronApi = window.electronAPI
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { thumbnail: { generate } }
    })

    try {
      render(
        <MasonryView
          files={[
            makeFile('missing', 200, 300),
            {
              ...makeFile('target', 200, 300),
              file_path: filePath,
              thumbnail: undefined
            }
          ]}
          selectedIds={[]}
          onSelect={() => {}}
        />
      )
      expect(document.querySelector(`[data-media-id="target"] [data-testid="thumb"]`)).toBeNull()
      await waitFor(() => expect(generate).toHaveBeenCalledWith(filePath))
      await waitFor(() =>
        expect(
          document
            .querySelector(`[data-media-id="target"] [data-testid="thumb"]`)
            ?.getAttribute('src')
        ).toBe(`media://file?path=${encodeURIComponent(generatedPath)}`)
      )
    } finally {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: originalElectronApi
      })
    }
  })

  it('结构：不得存在原图回退，可见卡片统一走共享 Hook', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/gallery/MasonryView.tsx'),
      'utf-8'
    )
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n')
    expect(code).not.toContain('toFileUrl(file.thumbnail || file.file_path)')
    expect(code).toContain('useOnDemandThumbnails()')
    expect(code).toContain('ensureThumbnail(file)')
    expect(code).toContain('getGeneratedPath(file.file_path)')
  })
})

describe('MasonryView 骨架门控直显（fix-thumbnail-skeleton-reveal N5）', () => {
  it('img 加载完成前显示骨架动画层，onLoad 后骨架卸载、img 淡入', () => {
    render(<MasonryView files={files} selectedIds={[]} onSelect={() => {}} />)
    const card = document.querySelector('[data-media-id="1"]') as HTMLElement
    const img = card.querySelector('[data-testid="thumb"]') as HTMLImageElement
    expect(img).toBeTruthy()
    // 未加载：img 透明 + 该卡片骨架层可见
    expect(img.className).toContain('opacity-0')
    expect(card.querySelector('.skeleton')).toBeTruthy()
    // 加载完成：该卡片骨架卸载（其余未 load 的卡片骨架保留）
    fireEvent.load(img)
    expect(img.className).toContain('opacity-100')
    expect(card.querySelector('.skeleton')).toBeNull()
  })

  it('结构：裸 <img> 已替换为 ThumbReveal 骨架门控组件', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/gallery/MasonryView.tsx'),
      'utf-8'
    )
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n')
    expect(code).toContain('<ThumbReveal')
    expect(code).not.toContain('<img')
  })
})
