/**
 * @layer L3
 * @module src/renderer/pages/DetailPage
 * @coverage 详情页删除：走软删除进回收站，不再硬删 DB / 搬动文件（回收站语义修复 D3）
 *
 * 修复前：handleDelete 调 file.delete（shell.trashItem 搬文件）+ mediaAction.delete
 * （硬删 DB 行）——记录根本进不了回收站，且文件被移入系统回收站无法还原。
 * 修复后：只调 mediaAction.softDelete 打 is_deleted 标记，文件保留在原路径，
 * 可从回收站恢复。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const showMessageMock = vi.hoisted(() => vi.fn())
vi.mock('./settings/sections', () => ({
  useGlobalToast: () => showMessageMock
}))

const softDelete = vi.hoisted(() => vi.fn())
const hardDelete = vi.hoisted(() => vi.fn())
const fileDelete = vi.hoisted(() => vi.fn())
const electron = {
  mediaAction: {
    softDelete,
    delete: hardDelete,
    updateFavorite: vi.fn().mockResolvedValue({ updated: true }),
    updateTags: vi.fn(),
    updateRating: vi.fn(),
    updateNotes: vi.fn(),
    updateCategory: vi.fn(),
    updateOutfit: vi.fn()
  },
  file: {
    delete: fileDelete,
    saveAs: vi.fn(),
    getExif: vi.fn().mockResolvedValue(null)
  },
  dialog: { selectDirectory: vi.fn() },
  video: { metadata: vi.fn().mockResolvedValue({ success: false }) },
  media: {
    list: vi.fn().mockResolvedValue({ files: [], total: 0, hasMore: false, nextCursor: null })
  }
}

function makeFile(): MediaFile {
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
    height: 1080
  }
}

function setupStores(): void {
  useMediaStore.setState({ mediaFiles: [makeFile()] })
  useUIStore.setState({
    selectedMediaIds: ['1'],
    currentView: 'detail',
    viewStack: ['gallery', 'detail']
  })
}

import { DetailPage } from './DetailPage'
import { useMediaStore, type MediaFile } from '../stores/mediaStore'
import { useUIStore } from '../stores/uiStore'

beforeEach(() => {
  vi.clearAllMocks()
  showMessageMock.mockClear()
  // 旧链路的两步都 mock 成功，确保红灯源于「走错通道」而非 mock 报错
  fileDelete.mockResolvedValue({ success: true, message: '已删除' })
  hardDelete.mockResolvedValue({ deleted: true })
  softDelete.mockResolvedValue({ success: true, message: '已移入回收站' })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = electron
  setupStores()
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('DetailPage 删除（回收站语义修复 D3）', () => {
  it('调 mediaAction.softDelete 进回收站，不调 file.delete / mediaAction.delete', async () => {
    render(<DetailPage />)

    // 删除按钮文本 = common.delete = 「删除」
    const deleteBtn = await screen.findByRole('button', { name: '删除' })
    fireEvent.click(deleteBtn)

    // ConfirmDialog 确认按钮 = common.confirm = 「确认」
    const confirmBtn = await screen.findByRole('button', { name: '确认' })
    await waitFor(() => fireEvent.click(confirmBtn))

    await waitFor(() => expect(softDelete).toHaveBeenCalledWith([1]))
    expect(fileDelete).not.toHaveBeenCalled()
    expect(hardDelete).not.toHaveBeenCalled()
  })

  it('软删成功后从 store 移除并跳回图库', async () => {
    render(<DetailPage />)

    const deleteBtn = await screen.findByRole('button', { name: '删除' })
    fireEvent.click(deleteBtn)
    const confirmBtn = await screen.findByRole('button', { name: '确认' })
    await waitFor(() => fireEvent.click(confirmBtn))

    await waitFor(() => expect(useMediaStore.getState().mediaFiles).toHaveLength(0))
    expect(useUIStore.getState().currentView).toBe('gallery')
  })
})
