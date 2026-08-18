/**
 * @layer L3
 * @module src/renderer/hooks/useContainerSize
 * @coverage ResizeObserver + window resize 测量容器尺寸
 * @dependencies react, ResizeObserver
 * @remarks jsdom 环境，使用 setup.ts 中已注入的 MockResizeObserver
 */
import { describe, it, expect, beforeEach, vi, afterEach, type MockInstance } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React from 'react'
import { useContainerSize } from './useContainerSize'

describe('useContainerSize', () => {
  let observerCallback: ResizeObserverCallback | null
  let observeSpy: MockInstance
  let disconnectSpy: MockInstance

  beforeEach(() => {
    observerCallback = null
    observeSpy = vi.fn()
    disconnectSpy = vi.fn()
    class MockRO {
      constructor(cb: ResizeObserverCallback) {
        observerCallback = cb
      }
      observe = observeSpy
      unobserve = vi.fn()
      disconnect = disconnectSpy
    }
    ;(global as unknown as { ResizeObserver: unknown }).ResizeObserver = MockRO
    ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver = MockRO
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('初始状态', () => {
    it('初始返回 {width:0, height:0}', () => {
      const ref = React.createRef<HTMLDivElement>()
      const { result } = renderHook(() => useContainerSize(ref))
      expect(result.current).toEqual({ width: 0, height: 0 })
    })

    it('ref.current 为 null 时不抛错', () => {
      const ref = React.createRef<HTMLDivElement>()
      expect(() => renderHook(() => useContainerSize(ref))).not.toThrow()
    })
  })

  describe('挂载后测量', () => {
    it('挂载后立即测量 container 的 clientWidth/clientHeight', () => {
      const el = document.createElement('div')
      Object.defineProperty(el, 'clientWidth', { value: 500, configurable: true })
      Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true })
      const ref = React.createRef<HTMLDivElement>()
      ref.current = el
      const { result } = renderHook(() => useContainerSize(ref))
      expect(result.current).toEqual({ width: 500, height: 300 })
    })

    it('注册 ResizeObserver 监听容器', () => {
      const el = document.createElement('div')
      const ref = React.createRef<HTMLDivElement>()
      ref.current = el
      renderHook(() => useContainerSize(ref))
      expect(observeSpy).toHaveBeenCalledWith(el)
    })

    it('注册 window resize 事件', () => {
      const el = document.createElement('div')
      const ref = React.createRef<HTMLDivElement>()
      ref.current = el
      const spy = vi.spyOn(window, 'addEventListener')
      renderHook(() => useContainerSize(ref))
      expect(spy).toHaveBeenCalledWith('resize', expect.any(Function))
    })
  })

  describe('尺寸变化', () => {
    it('ResizeObserver 触发回调时更新 size', () => {
      const el = document.createElement('div')
      let cw = 100
      let ch = 100
      Object.defineProperty(el, 'clientWidth', { get: () => cw, configurable: true })
      Object.defineProperty(el, 'clientHeight', { get: () => ch, configurable: true })
      const ref = React.createRef<HTMLDivElement>()
      ref.current = el
      const { result } = renderHook(() => useContainerSize(ref))
      expect(result.current).toEqual({ width: 100, height: 100 })
      cw = 800
      ch = 600
      act(() => {
        observerCallback?.([], el as unknown as ResizeObserver)
      })
      expect(result.current).toEqual({ width: 800, height: 600 })
    })

    it('window resize 事件触发时更新 size', () => {
      const el = document.createElement('div')
      let cw = 200
      Object.defineProperty(el, 'clientWidth', { get: () => cw, configurable: true })
      Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true })
      const ref = React.createRef<HTMLDivElement>()
      ref.current = el
      const { result } = renderHook(() => useContainerSize(ref))
      expect(result.current.width).toBe(200)
      cw = 600
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      expect(result.current.width).toBe(600)
    })
  })

  describe('卸载清理', () => {
    it('unmount 时调用 observer.disconnect', () => {
      const el = document.createElement('div')
      const ref = React.createRef<HTMLDivElement>()
      ref.current = el
      const { unmount } = renderHook(() => useContainerSize(ref))
      unmount()
      expect(disconnectSpy).toHaveBeenCalled()
    })

    it('unmount 时移除 window resize 监听', () => {
      const el = document.createElement('div')
      const ref = React.createRef<HTMLDivElement>()
      ref.current = el
      const spy = vi.spyOn(window, 'removeEventListener')
      const { unmount } = renderHook(() => useContainerSize(ref))
      unmount()
      expect(spy).toHaveBeenCalledWith('resize', expect.any(Function))
    })
  })
})
