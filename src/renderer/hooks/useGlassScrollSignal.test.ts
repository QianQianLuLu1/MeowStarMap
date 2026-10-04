import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGlassScrollSignal } from './useGlassScrollSignal'

/**
 * useGlassScrollSignal 测试。
 * jsdom 无布局引擎，滚动几何（scrollTop/scrollHeight/clientHeight）用
 * Object.defineProperty 注入；rAF 用 spy 手动驱动以保证确定性。
 */
describe('useGlassScrollSignal', () => {
  let rafCallbacks: FrameRequestCallback[]

  const flushFrame = () => {
    const cbs = rafCallbacks
    rafCallbacks = []
    act(() => {
      cbs.forEach((cb) => cb(0))
    })
  }

  /** 造一个带注入几何的滚动容器并挂到 body */
  const mountScrollable = (geo: {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
  }) => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'scrollTop', { value: geo.scrollTop, configurable: true })
    Object.defineProperty(el, 'scrollHeight', { value: geo.scrollHeight, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: geo.clientHeight, configurable: true })
    document.body.appendChild(el)
    return el
  }

  beforeEach(() => {
    rafCallbacks = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
    document.documentElement.style.removeProperty('--glass-scroll-progress')
    delete document.documentElement.dataset.glassTone
  })

  it('正常：后代滚动容器派发 scroll 后经 rAF 合帧写入进度变量', () => {
    renderHook(() => useGlassScrollSignal())
    const el = mountScrollable({ scrollTop: 100, scrollHeight: 1000, clientHeight: 200 })

    act(() => {
      el.dispatchEvent(new Event('scroll'))
    })
    // rAF 合帧：事件已到但尚未写变量
    expect(document.documentElement.style.getPropertyValue('--glass-scroll-progress')).toBe('')
    flushFrame()
    expect(document.documentElement.style.getPropertyValue('--glass-scroll-progress')).toBe(
      '0.1250'
    )
  })

  it('边界：无可滚动区间（scrollHeight==clientHeight）进度归 0', () => {
    renderHook(() => useGlassScrollSignal())
    const el = mountScrollable({ scrollTop: 50, scrollHeight: 200, clientHeight: 200 })

    act(() => {
      el.dispatchEvent(new Event('scroll'))
    })
    flushFrame()
    expect(document.documentElement.style.getPropertyValue('--glass-scroll-progress')).toBe(
      '0.0000'
    )
  })

  it('边界：data-glass-scroll-ignore 内部的滚动不更新变量', () => {
    renderHook(() => useGlassScrollSignal())
    const ignoreWrap = document.createElement('div')
    ignoreWrap.setAttribute('data-glass-scroll-ignore', '')
    document.body.appendChild(ignoreWrap)

    const outer = mountScrollable({ scrollTop: 450, scrollHeight: 900, clientHeight: 0 })
    // 先写入一个基线值
    act(() => {
      outer.dispatchEvent(new Event('scroll'))
    })
    flushFrame()
    const baseline = document.documentElement.style.getPropertyValue('--glass-scroll-progress')
    expect(baseline).toBe('0.5000')

    // ignore 区域内的滚动不应覆盖基线
    const inner = document.createElement('div')
    Object.defineProperty(inner, 'scrollTop', { value: 999, configurable: true })
    Object.defineProperty(inner, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(inner, 'clientHeight', { value: 10, configurable: true })
    ignoreWrap.appendChild(inner)
    act(() => {
      inner.dispatchEvent(new Event('scroll'))
    })
    flushFrame()
    expect(document.documentElement.style.getPropertyValue('--glass-scroll-progress')).toBe(
      baseline
    )
  })

  it('边界：同一帧内多次 scroll 只写一次（rAF 合帧）', () => {
    renderHook(() => useGlassScrollSignal())
    const el = mountScrollable({ scrollTop: 0, scrollHeight: 900, clientHeight: 0 })

    act(() => {
      el.dispatchEvent(new Event('scroll'))
      el.dispatchEvent(new Event('scroll'))
      el.dispatchEvent(new Event('scroll'))
    })
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1)
    flushFrame()
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1)
    expect(document.documentElement.style.getPropertyValue('--glass-scroll-progress')).toBe(
      '0.0000'
    )
  })

  it('异常：卸载后 scroll 事件不再写入变量', () => {
    const { unmount } = renderHook(() => useGlassScrollSignal())
    unmount()
    const el = mountScrollable({ scrollTop: 100, scrollHeight: 1000, clientHeight: 200 })

    act(() => {
      el.dispatchEvent(new Event('scroll'))
    })
    flushFrame()
    expect(document.documentElement.style.getPropertyValue('--glass-scroll-progress')).toBe('')
  })

  it('异常：非 Element 目标（如 document 自身）被忽略且不抛错', () => {
    renderHook(() => useGlassScrollSignal())

    act(() => {
      document.dispatchEvent(new Event('scroll'))
    })
    flushFrame()
    expect(document.documentElement.style.getPropertyValue('--glass-scroll-progress')).toBe('')
  })

  it('正常：挂载时按背景色亮度写入 data-glass-tone 档位', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      backgroundColor: 'rgb(20, 20, 24)'
    } as CSSStyleDeclaration)

    renderHook(() => useGlassScrollSignal())
    expect(document.documentElement.dataset.glassTone).toBe('dim')
  })

  it('边界：html class 变化（主题切换）时重算档位', async () => {
    const spy = vi
      .spyOn(window, 'getComputedStyle')
      .mockReturnValueOnce({ backgroundColor: 'rgb(20, 20, 24)' } as CSSStyleDeclaration)
      .mockReturnValue({ backgroundColor: 'rgb(245, 245, 245)' } as CSSStyleDeclaration)

    renderHook(() => useGlassScrollSignal())
    expect(document.documentElement.dataset.glassTone).toBe('dim')

    // 模拟主题切换（applyThemeClass 改 html class）；MutationObserver 回调为微任务，需异步冲刷
    await act(async () => {
      document.documentElement.classList.add('soft-pink-luxury')
    })
    expect(document.documentElement.dataset.glassTone).toBe('light')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('异常：背景色不可解析时保持档位不变（不写 data-glass-tone）', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      backgroundColor: 'rgba(0, 0, 0, 0)'
    } as CSSStyleDeclaration)

    renderHook(() => useGlassScrollSignal())
    expect(document.documentElement.dataset.glassTone).toBeUndefined()
  })
})
