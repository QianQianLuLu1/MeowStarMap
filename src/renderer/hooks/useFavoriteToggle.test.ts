/**
 * @layer L3
 * @module src/renderer/hooks/useFavoriteToggle
 * @coverage 乐观更新 + IPC 成功/失败/reject 回滚 + pushHistory + 预览环境降级
 * @dependencies react, stores/mediaStore, stores/operationHistoryStore, window.electronAPI.mediaAction.updateFavorite
 * @remarks jsdom 环境，mock window.electronAPI，store 走真实路径
 */
import { describe, it, expect, beforeEach, vi, afterEach, type MockInstance } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import { useMediaStore, type MediaFile } from '../stores/mediaStore'
import { useOperationHistoryStore } from '../stores/operationHistoryStore'
import { useFavoriteToggle } from './useFavoriteToggle'

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

describe('useFavoriteToggle', () => {
  let updateFavorite: MockInstance
  let updateMediaFileSpy: MockInstance
  let pushHistorySpy: MockInstance

  beforeEach(() => {
    useMediaStore.setState({ mediaFiles: [] })
    useOperationHistoryStore.setState({ stack: [], undoing: false })
    updateFavorite = vi.fn()
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      mediaAction: { updateFavorite }
    }
    updateMediaFileSpy = vi.spyOn(useMediaStore.getState(), 'updateMediaFile')
    pushHistorySpy = vi.spyOn(useOperationHistoryStore.getState(), 'push')
  })

  afterEach(() => {
    updateMediaFileSpy.mockRestore()
    pushHistorySpy.mockRestore()
    vi.restoreAllMocks()
  })

  describe('预览环境（无 electronAPI）', () => {
    it('直接切换本地状态且不调用 IPC', async () => {
      ;(window as unknown as { electronAPI: unknown }).electronAPI = undefined
      const { result } = renderHook(() => useFavoriteToggle())
      const file = makeFile({ is_favorite: false })
      await act(async () => {
        await result.current(file)
      })
      expect(updateMediaFileSpy).toHaveBeenCalledWith('1', { is_favorite: true })
      expect(updateFavorite).not.toHaveBeenCalled()
      expect(pushHistorySpy).not.toHaveBeenCalled()
    })
  })

  describe('真实环境 - 成功路径', () => {
    it('乐观更新后调用 IPC 并 pushHistory', async () => {
      updateFavorite.mockResolvedValue({ success: true })
      const { result } = renderHook(() => useFavoriteToggle())
      const file = makeFile({ is_favorite: false })
      await act(async () => {
        await result.current(file)
      })
      expect(updateMediaFileSpy).toHaveBeenCalledWith('1', { is_favorite: true })
      expect(updateFavorite).toHaveBeenCalledWith(1, true)
      expect(pushHistorySpy).toHaveBeenCalledTimes(1)
      const record = pushHistorySpy.mock.calls[0][0] as {
        type: string
        payload: { mediaId: number; originalFavorite: boolean; newFavorite: boolean }
        description: string
      }
      expect(record.type).toBe('favorite_toggle')
      expect(record.payload).toEqual({
        mediaId: 1,
        originalFavorite: false,
        newFavorite: true
      })
    })

    it('当前为收藏状态时切换为 false', async () => {
      updateFavorite.mockResolvedValue({ success: true })
      const { result } = renderHook(() => useFavoriteToggle())
      const file = makeFile({ is_favorite: true })
      await act(async () => {
        await result.current(file)
      })
      expect(updateMediaFileSpy).toHaveBeenCalledWith('1', { is_favorite: false })
      expect(updateFavorite).toHaveBeenCalledWith(1, false)
    })

    it('description 文案随收藏状态变化', async () => {
      updateFavorite.mockResolvedValue({ success: true })
      const { result } = renderHook(() => useFavoriteToggle())
      const file = makeFile({ is_favorite: false, file_name: 'photo.jpg' })
      await act(async () => {
        await result.current(file)
      })
      expect(pushHistorySpy.mock.calls[0][0].description as string).toContain('收藏')
      expect(pushHistorySpy.mock.calls[0][0].description as string).toContain('photo.jpg')
    })

    // 回归：preload call() 真实解包响应为 { updated: true }（无 success 字段）。
    // 修复前 useFavoriteToggle 误判 result.success 恒 undefined → 抛 "undefined" 并弹红 Toast。
    // 修复后应视为成功：不弹错误 Toast 且 pushHistory 正常。
    it('preload 真实响应 { updated: true } 时不弹错误 Toast（回归）', async () => {
      updateFavorite.mockResolvedValue({ updated: true })
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useFavoriteToggle(onShowMessage))
      const file = makeFile({ is_favorite: false })
      await act(async () => {
        await result.current(file)
      })
      expect(updateFavorite).toHaveBeenCalledWith(1, true)
      expect(onShowMessage).not.toHaveBeenCalled()
      expect(pushHistorySpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('真实环境 - 失败路径', () => {
    it('updateFavorite reject(IpcError) 时回滚并触发 onShowMessage', async () => {
      updateFavorite.mockRejectedValue(new Error('数据库写入失败'))
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useFavoriteToggle(onShowMessage))
      const file = makeFile({ is_favorite: false })
      await act(async () => {
        await result.current(file)
      })
      // 乐观更新（false → true）+ 失败回滚（true → false）
      expect(updateMediaFileSpy).toHaveBeenNthCalledWith(1, '1', { is_favorite: true })
      expect(updateMediaFileSpy).toHaveBeenNthCalledWith(2, '1', { is_favorite: false })
      expect(onShowMessage).toHaveBeenCalledWith('数据库写入失败', 'error')
      expect(pushHistorySpy).not.toHaveBeenCalled()
    })

    it('updateFavorite reject 时回滚并触发 onShowMessage', async () => {
      updateFavorite.mockRejectedValue(new Error('network down'))
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useFavoriteToggle(onShowMessage))
      const file = makeFile({ is_favorite: true })
      await act(async () => {
        await result.current(file)
      })
      // 乐观更新（true → false）+ 失败回滚（false → true）
      expect(updateMediaFileSpy).toHaveBeenNthCalledWith(1, '1', { is_favorite: false })
      expect(updateMediaFileSpy).toHaveBeenNthCalledWith(2, '1', { is_favorite: true })
      expect(onShowMessage).toHaveBeenCalledWith('network down', 'error')
    })

    it('reject 非 Error 时 onShowMessage 收到兜底文案', async () => {
      updateFavorite.mockRejectedValue('string err')
      const onShowMessage = vi.fn()
      const { result } = renderHook(() => useFavoriteToggle(onShowMessage))
      const file = makeFile({ is_favorite: false })
      await act(async () => {
        await result.current(file)
      })
      expect(onShowMessage).toHaveBeenCalledWith('收藏操作失败', 'error')
    })

    it('未传 onShowMessage 时不抛错', async () => {
      updateFavorite.mockRejectedValue(new Error('boom'))
      const { result } = renderHook(() => useFavoriteToggle())
      const file = makeFile({ is_favorite: false })
      await act(async () => {
        await result.current(file)
      })
      // 仅断言回滚发生
      expect(updateMediaFileSpy).toHaveBeenNthCalledWith(2, '1', { is_favorite: false })
    })
  })

  describe('引用稳定性', () => {
    it('onShowMessage 不变时回调引用稳定', () => {
      const onShowMessage = vi.fn()
      const { result, rerender } = renderHook(() => useFavoriteToggle(onShowMessage))
      const first = result.current
      rerender()
      expect(result.current).toBe(first)
    })
  })
})
