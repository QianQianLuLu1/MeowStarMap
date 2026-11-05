/**
 * @layer L3
 * @module src/renderer/components/gallery/SlideshowPlayer
 * @coverage 幻灯片播放器根容器 no-drag 接线（topbar-fix 同病同修）
 * @dependencies @testing-library/react + useUIStore + useMediaStore（jsdom）
 * @remarks
 *   缺陷复位（修复前）：幻灯片模式（从全屏工具栏播放按钮进入）顶栏「退出」按钮同在
 *   窗口顶部 40px 的 TitleBar .app-drag 拖拽条内——Electron 拖拽区不感知遮挡，覆盖层
 *   之上 mousedown 仍被窗口拖动吞掉。根容器须声明 .app-no-drag 做几何减法。
 *
 *   断言口径：jsdom 不模拟 app-region 命中测试，断言 class 存在性（真实拖拽行为由
 *   docs/plans/archive/2026-Q4/2026-11-01-fullscreen-topbar-fix-实施计划.md T5 真机实测兜底）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { SlideshowPlayer } from './SlideshowPlayer'
import { useUIStore } from '../../stores/uiStore'
import { useMediaStore, type MediaFile } from '../../stores/mediaStore'

function makeFile(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    id: '1',
    file_path: 'C:\\media\\k1.jpg',
    file_name: 'k1.jpg',
    file_type: 'image',
    file_ext: '.jpg',
    file_size: 1024,
    created_at: '2026-01-01T00:00:00.000Z',
    modified_at: '2026-01-01T00:00:00.000Z',
    thumbnail: 'C:\\cache\\thumb.jpg',
    tags: [],
    rating: 0,
    is_favorite: false,
    notes: '',
    scene_category: 'other',
    width: 1920,
    height: 1080,
    ...overrides
  }
}

function resetStores(): void {
  useMediaStore.setState({ mediaFiles: [] })
  useUIStore.setState({
    slideshowOpen: false,
    slideshowStartIndex: 0,
    fullscreenOpen: false,
    fullscreenIndex: 0,
    fullscreenFiles: null,
    fullscreenTargetImg: null
  })
}

function openSlideshow(startIndex = 0): void {
  useUIStore.setState({ slideshowOpen: true, slideshowStartIndex: startIndex })
}

let files: MediaFile[] = []

beforeEach(() => {
  files = [makeFile({ id: '1', file_name: 'k1.jpg' }), makeFile({ id: '2', file_name: 'k2.jpg' })]
  resetStores()
  openSlideshow()
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  resetStores()
})

describe('幻灯片播放器根容器 no-drag（topbar-fix）', () => {
  it('点击修复：根容器声明 app-no-drag（顶栏退出按钮同在 TitleBar 40px 拖拽条内，需 no-drag 减法）', () => {
    render(<SlideshowPlayer filteredFiles={files} />)

    const root = document.querySelector('div.fixed.inset-0')
    expect(root, '幻灯片播放器未渲染').not.toBeNull()
    // z-[85]：确认定位到的确实是幻灯片根容器（与全屏查看器 z-[80] 区分）
    expect(root?.classList.contains('z-[85]')).toBe(true)
    expect(
      root?.classList.contains('app-no-drag'),
      '幻灯片根容器缺少 .app-no-drag：顶部拖拽条吞掉「退出」按钮点击'
    ).toBe(true)
  })

  it('边界：关闭幻灯片后组件不渲染（不残留 no-drag 覆盖）', () => {
    const { unmount } = render(<SlideshowPlayer filteredFiles={files} />)
    expect(document.querySelector('div.fixed.inset-0')).not.toBeNull()
    unmount()
    resetStores()
    render(<SlideshowPlayer filteredFiles={files} />)
    expect(document.querySelector('div.fixed.inset-0')).toBeNull()
  })
})
