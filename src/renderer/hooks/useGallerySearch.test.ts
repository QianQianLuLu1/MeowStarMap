/**
 * @layer L3
 * @module src/renderer/hooks/useGallerySearch
 * @coverage 防抖搜索 + inputValue/searchQuery 同步
 * @dependencies react, stores/uiStore
 * @remarks jsdom 环境，重置 uiStore 隔离状态
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useGallerySearch } from './useGallerySearch'
import { useUIStore } from '../stores/uiStore'

describe('useGallerySearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useUIStore.setState({ searchQuery: '' })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('初始状态', () => {
    it('inputValue 从 uiStore.searchQuery 派生', () => {
      useUIStore.setState({ searchQuery: 'initial' })
      const { result } = renderHook(() => useGallerySearch())
      expect(result.current.inputValue).toBe('initial')
      expect(result.current.searchQuery).toBe('initial')
    })

    it('uiStore.searchQuery 为空时 inputValue 也为空', () => {
      useUIStore.setState({ searchQuery: '' })
      const { result } = renderHook(() => useGallerySearch())
      expect(result.current.inputValue).toBe('')
    })
  })

  describe('setInputValue 防抖', () => {
    it('setInputValue 立即更新 inputValue', () => {
      const { result } = renderHook(() => useGallerySearch())
      act(() => {
        result.current.setInputValue('abc')
      })
      expect(result.current.inputValue).toBe('abc')
    })

    it('防抖时间内不更新 uiStore.searchQuery', () => {
      const { result } = renderHook(() => useGallerySearch(250))
      act(() => {
        result.current.setInputValue('abc')
      })
      // 推进 249ms（未到 250ms）
      act(() => {
        vi.advanceTimersByTime(249)
      })
      expect(useUIStore.getState().searchQuery).toBe('')
    })

    it('防抖结束后同步到 uiStore.searchQuery', () => {
      const { result } = renderHook(() => useGallerySearch(250))
      act(() => {
        result.current.setInputValue('abc')
      })
      act(() => {
        vi.advanceTimersByTime(250)
      })
      expect(useUIStore.getState().searchQuery).toBe('abc')
      expect(result.current.searchQuery).toBe('abc')
    })

    it('连续输入重置防抖计时器', () => {
      const { result } = renderHook(() => useGallerySearch(250))
      act(() => {
        result.current.setInputValue('a')
      })
      act(() => {
        vi.advanceTimersByTime(200)
      })
      act(() => {
        result.current.setInputValue('ab')
      })
      // 距第一次输入 300ms，但因第二次输入已重置计时器，searchQuery 仍为 ''
      act(() => {
        vi.advanceTimersByTime(100)
      })
      expect(useUIStore.getState().searchQuery).toBe('')
      act(() => {
        vi.advanceTimersByTime(150)
      })
      expect(useUIStore.getState().searchQuery).toBe('ab')
    })
  })

  describe('自定义 debounceMs', () => {
    it('500ms 防抖生效', () => {
      const { result } = renderHook(() => useGallerySearch(500))
      act(() => {
        result.current.setInputValue('hello')
      })
      act(() => {
        vi.advanceTimersByTime(499)
      })
      expect(useUIStore.getState().searchQuery).toBe('')
      act(() => {
        vi.advanceTimersByTime(2)
      })
      expect(useUIStore.getState().searchQuery).toBe('hello')
    })
  })

  describe('卸载清理', () => {
    it('unmount 后定时器被清理不更新 store', () => {
      const { result, unmount } = renderHook(() => useGallerySearch(250))
      act(() => {
        result.current.setInputValue('temp')
      })
      unmount()
      act(() => {
        vi.advanceTimersByTime(500)
      })
      // store 应保持初始值
      expect(useUIStore.getState().searchQuery).toBe('')
    })
  })

  describe('多次输入最终值', () => {
    it('以最后一次输入为准', () => {
      const { result } = renderHook(() => useGallerySearch(100))
      act(() => {
        result.current.setInputValue('first')
      })
      act(() => {
        vi.advanceTimersByTime(50)
      })
      act(() => {
        result.current.setInputValue('second')
      })
      act(() => {
        vi.advanceTimersByTime(50)
      })
      act(() => {
        result.current.setInputValue('third')
      })
      act(() => {
        vi.advanceTimersByTime(100)
      })
      expect(useUIStore.getState().searchQuery).toBe('third')
    })

    it('清空 inputValue 同样防抖生效', () => {
      useUIStore.setState({ searchQuery: 'old' })
      const { result } = renderHook(() => useGallerySearch(100))
      act(() => {
        result.current.setInputValue('')
      })
      act(() => {
        vi.advanceTimersByTime(99)
      })
      expect(useUIStore.getState().searchQuery).toBe('old')
      act(() => {
        vi.advanceTimersByTime(2)
      })
      expect(useUIStore.getState().searchQuery).toBe('')
    })
  })
})
