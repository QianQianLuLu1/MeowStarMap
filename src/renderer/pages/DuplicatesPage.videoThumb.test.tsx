/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/pages/DuplicatesPage
 * @coverage 重复文件板块视频缩略图预览：复用 MediaThumbnail + 视频专用取源规则 +
 *           缺图视频按需生成一次。回归 VirtualImageGrid.thumb.test.tsx 已固化的不变量：
 *           「视频绝不回退到原文件当 <img src>」。
 * @dependencies window.electronAPI（覆盖占位 Proxy）/ @testing-library/react
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
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

const group: DuplicateItem[] = [
  {
    id: 1,
    file_path: 'C:\\videos\\v1.mp4',
    file_name: 'v1.mp4',
    file_type: 'video',
    file_size: 100,
    modified_at: '2024-01-01T00:00:00Z',
    width: 1920,
    height: 1080,
    is_favorite: false,
    rating: 0,
    thumbnail: 'C:\\cache\\v1.jpg'
  },
  {
    id: 2,
    file_path: 'C:\\videos\\v2.mp4',
    file_name: 'v2.mp4',
    file_type: 'video',
    file_size: 120,
    modified_at: '2024-01-02T00:00:00Z',
    width: 1920,
    height: 1080,
    is_favorite: false,
    rating: 0,
    thumbnail: null
  },
  {
    id: 3,
    file_path: 'C:\\images\\img1.jpg',
    file_name: 'img1.jpg',
    file_type: 'image',
    file_size: 80,
    modified_at: '2024-01-03T00:00:00Z',
    width: 800,
    height: 600,
    is_favorite: false,
    rating: 0,
    thumbnail: 'C:\\cache\\img1.jpg'
  },
  {
    id: 4,
    file_path: 'C:\\images\\img2.png',
    file_name: 'img2.png',
    file_type: 'image',
    file_size: 90,
    modified_at: '2024-01-04T00:00:00Z',
    width: 800,
    height: 600,
    is_favorite: false,
    rating: 0,
    thumbnail: null
  }
]

const scanResult = {
  success: true,
  cancelled: false,
  totalGroups: 1,
  totalFiles: 4,
  duplicates: [group],
  bestItemIds: { 0: 1 },
  totalSizeSavedBytes: 0,
  totalCount: 4
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

function imgIn(card: HTMLElement): HTMLImageElement | null {
  return card.querySelector('img')
}

// 构造扫描结果（与页面读取字段对齐：duplicates / success / totalGroups / bestItemIds）
function buildScan(items: DuplicateItem[]) {
  return {
    success: true,
    cancelled: false,
    totalGroups: 1,
    totalFiles: items.length,
    duplicates: [items],
    bestItemIds: { 0: items[0]?.id ?? 0 },
    totalSizeSavedBytes: 0,
    totalCount: items.length
  }
}

// 复制默认组内 v2（缺图视频），替换为唯一路径，避免模块级缓存跨用例串扰
function groupWithV2(path: string, name: string, id: number): DuplicateItem[] {
  return group.map((it) =>
    it.id === 2 ? { ...it, id, file_path: path, file_name: name } : { ...it }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  setupElectron()
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('重复文件板块视频缩略图预览', () => {
  it('视频含 thumbnail → 渲染 <img> 且 src 指向缩略图 jpg（不含 .mp4）', async () => {
    render(<DuplicatesPage />)
    await waitFor(() => expect(electron.media.findDuplicates).toHaveBeenCalled())
    const card = await waitFor(() => cardFor('v1.mp4'))
    const img = imgIn(card)
    expect(img).not.toBeNull()
    expect(img!.src).toContain('.jpg')
    expect(img!.src).not.toContain('.mp4')
  })

  it('全页任意 <img> src 都不含 .mp4（视频绝不回退原文件）', async () => {
    render(<DuplicatesPage />)
    await waitFor(() => expect(electron.media.findDuplicates).toHaveBeenCalled())
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0))
    const imgs = screen.getAllByRole('img') as HTMLImageElement[]
    for (const img of imgs) {
      expect(img.src).not.toContain('.mp4')
    }
  })

  it('视频无 thumbnail → 不渲染 <img>（降级为视频占位图标）', async () => {
    render(<DuplicatesPage />)
    await waitFor(() => expect(electron.media.findDuplicates).toHaveBeenCalled())
    const card = await waitFor(() => cardFor('v2.mp4'))
    expect(imgIn(card)).toBeNull()
    // 占位图标（svg）存在
    expect(card.querySelector('svg')).not.toBeNull()
  })

  it('图片含 thumbnail → 渲染 <img> 指向缩略图；图片无 thumbnail → 回退 file_path', async () => {
    render(<DuplicatesPage />)
    await waitFor(() => expect(electron.media.findDuplicates).toHaveBeenCalled())
    const img1 = await waitFor(() => {
      const c = cardFor('img1.jpg')
      const i = imgIn(c)
      expect(i).not.toBeNull()
      return i!
    })
    expect(img1.src).toContain('.jpg')

    const img2 = await waitFor(() => {
      const c = cardFor('img2.png')
      const i = imgIn(c)
      expect(i).not.toBeNull()
      return i!
    })
    expect(img2.src).toContain('.png')
  })

  it('视频无 thumbnail 且 generate 返回路径 → 触发一次生成并渲染 <img>', async () => {
    electron.media.findDuplicates.mockResolvedValue(
      buildScan(groupWithV2('C:\\videos\\v5.mp4', 'v5.mp4', 2))
    )
    electron.thumbnail.generate.mockResolvedValue('C:\\cache\\v5_gen.jpg')
    render(<DuplicatesPage />)
    await waitFor(() => expect(electron.media.findDuplicates).toHaveBeenCalled())
    const card = await waitFor(() => {
      const c = cardFor('v5.mp4')
      expect(imgIn(c)).not.toBeNull()
      return c
    })
    expect(electron.thumbnail.generate).toHaveBeenCalledTimes(1)
    expect(electron.thumbnail.generate).toHaveBeenCalledWith('C:\\videos\\v5.mp4')
    expect(imgIn(card)!.src).toContain('.jpg')
  })

  it('图片类型不触发 thumbnail.generate', async () => {
    // 组内视频均带缩略图，确保不会触发生成
    const g = group.map((it) => (it.id === 2 ? { ...it, thumbnail: 'C:\\cache\\v2.jpg' } : it))
    electron.media.findDuplicates.mockResolvedValue(buildScan(g))
    render(<DuplicatesPage />)
    await waitFor(() => expect(electron.media.findDuplicates).toHaveBeenCalled())
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0))
    expect(electron.thumbnail.generate).not.toHaveBeenCalled()
  })

  it('缺图视频 generate 返回 null → 仍不渲染 <img>（静默降级）', async () => {
    electron.media.findDuplicates.mockResolvedValue(
      buildScan(groupWithV2('C:\\videos\\v7.mp4', 'v7.mp4', 2))
    )
    electron.thumbnail.generate.mockResolvedValue(null)
    render(<DuplicatesPage />)
    await waitFor(() => expect(electron.media.findDuplicates).toHaveBeenCalled())
    const card = await waitFor(() => cardFor('v7.mp4'))
    // 等待 effect 跑完
    await new Promise((r) => setTimeout(r, 50))
    expect(imgIn(card)).toBeNull()
    expect(electron.thumbnail.generate).toHaveBeenCalledTimes(1)
  })
})
