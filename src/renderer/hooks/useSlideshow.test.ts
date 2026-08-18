/**
 * @layer L3
 * @module src/renderer/hooks/useSlideshow
 * @coverage 幻灯片播放 isPlaying/timer/start/stop/toggle + interval 重启 + 卸载清理
 * @dependencies react
 * @remarks jsdom 环境 + fake timers
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSlideshow } from './useSlideshow'

describe('useSlideshow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('初始状态', () => {
    it('isPlaying 默认 false', () => {
      const { result } = renderHook(() => useSlideshow({ interval: 1000, onTick: vi.fn() }))
      expect(result.current.isPlaying).toBe(false)
    })
  })

  describe('start', () => {
    it('start 后 isPlaying=true', () => {
      const { result } = renderHook(() => useSlideshow({ interval: 1000, onTick: vi.fn() }))
      act(() => {
        result.current.start()
      })
      expect(result.current.isPlaying).toBe(true)
    })

    it('start 后 interval 触发 onTick', () => {
      const onTick = vi.fn()
      const { result } = renderHook(() => useSlideshow({ interval: 1000, onTick }))
      act(() => {
        result.current.start()
      })
      expect(onTick).not.toHaveBeenCalled()
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(onTick).toHaveBeenCalledTimes(1)
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(onTick).toHaveBeenCalledTimes(2)
    })

    it('重复 start 不叠加 timer', () => {
      const onTick = vi.fn()
      const { result } = renderHook(() => useSlideshow({ interval: 1000, onTick }))
      act(() => {
        result.current.start()
        result.current.start()
      })
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(onTick).toHaveBeenCalledTimes(1)
    })

    it('onTick 引用变化不影响 interval 触发', () => {
      const onTick1 = vi.fn()
      const onTick2 = vi.fn()
      const { result, rerender } = renderHook(
        ({ onTick }) => useSlideshow({ interval: 1000, onTick }),
        { initialProps: { onTick: onTick1 } }
      )
      act(() => {
        result.current.start()
      })
      rerender({ onTick: onTick2 })
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(onTick1).not.toHaveBeenCalled()
      expect(onTick2).toHaveBeenCalledTimes(1)
    })
  })

  describe('stop', () => {
    it('stop 后 isPlaying=false', () => {
      const { result } = renderHook(() => useSlideshow({ interval: 1000, onTick: vi.fn() }))
      act(() => {
        result.current.start()
        result.current.stop()
      })
      expect(result.current.isPlaying).toBe(false)
    })

    it('stop 后 interval 不再触发 onTick', () => {
      const onTick = vi.fn()
      const { result } = renderHook(() => useSlideshow({ interval: 1000, onTick }))
      act(() => {
        result.current.start()
        result.current.stop()
      })
      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(onTick).not.toHaveBeenCalled()
    })

    it('未 start 时 stop 不抛错', () => {
      const { result } = renderHook(() => useSlideshow({ interval: 1000, onTick: vi.fn() }))
      expect(() => {
        act(() => {
          result.current.stop()
        })
      }).not.toThrow()
    })
  })

  describe('toggle', () => {
    it('未播放时 toggle 开始播放', () => {
      const { result } = renderHook(() => useSlideshow({ interval: 1000, onTick: vi.fn() }))
      act(() => {
        result.current.toggle()
      })
      expect(result.current.isPlaying).toBe(true)
    })

    it('播放中 toggle 停止播放', () => {
      const { result } = renderHook(() => useSlideshow({ interval: 1000, onTick: vi.fn() }))
      act(() => {
        result.current.start()
      })
      // 拆分 act：start 后 isPlaying 已更新，toggle 闭包基于新值
      act(() => {
        result.current.toggle()
      })
      expect(result.current.isPlaying).toBe(false)
    })
  })

  describe('interval 变化时重启', () => {
    it('播放中 interval 变化时重启 timer', () => {
      const onTick = vi.fn()
      const { result, rerender } = renderHook(
        ({ interval }) => useSlideshow({ interval, onTick }),
        { initialProps: { interval: 1000 } }
      )
      act(() => {
        result.current.start()
      })
      act(() => {
        vi.advanceTimersByTime(500)
      })
      rerender({ interval: 2000 })
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      // 旧 timer 1000ms 时应已触发，但重启后从 0 计时
      expect(onTick).not.toHaveBeenCalled()
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(onTick).toHaveBeenCalledTimes(1)
    })
  })

  describe('卸载清理', () => {
    it('unmount 时清理 timer', () => {
      const onTick = vi.fn()
      const { result, unmount } = renderHook(() => useSlideshow({ interval: 1000, onTick }))
      act(() => {
        result.current.start()
      })
      unmount()
      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(onTick).not.toHaveBeenCalled()
    })
  })
})
