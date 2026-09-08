/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/components/gallery（多选接线）
 * @coverage 五种视图均支持 multiSelectMode、GalleryPage 全量透传、GalleryToolbar 提供切换按钮
 *
 * 测试策略：
 * - 渲染级：以 MasonryView 为真实渲染样本（jsdom 下需注入 clientWidth/Height）
 * - 结构级：其余视图与页面/工具栏用源码断言（复用 GalleryPage.test.tsx 既有模式），
 *   避免为虚拟列表引入脆弱 mock
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
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

const files: MediaFile[] = Array.from({ length: 6 }, (_, i) =>
  makeFile(String(i + 1), 200, [300, 150, 400, 250][i % 4])
)

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

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), ...rel.split('/')), 'utf-8')
}

describe('多选接线｜正常流程（渲染级）', () => {
  it('multiSelectMode=true 时每张卡片应渲染勾选框', () => {
    render(
      <MasonryView
        files={files}
        selectedIds={['1']}
        onSelect={() => {}}
        onToggleSelection={() => {}}
        multiSelectMode={true}
      />
    )
    expect(document.querySelectorAll('.media-card').length).toBe(6)
    expect(screen.getAllByRole('checkbox').length).toBe(6)
    // 已选中项的勾选框 aria-checked=true
    const checked = screen
      .getAllByRole('checkbox')
      .filter((el) => el.getAttribute('aria-checked') === 'true')
    expect(checked.length).toBe(1)
  })

  it('点击勾选框应回调 onToggleSelection 且不冒泡触发 onSelect', () => {
    const onSelect = vi.fn()
    const onToggleSelection = vi.fn()
    render(
      <MasonryView
        files={files}
        selectedIds={[]}
        onSelect={onSelect}
        onToggleSelection={onToggleSelection}
        multiSelectMode={true}
      />
    )
    const card = document.querySelector('[data-media-id="3"]') as HTMLElement
    const box = card.querySelector('[data-testid="media-checkbox"]') as HTMLElement
    expect(box).toBeTruthy()
    fireEvent.click(box)

    expect(onToggleSelection).toHaveBeenCalledWith('3')
    expect(onSelect, '勾选框点击不得冒泡到卡片').not.toHaveBeenCalled()
  })
})

describe('多选接线｜边界条件（向后兼容）', () => {
  it('multiSelectMode 未传时不应渲染勾选框（既有调用点行为不变）', () => {
    render(<MasonryView files={files} selectedIds={[]} onSelect={() => {}} />)
    expect(screen.queryAllByRole('checkbox').length).toBe(0)
  })

  it('multiSelectMode=false 时不应渲染勾选框', () => {
    render(
      <MasonryView files={files} selectedIds={[]} onSelect={() => {}} multiSelectMode={false} />
    )
    expect(screen.queryAllByRole('checkbox').length).toBe(0)
  })

  it('空列表 + 多选模式不应渲染勾选框', () => {
    render(<MasonryView files={[]} selectedIds={[]} onSelect={() => {}} multiSelectMode={true} />)
    expect(screen.queryAllByRole('checkbox').length).toBe(0)
  })
})

describe('多选接线｜五种视图结构契约', () => {
  const viewFiles = [
    'src/renderer/components/gallery/VirtualImageGrid.tsx',
    'src/renderer/components/gallery/ListView.tsx',
    'src/renderer/components/gallery/MasonryView.tsx',
    'src/renderer/components/gallery/TimelineView.tsx',
    'src/renderer/components/gallery/EventTimelineView.tsx'
  ]

  for (const rel of viewFiles) {
    it(`${path.basename(rel)} 应声明可选的 multiSelectMode prop`, () => {
      expect(readSrc(rel)).toMatch(/multiSelectMode\?: boolean/)
    })
  }

  it('GalleryPage 应向五种视图透传 multiSelectMode', () => {
    const src = readSrc('src/renderer/pages/GalleryPage.tsx')
    const passed = src.match(/multiSelectMode=\{multiSelectMode\}/g) || []
    expect(passed.length, '五个视图调用点均需透传 multiSelectMode').toBeGreaterThanOrEqual(5)
  })

  it('GalleryToolbar 应提供带 aria-pressed 的多选切换按钮', () => {
    const src = readSrc('src/renderer/components/gallery/GalleryToolbar.tsx')
    expect(src).toContain('multiSelectMode')
    expect(src).toContain('aria-pressed')
    expect(src).toContain('onToggleMultiSelect')
  })
})
