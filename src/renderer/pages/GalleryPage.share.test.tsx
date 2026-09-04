/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/pages/GalleryPage
 * @coverage 剪贴板分享链路集成：批量分享触发 → copyFiles → detectApp → ShareGuideDialog 状态
 * @dependencies electronAPI.share（mock）/ uiStore / mediaStore
 *
 * 修复背景：右键/批量"分享"三渠道不可用——handleShareToClipboard 误读 detectApp 结果中
 * 不存在的 success 字段（installed/running 恒 false），且 copyFiles/detectApp 抛 IpcError 时
 * 无兜底导致点击无反应。修复后流程收敛到 runClipboardShare，本测试验证渲染层接线。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { MediaFile } from '../stores/mediaStore'

// vi.mock 工厂被提升到模块顶部：共享状态与夹具必须经 vi.hoisted 定义
const { hoisted } = vi.hoisted(() => {
  const guidePropsHolder: { current: Record<string, unknown> | null } = { current: null }
  const showMessageSpy = vi.fn()
  const makeFile = (id: string, filePath: string): MediaFile => ({
    id,
    file_path: filePath,
    file_name: filePath.split('\\').pop() ?? filePath,
    file_type: 'image',
    file_ext: '.jpg',
    file_size: 1024,
    created_at: '2026-08-27T00:00:00Z',
    modified_at: '2026-08-27T00:00:00Z',
    tags: [],
    rating: 0,
    is_favorite: false,
    notes: '',
    scene_category: 'screenshot'
  })
  return {
    hoisted: {
      guidePropsHolder,
      showMessageSpy,
      // 测试媒体：两张图，路径用于断言 copyFiles 入参
      testFiles: [makeFile('1', 'D:\\Game\\a.jpg'), makeFile('2', 'D:\\Game\\b.jpg')]
    }
  }
})

vi.mock('../components/common/ShareGuideDialog', () => ({
  // 捕获最新 props 供状态断言（含 open/channelId/installed/running/copyResult）
  ShareGuideDialog: (props: Record<string, unknown>) => {
    hoisted.guidePropsHolder.current = props
    return <div data-testid="share-guide" />
  }
}))
vi.mock('../components/gallery/BatchActions', () => ({
  BatchActions: ({ onShareClipboard }: { onShareClipboard?: (c: string) => void }) =>
    onShareClipboard ? (
      <div>
        <button onClick={() => onShareClipboard('wechat')}>share-wechat</button>
        <button onClick={() => onShareClipboard('qq')}>share-qq</button>
        <button onClick={() => onShareClipboard('vivo')}>share-vivo</button>
      </div>
    ) : null
}))
vi.mock('../components/common/EmptyState', () => ({ EmptyState: () => null }))
vi.mock('../components/common/ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('../components/common/TaskProgressOverlay', () => ({ TaskProgressOverlay: () => null }))
vi.mock('../components/common/PropertiesDialog', () => ({ PropertiesDialog: () => null }))
vi.mock('../components/common/ContextMenu', () => ({ ContextMenu: () => null }))
vi.mock('../components/common/WifiShareDialog', () => ({ WifiShareDialog: () => null }))
vi.mock('../components/gallery/VirtualImageGrid', () => ({ VirtualImageGrid: () => null }))
vi.mock('../components/gallery/ListView', () => ({ ListView: () => null }))
vi.mock('../components/gallery/TimelineView', () => ({ TimelineView: () => null }))
vi.mock('../components/gallery/MasonryView', () => ({ MasonryView: () => null }))
vi.mock('../components/gallery/EventTimelineView', () => ({ EventTimelineView: () => null }))
vi.mock('../components/gallery/GalleryToolbar', () => ({ GalleryToolbar: () => null }))
vi.mock('../components/gallery/RenameDialog', () => ({ RenameDialog: () => null }))
vi.mock('../components/gallery/WatermarkDialog', () => ({ WatermarkDialog: () => null }))
vi.mock('../components/gallery/SlideshowPlayer', () => ({ SlideshowPlayer: () => null }))
vi.mock('../components/gallery/BatchRenameDialog', () => ({ BatchRenameDialog: () => null }))
vi.mock('../components/gallery/ImportWizard', () => ({ ImportWizard: () => null }))
vi.mock('../components/gallery/SmartGroupPanel', () => ({ SmartGroupPanel: () => null }))
vi.mock('../components/scanner/ScanProgress', () => ({ ScanProgress: () => null }))
vi.mock('../icons', () => ({ IconImage: () => null }))
vi.mock('../hooks/useFileOperations', () => ({
  useFileOperations: () => ({
    handleOpen: vi.fn(),
    handleEdit: vi.fn(),
    handleSaveAs: vi.fn(),
    handleCopy: vi.fn(),
    handleMove: vi.fn(),
    handleRename: vi.fn(),
    handleToggleFavorite: vi.fn(),
    deleteFilesBatch: vi.fn(),
    getDeleteConfirm: vi.fn(() => ({ title: '', message: '', onConfirm: vi.fn() })),
    deleteProgress: null,
    cancelDelete: vi.fn()
  })
}))
vi.mock('../hooks/useBatchOperations', () => ({
  useBatchOperations: () => ({
    handleBatchExport: vi.fn(),
    handleBatchMove: vi.fn(),
    handleTransferToProfile: vi.fn(),
    handleBatchWatermark: vi.fn(),
    handleCancelWatermarkTask: vi.fn(),
    handleBatchRename: vi.fn(),
    setWatermarkDialog: vi.fn(),
    setWatermarkConfig: vi.fn(),
    setBatchRenameDialog: vi.fn(),
    watermarkDialog: false,
    watermarkConfig: null,
    watermarkProgress: null,
    watermarking: false,
    batchRenameDialog: false,
    selectedFiles: []
  })
}))
vi.mock('../hooks/useGallerySearch', () => ({
  useGallerySearch: () => ({ inputValue: '', setInputValue: vi.fn() })
}))
vi.mock('../hooks/useRefreshMedia', () => ({ useRefreshMedia: () => vi.fn() }))
vi.mock('../hooks/useFilteredMediaFiles', () => ({
  useFilteredMediaFiles: () => hoisted.testFiles
}))
vi.mock('./settings/sections', () => ({ useGlobalToast: () => hoisted.showMessageSpy }))
vi.mock('../utils/gallery', () => ({ getContextMenuItems: vi.fn(() => []) }))

import { GalleryPage } from './GalleryPage'
import { useMediaStore } from '../stores/mediaStore'
import { useUIStore } from '../stores/uiStore'

function setElectronAPI(share: unknown): void {
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    scanner: {
      status: vi.fn().mockResolvedValue({ status: 'idle' }),
      onComplete: vi.fn(() => () => {})
    },
    media: {
      list: vi.fn().mockResolvedValue({ files: [], categories: [], total: 0, hasMore: false }),
      onUpdated: vi.fn(() => () => {})
    },
    category: { list: vi.fn().mockResolvedValue({ categories: [] }) },
    share
  }
}

function selectBothFiles(): void {
  useMediaStore.setState({ mediaFiles: hoisted.testFiles, loading: false })
  useUIStore.setState({
    currentView: 'gallery',
    viewMode: 'grid',
    selectedMediaIds: ['1', '2'],
    showDuplicates: false,
    showCorruptedOnly: false
  })
}

describe('GalleryPage 剪贴板分享链路（右键/批量共用的 handleShareToClipboard）', () => {
  let copyFiles: ReturnType<typeof vi.fn>
  let detectApp: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.guidePropsHolder.current = null
    copyFiles = vi.fn().mockResolvedValue({ success: true, count: 2, skipped: 0, message: 'ok' })
    detectApp = vi
      .fn()
      .mockResolvedValue({ installed: true, running: true, installPath: 'C:\\WeChat.exe' })
    setElectronAPI({ copyFiles, detectApp })
    selectBothFiles()
  })

  it.each(['wechat', 'qq', 'vivo'] as const)(
    '渠道 %s：复制选中文件 → 检测渠道 → 弹窗透传真实 installed/running（不再恒 false）',
    async (channel) => {
      render(<GalleryPage />)
      fireEvent.click(screen.getByText(`share-${channel}`))

      await waitFor(() => {
        expect(copyFiles).toHaveBeenCalledWith(['D:\\Game\\a.jpg', 'D:\\Game\\b.jpg'])
      })
      expect(detectApp).toHaveBeenCalledWith(channel)
      await waitFor(() => {
        expect(hoisted.guidePropsHolder.current).toMatchObject({
          open: true,
          channelId: channel,
          installed: true,
          running: true
        })
      })
      expect(hoisted.showMessageSpy).not.toHaveBeenCalled()
    }
  )

  it('已安装未运行：installed=true/running=false 原样透传（修复缺陷 A 的核心断言）', async () => {
    detectApp.mockResolvedValue({ installed: true, running: false, installPath: 'C:\\QQ.exe' })
    render(<GalleryPage />)
    fireEvent.click(screen.getByText('share-qq'))

    await waitFor(() => {
      expect(hoisted.guidePropsHolder.current).toMatchObject({
        open: true,
        installed: true,
        running: false
      })
    })
  })

  it('复制业务失败：失败 copyResult 透传给引导弹窗，不进入检测', async () => {
    copyFiles.mockResolvedValue({
      success: false,
      count: 0,
      skipped: 2,
      message: '所有文件均不可访问'
    })
    render(<GalleryPage />)
    fireEvent.click(screen.getByText('share-wechat'))

    await waitFor(() => {
      expect(hoisted.guidePropsHolder.current).toMatchObject({
        open: true,
        copyResult: { success: false, message: '所有文件均不可访问' }
      })
    })
    expect(detectApp).not.toHaveBeenCalled()
  })

  it('复制 IPC 抛 IpcError（如路径白名单拒绝）：弹窗展示错误消息，不再静默无反应', async () => {
    copyFiles.mockRejectedValue(
      Object.assign(new Error('path not allowed'), {
        name: 'IpcError',
        code: 'IPC_FORBIDDEN',
        userMessage: '该路径不允许读取'
      })
    )
    render(<GalleryPage />)
    fireEvent.click(screen.getByText('share-vivo'))

    await waitFor(() => {
      expect(hoisted.guidePropsHolder.current).toMatchObject({
        open: true,
        copyResult: { success: false, message: '该路径不允许读取' }
      })
    })
  })

  it('share 命名空间缺失：提示分享接口不可用，不调用 IPC', async () => {
    setElectronAPI(undefined)
    render(<GalleryPage />)
    // share 缺失时 BatchActions 回调仍可用（守卫在 handleShareToClipboard 内）
    fireEvent.click(screen.getByText('share-wechat'))

    await waitFor(() => {
      expect(hoisted.showMessageSpy).toHaveBeenCalledWith('分享接口不可用', 'error')
    })
    expect(copyFiles).not.toHaveBeenCalled()
  })
})
