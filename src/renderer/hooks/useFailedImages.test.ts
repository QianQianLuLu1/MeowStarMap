/**
 * @layer L3
 * @module src/renderer/hooks/useFailedImages
 * @coverage 失败图片 id 集合 + dep 变化清空
 * @dependencies react
 * @remarks jsdom 环境
 */
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFailedImages } from './useFailedImages'

describe('useFailedImages', () => {
  describe('初始状态', () => {
    it('failedImages 初始为空 Set', () => {
      const { result } = renderHook(() => useFailedImages('dep1'))
      expect(result.current.failedImages).toBeInstanceOf(Set)
      expect(result.current.failedImages.size).toBe(0)
    })
  })

  describe('markFailed', () => {
    it('添加一个 id 到 failedImages', () => {
      const { result } = renderHook(() => useFailedImages('dep1'))
      act(() => {
        result.current.markFailed('img-1')
      })
      expect(result.current.failedImages.has('img-1')).toBe(true)
      expect(result.current.failedImages.size).toBe(1)
    })

    it('重复添加同一 id 不增加 size', () => {
      const { result } = renderHook(() => useFailedImages('dep1'))
      act(() => {
        result.current.markFailed('img-1')
        result.current.markFailed('img-1')
      })
      expect(result.current.failedImages.size).toBe(1)
    })

    it('添加多个不同 id 全部入集合', () => {
      const { result } = renderHook(() => useFailedImages('dep1'))
      act(() => {
        result.current.markFailed('a')
        result.current.markFailed('b')
        result.current.markFailed('c')
      })
      expect(result.current.failedImages.size).toBe(3)
      expect(Array.from(result.current.failedImages)).toEqual(['a', 'b', 'c'])
    })

    it('markFailed 引用稳定（同一 render 周期）', () => {
      const { result } = renderHook(() => useFailedImages('dep1'))
      const first = result.current.markFailed
      act(() => {
        result.current.markFailed('x')
      })
      expect(result.current.markFailed).toBe(first)
    })
  })

  describe('dep 变化清空', () => {
    it('dep 引用变化时清空 failedImages', () => {
      let dep: string[] = ['a']
      const { result, rerender } = renderHook(() => useFailedImages(dep))
      act(() => {
        result.current.markFailed('img-1')
        result.current.markFailed('img-2')
      })
      expect(result.current.failedImages.size).toBe(2)
      // 改变 dep 引用
      dep = ['a', 'b']
      rerender()
      expect(result.current.failedImages.size).toBe(0)
    })

    it('dep 内容变但引用不变时不清空', () => {
      const dep = { items: ['a'] }
      const { result, rerender } = renderHook(() => useFailedImages(dep))
      act(() => {
        result.current.markFailed('img-1')
      })
      // mutate 但不改变引用
      dep.items.push('b')
      rerender()
      expect(result.current.failedImages.size).toBe(1)
    })

    it('dep 切换后又切回，failedImages 重新清空', () => {
      const { result, rerender } = renderHook(({ dep }) => useFailedImages(dep), {
        initialProps: { dep: 'first' }
      })
      act(() => {
        result.current.markFailed('a')
      })
      rerender({ dep: 'second' })
      expect(result.current.failedImages.size).toBe(0)
    })

    it('dep 是 number 类型时也正常工作', () => {
      const { result, rerender } = renderHook(({ dep }) => useFailedImages(dep), {
        initialProps: { dep: 1 }
      })
      act(() => {
        result.current.markFailed('a')
        result.current.markFailed('b')
      })
      rerender({ dep: 2 })
      expect(result.current.failedImages.size).toBe(0)
    })
  })
})
