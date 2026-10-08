/**
 * @vitest-environment jsdom
 * @module src/renderer/hooks/useFluidTabIndicator
 * @coverage 流体滑块 Tab 指示器 Hook
 *
 * 三类覆盖：
 *   正常渲染 —— 首次落位、切换后落到目标、前沿/后沿分别用不同缓动曲线
 *   异常状态 —— 测量抛错降级隐藏、未注册 activeId 隐藏
 *   边界条件 —— 快速连点（中断续接 + 停掉上一段）、窗口缩放吸附、组件卸载清理、减弱动效
 *
 * 说明：jsdom 无布局，矩形由 `Element.prototype.getBoundingClientRect` 打桩提供；
 * motion 的 `animate()` 由 tests/setup.ts 同步桩替代（立即推到终态并记录调用）。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import React from 'react'
import { useFluidTabIndicator } from './useFluidTabIndicator'
import { fluidTabLead, fluidTabTrail } from '../utils/motionPresets'
import { getMotionAnimateCalls, resetMotionAnimateCalls } from '../../../tests/motion-animate-stub'

/** 各元素的打桩矩形：容器高 200，三个导航项高 40、间距 8 */
const rects: Record<string, { top: number; height: number }> = {
  container: { top: 0, height: 200 },
  a: { top: 0, height: 40 },
  b: { top: 48, height: 40 },
  c: { top: 96, height: 40 }
}

/** ResizeObserver 桩的每个实例：回调 + 被观察目标集合（用于断言订阅面是否覆盖导航项本身） */
interface RoInstance {
  cb: () => void
  targets: Element[]
}

/** 捕获 ResizeObserver 实例，用于模拟窗口缩放 / 单个导航项几何变化 */
let roInstances: RoInstance[] = []

function Harness({ activeId }: { activeId: string | null }): React.ReactElement {
  const { containerRef, indicatorRef, registerItem } =
    useFluidTabIndicator<HTMLDivElement>(activeId)
  return (
    <div ref={containerRef} data-rect="container" style={{ position: 'relative' }}>
      <div
        ref={indicatorRef}
        data-testid="indicator"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, opacity: 0 }}
      />
      {(['a', 'b', 'c'] as const).map((id) => (
        <button
          key={id}
          ref={registerItem(id)}
          data-rect={id}
          data-testid={`item-${id}`}
          type="button"
        >
          {id}
        </button>
      ))}
    </div>
  )
}

function indicator(): HTMLElement {
  return screen.getByTestId('indicator')
}

beforeEach(() => {
  roInstances = []
  resetMotionAnimateCalls()
  Object.assign(rects, {
    container: { top: 0, height: 200 },
    a: { top: 0, height: 40 },
    b: { top: 48, height: 40 },
    c: { top: 96, height: 40 }
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private instance: RoInstance
      constructor(cb: () => void) {
        this.instance = { cb, targets: [] }
        roInstances.push(this.instance)
      }
      observe(el: Element): void {
        this.instance.targets.push(el)
      }
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element
  ): DOMRect {
    const r = rects[this.getAttribute('data-rect') ?? ''] ?? { top: 0, height: 0 }
    return {
      top: r.top,
      height: r.height,
      bottom: r.top + r.height,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: r.top,
      toJSON: () => ({})
    } as DOMRect
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.classList.remove('reduce-motion')
})

describe('正常渲染', () => {
  it('首次挂载：瞬时落位到 activeId 对应项，不产生动画', () => {
    render(<Harness activeId="a" />)
    expect(indicator().style.opacity).toBe('1')
    expect(indicator().style.height).toBe('40px')
    expect(indicator().style.transform).toBe('translateY(0px) scaleY(1)')
    expect(getMotionAnimateCalls()).toHaveLength(0)
  })

  it('切换导航项：落到目标位置，且前沿/后沿各起一条动画、缓动曲线不同', () => {
    const { rerender } = render(<Harness activeId="a" />)
    rerender(<Harness activeId="b" />)

    const calls = getMotionAnimateCalls()
    expect(calls).toHaveLength(2)
    // 下移：前沿 = bottom（0+40 → 48+40），后沿 = top（0 → 48）
    expect(calls[0].from).toBe(40)
    expect(calls[0].to).toBe(88)
    expect(calls[0].options.ease).toEqual(fluidTabLead)
    expect(calls[1].from).toBe(0)
    expect(calls[1].to).toBe(48)
    expect(calls[1].options.ease).toEqual(fluidTabTrail)
    // 同步桩直接推到终态
    expect(indicator().style.transform).toBe('translateY(48px) scaleY(1)')
  })

  it('上移：前沿改判为 top，缓动曲线随之互换', () => {
    const { rerender } = render(<Harness activeId="c" />)
    rerender(<Harness activeId="a" />)

    const calls = getMotionAnimateCalls()
    expect(calls).toHaveLength(2)
    // 上移：前沿 = top（96 → 0）走快出曲线，后沿 = bottom（136 → 40）走慢曲线
    expect(calls[0].from).toBe(96)
    expect(calls[0].to).toBe(0)
    expect(calls[0].options.ease).toEqual(fluidTabLead)
    expect(calls[1].from).toBe(136)
    expect(calls[1].to).toBe(40)
    expect(calls[1].options.ease).toEqual(fluidTabTrail)
  })
})

describe('边界条件', () => {
  it('快速连点：最终落在最后一项，且前一段动画被 stop', () => {
    const { rerender } = render(<Harness activeId="a" />)
    // 两次独立渲染各自提交（放在同一个 act 内会被批处理合并成一次提交）
    rerender(<Harness activeId="b" />)
    rerender(<Harness activeId="c" />)

    const calls = getMotionAnimateCalls()
    // a→b（2 条）+ b→c（2 条）
    expect(calls).toHaveLength(4)
    // 第二段开始前，第一段的两条动画都必须已停止
    expect(calls[0].stopped).toBeGreaterThanOrEqual(1)
    expect(calls[1].stopped).toBeGreaterThanOrEqual(1)
    expect(indicator().style.transform).toBe('translateY(96px) scaleY(1)')
  })

  it('窗口缩放 / 布局变化：ResizeObserver 触发后吸附到新几何，且不启动动画', () => {
    render(<Harness activeId="b" />)
    // 布局变化：b 上移到 60
    rects.b = { top: 60, height: 40 }
    const before = getMotionAnimateCalls().length
    act(() => {
      roInstances.forEach((o) => o.cb())
    })
    expect(getMotionAnimateCalls()).toHaveLength(before)
    expect(indicator().style.transform).toBe('translateY(60px) scaleY(1)')
  })

  it('单个导航项几何变化但容器尺寸不变：滑块跟随吸附（容器级订阅感知不到此类变化）', () => {
    render(<Harness activeId="b" />)
    expect(indicator().style.transform).toBe('translateY(48px) scaleY(1)')

    // 仅 b 项的几何变化（如 compact-mode 改导航项内边距）：容器矩形保持不动
    rects.b = { top: 60, height: 44 }
    const itemObserver = roInstances.find((o) =>
      o.targets.some((el) => el.getAttribute('data-rect') === 'b')
    )
    expect(itemObserver).toBeDefined()
    act(() => {
      itemObserver?.cb()
    })
    expect(indicator().style.transform).toBe('translateY(60px) scaleY(1)')
    expect(indicator().style.height).toBe('44px')
  })

  it('组件卸载：在飞的动画被停止', () => {
    const { rerender, unmount } = render(<Harness activeId="a" />)
    rerender(<Harness activeId="b" />)
    // 同步桩会立即完成，手动保留一条在飞的动画：再次切换后立刻卸载
    rerender(<Harness activeId="c" />)
    const calls = getMotionAnimateCalls()
    unmount()
    expect(calls.every((c) => c.stopped >= 1)).toBe(true)
  })

  it('减弱动效：html.reduce-motion 下瞬时落位，不启动动画', () => {
    document.documentElement.classList.add('reduce-motion')
    const { rerender } = render(<Harness activeId="a" />)
    rerender(<Harness activeId="b" />)
    expect(getMotionAnimateCalls()).toHaveLength(0)
    expect(indicator().style.transform).toBe('translateY(48px) scaleY(1)')
  })
})

describe('异常状态', () => {
  it('activeId 为 null：滑块隐藏', () => {
    render(<Harness activeId={null} />)
    expect(indicator().style.opacity).toBe('0')
    expect(getMotionAnimateCalls()).toHaveLength(0)
  })

  it('activeId 未注册（如 detail / editor 视图）：滑块隐藏', () => {
    render(<Harness activeId="editor" />)
    expect(indicator().style.opacity).toBe('0')
  })

  it('测量抛错：降级隐藏并告警，不阻断渲染', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => {
      throw new Error('measure boom')
    })
    expect(() => render(<Harness activeId="a" />)).not.toThrow()
    expect(indicator().style.opacity).toBe('0')
    expect(warn).toHaveBeenCalled()
  })

  it('矩形非法（高度为 0）：隐藏滑块，不写形变', () => {
    rects.a = { top: 0, height: 0 }
    render(<Harness activeId="a" />)
    expect(indicator().style.opacity).toBe('0')
  })
})
