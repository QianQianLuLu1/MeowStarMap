/**
 * @layer L3
 * @module src/renderer/components/gallery/FullscreenViewer
 * @coverage 全屏查看器收藏按钮：成功路径不弹错误 Toast（回归 #fix-favorite-error-toast）
 *
 * 根因（已修复）：preload call() 已把主进程 IpcResponse<T> 解包为 data（如 { updated: true }），
 * 失败时抛 IpcError。修复前 useFavoriteToggle 误读 result.success 恒 undefined → 抛 "undefined" 并弹红 Toast。
 * 本文件在全屏入口层面验证「点击收藏 → updateFavorite 收到真实契约响应 { updated: true } →
 * 不弹错误 Toast 且 IPC 以 (mediaId, true) 正确调用」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { FullscreenViewer } from './FullscreenViewer'
import { useUIStore } from '../../stores/uiStore'
import { useMediaStore, type MediaFile } from '../../stores/mediaStore'

// 捕获组件内 useToast().showMessage，断言成功时不被以 'error' 调用
const showMessageMock = vi.hoisted(() => vi.fn())
vi.mock('../../hooks/useToast', () => ({
  useToast: () => ({
    messages: [],
    showMessage: showMessageMock,
    showMessageWithAction: vi.fn(),
    dismiss: vi.fn(),
    clear: vi.fn()
  })
}))

// 离屏预解码 Image 占位（避免挂起 / 报错），与 transition 测试一致的轻量 stub
class FakeImage {
  src = ''
  async decode(): Promise<void> {
    return
  }
}

const updateFavorite = vi.fn()
const electron = {
  mediaAction: { updateFavorite, delete: vi.fn() },
  file: { delete: vi.fn(), saveAs: vi.fn(), getExif: vi.fn().mockResolvedValue(null) },
  dialog: { selectDirectory: vi.fn() },
  video: { captureFrame: vi.fn(), metadata: vi.fn().mockResolvedValue({ success: false }) }
}

function makeFile(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    id: '1',
    file_path: 'C:\\media\\img.jpg',
    file_name: 'img.jpg',
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

const file = makeFile()

function openFullscreen(files: MediaFile[], index = 0): void {
  useUIStore.setState({
    fullscreenOpen: true,
    fullscreenIndex: index,
    fullscreenFiles: files,
    fullscreenTargetImg: null
  })
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

beforeEach(() => {
  vi.stubGlobal('Image', FakeImage)
  showMessageMock.mockClear()
  updateFavorite.mockReset()
  updateFavorite.mockResolvedValue({ updated: true })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = electron
  resetStores()
  // 渲染前即打开全屏，避免「先渲染后 setState」的时序抖动
  openFullscreen([file])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  resetStores()
})

describe('FullscreenViewer 收藏（#fix-favorite-error-toast）', () => {
  it('成功响应 { updated: true } 时不弹错误 Toast 且 IPC 正确调用', async () => {
    render(<FullscreenViewer filteredFiles={[file]} />)

    // 收藏按钮 aria-label = gallery.fullscreen.favoriteTitle = 「收藏」
    const btn = await screen.findByRole('button', { name: '收藏' })
    fireEvent.click(btn)

    await waitFor(() => expect(updateFavorite).toHaveBeenCalledWith(1, true))

    // 修复前：误读 result.success 恒 undefined → 抛 "undefined" → 红 Toast
    expect(showMessageMock).not.toHaveBeenCalled()
  })

  it('updateFavorite reject 时回滚并弹错误 Toast（护栏：测试可捕获回归）', async () => {
    updateFavorite.mockRejectedValue(new Error('数据库写入失败'))
    render(<FullscreenViewer filteredFiles={[file]} />)

    const btn = await screen.findByRole('button', { name: '收藏' })
    fireEvent.click(btn)

    await waitFor(() => expect(showMessageMock).toHaveBeenCalledWith('数据库写入失败', 'error'))
  })
})
