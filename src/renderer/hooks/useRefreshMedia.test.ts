/**
 * @layer L3
 * @module src/renderer/hooks/useRefreshMedia
 * @coverage 媒体刷新：fetchMediaFromDatabase 成功/null/异常 + withLoading 切换 + onError 回调
 * @dependencies react, stores/mediaStore
 * @remarks jsdom 环境，spyOn fetchMediaFromDatabase 隔离数据库读取
 */
import { describe, it, expect, beforeEach, vi, afterEach, type MockInstance } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

import * as mediaStoreModule from '../stores/mediaStore'
import { useMediaStore } from '../stores/mediaStore'
import { useRefreshMedia } from './useRefreshMedia'

describe('useRefreshMedia', () => {
  let loadMediaSpy: MockInstance

  beforeEach(() => {
    useMediaStore.setState({
      mediaFiles: [],
      categories: [],
      loading: false
    })
    loadMediaSpy = vi
      .spyOn(mediaStoreModule, 'fetchMediaFromDatabase')
      .mockResolvedValue({ files: [], categories: [] })
  })

  afterEach(() => {
    loadMediaSpy.mockRestore()
    vi.restoreAllMocks()
  })

  describe('默认行为（withLoading=false）', () => {
    it('返回 refresh 函数', () => {
      const { result } = renderHook(() => useRefreshMedia())
      expect(typeof result.current).toBe('function')
    })

    it('调用后触发 fetchMediaFromDatabase', async () => {
      loadMediaSpy.mockResolvedValue({
        files: [{ id: '1' }] as never,
        categories: [{ id: 10 }] as never
      })
      const { result } = renderHook(() => useRefreshMedia())
      await act(async () => {
        await result.current()
      })
      expect(loadMediaSpy).toHaveBeenCalledTimes(1)
      expect(useMediaStore.getState().mediaFiles).toHaveLength(1)
      expect(useMediaStore.getState().categories).toHaveLength(1)
    })

    it('默认不修改 loading 状态', async () => {
      const { result } = renderHook(() => useRefreshMedia())
      await act(async () => {
        await result.current()
      })
      expect(useMediaStore.getState().loading).toBe(false)
    })
  })

  describe('withLoading=true', () => {
    it('调用前设置 loading=true，完成后复位为 false', async () => {
      let resolveLoad: (v: unknown) => void
      loadMediaSpy.mockReturnValue(
        new Promise((r) => {
          resolveLoad = r
        })
      )
      const { result } = renderHook(() => useRefreshMedia({ withLoading: true }))
      let p: Promise<void> | undefined
      act(() => {
        p = result.current()
      })
      await waitFor(() => {
        expect(useMediaStore.getState().loading).toBe(true)
      })
      await act(async () => {
        resolveLoad!({ files: [], categories: [] })
        await p
      })
      expect(useMediaStore.getState().loading).toBe(false)
    })

    it('fetchMediaFromDatabase 抛错时 loading 仍复位', async () => {
      loadMediaSpy.mockRejectedValue(new Error('db fail'))
      const { result } = renderHook(() => useRefreshMedia({ withLoading: true }))
      let caught: unknown
      await act(async () => {
        try {
          await result.current()
        } catch (e) {
          caught = e
        }
      })
      expect(caught).toBeInstanceOf(Error)
      // finally 仍执行 loading 复位
      expect(useMediaStore.getState().loading).toBe(false)
    })
  })

  describe('fetchMediaFromDatabase 返回 null', () => {
    it('触发 onError 回调', async () => {
      loadMediaSpy.mockResolvedValue(null)
      const onError = vi.fn()
      const { result } = renderHook(() => useRefreshMedia({ onError }))
      await act(async () => {
        await result.current()
      })
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('媒体数据加载失败'))
    })

    it('未传 onError 时不抛错', async () => {
      loadMediaSpy.mockResolvedValue(null)
      const { result } = renderHook(() => useRefreshMedia())
      await act(async () => {
        await result.current()
      })
      // 不抛错即视为通过
      expect(loadMediaSpy).toHaveBeenCalled()
    })
  })

  describe('异常路径', () => {
    it('fetchMediaFromDatabase reject 时向上抛出且 finally 复位 loading', async () => {
      loadMediaSpy.mockRejectedValue(new Error('boom'))
      const { result } = renderHook(() => useRefreshMedia({ withLoading: true }))
      let caught: unknown
      await act(async () => {
        try {
          await result.current()
        } catch (e) {
          caught = e
        }
      })
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toBe('boom')
      // finally 仍执行 loading 复位
      expect(useMediaStore.getState().loading).toBe(false)
    })

    it('reject 时 onError 不触发（onError 仅在 result===null 时触发）', async () => {
      loadMediaSpy.mockRejectedValue(new Error('boom'))
      const onError = vi.fn()
      const { result } = renderHook(() => useRefreshMedia({ onError }))
      await act(async () => {
        try {
          await result.current()
        } catch {
          /* swallow */
        }
      })
      expect(onError).not.toHaveBeenCalled()
    })
  })

  describe('引用稳定性', () => {
    it('options 不变时 refresh 引用稳定', () => {
      const { result, rerender } = renderHook(() => useRefreshMedia())
      const first = result.current
      rerender()
      expect(result.current).toBe(first)
    })
  })
})
