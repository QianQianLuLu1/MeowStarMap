/**
 * @layer L3
 * @module src/renderer/components/gallery/FullscreenViewer
 * @coverage 全屏查看器删除：走软删除进回收站，不再硬删 DB / 搬动文件（回收站语义修复 D3）
 *
 * 修复前：handleDelete 调 file.delete（shell.trashItem 搬文件）+ mediaAction.delete
 * （硬删 DB 行）——记录根本进不了回收站。修复后只调 mediaAction.softDelete 打标记。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { FullscreenViewer } from './FullscreenViewer'
import { useUIStore } from '../../stores/uiStore'
import { useMediaStore, type MediaFile } from '../../stores/mediaStore'

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

// 离屏预解码 Image 占位（避免挂起 / 报错），与 favorite 测试一致的轻量 stub
class FakeImage {
  src = ''
  async decode(): Promise<void> {
    return
  }
}

const softDelete = vi.hoisted(() => vi.fn())
const hardDelete = vi.hoisted(() => vi.fn())
const fileDelete = vi.hoisted(() => vi.fn())
const electron = {
  mediaAction: { softDelete, delete: hardDelete, updateFavorite: vi.fn() },
  file: { delete: fileDelete, saveAs: vi.fn(), getExif: vi.fn().mockResolvedValue(null) },
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
  fileDelete.mockResolvedValue({ success: true, message: '已删除' })
  hardDelete.mockResolvedValue({ deleted: true })
  softDelete.mockResolvedValue({ success: true, message: '已移入回收站' })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = electron
  resetStores()
  // 渲染前即打开全屏，避免「先渲染后 setState」的时序抖动
  useUIStore.setState({
    fullscreenOpen: true,
    fullscreenIndex: 0,
    fullscreenFiles: [file],
    fullscreenTargetImg: null
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  resetStores()
})

describe('FullscreenViewer 删除（回收站语义修复 D3）', () => {
  it('调 mediaAction.softDelete 进回收站，不调 file.delete / mediaAction.delete', async () => {
    render(<FullscreenViewer filteredFiles={[file]} />)

    // 删除按钮 aria-label = common.delete = 「删除」
    const deleteBtn = await screen.findByRole('button', { name: '删除' })
    fireEvent.click(deleteBtn)

    // ConfirmDialog 确认按钮 = common.confirm = 「确认」
    const confirmBtn = await screen.findByRole('button', { name: '确认' })
    await waitFor(() => fireEvent.click(confirmBtn))

    await waitFor(() => expect(softDelete).toHaveBeenCalledWith([1]))
    expect(fileDelete).not.toHaveBeenCalled()
    expect(hardDelete).not.toHaveBeenCalled()
  })

  it('软删成功后从 store 移除并关闭全屏（最后一张）', async () => {
    render(<FullscreenViewer filteredFiles={[file]} />)

    const deleteBtn = await screen.findByRole('button', { name: '删除' })
    fireEvent.click(deleteBtn)
    const confirmBtn = await screen.findByRole('button', { name: '确认' })
    await waitFor(() => fireEvent.click(confirmBtn))

    await waitFor(() => expect(useMediaStore.getState().mediaFiles).toHaveLength(0))
    await waitFor(() => expect(useUIStore.getState().fullscreenOpen).toBe(false))
  })
})
