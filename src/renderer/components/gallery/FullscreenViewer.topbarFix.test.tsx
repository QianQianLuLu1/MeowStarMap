/**
 * @layer L3
 * @module src/renderer/components/gallery/FullscreenViewer
 * @coverage 全屏顶栏修复（topbar-fix）：根容器 no-drag 接线 + 播放/间隔按钮组对齐
 * @dependencies @testing-library/react + useUIStore + useMediaStore（jsdom）
 * @remarks
 *   缺陷复位（修复前）：
 *   - TitleBar 的 .app-drag 拖拽区按矩形计算、不感知遮挡（Electron 官方语义）：全屏
 *     查看器视觉盖住它，窗口顶部 40px 条带仍是活动拖拽区 → 顶栏按钮 mousedown 被
 *     窗口拖动吞掉、click 永不触发。全屏根容器必须声明 .app-no-drag 做几何减法
 *     （globals.css:1597 仓库预留工具类），非全屏 TitleBar 不受影响；
 *   - 播放/间隔按钮包在裸 div.relative（块级、行内基线对齐）：图标基线与文本基线
 *     不同 → 间隔按钮下沉与其余按钮不齐，wrapper 需改 flex items-center；
 *   - 间隔按钮 ml-1 + 内联 minWidth/padding 覆盖 → 间距 12px（其余 8px）、尺寸口径
 *     不一致 → 去除后统一 36×36 盒 + 8px 等距。
 *
 *   断言口径：jsdom 不应用样式表、也不模拟 app-region 命中测试，故按既有约定断言
 *   class 与内联 style 字符串（与 toolbarContrast 同口径）；真实拖拽区行为由真机
 *   实测兜底（docs/plans/archive/2026-Q4/2026-11-01-fullscreen-topbar-fix-实施计划.md T5）。
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
    fullscreenTargetImg: null,
    slideshowOpen: false,
    slideshowStartIndex: 0
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
  mediaAction: {
    updateFavorite: vi.fn().mockResolvedValue({ updated: true }),
    delete: vi.fn(),
    softDelete: vi.fn().mockResolvedValue({ success: true })
  },
  file: { getExif: vi.fn().mockResolvedValue(null), saveAs: vi.fn(), delete: vi.fn() },
  dialog: { selectDirectory: vi.fn().mockResolvedValue(undefined) },
  video: { captureFrame: vi.fn(), metadata: vi.fn().mockResolvedValue({ success: false }) }
}

let files: MediaFile[] = []

beforeEach(() => {
  vi.stubGlobal('Image', FakeImage)
  ;(window as unknown as { electronAPI: unknown }).electronAPI = electronApi
  vi.clearAllMocks()
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

describe('全屏顶栏 no-drag 与按钮组对齐（topbar-fix）', () => {
  it('点击修复：全屏根容器声明 app-no-drag（Electron 拖拽区不感知遮挡，需 no-drag 减法盖掉 TitleBar 拖拽条）', () => {
    render(<FullscreenViewer filteredFiles={files} />)

    const root = screen.getByRole('dialog')
    expect(
      root.classList.contains('app-no-drag'),
      '全屏根容器缺少 .app-no-drag：顶部 40px 拖拽条仍在按钮下方活动，点击被窗口拖动吞掉'
    ).toBe(true)
  })

  it('对齐修复：播放/间隔按钮容器为 flex 垂直居中（原裸 div.relative 行内基线对齐致间隔按钮下沉）', () => {
    render(<FullscreenViewer filteredFiles={files} />)

    const playBtn = screen.getByRole('button', { name: '播放幻灯片' })
    const wrapper = playBtn.parentElement
    expect(wrapper).not.toBeNull()
    // relative 必须保留：间隔下拉菜单以它为定位锚
    expect(wrapper?.classList.contains('relative')).toBe(true)
    expect(
      wrapper?.classList.contains('flex'),
      '播放/间隔容器未改为 flex：两按钮仍按行内基线对齐，间隔按钮相对下沉'
    ).toBe(true)
    expect(wrapper?.classList.contains('items-center')).toBe(true)
  })

  it('等距同尺寸修复：间隔按钮去除 ml-1 与内联 minWidth/padding 覆盖（统一 36×36 盒 + 8px 等距）', () => {
    render(<FullscreenViewer filteredFiles={files} />)

    const intervalBtn = screen.getByRole('button', { name: '播放间隔' })
    expect(
      intervalBtn.classList.contains('ml-1'),
      '间隔按钮仍有 ml-1：与播放按钮间距 12px，其余按钮为 8px，间距不统一'
    ).toBe(false)
    expect(intervalBtn.style.minWidth).toBe('')
    expect(intervalBtn.style.padding).toBe('')
  })
})

describe('安全网：顶栏按钮接线不回归（今天即通过）', () => {
  it('间隔菜单：点击弹出 5 个间隔选项', () => {
    render(<FullscreenViewer filteredFiles={files} />)

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '播放间隔' }))
    })
    const options = screen.getAllByRole('button', { name: /秒$/ })
    expect(options.length).toBe(5)
  })

  it('信息浮层：点击展开 data-fullscreen-info-panel', async () => {
    render(<FullscreenViewer filteredFiles={files} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '查看图片信息' }))
    })
    expect(document.querySelector('[data-fullscreen-info-panel]')).not.toBeNull()
  })

  it('另存为：点击调用 dialog.selectDirectory', async () => {
    render(<FullscreenViewer filteredFiles={files} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '另存为' }))
    })
    expect(electronApi.dialog.selectDirectory).toHaveBeenCalledTimes(1)
  })

  it('删除：点击弹出确认对话框（删除 = 软删除，确认前不动库）', () => {
    render(<FullscreenViewer filteredFiles={files} />)

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '删除' }))
    })
    expect(screen.getByText('删除文件')).toBeTruthy()
  })

  it('收藏：点击调用 mediaAction.updateFavorite', async () => {
    render(<FullscreenViewer filteredFiles={files} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '收藏' }))
    })
    expect(electronApi.mediaAction.updateFavorite).toHaveBeenCalled()
  })

  it('关闭：点击退出全屏（jsdom 无 View Transition，走直接置位回退路径）', () => {
    render(<FullscreenViewer filteredFiles={files} />)

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    })
    expect(useUIStore.getState().fullscreenOpen).toBe(false)
  })

  it('播放：点击进入幻灯片播放（aria-label 切换为暂停）', () => {
    render(<FullscreenViewer filteredFiles={files} />)

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '播放幻灯片' }))
    })
    expect(screen.getByRole('button', { name: '暂停幻灯片' })).toBeTruthy()
  })
})

describe('边界：视频与单张文件', () => {
  it('视频文件：顶栏无「查看图片信息」按钮，关闭按钮仍可用', () => {
    const video = [
      makeFile({ id: 'v1', file_name: 'v1.mp4', file_type: 'video', file_ext: '.mp4' })
    ]
    resetStores()
    openFullscreen(video)
    render(<FullscreenViewer filteredFiles={video} />)

    expect(screen.queryByRole('button', { name: '查看图片信息' })).toBeNull()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    })
    expect(useUIStore.getState().fullscreenOpen).toBe(false)
  })

  it('单张文件：无左右导航按钮，仍可点关闭退出', () => {
    const single = [makeFile({ id: '1' })]
    resetStores()
    openFullscreen(single)
    render(<FullscreenViewer filteredFiles={single} />)

    expect(screen.queryByRole('button', { name: '下一张' })).toBeNull()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    })
    expect(useUIStore.getState().fullscreenOpen).toBe(false)
  })
})
