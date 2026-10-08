/**
 * @vitest-environment jsdom
 * @module src/renderer/components/layout/Sidebar
 * @coverage 侧边栏流体滑块 Tab 指示器（组件级）
 *
 * 三类覆盖：
 *   正常渲染 —— 滑块是导航区首个子节点、首次瞬时落位、激活项保留 active 语义
 *   边界条件 —— 快速连点收敛到最后一项、减弱动效瞬时落位
 *   异常状态 —— 非导航视图（detail / editor）隐藏滑块
 *
 * 说明：jsdom 无布局，导航项矩形由 `getBoundingClientRect` 按索引打桩；
 * uiStore 用真实 store（验证 navigateTo → 滑块联动），mediaStore 与过滤 hooks 打桩隔离。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { Sidebar } from './Sidebar'
import { useUIStore } from '../../stores/uiStore'
import { fluidTabLead, fluidTabTrail } from '../../utils/motionPresets'
import {
  getMotionAnimateCalls,
  resetMotionAnimateCalls
} from '../../../../tests/motion-animate-stub'

/** 导航项高度 40px、间距 8px */
const ITEM_H = 40
const STEP = 48

function fakeRect(top: number, height: number): DOMRect {
  return {
    top,
    height,
    bottom: top + height,
    left: 0,
    right: 200,
    width: 200,
    x: 0,
    y: top,
    toJSON: () => ({})
  } as DOMRect
}

function navButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button.nav-item'))
}

function indicator(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.fluid-tab-indicator')
  if (!el) throw new Error('fluid-tab-indicator not found')
  return el
}

vi.mock('../../stores/mediaStore', () => ({
  useMediaStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      mediaFiles: [],
      categories: [],
      currentProfileUid: 'default',
      profiles: [],
      setMediaFiles: () => {},
      setCurrentProfileUid: () => {}
    }),
  fetchMediaFromDatabase: vi.fn(async () => null),
  loadProfiles: vi.fn(async () => undefined)
}))

vi.mock('../../hooks/useFilteredMediaFiles', () => ({
  useFilteredMediaFiles: () => []
}))

beforeEach(() => {
  resetMotionAnimateCalls()
  useUIStore.setState({
    currentView: 'gallery',
    viewStack: ['gallery'],
    sidebarCollapsed: false,
    groupDimension: 'none'
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element
  ): DOMRect {
    const idx = navButtons().indexOf(this as HTMLButtonElement)
    if (idx >= 0) return fakeRect(idx * STEP, ITEM_H)
    if (this.tagName === 'NAV') return fakeRect(0, 9 * STEP)
    return fakeRect(0, 0)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.classList.remove('reduce-motion')
})

describe('正常渲染', () => {
  it('滑块渲染为导航区首个子节点（绘制在按钮之下），激活项保留 active 类', () => {
    render(<Sidebar />)
    const nav = document.querySelector('nav')
    expect(nav).not.toBeNull()
    expect(nav?.classList.contains('nav-fluid')).toBe(true)
    expect(nav?.firstElementChild?.classList.contains('fluid-tab-indicator')).toBe(true)
    expect(navButtons()[0].classList.contains('active')).toBe(true)
  })

  it('首次挂载：瞬时落位到当前项，不产生动画', () => {
    render(<Sidebar />)
    expect(indicator().style.opacity).toBe('1')
    expect(indicator().style.height).toBe(`${ITEM_H}px`)
    expect(indicator().style.transform).toBe('translateY(0px) scaleY(1)')
    expect(getMotionAnimateCalls()).toHaveLength(0)
  })

  it('点击第 9 项：滑块两条边分别补间并落到目标位置', () => {
    render(<Sidebar />)
    fireEvent.click(navButtons()[8])

    const calls = getMotionAnimateCalls()
    expect(calls).toHaveLength(2)
    expect(calls[0].options.ease).toEqual(fluidTabLead)
    expect(calls[1].options.ease).toEqual(fluidTabTrail)
    expect(indicator().style.transform).toBe(`translateY(${8 * STEP}px) scaleY(1)`)
  })
})

describe('边界条件', () => {
  it('快速连点：最终落在最后点击的项，且前一段动画被 stop', () => {
    render(<Sidebar />)
    fireEvent.click(navButtons()[5]) // 分类
    fireEvent.click(navButtons()[6]) // 重复文件
    fireEvent.click(navButtons()[7]) // 回收站

    const calls = getMotionAnimateCalls()
    expect(calls).toHaveLength(6) // 3 段 × 2 条
    expect(calls[0].stopped).toBeGreaterThanOrEqual(1)
    expect(calls[1].stopped).toBeGreaterThanOrEqual(1)
    expect(indicator().style.transform).toBe(`translateY(${7 * STEP}px) scaleY(1)`)
  })

  it('减弱动效：html.reduce-motion 下瞬时落位，不启动动画', () => {
    document.documentElement.classList.add('reduce-motion')
    render(<Sidebar />)
    fireEvent.click(navButtons()[8])
    expect(getMotionAnimateCalls()).toHaveLength(0)
    expect(indicator().style.transform).toBe(`translateY(${8 * STEP}px) scaleY(1)`)
  })
})

describe('异常状态', () => {
  it('非导航视图（detail / editor）：滑块隐藏', () => {
    render(<Sidebar />)
    expect(indicator().style.opacity).toBe('1')
    // store 更新会触发 Sidebar 重渲染，必须包在 act 内
    act(() => {
      useUIStore.setState({ currentView: 'detail' })
    })
    expect(indicator().style.opacity).toBe('0')
  })
})
