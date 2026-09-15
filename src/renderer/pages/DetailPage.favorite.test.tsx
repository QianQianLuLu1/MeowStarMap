/**
 * @layer L3
 * @module src/renderer/pages/DetailPage
 * @coverage 详情页收藏按钮：成功路径不弹错误 Toast（回归 #fix-favorite-error-toast）
 *
 * DetailPage 使用独立的 toggleFavorite：调用 updateMediaFileAndPersist(...) 后
 * 读取 result.success；updateMediaFileAndPersist 在 IPC 返回真实契约 { updated: true } 时
 * 已 await 通过并返回 { success: true }，故不应弹错误 Toast。
 * 本文件验证「点击收藏 → updateFavorite 收到 { updated: true } → 不弹错误 Toast」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

// 捕获 useGlobalToast() 返回的 showMessage，断言成功时不被以 'error' 调用
const showMessageMock = vi.hoisted(() => vi.fn())
vi.mock('./settings/sections', () => ({
  useGlobalToast: () => showMessageMock
}))

const updateFavorite = vi.fn()
const electron = {
  mediaAction: {
    updateFavorite,
    updateTags: vi.fn(),
    updateRating: vi.fn(),
    updateNotes: vi.fn(),
    updateCategory: vi.fn(),
    updateOutfit: vi.fn(),
    delete: vi.fn()
  },
  file: {
    delete: vi.fn(),
    saveAs: vi.fn(),
    getExif: vi.fn().mockResolvedValue(null)
  },
  dialog: { selectDirectory: vi.fn() },
  video: { metadata: vi.fn().mockResolvedValue({ success: false }) },
  media: {
    list: vi.fn().mockResolvedValue({ files: [], total: 0, hasMore: false, nextCursor: null })
  }
}

function setupElectron(): void {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = electron
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

function setMedia(): void {
  useMediaStore.setState({ mediaFiles: [makeFile()] })
  // selectFocusedMediaId 读取 selectedMediaIds[0]
  useUIStore.setState({ selectedMediaIds: ['1'] })
}

import { DetailPage } from './DetailPage'
import { useMediaStore, type MediaFile } from '../stores/mediaStore'
import { useUIStore } from '../stores/uiStore'

beforeEach(() => {
  vi.clearAllMocks()
  showMessageMock.mockClear()
  updateFavorite.mockReset()
  updateFavorite.mockResolvedValue({ updated: true })
  setupElectron()
  setMedia()
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('DetailPage 收藏（#fix-favorite-error-toast）', () => {
  it('成功响应 { updated: true } 时不弹错误 Toast 且 IPC 正确调用', async () => {
    render(<DetailPage />)

    // 收藏按钮文本 = detail.fields.notFavorited = 「未收藏」
    const btn = await screen.findByText('未收藏')
    fireEvent.click(btn)

    await waitFor(() => expect(updateFavorite).toHaveBeenCalledWith(1, true))

    // 修复前：误读 result.success 恒 undefined → 抛 "undefined" → 红 Toast
    expect(showMessageMock).not.toHaveBeenCalled()
  })

  it('updateFavorite reject 时弹错误 Toast（护栏：测试可捕获回归）', async () => {
    updateFavorite.mockRejectedValue(new Error('数据库写入失败'))
    render(<DetailPage />)

    const btn = await screen.findByText('未收藏')
    fireEvent.click(btn)

    await waitFor(() => expect(showMessageMock).toHaveBeenCalledWith('数据库写入失败', 'error'))
  })
})
