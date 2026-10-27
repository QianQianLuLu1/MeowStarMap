/**
 * @layer L3
 * @module src/renderer/components/gallery/FullscreenViewer
 * @coverage 全屏预览顶部工具栏标识对比度（fullscreen-toolbar-contrast）：DOM 侧接线
 * @dependencies @testing-library/react + useUIStore + useMediaStore（jsdom）
 * @remarks
 *   与 src/renderer/styles/fullscreen-toolbar-contrast.test.ts 配套：该文件锁 CSS 契约，
 *   本文件锁组件接线——即「工具栏里的每个图标按钮真的带上了遮罩变体类、且不再内联硬编码
 *   半透明底」。两者缺一，缺陷都会复活。
 *
 *   缺陷复位（修复前）：
 *   - 7 个顶栏按钮 + 2 个左右导航按钮均写 `icon-btn text-[var(--text-on-overlay)]`，
 *     前景被 `.icon-btn` 盖成 --text-secondary(#666666)，hover 再变 --text-primary(#1a1a1a)；
 *   - 左右导航按钮另内联 `background: rgba(0,0,0,0.4)`（硬编码），白图标最坏仅 2.85:1；
 *   - 标题无 text-shadow，压在浅色照片 + 渐变透明处为白压白；
 *   - 播放间隔菜单选中项用 --accent，默认主题下压深底仅 2.78:1；
 *   - 收藏激活态用 --favorite，最坏情况仅 2.32:1。
 *
 *   断言口径：jsdom 不应用样式表，故只断言「内联 style 字符串」与 class，
 *   不依赖 computed 值（已实测 jsdom 完整保留 var() 语义，含 text-shadow）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { FullscreenViewer } from './FullscreenViewer'
import { useUIStore } from '../../stores/uiStore'
import { useMediaStore, type MediaFile } from '../../stores/mediaStore'

// 离屏预解码 Image 占位（useNeighborPrefetch 会 new Image()，避免挂起 / 报错）
class FakeImage {
  src = ''
  async decode(): Promise<void> {
    return
  }
}

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

function makeFiles(): MediaFile[] {
  return [
    makeFile({ id: '1', file_name: 'k1.jpg' }),
    makeFile({ id: '2', file_name: 'k2.jpg' }),
    makeFile({ id: '3', file_name: 'k3.jpg' })
  ]
}

function resetStores(): void {
  useMediaStore.setState({ mediaFiles: [] })
  useUIStore.setState({
    fullscreenOpen: false,
    fullscreenIndex: 0,
    fullscreenFiles: null,
    fullscreenTargetImg: null
  })
}

/** 渲染前即打开全屏，避免「先渲染后 setState」的时序抖动 */
function openFullscreen(files: MediaFile[], index = 0): void {
  useUIStore.setState({
    fullscreenOpen: true,
    fullscreenIndex: index,
    fullscreenFiles: files,
    fullscreenTargetImg: null
  })
}

/** 信息浮层（ExifPanel 等）会经 useExif 调 window.electronAPI.file.getExif，
    setup.ts 的 Proxy 占位只到第二层（`.file` 是 vi.fn，`.file.getExif` 为 undefined），
    展开信息面板会抛 TypeError，故本地补一层真实形状 */
const electronApi = {
  mediaAction: { updateFavorite: vi.fn().mockResolvedValue({ updated: true }), delete: vi.fn() },
  file: { getExif: vi.fn().mockResolvedValue(null), saveAs: vi.fn(), delete: vi.fn() },
  dialog: { selectDirectory: vi.fn() },
  video: { captureFrame: vi.fn(), metadata: vi.fn().mockResolvedValue({ success: false }) }
}

let files: MediaFile[] = []

beforeEach(() => {
  vi.stubGlobal('Image', FakeImage)
  ;(window as unknown as { electronAPI: unknown }).electronAPI = electronApi
  files = makeFiles()
  resetStores()
  openFullscreen(files)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  resetStores()
})

/** 全屏树内所有图标按钮（顶栏 7 个 + 当前可见的左右导航） */
function iconButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button.icon-btn'))
}

describe('全屏工具栏遮罩变体接线（fullscreen-toolbar-contrast）', () => {
  it('核心：每个图标按钮都带 .icon-btn-on-overlay（否则前景被 .icon-btn 压成 #666666）', () => {
    render(<FullscreenViewer filteredFiles={files} />)

    const buttons = iconButtons()
    expect(buttons.length, '顶栏 7 个 + 下一张，共 8 个图标按钮').toBeGreaterThanOrEqual(7)
    for (const btn of buttons) {
      expect(
        btn.classList.contains('icon-btn-on-overlay'),
        `按钮「${btn.getAttribute('aria-label') ?? btn.textContent}」缺少遮罩变体类`
      ).toBe(true)
    }
  })

  it('核心：按钮不再内联硬编码半透明底（左右导航原为 rgba(0,0,0,0.4)，白图标仅 2.85:1）', () => {
    render(<FullscreenViewer filteredFiles={files} />)

    for (const btn of iconButtons()) {
      expect(
        btn.style.background,
        `按钮「${btn.getAttribute('aria-label') ?? btn.textContent}」仍有内联底`
      ).toBe('')
    }
  })

  it('核心：标题带 text-shadow（浅色照片 + 渐变透明处原为白压白）', () => {
    render(<FullscreenViewer filteredFiles={files} />)

    const title = screen.getByText(/k1\.jpg/)
    expect(title.style.textShadow).toBe('var(--overlay-title-shadow)')
  })

  it('核心：工具栏渐变改走令牌，不再内联硬编码', () => {
    render(<FullscreenViewer filteredFiles={files} />)

    const toolbar = screen.getByText(/k1\.jpg/).parentElement
    expect(toolbar).not.toBeNull()
    expect(toolbar?.style.background).toBe('var(--overlay-gradient-top)')
  })

  it('核心：播放间隔菜单选中项改用 --accent-light（--accent 压深底仅 2.78:1）', () => {
    render(<FullscreenViewer filteredFiles={files} />)

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '播放间隔' }))
    })

    const options = screen.getAllByRole('button', { name: /秒$/ })
    expect(options.length).toBe(5)
    const selected = options.filter((btn) => btn.style.fontWeight === '600')
    expect(selected, '应恰有一项被选中').toHaveLength(1)
    expect(selected[0]?.style.color).toBe('var(--accent-light)')
  })

  it('核心：信息按钮激活态用高对比底 + 描边（原为 rgba(255,255,255,0.18) 无描边）', async () => {
    render(<FullscreenViewer filteredFiles={files} />)

    const infoBtn = screen.getByRole('button', { name: '查看图片信息' })
    // async act：信息浮层的 useExif 会在 effect 里 resolve，需一并 flush，否则 act 警告
    await act(async () => {
      fireEvent.click(infoBtn)
    })

    expect(infoBtn.style.background).toBe('var(--overlay-control-bg-active)')
    expect(infoBtn.style.borderColor).toBe('var(--overlay-control-border-active)')
  })

  it('核心：收藏激活态改用 --favorite-on-overlay（--favorite 最坏情况仅 2.32:1）', () => {
    const favorites = [makeFile({ id: '1', file_name: 'k1.jpg', is_favorite: true })]
    resetStores()
    openFullscreen(favorites)
    render(<FullscreenViewer filteredFiles={favorites} />)

    const favBtn = screen.getByRole('button', { name: '取消收藏' })
    expect(favBtn.querySelector('svg')?.getAttribute('fill')).toBe('var(--favorite-on-overlay)')
  })
})

describe('安全网：结构与交互不回归（今天即通过）', () => {
  it('边界：7 个顶栏按钮的 aria-label 全集不变（证明没动结构）', () => {
    render(<FullscreenViewer filteredFiles={files} />)

    for (const name of [
      '播放幻灯片',
      '播放间隔',
      '收藏',
      '查看图片信息',
      '另存为',
      '删除',
      '关闭'
    ]) {
      expect(screen.getByRole('button', { name }), `缺少按钮「${name}」`).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: '下一张' })).toBeTruthy()
  })
})
