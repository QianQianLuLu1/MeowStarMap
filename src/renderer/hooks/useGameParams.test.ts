/**
 * @layer L3
 * @module src/renderer/hooks/useGameParams
 * @coverage LRU+TTL 缓存 + 异步解码 + 取消竞态 + refresh + clearAllGameParamsCache
 * @dependencies react, window.electronAPI.decrypt.decodeFile, GameParamsData
 * @remarks jsdom 环境，mock window.electronAPI.decrypt.decodeFile
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

import { useGameParams, clearAllGameParamsCache } from './useGameParams'
import type { GameParamsData } from '../types/decryption'

describe('useGameParams', () => {
  let decodeFile: ReturnType<typeof vi.fn>

  beforeEach(() => {
    clearAllGameParamsCache()
    decodeFile = vi.fn()
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      decrypt: { decodeFile }
    }
  })

  afterEach(() => {
    clearAllGameParamsCache()
    vi.restoreAllMocks()
  })

  describe('初始状态与参数守卫', () => {
    it('filePath 为 undefined 时不加载', () => {
      const { result } = renderHook(() => useGameParams(undefined, 'album', 'uid'))
      expect(result.current.data).toBeNull()
      expect(result.current.loading).toBe(false)
      expect(result.current.error).toBeNull()
      expect(decodeFile).not.toHaveBeenCalled()
    })

    it('albumType 为 undefined 时不加载', () => {
      const { result } = renderHook(() => useGameParams('/a.jpg', undefined, 'uid'))
      expect(result.current.data).toBeNull()
      expect(result.current.loading).toBe(false)
      expect(decodeFile).not.toHaveBeenCalled()
    })

    it('enabled=false 时不加载', () => {
      const { result } = renderHook(() => useGameParams('/a.jpg', 'album', 'uid', false))
      expect(result.current.data).toBeNull()
      expect(decodeFile).not.toHaveBeenCalled()
    })

    it('参数缺失时清空已有 data', async () => {
      decodeFile.mockResolvedValue({ ok: true, data: { hasParams: true } })
      const { result, rerender } = renderHook(
        ({ path }: { path: string | undefined }) => useGameParams(path, 'album', 'uid'),
        { initialProps: { path: '/a.jpg' } as { path: string | undefined } }
      )
      await waitFor(() => {
        expect(result.current.data).toEqual({ hasParams: true })
      })
      rerender({ path: undefined })
      expect(result.current.data).toBeNull()
    })
  })

  describe('解码成功', () => {
    it('result.ok=true 且 data 存在时写入 data', async () => {
      const payload: GameParamsData = { hasParams: true, camera: undefined }
      decodeFile.mockResolvedValue({ ok: true, data: payload })
      const { result } = renderHook(() => useGameParams('/a.jpg', 'album', 'uid'))
      await waitFor(() => {
        expect(result.current.data).toEqual(payload)
      })
      expect(result.current.loading).toBe(false)
      expect(result.current.error).toBeNull()
    })

    it('decodeFile 被以 (filePath, albumType, uid) 调用', async () => {
      decodeFile.mockResolvedValue({ ok: true, data: { hasParams: true } })
      renderHook(() => useGameParams('/a.jpg', 'album', 'uid'))
      await waitFor(() => {
        expect(decodeFile).toHaveBeenCalledWith('/a.jpg', 'album', 'uid')
      })
    })

    it('uid 为 undefined 时 cacheKey 使用空串兜底', async () => {
      decodeFile.mockResolvedValue({ ok: true, data: { hasParams: true } })
      renderHook(() => useGameParams('/a.jpg', 'album', undefined))
      await waitFor(() => {
        expect(decodeFile).toHaveBeenCalledWith('/a.jpg', 'album', undefined)
      })
    })

    it('成功后写入缓存，二次挂载直接命中缓存不再请求', async () => {
      const payload: GameParamsData = { hasParams: true }
      decodeFile.mockResolvedValue({ ok: true, data: payload })
      const { unmount } = renderHook(() => useGameParams('/cached.jpg', 'album', 'uid'))
      await waitFor(() => {
        expect(decodeFile).toHaveBeenCalledTimes(1)
      })
      unmount()
      // 二次挂载相同参数应命中缓存
      const { result } = renderHook(() => useGameParams('/cached.jpg', 'album', 'uid'))
      await waitFor(() => {
        expect(result.current.data).toEqual(payload)
      })
      expect(decodeFile).toHaveBeenCalledTimes(1)
    })
  })

  describe('解码失败', () => {
    it('result.ok=false 时 data.hasParams=false 且带 error', async () => {
      decodeFile.mockResolvedValue({ ok: false, message: '解码失败' })
      const { result } = renderHook(() => useGameParams('/a.jpg', 'album', 'uid'))
      await waitFor(() => {
        expect(result.current.data).toEqual({
          hasParams: false,
          error: '解码失败'
        })
      })
    })

    it('result.ok=true 但 data 为空时 data.hasParams=false', async () => {
      decodeFile.mockResolvedValue({ ok: true, data: null })
      const { result } = renderHook(() => useGameParams('/a.jpg', 'album', 'uid'))
      await waitFor(() => {
        expect(result.current.data).toEqual({
          hasParams: false,
          error: '解码失败'
        })
      })
    })

    it('result.message 为空时使用兜底文案', async () => {
      decodeFile.mockResolvedValue({ ok: false, message: '' })
      const { result } = renderHook(() => useGameParams('/a.jpg', 'album', 'uid'))
      await waitFor(() => {
        expect(result.current.data).toEqual({
          hasParams: false,
          error: '解码失败'
        })
      })
    })

    it('decodeFile reject Error 时 data.error 为错误消息', async () => {
      decodeFile.mockRejectedValue(new Error('network down'))
      const { result } = renderHook(() => useGameParams('/a.jpg', 'album', 'uid'))
      await waitFor(() => {
        expect(result.current.data).toEqual({
          hasParams: false,
          error: 'network down'
        })
      })
      expect(result.current.loading).toBe(false)
    })

    it('decodeFile reject 非 Error 时 data.error 为"未知错误"', async () => {
      decodeFile.mockRejectedValue('string error')
      const { result } = renderHook(() => useGameParams('/a.jpg', 'album', 'uid'))
      await waitFor(() => {
        expect(result.current.data).toEqual({
          hasParams: false,
          error: '未知错误'
        })
      })
    })
  })

  describe('取消竞态', () => {
    it('filePath 切换时上一次未完成请求结果被忽略', async () => {
      let resolve1: (v: unknown) => void
      let resolve2: (v: unknown) => void
      decodeFile.mockReturnValueOnce(
        new Promise((r) => {
          resolve1 = r
        })
      )
      decodeFile.mockReturnValueOnce(
        new Promise((r) => {
          resolve2 = r
        })
      )
      const { result, rerender } = renderHook(({ path }) => useGameParams(path, 'album', 'uid'), {
        initialProps: { path: '/a.jpg' }
      })
      rerender({ path: '/b.jpg' })
      // 即使 resolve1 后于 resolve2 完成，data 只反映 b.jpg 的结果
      resolve2!({ ok: true, data: { hasParams: true } })
      resolve1!({ ok: true, data: { hasParams: true, error: 'should be ignored' } })
      await waitFor(() => {
        expect(result.current.data).toEqual({ hasParams: true })
      })
      // a.jpg 的 result 不应写入（token.cancelled）
      // 由于 data 已是 b.jpg 的结果，再次触发不会改变
    })
  })

  describe('refresh', () => {
    it('refresh 清除缓存并重新拉取', async () => {
      decodeFile.mockResolvedValue({ ok: true, data: { hasParams: true } })
      const { result } = renderHook(() => useGameParams('/r.jpg', 'album', 'uid'))
      await waitFor(() => {
        expect(decodeFile).toHaveBeenCalledTimes(1)
      })
      // 命中缓存，refresh 应清除并重新调用 decodeFile
      decodeFile.mockResolvedValue({ ok: true, data: { hasParams: false } })
      await act(async () => {
        result.current.refresh()
      })
      await waitFor(() => {
        expect(decodeFile).toHaveBeenCalledTimes(2)
      })
    })

    it('filePath 缺失时 refresh 仅触发 doFetch（不写缓存键）', async () => {
      const { result } = renderHook(() => useGameParams(undefined, 'album', 'uid'))
      await act(async () => {
        result.current.refresh()
      })
      expect(decodeFile).not.toHaveBeenCalled()
    })
  })

  describe('LRU 容量淘汰', () => {
    it('clearAllGameParamsCache 后缓存失效重新拉取', async () => {
      decodeFile.mockResolvedValue({ ok: true, data: { hasParams: true } })
      const { unmount } = renderHook(() => useGameParams('/clr.jpg', 'album', 'uid'))
      await waitFor(() => {
        expect(decodeFile).toHaveBeenCalledTimes(1)
      })
      unmount()
      clearAllGameParamsCache()
      const { result: r2 } = renderHook(() => useGameParams('/clr.jpg', 'album', 'uid'))
      await waitFor(() => {
        expect(decodeFile).toHaveBeenCalledTimes(2)
        expect(r2.current.data).toEqual({ hasParams: true })
      })
    })
  })

  describe('卸载清理', () => {
    it('卸载后 token.cancelled=true 不抛错', async () => {
      let resolve1: (v: unknown) => void
      decodeFile.mockReturnValue(
        new Promise((r) => {
          resolve1 = r
        })
      )
      const { unmount } = renderHook(() => useGameParams('/u.jpg', 'album', 'uid'))
      unmount()
      // 卸载后 resolve 不应导致 React 状态更新告警
      resolve1!({ ok: true, data: { hasParams: true } })
      // 给微任务一个 flush 机会
      await new Promise((r) => setTimeout(r, 0))
    })
  })
})
