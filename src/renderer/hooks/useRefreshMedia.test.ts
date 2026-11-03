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

    it('被后续整刷取代时不弹加载失败 toast（弃权返回 null ≠ 取数失败）', async () => {
      // 缺陷：fetchMediaFromDatabase 让「最新一轮胜出」，被顶掉的那轮弃权返回 null——UI 由那一轮
      // 交付，这是成功语义；本钩子却把它与「真的取数失败」混为一谈，重试耗尽后弹一条用户无从处置的
      // 红色 toast。判据：契约访问器判 superseded ⇒ 不重试、不弹错（DEBT-053 收口后语义由
      // getMediaRefreshAbortKind 承担；mock 自代次启发式迁移到访问器，断言集不变）。
      vi.spyOn(mediaStoreModule, 'getMediaRefreshAbortKind').mockReturnValue('superseded')
      loadMediaSpy.mockResolvedValue(null)
      const onError = vi.fn()
      const { result } = renderHook(() => useRefreshMedia({ onError }))
      await act(async () => {
        await result.current()
      })
      expect(onError).not.toHaveBeenCalled()
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

  describe('重试日志措辞按「被取代 / 真失败」分叉', () => {
    it('被取代的 null 打「已被新一轮整刷取代」，不再自称加载失败', async () => {
      // 缺陷：被更新一轮取代时（取数弃权返回 null，这本身是**成功**语义）不能自称「加载失败」，
      // 把开发者往查错了的方向引。判据：契约访问器判 superseded ⇒ 打一条「已被新一轮整刷取代、
      // 不再重试」的 warn，且不进重试循环（DEBT-053 收口；mock 自代次启发式迁移到访问器，
      // 断言集不变）。
      vi.spyOn(mediaStoreModule, 'getMediaRefreshAbortKind').mockReturnValue('superseded')
      loadMediaSpy.mockResolvedValue(null)
      const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const onError = vi.fn()
      const { result } = renderHook(() => useRefreshMedia({ onError }))
      await act(async () => {
        await result.current()
      })
      expect(warnMock).toHaveBeenCalledTimes(1)
      const line = String(warnMock.mock.calls[0]?.[0] ?? '')
      expect(line).toContain('已被新一轮整刷取代')
      expect(line).not.toContain('加载失败')
      expect(onError).not.toHaveBeenCalled()
    })

    it('真实取数失败的 null 仍逐字打「加载失败…重试」（对照，修复前亦绿）', async () => {
      // 这条刻意不 spy 代次：取数被 mock 掉时真实 depthRefreshSeq 恒不动 ⇒ superseded 恒 false，
      // 走的必须还是「加载失败」分支。修复前它就是绿的 —— 作用是把这个改动钉成「只有取代分支变了」，
      // 防止把真失败的提示改成哑巴（那才是真正的回归）。
      loadMediaSpy.mockResolvedValueOnce(null)
      const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { result } = renderHook(() => useRefreshMedia())
      await act(async () => {
        await result.current()
      })
      expect(warnMock).toHaveBeenCalledTimes(1)
      expect(String(warnMock.mock.calls[0]?.[0] ?? '')).toBe(
        '[useRefreshMedia] 加载失败，500ms 后重试 (1/3)'
      )
    })
  })

  describe('被取代路径不再重试（DEBT-053 收口）', () => {
    it('被取代时不再发出第二次取数（弃权是成功语义，重试只会白废三次深度取数）', async () => {
      // 判据：契约访问器判 superseded ⇒ 不重试，fetchMediaFromDatabase 恰发一次。
      // 修复前 hook 的 while 只看 !result，会照常重试 3 次（1+3=4 次取数）——本用例修复前红。
      vi.spyOn(mediaStoreModule, 'getMediaRefreshAbortKind').mockReturnValue('superseded')
      loadMediaSpy.mockResolvedValue(null)
      const onError = vi.fn()
      const { result } = renderHook(() => useRefreshMedia({ onError }))
      await act(async () => {
        await result.current()
      })
      expect(loadMediaSpy).toHaveBeenCalledTimes(1)
      expect(onError).not.toHaveBeenCalled()
    })

    it('真失败仍重试到耗尽并弹 toast（对照，修复前亦绿：防把真失败改哑）', async () => {
      // 刻意给契约访问器钉 'failed'：失败语义必须照旧走满 3 次重试（1+3=4 次取数）并弹 onError。
      // 修复前它就是绿的 —— 作用是把「只收窄被取代路径」钉死，防止顺手把真失败的重试也砍掉。
      vi.spyOn(mediaStoreModule, 'getMediaRefreshAbortKind').mockReturnValue('failed')
      loadMediaSpy.mockResolvedValue(null)
      const onError = vi.fn()
      const { result } = renderHook(() => useRefreshMedia({ onError }))
      await act(async () => {
        await result.current()
      })
      expect(loadMediaSpy).toHaveBeenCalledTimes(4)
      expect(onError).toHaveBeenCalledTimes(1)
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
