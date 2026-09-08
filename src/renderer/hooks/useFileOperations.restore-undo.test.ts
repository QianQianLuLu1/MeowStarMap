/**
 * @layer L3
 * @module src/renderer/hooks/useFileOperations
 * @coverage media_soft_delete undo handler：回收站恢复契约（preload call() 不回传 success 字段），
 *   撤销删除后必须调用 onRefreshMedia 同步图库
 * @dependencies react, stores/operationHistoryStore, window.electronAPI
 * @remarks jsdom 环境，mock window.electronAPI。restore 经 preload call() 解包后实际返回
 *   { message }（无 success 字段，见 #fix-empty-recycle-bin-contract / #fix-restore-sync），
 *   成功 = 未抛 IpcError。缺陷写法读取恒为 undefined 的 undoResult.success，
 *   导致撤销恢复永远误报失败且跳过 onRefreshMedia（图库不同步）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

import { useFileOperations } from './useFileOperations'
import { useOperationHistoryStore, type UndoHandler } from '../stores/operationHistoryStore'

describe('useFileOperations media_soft_delete undo（#fix-restore-sync）', () => {
  let api: { mediaAction: { restore: ReturnType<typeof vi.fn> } }
  let captured: UndoHandler | undefined
  let originalRegister: ReturnType<typeof useOperationHistoryStore.getState>['registerUndoHandler']
  let onRefreshMedia: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onRefreshMedia = vi.fn().mockResolvedValue(undefined)
    // 覆盖前先捕获原始 registerUndoHandler，供 afterEach 恢复
    originalRegister = useOperationHistoryStore.getState().registerUndoHandler
    // 捕获 useFileOperations 注册的 media_soft_delete undo handler，直接驱动其真实逻辑
    useOperationHistoryStore.setState({
      stack: [],
      undoing: false,
      registerUndoHandler: (type, handler) => {
        if (type === 'media_soft_delete') captured = handler
        return () => {}
      }
    })
    api = { mediaAction: { restore: vi.fn() } }
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      mediaAction: api.mediaAction
    }
    renderHook(() =>
      useFileOperations({
        filteredFiles: [],
        onShowMessage: vi.fn(),
        onRefreshMedia: onRefreshMedia as unknown as () => Promise<void>
      })
    )
  })

  afterEach(() => {
    useOperationHistoryStore.setState({ registerUndoHandler: originalRegister })
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  it('恢复成功（真实契约形态 { message }，无 success 字段）应返回 success:true 并调用 onRefreshMedia 同步图库', async () => {
    expect(captured).toBeTypeOf('function')
    // 模拟 preload call() 的真实返回：解包后只有 data，无 success 字段
    api.mediaAction.restore.mockResolvedValue({ message: '已恢复 1 项照片' })

    const result = await captured!({ mediaId: 42 }, '42')

    expect(api.mediaAction.restore).toHaveBeenCalledWith([42])
    expect(result.success).toBe(true)
    // 恢复成功后必须刷新图库，否则 mediaStore.mediaFiles 不含恢复的记录
    expect(onRefreshMedia).toHaveBeenCalledTimes(1)
  })

  it('恢复失败（restore 抛 IpcError）应返回 success:false 且不调用 onRefreshMedia', async () => {
    expect(captured).toBeTypeOf('function')
    api.mediaAction.restore.mockRejectedValue(new Error('数据库未初始化'))

    const result = await captured!({ mediaId: 42 }, '42')

    expect(result.success).toBe(false)
    expect(result.message).toBe('数据库未初始化')
    expect(onRefreshMedia).not.toHaveBeenCalled()
  })
})
