/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/components/gallery（批量模式收藏按钮接线）
 * @coverage 批量选择模式下五视图每条记录常驻收藏图标、点击即时切换、与勾选互不冲突
 *
 * 测试策略：
 * - 渲染级：VirtualImageGrid（mock react-virtuoso 透传 itemContent + thumb.test.tsx mock 清单）
 *   与 MasonryView（jsdom 注入 clientWidth/Height 的既有模式）做真实 DOM 断言；
 * - 结构级：ListView / TimelineView / EventTimelineView 与 GalleryPage 用源码断言
 *   （复用 media-card-selection.test.tsx 既有模式，避免为虚拟列表引入脆弱 mock）。
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import fs from 'fs'
import path from 'path'

// —— VirtualImageGrid 渲染级 mock 清单（沿用 VirtualImageGrid.thumb.test.tsx 先例）——
// VirtuosoGrid 透传渲染全部 itemContent，并在外包一层带 data-card-id 的容器便于按卡定位
vi.mock('react-virtuoso', () => ({
  VirtuosoGrid: ({
    data,
    itemContent
  }: {
    data: unknown[]
    itemContent: (index: number, file: unknown) => React.ReactNode
  }) => (
    <>
      {(data as { id: string }[]).map((f, i) => (
        <div key={f.id} data-card-id={f.id}>
          {itemContent(i, f)}
        </div>
      ))}
    </>
  )
}))
vi.mock('../../stores/mediaStore', () => ({ toFileUrl: (p: string) => `file:///${p}` }))
vi.mock('../../utils/format', () => ({ formatFileSize: () => '' }))
vi.mock('../../icons', () => ({
  IconEdit: () => null,
  IconFavorite: () => null,
  IconDelete: () => null,
  IconCheck: () => null,
  IconStar: () => null
}))
vi.mock('../common/MissingBadge', () => ({ MissingBadge: () => null }))
vi.mock('../common/CorruptedBadge', () => ({ CorruptedBadge: () => null }))
vi.mock('./MediaThumbPlaceholder', () => ({ MediaThumbPlaceholder: () => null }))
vi.mock('../common/ThumbReveal', () => ({ ThumbReveal: () => null }))
vi.mock('./MediaCheckbox', () => ({ MediaCheckbox: () => null }))
vi.mock('../../hooks/useFailedImages', () => ({
  useFailedImages: () => ({
    failedImages: new Set(),
    markFailed: () => {},
    clearFailed: () => {}
  })
}))
vi.mock('../../hooks/useIsScrolling', () => ({ useIsScrolling: () => ({ current: false }) }))
vi.mock('../../hooks/useOnDemandThumbnails', () => ({
  useOnDemandThumbnails: () => ({
    ensureThumbnail: () => Promise.resolve(null),
    getGeneratedPath: () => undefined,
    hasFailed: () => false
  })
}))
vi.mock('../../utils/responsive', () => ({
  getResponsiveColumns: () => 4,
  DEFAULT_COLUMNS_BREAKPOINTS: {}
}))

import { VirtualImageGrid } from './VirtualImageGrid'
import { MasonryView } from './MasonryView'
import type { MediaFile } from '../../stores/mediaStore'

function makeFile(id: string, isFavorite = 0): MediaFile {
  return {
    id,
    file_name: `file-${id}.png`,
    file_path: `/tmp/${id}.png`,
    thumbnail: `/tmp/${id}.png`,
    file_type: 'image',
    width: 200,
    height: 300,
    is_favorite: isFavorite,
    is_missing: false,
    is_corrupted: false
  } as unknown as MediaFile
}

// 3 条记录，file-2 已收藏
const files: MediaFile[] = [makeFile('1'), makeFile('2', 1), makeFile('3')]

// jsdom 会按 IDL 在 window（原型）上定义 ontouchstart，使组件误判为触屏设备，
// 收藏徽标分支被 !isTouchDevice 门控而不渲染。此处移除该属性还原桌面语义。
// 同时注入固定 clientWidth/Height 驱动 masonic 布局（MasonryView 渲染级用例需要）。
beforeAll(() => {
  const win = window as unknown as Record<string, unknown>
  const proto = Object.getPrototypeOf(window) as Record<string, unknown> | null
  if (proto && 'ontouchstart' in proto) delete proto.ontouchstart
  delete win.ontouchstart
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 1200
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 4000
  })
})

function favOfCard(id: string): HTMLElement {
  const card = document.querySelector(`[data-card-id="${id}"]`) as HTMLElement
  return card.querySelector('[data-testid="media-favorite"]') as HTMLElement
}

describe('VirtualImageGrid｜批量模式收藏按钮（渲染级）', () => {
  it('正常：批量模式下每张卡片渲染收藏按钮，aria-pressed 与收藏态对应', () => {
    render(
      <VirtualImageGrid
        items={files}
        selectedIds={[]}
        onSelect={() => {}}
        onHover={() => {}}
        onContextMenu={() => {}}
        onFavorite={() => {}}
        multiSelectMode
        onToggleSelection={() => {}}
      />
    )
    const buttons = screen.getAllByTestId('media-favorite')
    expect(buttons.length).toBe(3)
    expect(favOfCard('1').getAttribute('aria-pressed')).toBe('false')
    expect(favOfCard('2').getAttribute('aria-pressed')).toBe('true')
    expect(favOfCard('3').getAttribute('aria-pressed')).toBe('false')
  })

  it('交互：点击收藏按钮回调 onFavorite(file)，不触发勾选与卡片点击', () => {
    const onFavorite = vi.fn()
    const onSelect = vi.fn()
    const onToggleSelection = vi.fn()
    render(
      <VirtualImageGrid
        items={files}
        selectedIds={[]}
        onSelect={onSelect}
        onHover={() => {}}
        onContextMenu={() => {}}
        onFavorite={onFavorite}
        multiSelectMode
        onToggleSelection={onToggleSelection}
      />
    )
    fireEvent.click(favOfCard('3'))
    expect(onFavorite).toHaveBeenCalledWith(files[2])
    expect(
      onSelect,
      '收藏点击不得冒泡触发卡片点击（批量模式裸点是切换勾选）'
    ).not.toHaveBeenCalled()
    expect(onToggleSelection).not.toHaveBeenCalled()
  })

  it('边界：非批量模式下仅已收藏卡片渲染收藏按钮（静态徽标升级为可点击）', () => {
    render(
      <VirtualImageGrid
        items={files}
        selectedIds={[]}
        onSelect={() => {}}
        onHover={() => {}}
        onContextMenu={() => {}}
        onFavorite={() => {}}
      />
    )
    const buttons = screen.getAllByTestId('media-favorite')
    expect(buttons.length).toBe(1)
    expect(favOfCard('2').getAttribute('aria-pressed')).toBe('true')
  })

  it('边界：未传 onFavorite 时不渲染收藏按钮（既有调用点行为不变）', () => {
    render(
      <VirtualImageGrid
        items={files}
        selectedIds={[]}
        onSelect={() => {}}
        onHover={() => {}}
        onContextMenu={() => {}}
        multiSelectMode
        onToggleSelection={() => {}}
      />
    )
    expect(screen.queryAllByTestId('media-favorite')).toHaveLength(0)
  })
})

describe('MasonryView｜批量模式收藏按钮（渲染级）', () => {
  it('正常：批量模式下每张卡片渲染收藏按钮，aria-pressed 与收藏态对应', () => {
    render(
      <MasonryView
        files={files}
        selectedIds={[]}
        onSelect={() => {}}
        onFavorite={() => {}}
        multiSelectMode
        onToggleSelection={() => {}}
      />
    )
    const buttons = screen.getAllByTestId('media-favorite')
    expect(buttons.length).toBe(3)
    const card1 = document.querySelector('[data-media-id="1"]') as HTMLElement
    const card2 = document.querySelector('[data-media-id="2"]') as HTMLElement
    expect(
      (card1.querySelector('[data-testid="media-favorite"]') as HTMLElement).getAttribute(
        'aria-pressed'
      )
    ).toBe('false')
    expect(
      (card2.querySelector('[data-testid="media-favorite"]') as HTMLElement).getAttribute(
        'aria-pressed'
      )
    ).toBe('true')
  })

  it('交互：点击收藏按钮回调 onFavorite(file)，不触发勾选与卡片点击', () => {
    const onFavorite = vi.fn()
    const onSelect = vi.fn()
    const onToggleSelection = vi.fn()
    render(
      <MasonryView
        files={files}
        selectedIds={[]}
        onSelect={onSelect}
        onFavorite={onFavorite}
        multiSelectMode
        onToggleSelection={onToggleSelection}
      />
    )
    const card3 = document.querySelector('[data-media-id="3"]') as HTMLElement
    fireEvent.click(card3.querySelector('[data-testid="media-favorite"]') as HTMLElement)
    expect(onFavorite).toHaveBeenCalledWith(files[2])
    expect(onSelect, '收藏点击不得冒泡触发卡片点击').not.toHaveBeenCalled()
    expect(onToggleSelection).not.toHaveBeenCalled()
  })

  it('边界：非批量模式下仅已收藏卡片渲染收藏按钮', () => {
    render(<MasonryView files={files} selectedIds={[]} onSelect={() => {}} onFavorite={() => {}} />)
    expect(screen.getAllByTestId('media-favorite').length).toBe(1)
  })
})

/** 读取组件源码并剔除整行注释，避免修复说明注释误命中断言（media-card-selection.test.tsx 先例） */
function readCode(...segments: string[]): string {
  const src = fs.readFileSync(path.resolve(process.cwd(), ...segments), 'utf-8')
  return src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

describe('四视图与 GalleryPage｜收藏按钮接线（结构级）', () => {
  const VIEW_FILES = ['ListView.tsx', 'TimelineView.tsx', 'EventTimelineView.tsx'] as const

  for (const file of VIEW_FILES) {
    it(`核心：${file} 渲染 MediaFavoriteButton 收藏按钮分支`, () => {
      const code = readCode('src', 'renderer', 'components', 'gallery', file)
      expect(code).toContain('MediaFavoriteButton')
      expect(code).toContain('multiSelectMode || file.is_favorite')
    })
  }

  it('核心：GalleryPage 五个视图调用均传 onFavorite={fileOperations.handleToggleFavorite}', () => {
    const code = readCode('src', 'renderer', 'pages', 'GalleryPage.tsx')
    const count = (code.match(/onFavorite=\{fileOperations\.handleToggleFavorite\}/g) ?? []).length
    expect(count).toBe(5)
  })
})
