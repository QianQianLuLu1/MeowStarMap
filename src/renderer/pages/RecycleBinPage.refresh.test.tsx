/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/pages/RecycleBinPage
 * @coverage 回收站数据刷新：media:updated 广播订阅 + 视图切回刷新（回收站语义修复 D4）
 *
 * 修复前：页面空依赖 useEffect 只在首次挂载拉一次数据，而 App 采用 keep-alive
 * （display:none 保活）——从图库删除照片后切到回收站，列表长期为空/陈旧。
 * 修复后：① 订阅 media:updated 广播（当前视图为回收站时重新拉取）；
 * ② currentView 变为 recycle-bin 时重新拉取。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, cleanup, act } from '@testing-library/react'

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
vi.mock('../components/common/ConfirmDialog', () => ({
  ConfirmDialog: () => null
}))
vi.mock('../components/common/TaskProgressOverlay', () => ({
  TaskProgressOverlay: () => null
}))
vi.mock('../hooks/useRefreshMedia', () => ({
  useRefreshMedia: () => vi.fn().mockResolvedValue(undefined)
}))

import { RecycleBinPage } from './RecycleBinPage'
import { useMediaStore, type MediaFile } from '../stores/mediaStore'
import { useUIStore } from '../stores/uiStore'

function makeRecycleFile(): MediaFile {
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
    height: 1080
  }
}

// onUpdated 捕获订阅回调（media:updated 广播 → 回调重新拉取）
let onUpdatedCallback: (() => void) | null = null
const electron = {
  media: {
    list: vi.fn().mockResolvedValue({
      files: [makeRecycleFile()],
      total: 1,
      hasMore: false,
      nextCursor: null,
      page: 1,
      pageSize: 200
    }),
    onUpdated: vi.fn((cb: () => void) => {
      onUpdatedCallback = cb
      return () => {
        onUpdatedCallback = null
      }
    })
  },
  mediaAction: {
    permanentDelete: vi.fn().mockResolvedValue({ message: '', deletedCount: 0, failedCount: 0 }),
    restore: vi.fn().mockResolvedValue({ message: '' }),
    softDelete: vi.fn().mockResolvedValue({ success: true, message: '' }),
    emptyRecycleBin: vi.fn().mockResolvedValue({ message: '', movedCount: 0, failedCount: 0 })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  showMessageMock.mockClear()
  onUpdatedCallback = null
  ;(window as unknown as { electronAPI: unknown }).electronAPI = electron
  useMediaStore.setState({
    recycleBinFiles: [],
    recycleBinTotal: 0,
    recycleBinLoading: false,
    recycleBinHasMore: false,
    recycleBinLoadingMore: false
  })
  useUIStore.setState({ currentView: 'recycle-bin', viewStack: ['gallery', 'recycle-bin'] })
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  useUIStore.setState({ currentView: 'gallery', viewStack: ['gallery'] })
})

describe('RecycleBinPage 数据刷新（回收站语义修复 D4）', () => {
  it('media:updated 广播后重新拉取（不依赖重新挂载）', async () => {
    render(<RecycleBinPage />)
    // 首次挂载拉取第 1 次
    await waitFor(() => expect(electron.media.list).toHaveBeenCalledTimes(1))
    expect(onUpdatedCallback).toBeTruthy()

    // 广播 media:updated（当前视图为回收站）→ 重新拉取
    act(() => {
      onUpdatedCallback!()
    })
    await waitFor(() => expect(electron.media.list).toHaveBeenCalledTimes(2))
  })

  it('视图从 gallery 切回 recycle-bin 时重新拉取', async () => {
    render(<RecycleBinPage />)
    await waitFor(() => expect(electron.media.list).toHaveBeenCalledTimes(1))

    // 切到图库（不拉取），再切回回收站（重新拉取）
    act(() => {
      useUIStore.setState({ currentView: 'gallery' })
    })
    act(() => {
      useUIStore.setState({ currentView: 'recycle-bin' })
    })
    await waitFor(() => expect(electron.media.list).toHaveBeenCalledTimes(2))
  })
})
