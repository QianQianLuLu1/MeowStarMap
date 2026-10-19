/**
 * @layer L3
 * @module src/renderer/hooks/useWheelPageNav
 * @coverage 全屏预览滚轮翻页（缺陷1：鼠标翻页失效）
 * @dependencies @use-gesture/react(useWheel) + @testing-library/react(renderHook) + 原生 WheelEvent
 * @remarks
 *   根因：全屏查看器（src/renderer/components/gallery/FullscreenViewer.tsx）原先只有
 *   触摸滑动与左右导航按钮，滚轮 / 鼠标侧键 / 边缘点击三条鼠标路径完全未接线。
 *   本套用例围绕新增的 useWheelPageNav 钩子，覆盖三类场景：
 *   - 正常：单次过阈值翻页、反向翻页、多次小幅累加后翻页、横向 delta 优先、自定义阈值生效；
 *   - 异常：target 未挂载 / 回调非函数不抛错，事件默认行为被 preventDefault 拦截；
 *   - 边界：冷却窗口吸收触控板惯性（一次甩动只翻一张）、冷却结束后可再翻、
 *           threshold 非法值回落默认、enabled=false 静默、ctrlKey（捏合缩放）不劫持。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import {
  useWheelPageNav,
  DEFAULT_WHEEL_THRESHOLD,
  DEFAULT_WHEEL_COOLDOWN_MS,
  type UseWheelPageNavOptions
} from './useWheelPageNav'

/** 每个用例一个干净的浮层节点，供钩子绑定原生 wheel 监听 */
let host: HTMLDivElement

beforeEach(() => {
  document.body.innerHTML = ''
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

/** 在当前节点上派发一个可取消的 wheel 事件，返回事件本体以便断言 defaultPrevented */
function wheel(delta: { deltaX?: number; deltaY?: number } & WheelEventInit = {}): WheelEvent {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaX: 0,
    deltaY: 0,
    ...delta
  })
  host.dispatchEvent(event)
  return event
}

/** 等待超过默认冷却窗口，让下一次滚动可被受理 */
async function waitPastCooldown(ms = DEFAULT_WHEEL_COOLDOWN_MS + 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 挂载钩子。target 用稳定的 ref-like 对象（每渲染复用同一对象，
 * 避免 ref 身份变化导致的重复绑定）。
 */
function mount(options: Partial<UseWheelPageNavOptions> = {}) {
  const onPrev = options.onPrev ?? vi.fn()
  const onNext = options.onNext ?? vi.fn()
  const targetRef = { current: options.target ? options.target.current : host }
  const view = renderHook(() =>
    useWheelPageNav({
      enabled: options.enabled ?? true,
      target: targetRef,
      onPrev,
      onNext,
      threshold: options.threshold,
      cooldownMs: options.cooldownMs,
      ignoreSelector: options.ignoreSelector
    })
  )
  return { view, onPrev, onNext }
}

describe('useWheelPageNav 滚轮翻页（正常）', () => {
  it('核心：向下滚动越过阈值触发下一张', () => {
    const { onPrev, onNext } = mount()

    wheel({ deltaY: DEFAULT_WHEEL_THRESHOLD + 20 })

    expect(onNext).toHaveBeenCalledTimes(1)
    expect(onPrev).not.toHaveBeenCalled()
  })

  it('核心：向上滚动越过阈值触发上一张', () => {
    const { onPrev, onNext } = mount()

    wheel({ deltaY: -(DEFAULT_WHEEL_THRESHOLD + 20) })

    expect(onPrev).toHaveBeenCalledTimes(1)
    expect(onNext).not.toHaveBeenCalled()
  })

  it('正常：多次小幅滚动累加到阈值后才触发一次', () => {
    const { onNext } = mount()

    // 20、40 < 60，未达阈值不应触发
    wheel({ deltaY: 20 })
    wheel({ deltaY: 20 })
    expect(onNext, '未达阈值不得翻页').not.toHaveBeenCalled()

    wheel({ deltaY: 20 })
    expect(onNext, '累加到 60 应触发一次').toHaveBeenCalledTimes(1)
  })

  it('正常：横向滚动以 deltaX 为准触发翻页', () => {
    const { onNext } = mount()

    wheel({ deltaX: DEFAULT_WHEEL_THRESHOLD + 20, deltaY: 1 })

    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('正常：自定义 threshold 覆盖默认值', () => {
    const { onNext } = mount({ threshold: 150 })

    wheel({ deltaY: 100 })
    expect(onNext, '未达自定义阈值不得翻页').not.toHaveBeenCalled()

    wheel({ deltaY: 100 })
    expect(onNext, '累加 200 越过自定义阈值应翻页').toHaveBeenCalledTimes(1)
  })
})

describe('useWheelPageNav 滚轮翻页（边界）', () => {
  it('边界：冷却窗口内的连发惯性只翻一张（触控板一次甩动）', () => {
    const { onNext } = mount()

    wheel({ deltaY: 100 })
    wheel({ deltaY: 100 })
    wheel({ deltaY: 100 })
    wheel({ deltaY: 100 })

    expect(onNext, '一次甩动只能翻一张').toHaveBeenCalledTimes(1)
  })

  it('边界：冷却窗口结束后可再次翻页', async () => {
    const { onNext } = mount({ cooldownMs: 50 })

    wheel({ deltaY: 100 })
    expect(onNext).toHaveBeenCalledTimes(1)

    await waitPastCooldown(70)
    wheel({ deltaY: 100 })
    expect(onNext, '冷却结束后应可再次翻页').toHaveBeenCalledTimes(2)
  })

  it('边界：首个事件的 timeStamp 小于冷却窗口时仍应受理（初值不得伪装成已触发）', () => {
    // F2 审查修复：lastTriggerRef 若以 0 初始化，「从未触发」会被误判为
    // 「t=0 已触发过一次」，timeStamp 小于冷却窗口的首次滚动被冷却吞掉
    const { onNext } = mount()

    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: DEFAULT_WHEEL_THRESHOLD + 20
    })
    Object.defineProperty(event, 'timeStamp', { value: 50, configurable: true })
    host.dispatchEvent(event)

    expect(onNext, '首次滚动不得被冷却初值吞掉').toHaveBeenCalledTimes(1)
  })

  it('边界：threshold 为非法值（NaN / 0 / 负数）回落默认阈值', () => {
    for (const threshold of [Number.NaN, 0, -10]) {
      const { onNext, view } = mount({ threshold })

      // 20 < 默认阈值 60：若非法值未被回落，此时会被误判为到达阈值而翻页
      wheel({ deltaY: 20 })
      expect(onNext, `threshold=${threshold} 应回落默认阈值`).not.toHaveBeenCalled()

      wheel({ deltaY: 60 })
      expect(onNext, `threshold=${threshold} 回落默认后应可翻页`).toHaveBeenCalledTimes(1)

      view.unmount()
    }
  })

  it('边界：enabled=false 时不响应滚动', () => {
    const { onPrev, onNext } = mount({ enabled: false })

    wheel({ deltaY: 300 })

    expect(onPrev).not.toHaveBeenCalled()
    expect(onNext).not.toHaveBeenCalled()
  })

  it('边界：ctrlKey（触控板捏合缩放）交还系统处理，不劫持也不翻页', () => {
    const { onNext } = mount()

    const event = wheel({ deltaY: 300, ctrlKey: true })

    expect(onNext, '捏合缩放不得被误判为翻页').not.toHaveBeenCalled()
    expect(event.defaultPrevented, '捏合缩放不得吞掉浏览器缩放').toBe(false)
  })

  it('边界：默认 defaultPrevented 为真（passive:false 生效，不滚动背景）', () => {
    mount()

    const event = wheel({ deltaY: 10 })

    expect(event.defaultPrevented, '全屏遮罩内的滚轮必须阻止默认滚动').toBe(true)
  })

  it('边界：事件目标命中 ignoreSelector 时整条放行（浮层自有滚动区不劫持）', () => {
    // F1 审查修复：EXIF 浮层等自有滚动区声明滚轮归属——命中放行选择器时
    // 既不 preventDefault（浮层可按默认行为自行滚动）也不累计位移/翻页
    const { onPrev, onNext } = mount({ ignoreSelector: '[data-wheel-ignore]' })

    const overlay = document.createElement('div')
    overlay.setAttribute('data-wheel-ignore', '')
    host.appendChild(overlay)
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 300 })
    overlay.dispatchEvent(event)

    expect(onNext, '命中放行选择器不得翻页').not.toHaveBeenCalled()
    expect(onPrev, '命中放行选择器不得翻页').not.toHaveBeenCalled()
    expect(event.defaultPrevented, '命中放行选择器不得阻止默认滚动').toBe(false)
  })

  it('边界：ignoreSelector 缺省时放行政策不生效（行为与引入前一致）', () => {
    const { onNext } = mount()

    const overlay = document.createElement('div')
    overlay.setAttribute('data-wheel-ignore', '')
    host.appendChild(overlay)
    wheel({ deltaY: 300 })

    expect(onNext, '未配置放行选择器时浮层内滚轮照常翻页（向后兼容）').toHaveBeenCalledTimes(1)
  })
})

describe('useWheelPageNav 滚轮翻页（异常）', () => {
  it('异常：target 未挂载时不抛错且回调 0 次（全屏关闭态）', () => {
    const { onPrev, onNext } = mount({ target: { current: null } })

    expect(() => wheel({ deltaY: 300 })).not.toThrow()
    expect(onNext).not.toHaveBeenCalled()
    expect(onPrev).not.toHaveBeenCalled()
  })

  it('异常：回调为非函数时不抛错（防御性：调用方传错类型不得崩掉组件）', () => {
    const broken = { prev: undefined, next: undefined } as unknown as {
      onPrev: () => void
      onNext: () => void
    }

    expect(() => mount({ onPrev: broken.onPrev, onNext: broken.onNext })).not.toThrow()
    expect(() => wheel({ deltaY: 300 })).not.toThrow()
  })
})
