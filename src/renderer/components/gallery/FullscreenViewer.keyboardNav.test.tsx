/**
 * @layer L3
 * @module src/renderer/components/gallery/FullscreenViewer
 * @coverage 全屏预览键盘切换稳定性（缺陷2：画面跳动/闪烁/重排）
 * @dependencies @testing-library/react + useUIStore + 原生 KeyboardEvent
 * @remarks
 *   三处根因各自一条「修复前必红」的用例：
 *   - 5a：keydown 分支未 preventDefault（方向键默认滚动行为不被抑制 → 背景滚动/画面抖）；
 *   - 5b：focus effect 依赖含 fullscreenIndex，每次翻页重新聚焦且未 preventScroll
 *         （聚焦会触发隐式 scroll-into-view）；
 *   - 5c：navigate 读闭包里的陈旧 fullscreenIndex，同帧连按只前进一张（丢步后跳）。
 *   另含两条回归守卫：方向键正常翻页、Esc 仍能关闭。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { FullscreenViewer } from './FullscreenViewer'
import { useUIStore } from '../../stores/uiStore'
import { useMediaStore, type MediaFile } from '../../stores/mediaStore'

function file(id: string, name: string): MediaFile {
  return {
    id,
    file_path: `C:\\media\\${name}`,
    file_name: name,
    file_type: 'image'
  } as unknown as MediaFile
}

const threeFiles = [file('k1', 'k1.jpg'), file('k2', 'k2.jpg'), file('k3', 'k3.jpg')]

function openFullscreen(files: MediaFile[], index = 0): void {
  act(() => {
    useUIStore.setState({
      fullscreenOpen: true,
      fullscreenIndex: index,
      fullscreenFiles: files,
      fullscreenTargetImg: null
    })
  })
}

function currentIndex(): number {
  return useUIStore.getState().fullscreenIndex
}

/** 向 window 派发一个可取消的 keydown（组件监听挂在 window 上）。
 *  F3：原生 dispatchEvent 不经 RTL 的 act 包装，翻页/关闭引发的 React 状态更新
 *  会落到 act 之外产生警告，故显式包一层 act（与调用方自带的 act 嵌套无冲突）。 */
function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => {
    window.dispatchEvent(event)
  })
  return event
}

beforeEach(() => {
  act(() => {
    useMediaStore.setState({ mediaFiles: [] })
    useUIStore.setState({
      fullscreenOpen: false,
      fullscreenIndex: 0,
      fullscreenFiles: null,
      fullscreenTargetImg: null
    })
  })
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('FullscreenViewer 键盘翻页（正常 / 回归）', () => {
  it('核心：方向键仍可正常翻页', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 0)

    act(() => {
      press('ArrowRight')
    })
    expect(currentIndex()).toBe(1)

    act(() => {
      press('ArrowLeft')
    })
    expect(currentIndex()).toBe(0)
  })

  it('回归：Esc 仍能关闭全屏', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 1)

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })

    expect(useUIStore.getState().fullscreenOpen).toBe(false)
  })
})

describe('5a 键盘事件必须阻止默认行为', () => {
  it('核心：已处理的方向键被 preventDefault', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 1)

    const right = press('ArrowRight')
    const left = press('ArrowLeft')

    expect(right.defaultPrevented, 'ArrowRight 必须阻止默认滚动').toBe(true)
    expect(left.defaultPrevented, 'ArrowLeft 必须阻止默认滚动').toBe(true)
  })

  it('边界：Esc 同样被 preventDefault（避免默认退出行为干扰）', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 1)

    const event = press('Escape')

    expect(event.defaultPrevented).toBe(true)
  })

  it('边界：未接管的按键不得被误吞（保持输入法/系统快捷键可用）', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 1)

    const event = press('F5')

    expect(event.defaultPrevented).toBe(false)
  })
})

describe('5b 翻页不得重复聚焦', () => {
  it('核心：连续翻页只聚焦一次，且带 preventScroll', () => {
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 0)

    act(() => {
      useUIStore.setState({ fullscreenIndex: 1 })
    })
    act(() => {
      useUIStore.setState({ fullscreenIndex: 2 })
    })
    act(() => {
      useUIStore.setState({ fullscreenIndex: 1 })
    })

    expect(focusSpy, '每次翻页重复聚焦会引发隐式滚动，必须只在开启时聚焦').toHaveBeenCalledTimes(1)
    expect(focusSpy.mock.calls[0]?.[0], '聚焦必须带 preventScroll').toMatchObject({
      preventScroll: true
    })
  })
})

describe('5c 同帧连按不得丢步', () => {
  it('核心：同一 tick 内连按两次方向键应前进两张', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 0)

    // 键 repeat 快于一次渲染：若 navigate 读闭包里的旧下标，两次都算到 1
    act(() => {
      press('ArrowRight')
      press('ArrowRight')
    })

    expect(currentIndex(), '同帧连按两次应前进两张').toBe(2)
  })

  it('边界：连续反向连按回到起点', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 2)

    act(() => {
      press('ArrowLeft')
      press('ArrowLeft')
    })

    expect(currentIndex()).toBe(0)
  })

  it('边界：同帧连按到边界时不得越界', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 2)

    act(() => {
      press('ArrowRight')
      press('ArrowRight')
    })

    expect(currentIndex(), '末张不得越界').toBe(2)
  })
})
