// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSyncOverview, OVERVIEW_POLL_MS } from './useSyncOverview'

/** R5 审查修复回归：瞬时 IPC 抖动不得把上次成功观测置 null（首跑二维码会作废重建）。 */
describe('useSyncOverview 轮询纪律与失败保留', () => {
  const overview = { available: true as const, assets: 3, pairedDevices: 1, firstRun: false }

  function stubApi(getLibraryOverview: ReturnType<typeof vi.fn>): void {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      nikkisync: { getLibraryOverview }
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  it('首轮成功、次轮失败 ⇒ 保留首轮值（不清空）', async () => {
    const getLibraryOverview = vi
      .fn()
      .mockResolvedValueOnce(overview)
      .mockRejectedValue(new Error('ipc jitter'))
    stubApi(getLibraryOverview)
    const { result } = renderHook(() => useSyncOverview(true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current).toEqual(overview)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OVERVIEW_POLL_MS)
    })
    expect(getLibraryOverview).toHaveBeenCalledTimes(2)
    expect(result.current).toEqual(overview)
  })

  it('从未成功时失败维持 null；active=false 零调用', async () => {
    const getLibraryOverview = vi.fn().mockRejectedValue(new Error('down'))
    stubApi(getLibraryOverview)
    const { result, rerender } = renderHook(({ active }) => useSyncOverview(active), {
      initialProps: { active: false }
    })
    expect(getLibraryOverview).not.toHaveBeenCalled()
    expect(result.current).toBeNull()
    rerender({ active: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current).toBeNull()
  })

  it('卸载后计时器清零（keep-alive 纪律不回归）', async () => {
    const getLibraryOverview = vi.fn().mockResolvedValue(overview)
    stubApi(getLibraryOverview)
    const { unmount } = renderHook(() => useSyncOverview(true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('桥面方法缺席（老 preload）⇒ 零调用恒 null', async () => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { nikkisync: {} }
    const { result } = renderHook(() => useSyncOverview(true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OVERVIEW_POLL_MS * 2)
    })
    expect(result.current).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})
