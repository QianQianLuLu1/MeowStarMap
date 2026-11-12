/**
 * @vitest-environment jsdom
 * @module src/renderer/pages/RecycleBinPage
 * @coverage 恢复成功契约：preload call() 不回传 success 字段、图库刷新必须写回 store、
 *   nikkisync 源恢复走叠加层取消隐藏
 *
 * #fix-nikkisync-recycle-orphan-page：本文件原先沿用「读源码 + indexOf 切片 + toMatch」
 * 的文本断言，既不渲染组件也不验证实参/失败分支。本轮按审查要求等价替换为 render
 * 行为测试，保留四条成功契约意图并补充失败分支与 nikkisync 分流断言。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub

const showMessageMock = vi.hoisted(() => vi.fn())
const refreshMediaMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('./settings/sections', () => ({
  useGlobalToast: () => showMessageMock
}))
vi.mock('../hooks/useRefreshMedia', () => ({
  useRefreshMedia: () => refreshMediaMock
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
    }) =>
      React.createElement(
        'div',
        { 'data-testid': 'virtuoso-grid' },
        (data ?? []).map((row, i) =>
          React.createElement(React.Fragment, { key: i }, itemContent ? itemContent(i, row) : null)
        )
      ),
    Virtuoso: () => null
  }
})
vi.mock('../components/common/ConfirmDialog', () => ({
  ConfirmDialog: () => null
}))
vi.mock('../components/common/TaskProgressOverlay', () => ({
  TaskProgressOverlay: () => null
}))

import { RecycleBinPage } from './RecycleBinPage'
import { useMediaStore } from '../stores/mediaStore'
import type { NikkiAsset } from '../../shared/sync/domain-types'
import type { AssetEditsInfo } from '../../shared/types/electron-api'

const localFile = {
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

const asset = (assetId: string): NikkiAsset => ({
  schemaVersion: 1,
  assetId,
  type: 'photo',
  state: 'ready',
  source: {
    game: 'infinity_nikki',
    uid: '101622755',
    discoveredAt: '2026-10-01T00:00:00.000Z',
    capturedAt: '2026-10-01T08:00:00.000Z'
  },
  resources: [
    {
      resourceId: `r-${assetId}`,
      role: 'source_high_quality',
      fileName: `${assetId}.png`,
      mimeType: 'image/png',
      fileExt: '.png',
      sizeBytes: 4096,
      sha256: 'aa',
      width: 100,
      height: 200
    }
  ],
  revision: 3
})

const edit = (assetId: string): AssetEditsInfo => ({
  assetId,
  isFavorite: false,
  rating: 0,
  tags: [],
  notes: '',
  categoryId: null,
  outfit: null,
  sceneCategory: null,
  sceneTime: null,
  isHidden: true,
  deletedAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z'
})

function setupLocal() {
  const mediaList = vi.fn().mockResolvedValue({
    files: [localFile],
    total: 1,
    hasMore: false,
    nextCursor: null
  })
  const restore = vi.fn().mockResolvedValue({ message: '已恢复 1 项' })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    media: { list: mediaList },
    mediaAction: { restore, permanentDelete: vi.fn(), emptyRecycleBin: vi.fn() }
  }
  return { mediaList, restore }
}

function setupNikkiBridge() {
  const assetSet = vi.fn().mockResolvedValue({ edit: null })
  const restore = vi.fn().mockResolvedValue({ message: '' })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    nikkisync: {
      getAssetDetail: vi.fn().mockImplementation(async (assetId: string) => ({
        asset: asset(assetId)
      })),
      getResourceRecords: vi
        .fn()
        .mockResolvedValue({ byAsset: { 'a/1': { 'r-a/1': 'D:/Game/a1.png' } } })
    },
    assetEdits: {
      listHidden: vi.fn().mockResolvedValue({ edits: [edit('a/1')], total: 1 }),
      set: assetSet
    },
    file: { deletePermanent: vi.fn() },
    media: {
      list: vi.fn().mockResolvedValue({ files: [], total: 0, hasMore: false, nextCursor: null })
    },
    mediaAction: { restore, permanentDelete: vi.fn(), emptyRecycleBin: vi.fn() }
  }
  useMediaStore.setState({ source: 'nikkisync' })
  return { assetSet, restore }
}

async function triggerRestore(fileName: string): Promise<void> {
  render(<RecycleBinPage />)
  const card = await waitFor(() => {
    const found = screen
      .getAllByRole('checkbox')
      .find((el) => el.getAttribute('aria-label')?.includes(fileName))
    if (!found) throw new Error('回收站卡片未渲染')
    return found as HTMLElement
  })
  fireEvent.click(card)
  fireEvent.click(screen.getByRole('button', { name: '恢复选中项' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  showMessageMock.mockClear()
  refreshMediaMock.mockClear()
  useMediaStore.setState({
    source: 'local',
    recycleBinFiles: [],
    recycleBinTotal: 0,
    recycleBinLoading: false,
    recycleBinHasMore: false,
    recycleBinLoadingMore: false
  })
})

afterEach(() => {
  cleanup()
  useMediaStore.setState({ source: 'local' })
  document.body.innerHTML = ''
})

describe('RecycleBinPage 恢复成功契约（行为断言）', () => {
  it('data 无 success 字段仍走成功路径：restore + 图库刷新 + 回收站刷新 + 成功 toast', async () => {
    const { mediaList, restore } = setupLocal()
    await triggerRestore('a.jpg')

    await waitFor(() => expect(restore).toHaveBeenCalledWith([1]))
    expect(refreshMediaMock).toHaveBeenCalled()
    await waitFor(() => expect(mediaList).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(showMessageMock).toHaveBeenCalledWith('已恢复 1 项', 'success'))
    expect(screen.queryByText('重试恢复')).not.toBeInTheDocument()
  })

  it('restore 抛错 ⇒ 错误 toast + 重试入口', async () => {
    const { restore } = setupLocal()
    restore.mockRejectedValue(new Error('数据库被锁定'))
    await triggerRestore('a.jpg')

    await waitFor(() => expect(showMessageMock).toHaveBeenCalledWith('数据库被锁定', 'error'))
    expect(screen.getByText('重试恢复')).toBeInTheDocument()
  })
})

describe('RecycleBinPage 恢复 nikkisync 分支（叠加层取消隐藏）', () => {
  it('assetEdits.set(assetId,{isHidden:false})，本地 restore 零调用', async () => {
    const { assetSet, restore } = setupNikkiBridge()
    await triggerRestore('a/1.png')

    await waitFor(() => expect(assetSet).toHaveBeenCalledWith('a/1', { isHidden: false }))
    expect(restore).not.toHaveBeenCalled()
    expect(refreshMediaMock).toHaveBeenCalled()
    await waitFor(() => expect(showMessageMock).toHaveBeenCalledWith('已恢复 1 项', 'success'))
  })

  it('assetEdits.set 失败 ⇒ 错误 toast + 重试入口', async () => {
    const { assetSet } = setupNikkiBridge()
    assetSet.mockRejectedValue(new Error('叠加层写入失败'))
    await triggerRestore('a/1.png')

    await waitFor(() => expect(showMessageMock).toHaveBeenCalledWith('叠加层写入失败', 'error'))
    expect(screen.getByText('重试恢复')).toBeInTheDocument()
  })
})
