/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/pages/RecycleBinPage
 * @coverage 回收站「彻底删除」批量流程：确认弹窗 → 逐项 media:permanentDelete → 结果 Toast / 重试入口
 *
 * #fix-permanent-delete-error-toast 回归防线：
 * - 修复前渲染端误读 preload call() 契约（读取 data 上不存在的 success 字段），
 *   删除实际成功却恒判失败 →「重试删除」按钮恒显示、成功 Toast 文案退化为 i18n key 字符串
 *   （recycleBin.permanentDeleteSuccess 键值在全部语言包缺失）；
 * - 本文件 mock 一律使用 media:permanentDelete 的真实契约 data：
 *   { message, deletedCount, failedCount }（无 success 字段）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

// jsdom 无 ResizeObserver，useContainerSize 需要
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub

const showMessageMock = vi.hoisted(() => vi.fn())
vi.mock('./settings/sections', () => ({
  useGlobalToast: () => showMessageMock
}))

vi.mock('react-virtuoso', () => {
  const React = require('react')
  return {
    VirtuosoGrid: ({
      data,
      itemContent
    }: {
      data?: unknown[]
      itemContent?: (index: number, row: unknown) => React.ReactNode
    }) => {
      const items = data ?? []
      return React.createElement(
        'div',
        { 'data-testid': 'virtuoso-grid' },
        items.map((row, i) =>
          React.createElement(React.Fragment, { key: i }, itemContent ? itemContent(i, row) : null)
        )
      )
    },
    Virtuoso: () => null
  }
})
// 仅当 open 为真时渲染确认按钮，便于触发 onConfirm
vi.mock('../components/common/ConfirmDialog', () => ({
  ConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    open ? <button data-testid="confirm-ok" onClick={onConfirm} /> : null
}))
vi.mock('../components/common/TaskProgressOverlay', () => ({
  TaskProgressOverlay: () => null
}))
vi.mock('../hooks/useRefreshMedia', () => ({
  useRefreshMedia: () => vi.fn().mockResolvedValue(undefined)
}))

import { RecycleBinPage } from './RecycleBinPage'
import { useMediaStore, type MediaFile } from '../stores/mediaStore'

function makeRecycleFile(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    id: '1',
    file_path: 'C:\\photos\\a.jpg',
    file_name: 'a.jpg',
    file_type: 'image',
    file_ext: '.jpg',
    file_size: 1024,
    created_at: '2026-01-01T00:00:00.000Z',
    modified_at: '2026-01-01T00:00:00.000Z',
    deleted_at: '2026-01-02T00:00:00.000Z',
    thumbnail: 'C:\\cache\\thumbnails\\a.jpg',
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

const recycleFile = makeRecycleFile()

const electron = {
  media: {
    list: vi.fn().mockResolvedValue({
      files: [recycleFile],
      total: 1,
      hasMore: false,
      nextCursor: null,
      page: 1,
      pageSize: 200
    })
  },
  mediaAction: {
    // 真实契约：{ message, deletedCount, failedCount }（无 success 字段）
    permanentDelete: vi.fn().mockResolvedValue({ message: '', deletedCount: 0, failedCount: 0 }),
    restore: vi.fn().mockResolvedValue({ message: '' }),
    softDelete: vi.fn().mockResolvedValue({ success: true, message: '' }),
    emptyRecycleBin: vi.fn().mockResolvedValue({ message: '', movedCount: 0, failedCount: 0 })
  }
}

function setupElectron(): void {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = electron
}

function firstCard(): HTMLElement {
  const cards = screen.getAllByRole('checkbox')
  const card = cards.find((el) => el.getAttribute('aria-label')?.includes('a.jpg'))
  if (!card) throw new Error('回收站卡片未渲染')
  return card as HTMLElement
}

async function confirmPermanentDelete(): Promise<void> {
  fireEvent.contextMenu(firstCard())
  // 选中唯一卡片（RecycleBinItem 点击即切换选中）
  fireEvent.click(firstCard())
  // 底部工具栏的「彻底删除」按钮（aria-label = recycleBin.permanentDeleteSelected）
  fireEvent.click(screen.getByRole('button', { name: '彻底删除选中项' }))
  await waitFor(() => expect(screen.getByTestId('confirm-ok')).toBeInTheDocument())
  fireEvent.click(screen.getByTestId('confirm-ok'))
}

beforeEach(() => {
  vi.clearAllMocks()
  showMessageMock.mockClear()
  setupElectron()
  useMediaStore.setState({
    recycleBinFiles: [],
    recycleBinTotal: 0,
    recycleBinLoading: false,
    recycleBinHasMore: false,
    recycleBinLoadingMore: false
  })
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('RecycleBinPage 批量彻底删除（#fix-permanent-delete-error-toast）', () => {
  it('全部成功时提示成功且不显示重试按钮', async () => {
    electron.mediaAction.permanentDelete.mockResolvedValue({
      message: '已彻底删除 1 项',
      deletedCount: 1,
      failedCount: 0
    })
    render(<RecycleBinPage />)
    await waitFor(() => expect(firstCard()).toBeTruthy())

    await confirmPermanentDelete()

    await waitFor(() => {
      expect(electron.mediaAction.permanentDelete).toHaveBeenCalledWith([1])
    })
    // 修复前：恒判失败 → 重试按钮出现 + 成功 Toast 退化为 i18n key 字符串
    await waitFor(() => {
      expect(showMessageMock).toHaveBeenCalledWith('已彻底删除 1 项', 'success')
    })
    expect(screen.queryByText('重试删除')).not.toBeInTheDocument()
  })

  it('部分失败时提示错误并显示重试按钮', async () => {
    electron.mediaAction.permanentDelete.mockResolvedValue({
      message: '已彻底删除 0 项，1 项失败',
      deletedCount: 0,
      failedCount: 1
    })
    render(<RecycleBinPage />)
    await waitFor(() => expect(firstCard()).toBeTruthy())

    await confirmPermanentDelete()

    await waitFor(() => {
      expect(showMessageMock).toHaveBeenCalledWith('已彻底删除 0 项，1 项失败', 'error')
    })
    expect(screen.getByText('重试删除')).toBeInTheDocument()
  })

  it('IPC 抛错（如数据库异常）时显示重试按钮', async () => {
    electron.mediaAction.permanentDelete.mockRejectedValue(new Error('数据库被锁定'))
    render(<RecycleBinPage />)
    await waitFor(() => expect(firstCard()).toBeTruthy())

    await confirmPermanentDelete()

    await waitFor(() => {
      expect(screen.getByText('重试删除')).toBeInTheDocument()
    })
  })
})
