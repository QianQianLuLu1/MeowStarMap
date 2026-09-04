/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/pages/DuplicatesPage
 * @coverage 重复文件板块复用图库右键菜单：卡片 onContextMenu → ContextMenu 渲染 → 操作触发对应 IPC
 * @dependencies window.electronAPI（覆盖占位 Proxy）/ useFileOperations（真实复用）/ getContextMenuItems（真实复用）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import type { DuplicateItem } from '../../shared/types/duplicate'

// 复用图库 ContextMenu 与 getContextMenuItems（真实，不 mock），仅 mock 虚拟列表与无关弹窗
vi.mock('react-virtuoso', () => {
  const React = require('react')
  return {
    Virtuoso: ({
      totalCount,
      itemContent,
      data
    }: {
      totalCount?: number
      itemContent?: (index: number, row: unknown) => React.ReactNode
      data?: unknown[]
    }) => {
      const items = data ?? []
      const count = totalCount ?? items.length
      return React.createElement(
        'div',
        { 'data-testid': 'virtuoso-list' },
        Array.from({ length: count }, (_, i) =>
          React.createElement(
            React.Fragment,
            { key: i },
            itemContent ? itemContent(i, items[i]) : null
          )
        )
      )
    },
    useVirtuoso: () => ({ virtuosoRef: { current: null }, scrollerRef: { current: null } })
  }
})
vi.mock('../components/common/ShareGuideDialog', () => ({ ShareGuideDialog: () => null }))
vi.mock('../components/common/PropertiesDialog', () => ({ PropertiesDialog: () => null }))
vi.mock('../components/gallery/RenameDialog', () => ({ RenameDialog: () => null }))
vi.mock('../components/common/TaskProgressOverlay', () => ({ TaskProgressOverlay: () => null }))
vi.mock('../components/common/EmptyState', () => ({ EmptyState: () => null }))
// 仅当 open 为真时渲染确认按钮，便于触发 onConfirm
vi.mock('../components/common/ConfirmDialog', () => ({
  ConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    open ? <button data-testid="confirm-ok" onClick={onConfirm} /> : null
}))

import { DuplicatesPage } from './DuplicatesPage'

const group: DuplicateItem[] = [
  {
    id: 1,
    file_path: 'C:\\dup\\a.jpg',
    file_name: 'a.jpg',
    file_type: 'image',
    file_size: 100,
    modified_at: '2024-01-01T00:00:00Z',
    width: 800,
    height: 600,
    is_favorite: false,
    rating: 0
  },
  {
    id: 2,
    file_path: 'C:\\dup\\b.jpg',
    file_name: 'b.jpg',
    file_type: 'image',
    file_size: 120,
    modified_at: '2024-01-01T00:00:00Z',
    width: 800,
    height: 600,
    is_favorite: false,
    rating: 0
  }
]

const scanResult = {
  success: true,
  cancelled: false,
  totalGroups: 1,
  totalFiles: 2,
  duplicates: [group],
  bestItemIds: { 0: 1 },
  totalSizeSavedBytes: 0,
  totalCount: 2
}

const electron = {
  media: {
    findDuplicates: vi.fn().mockResolvedValue(scanResult),
    findSimilar: vi.fn().mockResolvedValue(scanResult),
    list: vi.fn().mockResolvedValue({ files: [], categories: [], total: 0, hasMore: false }),
    getDetail: vi.fn().mockResolvedValue(null)
  },
  mediaAction: {
    updateFavorite: vi.fn().mockResolvedValue({ success: true, is_favorite: true, message: '' }),
    softDelete: vi.fn().mockResolvedValue({ success: true, message: '' }),
    deletePermanently: vi.fn().mockResolvedValue({ success: true, message: '' })
  },
  shell: { showItemInFolder: vi.fn().mockResolvedValue(undefined) },
  share: {
    copyFiles: vi.fn().mockResolvedValue({ success: true, count: 1, skipped: 0, message: 'ok' }),
    detectApp: vi.fn().mockResolvedValue({ installed: true, running: true, installPath: 'x' })
  },
  file: {
    export: vi.fn().mockResolvedValue({ success: true, message: '' }),
    rename: vi.fn().mockResolvedValue({ success: true, message: '' }),
    saveAs: vi.fn().mockResolvedValue({ success: true, message: '' })
  },
  dialog: { selectDirectory: vi.fn().mockResolvedValue('C:\\out') },
  scanner: {
    status: vi.fn().mockResolvedValue({ status: 'idle' }),
    onComplete: vi.fn(() => () => {})
  }
}

function setupElectron(): void {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = electron
  ;(global as unknown as { electronAPI: unknown }).electronAPI = electron
}

function firstCard(): HTMLElement {
  const cards = screen.getAllByRole('checkbox')
  const card = cards.find((el) => el.getAttribute('aria-label')?.includes('a.jpg'))
  if (!card) throw new Error('重复文件卡片未渲染')
  return card as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
  setupElectron()
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('重复文件板块右键菜单（复用图库实现）', () => {
  it('右键卡片弹出与图库一致的菜单项', async () => {
    render(<DuplicatesPage />)

    await waitFor(() => expect(electron.media.findDuplicates).toHaveBeenCalled())
    await waitFor(() => expect(firstCard()).toBeTruthy())
    fireEvent.contextMenu(firstCard())

    await waitFor(() => {
      expect(screen.getByText('收藏')).toBeInTheDocument()
    })
    expect(screen.getByText('打开文件所在位置')).toBeInTheDocument()
    expect(screen.getByText('删除')).toBeInTheDocument()
    expect(screen.getByText('属性')).toBeInTheDocument()
    expect(screen.getByText('分享')).toBeInTheDocument()
  })

  it('点击「收藏」调用 mediaAction.updateFavorite', async () => {
    render(<DuplicatesPage />)
    await waitFor(() => expect(firstCard()).toBeTruthy())
    fireEvent.contextMenu(firstCard())
    await waitFor(() => expect(screen.getByText('收藏')).toBeInTheDocument())

    fireEvent.click(screen.getByText('收藏'))

    await waitFor(() => {
      expect(electron.mediaAction.updateFavorite).toHaveBeenCalledWith(1, true)
    })
  })

  it('点击「打开文件所在位置」调用 shell.showItemInFolder', async () => {
    render(<DuplicatesPage />)
    await waitFor(() => expect(firstCard()).toBeTruthy())
    fireEvent.contextMenu(firstCard())
    await waitFor(() => expect(screen.getByText('打开文件所在位置')).toBeInTheDocument())

    fireEvent.click(screen.getByText('打开文件所在位置'))

    await waitFor(() => {
      expect(electron.shell.showItemInFolder).toHaveBeenCalledWith('C:\\dup\\a.jpg')
    })
  })

  it('点击「删除」经确认调用 mediaAction.softDelete', async () => {
    render(<DuplicatesPage />)
    await waitFor(() => expect(firstCard()).toBeTruthy())
    fireEvent.contextMenu(firstCard())
    await waitFor(() => expect(screen.getByText('删除')).toBeInTheDocument())

    fireEvent.click(screen.getByText('删除'))

    await waitFor(() => expect(screen.getByTestId('confirm-ok')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('confirm-ok'))

    await waitFor(() => {
      expect(electron.mediaAction.softDelete).toHaveBeenCalledWith([1])
    })
  })
})
