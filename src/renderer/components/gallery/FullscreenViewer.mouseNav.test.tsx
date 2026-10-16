/**
 * @layer L3
 * @module src/renderer/components/gallery/FullscreenViewer
 * @coverage 全屏预览鼠标翻页三条新路径：滚轮 / 鼠标侧键 / 左右边缘热区（缺陷1）
 * @dependencies @testing-library/react + useUIStore + useMediaStore + 原生 WheelEvent / MouseEvent
 * @remarks
 *   根因：全屏查看器原先只有左右导航按钮与触摸滑动，鼠标用户除了点那两个小箭头
 *   之外没有任何翻页手段。本文件按「正常 / 异常 / 边界」三类钉住新增的三条路径，
 *   同时守住既有行为：点击中间背景仍然关闭全屏（`onClick={handleClose}`）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { FullscreenViewer } from './FullscreenViewer'
import { useUIStore } from '../../stores/uiStore'
import { useMediaStore, type MediaFile } from '../../stores/mediaStore'

/** 无缩略图的 fixture：不走「缩略图先行」换源逻辑，避免 Image.decode 干扰断言 */
function file(id: string, name: string): MediaFile {
  return {
    id,
    file_path: `C:\\media\\${name}`,
    file_name: name,
    file_type: 'image'
  } as unknown as MediaFile
}

const threeFiles = [file('m1', 'm1.jpg'), file('m2', 'm2.jpg'), file('m3', 'm3.jpg')]

function openFullscreen(files: MediaFile[], index = 1): void {
  act(() => {
    useUIStore.setState({
      fullscreenOpen: true,
      fullscreenIndex: index,
      fullscreenFiles: files,
      fullscreenTargetImg: null
    })
  })
}

function resetStores(): void {
  act(() => {
    useMediaStore.setState({ mediaFiles: [] })
    useUIStore.setState({
      fullscreenOpen: false,
      fullscreenIndex: 0,
      fullscreenFiles: null,
      fullscreenTargetImg: null
    })
  })
}

function currentIndex(): number {
  return useUIStore.getState().fullscreenIndex
}

/** 取出全屏根节点（role=dialog） */
function dialog(): HTMLElement {
  return document.querySelector('[role="dialog"]') as HTMLElement
}

/** 在全屏根节点上派发 wheel 事件（关闭态无根节点时落到 body，用于「不得抛错」断言）。
 *  F3：原生 dispatchEvent 不经 RTL 的 act 包装，翻页引发的 React 状态更新会落到
 *  act 之外产生警告，故显式包一层 act。 */
function wheel(delta: { deltaX?: number; deltaY?: number } = {}): WheelEvent {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaX: 0,
    deltaY: 0,
    ...delta
  })
  const root = document.querySelector('[role="dialog"]') as HTMLElement | null
  act(() => {
    ;(root ?? document.body).dispatchEvent(event)
  })
  return event
}

/** 左右边缘热区（aria-hidden 的纯鼠标命中区，用 data 属性定位） */
function hotzone(side: 'prev' | 'next'): HTMLElement | null {
  return document.querySelector(`[data-mouse-hotzone="${side}"]`) as HTMLElement | null
}

beforeEach(() => {
  resetStores()
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  resetStores()
})

describe('FullscreenViewer 滚轮翻页（正常）', () => {
  it('核心：向下滚动切到下一张', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 1)

    wheel({ deltaY: 200 })

    expect(currentIndex(), '滚轮向下应翻到下一张').toBe(2)
  })

  it('核心：向上滚动切到上一张', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 1)

    wheel({ deltaY: -200 })

    expect(currentIndex(), '滚轮向上应翻到上一张').toBe(0)
  })

  it('正常：横向滚轮同样可翻页（触控板双指横扫）', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 1)

    wheel({ deltaX: 200, deltaY: 1 })

    expect(currentIndex()).toBe(2)
  })
})

describe('FullscreenViewer 滚轮翻页（边界）', () => {
  it('边界：位移不足阈值不翻页', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 1)

    wheel({ deltaY: 20 })

    expect(currentIndex(), '单次微滚不得翻页').toBe(1)
  })

  it('边界：末张继续向下不越界', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 2)

    wheel({ deltaY: 200 })

    expect(currentIndex()).toBe(2)
  })

  it('边界：首张继续向上不越界', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 0)

    wheel({ deltaY: -200 })

    expect(currentIndex()).toBe(0)
  })

  it('边界：全屏未打开时滚轮不改动状态且不抛错', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    expect(document.querySelector('[role="dialog"]'), '关闭态不应渲染全屏层').toBeNull()

    expect(() => wheel({ deltaY: 200 })).not.toThrow()
    expect(currentIndex()).toBe(0)
    expect(useUIStore.getState().fullscreenOpen).toBe(false)
  })
})

describe('FullscreenViewer 鼠标侧键翻页', () => {
  it('核心：侧键后退（button=3）切到上一张', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 1)

    fireEvent.mouseDown(dialog(), { button: 3 })

    expect(currentIndex()).toBe(0)
  })

  it('核心：侧键前进（button=4）切到下一张', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 1)

    fireEvent.mouseDown(dialog(), { button: 4 })

    expect(currentIndex()).toBe(2)
  })

  it('边界：侧键事件被 preventDefault（避免浏览器后退/前进手势）', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 1)

    const event = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 4
    })
    // F3：裸 dispatchEvent 同样需要 act 包装，避免翻页状态更新落在 act 之外
    act(() => {
      dialog().dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(true)
  })

  it('边界：左键按下不触发翻页（仅侧键）', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 1)

    fireEvent.mouseDown(dialog(), { button: 0 })

    expect(currentIndex()).toBe(1)
  })
})

describe('FullscreenViewer 左右边缘热区翻页', () => {
  it('核心：点击左边缘切到上一张且不关闭全屏', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 1)

    const zone = hotzone('prev')
    expect(zone, '左边缘热区应渲染').not.toBeNull()
    fireEvent.click(zone as HTMLElement)

    expect(currentIndex()).toBe(0)
    expect(useUIStore.getState().fullscreenOpen, '点热区不得关闭全屏').toBe(true)
  })

  it('核心：点击右边缘切到下一张且不关闭全屏', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 1)

    const zone = hotzone('next')
    expect(zone, '右边缘热区应渲染').not.toBeNull()
    fireEvent.click(zone as HTMLElement)

    expect(currentIndex()).toBe(2)
    expect(useUIStore.getState().fullscreenOpen).toBe(true)
  })

  it('边界：首张不渲染左热区、末张不渲染右热区（与 navigate 判据一致）', () => {
    const view = render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 0)
    expect(hotzone('prev'), '首张不应有左热区').toBeNull()
    expect(hotzone('next')).not.toBeNull()

    view.unmount()
    cleanup()
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 2)
    expect(hotzone('next'), '末张不应有右热区').toBeNull()
    expect(hotzone('prev')).not.toBeNull()
  })

  // F4：原名「点击中间背景仍然关闭全屏」名不副实——真实浏览器中点击中间背景的
  // 命中目标是内层 w-full h-full 容器（HEAD 既有 onClick stopPropagation），并不会
  // 冒泡到根 onClick；本用例经 fireEvent 直派根元素，真正守卫的是「热区接线没有
  // 破坏根层 onClick」这一契约。
  it('回归：根层点击仍触发关闭（热区接线不得影响 root onClick）', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 1)

    fireEvent.click(dialog())

    expect(useUIStore.getState().fullscreenOpen, '根层点击应关闭全屏').toBe(false)
  })

  it('边界：仅一项文件时两侧热区都不渲染', () => {
    render(<FullscreenViewer filteredFiles={[threeFiles[0]]} />)
    openFullscreen([threeFiles[0]], 0)

    expect(hotzone('prev')).toBeNull()
    expect(hotzone('next')).toBeNull()
  })
})

describe('FullscreenViewer EXIF 信息浮层滚轮归属（F1 审查修复）', () => {
  /**
   * EXIF 浮层内的 ExifPanel 经 useExif 走 IPC 边界读取拍摄参数。
   * tests/setup.ts 的全局 electronAPI 占位是「任意属性返回 vi.fn」的 Proxy，
   * 其 file 替身没有 getExif 方法；此处替换为仅含 file.getExif 的最小桩
   * （进程边界桩，非被测链路 mock），用后还原，不影响本文件其他用例。
   */
  const originalElectronAPI = window.electronAPI

  beforeEach(() => {
    // getExif 返回永挂起的 Promise：本套只关心滚轮归属，不关心 EXIF 读取结果；
    // 挂起而非 resolve 是为避免 ExifPanel 的异步 setState 落到 act 之外产生警告
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      file: { getExif: vi.fn(() => new Promise<null>(() => {})) }
    }
  })

  afterEach(() => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = originalElectronAPI
  })

  /**
   * 定位 EXIF 信息浮层：打开「查看图片信息」后，全屏树内唯一的可滚动浮层容器
   * （overflow-y-auto + max-h 限高）。修复前浮轮事件会冒泡到全屏根被
   * useWheelPageNav 吞掉：既 preventDefault 掐死浮层自身滚动，又越阈值误翻页。
   */
  function infoPanel(): HTMLElement | null {
    return document.querySelector('.overflow-y-auto') as HTMLElement | null
  }

  it('核心：信息浮层上的滚轮不得翻页，且不得阻止默认滚动（浮层可自行滚动）', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 1)

    const infoButton = document.querySelector(
      'button[title="查看图片信息"]'
    ) as HTMLButtonElement | null
    expect(infoButton, '图片文件应显示信息按钮').not.toBeNull()
    fireEvent.click(infoButton as HTMLButtonElement)

    const panel = infoPanel()
    expect(panel, '点击信息按钮后应展开 EXIF 浮层').not.toBeNull()

    const captured: { event?: WheelEvent } = {}
    act(() => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 300 })
      ;(panel as HTMLElement).dispatchEvent(event)
      captured.event = event
    })

    expect(currentIndex(), '浮层上的滚轮不得翻动背后照片').toBe(1)
    expect(captured.event?.defaultPrevented, '浮层滚轮不得被 preventDefault 掐死自身滚动').toBe(
      false
    )
  })

  it('边界：浮层关闭后滚轮翻页立即恢复（放行判定不得残留）', () => {
    render(<FullscreenViewer filteredFiles={threeFiles} />)
    openFullscreen(threeFiles, 1)

    const infoButton = document.querySelector(
      'button[title="查看图片信息"]'
    ) as HTMLButtonElement | null
    fireEvent.click(infoButton as HTMLButtonElement)
    const panel = infoPanel()
    expect(panel, '浮层应已展开').not.toBeNull()

    const first: { event?: WheelEvent } = {}
    act(() => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 300 })
      ;(panel as HTMLElement).dispatchEvent(event)
      first.event = event
    })
    expect(currentIndex(), '浮层展开时滚轮不得翻页').toBe(1)

    // 再点一次同一按钮收起浮层
    fireEvent.click(infoButton as HTMLButtonElement)
    expect(infoPanel(), '浮层应已收起').toBeNull()

    act(() => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 300 })
      dialog().dispatchEvent(event)
    })
    expect(currentIndex(), '浮层收起后滚轮翻页必须恢复').toBe(2)
  })
})
