/**
 * @vitest-environment jsdom
 * @module src/renderer/pages/RecycleBinPage
 * @coverage 清空回收站：成功契约、取数失败兜底、nikkisync 叠加层分页遍历
 *
 * #fix-nikkisync-recycle-orphan-page：本文件原先以「读源码 + indexOf 切片 + toMatch」
 * 做文本断言，分支写错仍会绿、无害重命名即变红。本轮按审查要求等价替换为 render
 * 行为测试：保留原有三条成功契约意图（不误读 result.success / 刷新列表 / toast 语义），
 * 并新增「真取数失败不得弹成功」与「整页孤儿行后仍能删除后续页」的分页行为断言。
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
import { useMediaStore } from '../stores/mediaStore'
import type { NikkiAsset } from '../../shared/sync/domain-types'
import type { AssetEditsInfo } from '../../shared/types/electron-api'

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

function setupLocal(emptyResult: Record<string, unknown> = {}) {
  const mediaList = vi.fn().mockResolvedValue({
    files: [localFile],
    total: 1,
    hasMore: false,
    nextCursor: null
  })
  const emptyRecycleBin = vi.fn().mockResolvedValue({
    message: '已清空回收站',
    movedCount: 1,
    failedCount: 0,
    ...emptyResult
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    media: { list: mediaList },
    mediaAction: {
      emptyRecycleBin,
      permanentDelete: vi.fn(),
      restore: vi.fn()
    }
  }
  return { mediaList, emptyRecycleBin }
}

function setupNikkiBridge(opts: {
  hiddenPages: Array<{ edits: AssetEditsInfo[]; total: number }>
  detail?: (assetId: string) => Promise<{ asset: NikkiAsset }>
  paths?: Record<string, Record<string, string>>
  nullPages?: number[]
}) {
  let call = 0
  const listHidden = vi.fn().mockImplementation(async () => {
    call += 1
    if (opts.nullPages?.includes(call)) return null
    return opts.hiddenPages[Math.min(call - 1, opts.hiddenPages.length - 1)]
  })
  const getAssetDetail = vi
    .fn()
    .mockImplementation(opts.detail ?? (async (assetId: string) => ({ asset: asset(assetId) })))
  const getResourceRecords = vi.fn().mockResolvedValue({ byAsset: opts.paths ?? {} })
  const deletePermanent = vi.fn().mockResolvedValue({ success: true, message: 'ok' })
  const assetSet = vi.fn().mockResolvedValue({ edit: null })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    nikkisync: { getAssetDetail, getResourceRecords },
    assetEdits: { listHidden, set: assetSet },
    file: { deletePermanent },
    media: {
      list: vi.fn().mockResolvedValue({ files: [], total: 0, hasMore: false, nextCursor: null })
    },
    mediaAction: {
      permanentDelete: vi.fn(),
      restore: vi.fn(),
      emptyRecycleBin: vi.fn()
    }
  }
  useMediaStore.setState({ source: 'nikkisync' })
  return { listHidden, deletePermanent, assetSet }
}

async function triggerEmpty(): Promise<void> {
  render(<RecycleBinPage />)
  const button = await waitFor(() => screen.getByRole('button', { name: '清空回收站' }))
  expect(button).not.toBeDisabled()
  fireEvent.click(button)
  await waitFor(() => expect(screen.getByTestId('confirm-ok')).toBeInTheDocument())
  fireEvent.click(screen.getByTestId('confirm-ok'))
}

beforeEach(() => {
  vi.clearAllMocks()
  showMessageMock.mockClear()
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

describe('RecycleBinPage 清空回收站成功契约（行为断言）', () => {
  it('data 无 success 字段仍走成功路径：调用清空、刷新列表并弹成功 toast', async () => {
    const { mediaList, emptyRecycleBin } = setupLocal()
    await triggerEmpty()

    await waitFor(() => expect(emptyRecycleBin).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mediaList).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(showMessageMock).toHaveBeenCalledWith('已清空回收站', 'success'))
    expect(screen.queryByText('重试清空')).not.toBeInTheDocument()
  })

  it('failedCount>0 时弹错误 toast 并点亮重试入口', async () => {
    setupLocal({ failedCount: 1, message: '1 项清空失败' })
    await triggerEmpty()

    await waitFor(() => expect(showMessageMock).toHaveBeenCalledWith('1 项清空失败', 'error'))
    expect(screen.getByText('重试清空')).toBeInTheDocument()
  })
})

describe('RecycleBinPage 清空 nikkisync 分支（叠加层隐藏集 + 文件通道）', () => {
  it('取数中途失败（listHidden 返回无效）⇒ 弹错误 + 重试入口，不得弹成功', async () => {
    setupNikkiBridge({
      hiddenPages: [{ edits: [edit('a/1')], total: 401 }],
      paths: { 'a/1': { 'r-a/1': 'D:/Game/a1.png' } },
      // 第 1 次 listHidden 是组件挂载的 loadRecycleBin；第 2 次是清空循环首页取数
      nullPages: [2]
    })
    await triggerEmpty()

    await waitFor(() => expect(showMessageMock).toHaveBeenCalledWith(expect.any(String), 'error'))
    expect(screen.getByText('重试清空')).toBeInTheDocument()
    expect(showMessageMock).not.toHaveBeenCalledWith(expect.anything(), 'success')
  })

  it('整页孤儿行后仍能删除后续页的有效行，成功计数只含实际删除数', async () => {
    const { deletePermanent } = setupNikkiBridge({
      hiddenPages: [
        { edits: [edit('a/1')], total: 401 },
        { edits: [edit('a/2')], total: 401 },
        { edits: [edit('a/3')], total: 401 }
      ],
      detail: async (assetId) => {
        if (assetId === 'a/2') throw new Error('runtime gone')
        return { asset: asset(assetId) }
      },
      paths: {
        'a/1': { 'r-a/1': 'D:/Game/a1.png' },
        'a/3': { 'r-a/3': 'D:/Game/a3.png' }
      }
    })
    await triggerEmpty()

    await waitFor(() => expect(deletePermanent).toHaveBeenCalledWith(['D:/Game/a3.png']))
    expect(deletePermanent).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(showMessageMock).toHaveBeenCalledWith('已彻底删除 2 项', 'success'))
  })

  it('文件通道返回 success:false ⇒ 弹错误 toast，不得弹成功', async () => {
    const { deletePermanent } = setupNikkiBridge({
      hiddenPages: [{ edits: [edit('a/1')], total: 1 }],
      paths: { 'a/1': { 'r-a/1': 'D:/Game/a1.png' } }
    })
    deletePermanent.mockResolvedValue({ success: false, message: '磁盘写入失败' })
    await triggerEmpty()

    await waitFor(() => expect(showMessageMock).toHaveBeenCalledWith('磁盘写入失败', 'error'))
    expect(showMessageMock).not.toHaveBeenCalledWith(expect.anything(), 'success')
  })
})
