/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/pages/DuplicatesPage + components/gallery/FullscreenViewer
 * @coverage 重复文件右键「打开」→ 全屏预览内容映射：全屏必须展示所点卡片对应的文件，
 *           且左右导航/标题等按打开时的重复文件列表工作（而非图库 filteredFiles）。
 *           FIX：全屏查看器此前按图库列表解释重复列表下标，导致内容错位或越界不打开。
 * @dependencies window.electronAPI（覆盖占位 Proxy）/ useUIStore / useMediaStore
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import type { DuplicateItem } from '../../shared/types/duplicate'

// 复用 DuplicatesPage.contextMenu.test.tsx 的成熟脚手架
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
vi.mock('../components/common/ConfirmDialog', () => ({
  ConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    open ? <button data-testid="confirm-ok" onClick={onConfirm} /> : null
}))

import { DuplicatesPage } from './DuplicatesPage'
import { FullscreenViewer } from '../components/gallery/FullscreenViewer'
import { useUIStore } from '../stores/uiStore'
import { useMediaStore, type MediaFile } from '../stores/mediaStore'

const dupGroup: DuplicateItem[] = [
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
    rating: 0,
    thumbnail: 'C:\\cache\\a.jpg'
  },
  {
    id: 2,
    file_path: 'C:\\dup\\b.jpg',
    file_name: 'b.jpg',
    file_type: 'image',
    file_size: 120,
    modified_at: '2024-01-02T00:00:00Z',
    width: 800,
    height: 600,
    is_favorite: false,
    rating: 0,
    thumbnail: 'C:\\cache\\b.jpg'
  }
]

const scanResult = {
  success: true,
  cancelled: false,
  totalGroups: 1,
  totalFiles: 2,
  duplicates: [dupGroup],
  bestItemIds: { 0: 1 },
  totalSizeSavedBytes: 0,
  totalCount: 2
}

// 故意构造与重复列表**长度不同**的图库列表，使「下标错位」在断言中可被观测
const galleryFiles = [
  {
    id: '101',
    file_path: 'C:\\gal\\g1.jpg',
    file_name: 'g1.jpg',
    file_type: 'image',
    created_at: '2024-01-01T00:00:00Z'
  },
  {
    id: '102',
    file_path: 'C:\\gal\\g2.jpg',
    file_name: 'g2.jpg',
    file_type: 'image',
    created_at: '2024-01-02T00:00:00Z'
  },
  {
    id: '103',
    file_path: 'C:\\gal\\g3.jpg',
    file_name: 'g3.jpg',
    file_type: 'image',
    created_at: '2024-01-03T00:00:00Z'
  }
] as unknown as MediaFile[]

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
  },
  thumbnail: { generate: vi.fn().mockResolvedValue(null) }
}

function setupElectron(): void {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = electron
  ;(global as unknown as { electronAPI: unknown }).electronAPI = electron
}

function cardFor(name: string): HTMLElement {
  const cards = screen.getAllByRole('checkbox') as HTMLElement[]
  const card = cards.find((el) => el.getAttribute('aria-label')?.includes(name))
  if (!card) throw new Error(`重复文件卡片未渲染: ${name}`)
  return card
}

function resetStores(): void {
  act(() => {
    useMediaStore.setState({ mediaFiles: [] })
    useUIStore.setState({
      fullscreenOpen: false,
      fullscreenIndex: -1,
      fullscreenTargetImg: null,
      fullscreenFiles: null
    })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  setupElectron()
  resetStores()
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  resetStores()
})

describe('重复文件右键「打开」→ 全屏内容映射', () => {
  it('「打开」把打开时所在的重复文件列表与对应下标一并写入全屏状态', async () => {
    // 图库列表与重复列表不同源：错位时全屏会指向图库的 g2.jpg 而非 b.jpg
    act(() => {
      useMediaStore.setState({ mediaFiles: galleryFiles })
    })
    render(<DuplicatesPage />)

    await waitFor(() => expect(cardFor('b.jpg')).toBeTruthy())
    fireEvent.contextMenu(cardFor('b.jpg'))
    await waitFor(() => expect(screen.getByText('打开')).toBeInTheDocument())
    fireEvent.click(screen.getByText('打开'))

    await waitFor(() => expect(useUIStore.getState().fullscreenOpen).toBe(true))
    const s = useUIStore.getState()
    // 全屏状态必须携带「重复文件列表」本体（null/undefined = 仍回退图库列表，属缺陷）
    expect(s.fullscreenFiles).toBeTruthy()
    // 下标必须在该列表内对准所点卡片 b.jpg
    expect(s.fullscreenFiles?.[s.fullscreenIndex]?.file_path).toBe('C:\\dup\\b.jpg')
  })

  it('FullscreenViewer 优先使用 store 传入的 fullscreenFiles 而非 props filteredFiles', () => {
    const dupFiles = [
      {
        id: '11',
        file_path: 'C:\\dup\\a.jpg',
        file_name: 'a.jpg',
        file_type: 'image',
        created_at: '2024-01-01T00:00:00Z'
      },
      {
        id: '12',
        file_path: 'C:\\dup\\b.jpg',
        file_name: 'b.jpg',
        file_type: 'image',
        created_at: '2024-01-02T00:00:00Z'
      }
    ] as unknown as MediaFile[]

    act(() => {
      useMediaStore.setState({ mediaFiles: galleryFiles })
      useUIStore.setState({
        fullscreenOpen: true,
        fullscreenIndex: 1,
        fullscreenFiles: dupFiles
      })
    })
    render(<FullscreenViewer filteredFiles={galleryFiles} />)

    // props 列表下标 1 是 g2.jpg；正确行为是显示 store 列表下标 1 的 b.jpg
    const img = screen.getByAltText('b.jpg') as HTMLImageElement
    expect(img.getAttribute('src')).toContain('b.jpg')
  })
})
