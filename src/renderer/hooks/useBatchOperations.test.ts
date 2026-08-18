/**
 * @layer L3
 * @module src/renderer/hooks/useBatchOperations
 * @coverage 批量导出/移动/水印/重命名/跨档案转移 + 进度回调订阅 + 卸载清理
 * @dependencies react, stores/uiStore, stores/mediaStore, window.electronAPI
 * @remarks jsdom 环境，mock window.electronAPI，store 走真实路径
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import { useBatchOperations } from './useBatchOperations'
import { useMediaStore, type MediaFile } from '../stores/mediaStore'
import { useUIStore } from '../stores/uiStore'
import type { WatermarkConfig } from '../utils/imageProcessor'

function makeFile(overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    id: '1',
    file_path: '/test/img.jpg',
    file_name: 'img.jpg',
    file_type: 'image',
    file_ext: '.jpg',
    file_size: 1024,
    created_at: '2026-01-01T00:00:00.000Z',
    modified_at: '2026-01-01T00:00:00.000Z',
    tags: [],
    rating: 0,
    is_favorite: false,
    notes: '',
    scene_category: 'other',
    ...overrides
  }
}

interface MockApi {
  dialog: { selectDirectory: ReturnType<typeof vi.fn> }
  file: {
    export: ReturnType<typeof vi.fn>
    move: ReturnType<typeof vi.fn>
    batchRename: ReturnType<typeof vi.fn>
  }
  settings: { get: ReturnType<typeof vi.fn> }
  watermark: {
    apply: ReturnType<typeof vi.fn>
    onProgress: ReturnType<typeof vi.fn>
  }
  profile: { transferFiles: ReturnType<typeof vi.fn> }
}

function setMockApi(_overrides: Partial<MockApi> = {}): MockApi {
  const api: MockApi = {
    dialog: { selectDirectory: vi.fn() },
    file: {
      export: vi.fn(),
      move: vi.fn(),
      batchRename: vi.fn()
    },
    settings: { get: vi.fn() },
    watermark: {
      apply: vi.fn(),
      onProgress: vi.fn().mockReturnValue(() => {})
    },
    profile: { transferFiles: vi.fn() }
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    dialog: api.dialog,
    file: api.file,
    settings: api.settings,
    watermark: api.watermark,
    profile: api.profile
  }
  return api
}

describe('useBatchOperations', () => {
  let api: MockApi

  beforeEach(() => {
    useMediaStore.setState({ mediaFiles: [] })
    useUIStore.setState({
      selectedMediaIds: []
    })
    api = setMockApi()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('初始状态', () => {
    it('watermarkDialog/watermarkConfig/watermarkProgress/watermarking/batchRenameDialog 初始值正确', () => {
      const { result } = renderHook(() => useBatchOperations({ onShowMessage: vi.fn() }))
      expect(result.current.watermarkDialog).toBe(false)
      expect(result.current.watermarkConfig).toBeNull()
      expect(result.current.watermarkProgress).toBeNull()
      expect(result.current.watermarking).toBe(false)
      expect(result.current.batchRenameDialog).toBe(false)
      expect(result.current.selectedFiles).toEqual([])
    })
  })

  describe('handleBatchExport', () => {
    it('无 electronAPI 时提示不支持', async () => {
      ;(window as unknown as { electronAPI: unknown }).electronAPI = undefined
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      await act(async () => {
        await result.current.handleBatchExport()
      })
      expect(onShowMessage).toHaveBeenCalledWith('当前环境不支持导出', 'error')
    })

    it('useDefaultDir=true 但默认路径未配置时提示', async () => {
      api.settings.get.mockResolvedValue('')
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      await act(async () => {
        await result.current.handleBatchExport(true)
      })
      expect(api.settings.get).toHaveBeenCalledWith('export.defaultDir', '')
      expect(onShowMessage).toHaveBeenCalledWith('未配置默认导出路径，请先在设置中配置', 'error')
    })

    it('useDefaultDir=true 配置存在时调用 file.export', async () => {
      useMediaStore.setState({
        mediaFiles: [makeFile({ id: '1', file_path: '/a.jpg' })]
      })
      useUIStore.setState({ selectedMediaIds: ['1'] })
      api.settings.get.mockResolvedValue('/default/export')
      api.file.export.mockResolvedValue({ success: true, message: '导出成功' })
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      await act(async () => {
        await result.current.handleBatchExport(true)
      })
      expect(api.file.export).toHaveBeenCalledWith(['/a.jpg'], '/default/export', {
        useDefaultDir: true
      })
      expect(onShowMessage).toHaveBeenCalledWith('导出成功', 'success')
    })

    it('useDefaultDir=false 用户取消选目录时不调用 export', async () => {
      api.dialog.selectDirectory.mockResolvedValue('')
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      await act(async () => {
        await result.current.handleBatchExport(false)
      })
      expect(api.file.export).not.toHaveBeenCalled()
    })

    it('export 失败时显示错误消息', async () => {
      useMediaStore.setState({
        mediaFiles: [makeFile({ id: '1', file_path: '/a.jpg' })]
      })
      useUIStore.setState({ selectedMediaIds: ['1'] })
      api.dialog.selectDirectory.mockResolvedValue('/target')
      api.file.export.mockResolvedValue({ success: false, message: '磁盘空间不足' })
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      await act(async () => {
        await result.current.handleBatchExport(false)
      })
      expect(onShowMessage).toHaveBeenCalledWith('磁盘空间不足', 'error')
    })

    it('export reject 时显示兜底错误', async () => {
      useMediaStore.setState({
        mediaFiles: [makeFile({ id: '1', file_path: '/a.jpg' })]
      })
      useUIStore.setState({ selectedMediaIds: ['1'] })
      api.dialog.selectDirectory.mockResolvedValue('/target')
      api.file.export.mockRejectedValue(new Error('network down'))
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      await act(async () => {
        await result.current.handleBatchExport(false)
      })
      expect(onShowMessage).toHaveBeenCalledWith('network down', 'error')
    })
  })

  describe('handleBatchMove', () => {
    it('成功后从 store 删除并 clearSelection', async () => {
      useMediaStore.setState({
        mediaFiles: [
          makeFile({ id: '1', file_path: '/a.jpg' }),
          makeFile({ id: '2', file_path: '/b.jpg' })
        ]
      })
      useUIStore.setState({ selectedMediaIds: ['1'] })
      api.dialog.selectDirectory.mockResolvedValue('/target')
      api.file.move.mockResolvedValue({ success: true, message: '移动成功' })
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      await act(async () => {
        await result.current.handleBatchMove()
      })
      expect(api.file.move).toHaveBeenCalledWith(['/a.jpg'], '/target')
      expect(useMediaStore.getState().mediaFiles).toHaveLength(1)
      expect(useMediaStore.getState().mediaFiles[0].id).toBe('2')
      expect(useUIStore.getState().selectedMediaIds).toEqual([])
      expect(onShowMessage).toHaveBeenCalledWith('移动成功', 'success')
    })

    it('用户取消选目录时不调用 move', async () => {
      api.dialog.selectDirectory.mockResolvedValue('')
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      await act(async () => {
        await result.current.handleBatchMove()
      })
      expect(api.file.move).not.toHaveBeenCalled()
    })

    it('无 electronAPI 时提示不支持', async () => {
      ;(window as unknown as { electronAPI: unknown }).electronAPI = undefined
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      await act(async () => {
        await result.current.handleBatchMove()
      })
      expect(onShowMessage).toHaveBeenCalledWith('当前环境不支持移动', 'error')
    })
  })

  describe('handleBatchWatermark', () => {
    const wmConfig: WatermarkConfig = {
      position: 'bottomRight',
      customX: 0,
      customY: 0,
      rotation: 0,
      margin: 10,
      tile: false,
      tileSpacingX: 0,
      tileSpacingY: 0
    }

    it('watermarkConfig=null 时提示配置水印', async () => {
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      await act(async () => {
        await result.current.handleBatchWatermark()
      })
      expect(onShowMessage).toHaveBeenCalledWith('请先配置水印', 'error')
    })

    it('无 electronAPI 时提示不支持', async () => {
      ;(window as unknown as { electronAPI: unknown }).electronAPI = undefined
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      act(() => {
        result.current.setWatermarkConfig(wmConfig)
      })
      await act(async () => {
        await result.current.handleBatchWatermark()
      })
      expect(onShowMessage).toHaveBeenCalledWith('当前环境不支持批量水印', 'error')
    })

    it('无选中图片时提示未选择', async () => {
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      act(() => {
        result.current.setWatermarkConfig(wmConfig)
      })
      // selectDirectory 必须返回非空，否则提前 return 不进入 filePaths 校验
      api.dialog.selectDirectory.mockResolvedValue('/target')
      await act(async () => {
        await result.current.handleBatchWatermark()
      })
      expect(onShowMessage).toHaveBeenCalledWith('未选择可添加水印的图片', 'error')
    })

    it('成功流程：触发 apply、watermarking 切换、进度清空、关闭对话框', async () => {
      useMediaStore.setState({
        mediaFiles: [
          makeFile({ id: '1', file_path: '/a.jpg', file_type: 'image' }),
          makeFile({ id: '2', file_path: '/b.mp4', file_type: 'video' })
        ]
      })
      useUIStore.setState({ selectedMediaIds: ['1', '2'] })
      api.dialog.selectDirectory.mockResolvedValue('/target')
      api.watermark.apply.mockResolvedValue({ success: true, message: '水印完成' })
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      act(() => {
        result.current.setWatermarkConfig(wmConfig)
        result.current.setWatermarkDialog(true)
      })
      await act(async () => {
        await result.current.handleBatchWatermark()
      })
      expect(api.watermark.apply).toHaveBeenCalledWith(wmConfig, ['/a.jpg'], '/target')
      expect(onShowMessage).toHaveBeenCalledWith('水印完成', 'success')
      expect(result.current.watermarking).toBe(false)
      expect(result.current.watermarkProgress).toBeNull()
      expect(result.current.watermarkDialog).toBe(false)
    })

    it('apply reject 时清理状态并显示错误', async () => {
      useMediaStore.setState({
        mediaFiles: [makeFile({ id: '1', file_path: '/a.jpg', file_type: 'image' })]
      })
      useUIStore.setState({ selectedMediaIds: ['1'] })
      api.dialog.selectDirectory.mockResolvedValue('/target')
      api.watermark.apply.mockRejectedValue(new Error('apply fail'))
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      act(() => {
        result.current.setWatermarkConfig(wmConfig)
      })
      await act(async () => {
        await result.current.handleBatchWatermark()
      })
      expect(result.current.watermarking).toBe(false)
      expect(result.current.watermarkProgress).toBeNull()
      expect(onShowMessage).toHaveBeenCalledWith('apply fail', 'error')
    })

    it('watermark.onProgress 进度回调更新 watermarkProgress', async () => {
      let progressCb: ((p: { current: number; total: number }) => void) | undefined
      api.watermark.onProgress.mockImplementation(
        (cb: (p: { current: number; total: number }) => void) => {
          progressCb = cb
          return () => {}
        }
      )
      useMediaStore.setState({
        mediaFiles: [makeFile({ id: '1', file_path: '/a.jpg', file_type: 'image' })]
      })
      useUIStore.setState({ selectedMediaIds: ['1'] })
      api.dialog.selectDirectory.mockResolvedValue('/target')
      let resolveApply: (v: unknown) => void
      api.watermark.apply.mockReturnValue(
        new Promise((r) => {
          resolveApply = r
        })
      )
      const { result } = renderHook(() => useBatchOperations({ onShowMessage: vi.fn() }))
      act(() => {
        result.current.setWatermarkConfig(wmConfig)
      })
      await act(async () => {
        result.current.handleBatchWatermark()
        await new Promise((r) => setTimeout(r, 0))
      })
      // 触发进度回调
      act(() => {
        progressCb!({ current: 1, total: 5 })
      })
      expect(result.current.watermarkProgress).toEqual({ current: 1, total: 5 })
      await act(async () => {
        resolveApply!({ success: true, message: 'ok' })
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(result.current.watermarkProgress).toBeNull()
    })

    it('watermarking=false 时忽略残留进度回调', async () => {
      let progressCb: ((p: { current: number; total: number }) => void) | undefined
      api.watermark.onProgress.mockImplementation(
        (cb: (p: { current: number; total: number }) => void) => {
          progressCb = cb
          return () => {}
        }
      )
      useMediaStore.setState({
        mediaFiles: [makeFile({ id: '1', file_path: '/a.jpg', file_type: 'image' })]
      })
      useUIStore.setState({ selectedMediaIds: ['1'] })
      api.dialog.selectDirectory.mockResolvedValue('/target')
      api.watermark.apply.mockResolvedValue({ success: true, message: 'ok' })
      const { result } = renderHook(() => useBatchOperations({ onShowMessage: vi.fn() }))
      act(() => {
        result.current.setWatermarkConfig(wmConfig)
      })
      await act(async () => {
        await result.current.handleBatchWatermark()
      })
      // apply 已完成，watermarking=false，残留进度回调应被忽略
      expect(result.current.watermarkProgress).toBeNull()
      act(() => {
        progressCb!({ current: 99, total: 99 })
      })
      expect(result.current.watermarkProgress).toBeNull()
    })
  })

  describe('handleBatchRename', () => {
    it('无 electronAPI.file.batchRename 时提示不支持', async () => {
      ;(window as unknown as { electronAPI: unknown }).electronAPI = {
        file: {}
      }
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      await act(async () => {
        await result.current.handleBatchRename([])
      })
      expect(onShowMessage).toHaveBeenCalledWith('当前环境不支持批量重命名', 'error')
    })

    it('成功后更新 store 文件名与路径，关闭对话框并清空选择', async () => {
      useMediaStore.setState({
        mediaFiles: [
          makeFile({ id: '1', file_path: '/old/a.jpg', file_name: 'a.jpg' }),
          makeFile({ id: '2', file_path: '/old/b.jpg', file_name: 'b.jpg' })
        ]
      })
      useUIStore.setState({ selectedMediaIds: ['1'] })
      api.file.batchRename.mockResolvedValue({
        success: true,
        message: '重命名成功',
        renamed: [{ oldPath: '/old/a.jpg', newPath: '/old/a_new.jpg', newFileName: 'a_new.jpg' }]
      })
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      act(() => {
        result.current.setBatchRenameDialog(true)
      })
      await act(async () => {
        await result.current.handleBatchRename([{ oldPath: '/old/a.jpg', newName: 'a_new.jpg' }])
      })
      const files = useMediaStore.getState().mediaFiles
      expect(files[0].file_path).toBe('/old/a_new.jpg')
      expect(files[0].file_name).toBe('a_new.jpg')
      expect(files[1].file_name).toBe('b.jpg') // 未被重命名
      expect(result.current.batchRenameDialog).toBe(false)
      expect(useUIStore.getState().selectedMediaIds).toEqual([])
      expect(onShowMessage).toHaveBeenCalledWith('重命名成功', 'success')
    })

    it('失败时不关闭对话框且不清空选择', async () => {
      useUIStore.setState({ selectedMediaIds: ['1'] })
      api.file.batchRename.mockResolvedValue({
        success: false,
        message: '文件名冲突',
        renamed: []
      })
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      act(() => {
        result.current.setBatchRenameDialog(true)
      })
      await act(async () => {
        await result.current.handleBatchRename([{ oldPath: '/old/a.jpg', newName: 'a_new.jpg' }])
      })
      expect(result.current.batchRenameDialog).toBe(true)
      expect(useUIStore.getState().selectedMediaIds).toEqual(['1'])
      expect(onShowMessage).toHaveBeenCalledWith('文件名冲突', 'error')
    })

    it('batchRename reject 时显示兜底错误', async () => {
      api.file.batchRename.mockRejectedValue(new Error('fs error'))
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      await act(async () => {
        await result.current.handleBatchRename([])
      })
      expect(onShowMessage).toHaveBeenCalledWith('fs error', 'error')
    })
  })

  describe('handleTransferToProfile', () => {
    it('无 electronAPI.profile.transferFiles 时提示不支持', async () => {
      ;(window as unknown as { electronAPI: unknown }).electronAPI = {
        profile: {}
      }
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      await act(async () => {
        await result.current.handleTransferToProfile('uid-1')
      })
      expect(onShowMessage).toHaveBeenCalledWith('当前环境不支持跨档案转移', 'error')
    })

    it('selectedMediaIds 为空时提示未选择', async () => {
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      await act(async () => {
        await result.current.handleTransferToProfile('uid-1')
      })
      expect(onShowMessage).toHaveBeenCalledWith('未选择要转移的文件', 'error')
    })

    it('成功后更新 account_uid 并 clearSelection', async () => {
      useMediaStore.setState({
        mediaFiles: [
          makeFile({ id: '1', account_uid: 'old-uid' }),
          makeFile({ id: '2', account_uid: 'old-uid' })
        ]
      })
      useUIStore.setState({ selectedMediaIds: ['1'] })
      api.profile.transferFiles.mockResolvedValue({
        success: true,
        message: '转移成功'
      })
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      await act(async () => {
        await result.current.handleTransferToProfile('new-uid')
      })
      expect(api.profile.transferFiles).toHaveBeenCalledWith([1], 'new-uid')
      const files = useMediaStore.getState().mediaFiles
      expect(files[0].account_uid).toBe('new-uid')
      expect(files[1].account_uid).toBe('old-uid') // 未转移
      expect(useUIStore.getState().selectedMediaIds).toEqual([])
      expect(onShowMessage).toHaveBeenCalledWith('转移成功', 'success')
    })

    it('失败时显示错误消息且不清空选择', async () => {
      useUIStore.setState({ selectedMediaIds: ['1'] })
      api.profile.transferFiles.mockResolvedValue({
        success: false,
        message: '档案不存在'
      })
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      await act(async () => {
        await result.current.handleTransferToProfile('bad-uid')
      })
      expect(onShowMessage).toHaveBeenCalledWith('档案不存在', 'error')
      expect(useUIStore.getState().selectedMediaIds).toEqual(['1'])
    })

    it('transferFiles reject 时显示兜底错误', async () => {
      useUIStore.setState({ selectedMediaIds: ['1'] })
      api.profile.transferFiles.mockRejectedValue(new Error('net error'))
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      await act(async () => {
        await result.current.handleTransferToProfile('uid')
      })
      expect(onShowMessage).toHaveBeenCalledWith('net error', 'error')
    })

    it('message 缺失时使用兜底文案', async () => {
      useUIStore.setState({ selectedMediaIds: ['1'] })
      api.profile.transferFiles.mockResolvedValue({ success: true })
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useBatchOperations({ onShowMessage }))
      await act(async () => {
        await result.current.handleTransferToProfile('uid')
      })
      expect(onShowMessage).toHaveBeenCalledWith('转移成功', 'success')
    })
  })

  describe('selectedFiles 计算', () => {
    it('仅返回 selectedMediaIds 中的文件', () => {
      useMediaStore.setState({
        mediaFiles: [makeFile({ id: '1' }), makeFile({ id: '2' }), makeFile({ id: '3' })]
      })
      useUIStore.setState({ selectedMediaIds: ['1', '3'] })
      const { result } = renderHook(() => useBatchOperations({ onShowMessage: vi.fn() }))
      expect(result.current.selectedFiles.map((f) => f.id)).toEqual(['1', '3'])
    })
  })

  describe('卸载清理', () => {
    it('卸载后调用 onProgress 返回的 unsubscribe', async () => {
      const unsubscribe = vi.fn()
      api.watermark.onProgress.mockReturnValue(unsubscribe)
      const { unmount } = renderHook(() => useBatchOperations({ onShowMessage: vi.fn() }))
      unmount()
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    })
  })
})
