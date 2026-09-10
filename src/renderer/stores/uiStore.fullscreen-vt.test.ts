// @vitest-environment jsdom
/**
 * @layer L3
 * @module src/renderer/stores/uiStore
 * @coverage openFullscreen / closeFullscreen 的过渡提交时机、参数校验与降级链
 * @dependencies React 19 + react-dom.flushSync + @testing-library/react + 新增 utils/view-transition
 * @remarks
 *   根因回归：
 *   RC1 —— apply() 内只做 zustand set()，React 走并发/异步调度，浏览器在 View Transitions
 *          回调 resolve 后的下一渲染机会拍新快照时 DOM 尚未提交，导致共享元素丢失、
 *          并与 React render 争抢动画窗口。契约：回调返回时必须已可观测到新状态。
 *   RC3 —— 清理标记不得再走全文档 querySelectorAll 扫描。
 *   本文件所有用例在修复前均为红灯（已实证）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { useUIStore } from './uiStore'
import type { MediaFile } from './mediaStore'
import { whenTransitionSettled } from '../utils/view-transition'

/** vi.mock 工厂在模块求值阶段执行，需用 vi.hoisted 提前声明可变开关 */
const control = vi.hoisted(() => ({
  throwOnFlushSync: false
}))

vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom')>()
  return {
    ...actual,
    flushSync: (cb: () => void) => {
      if (control.throwOnFlushSync) throw new Error('flushSync boom')
      return actual.flushSync(cb)
    }
  }
})

interface FakeElement {
  finished: Promise<void>
}

const observedSelectors: string[] = []
// 用 unknown 覆盖 DOM lib 自带的 startViewTransition 签名，便于注入任意桩
const doc = document as unknown as { startViewTransition?: unknown }
const originalStarter = doc.startViewTransition
const originalQSA = document.querySelectorAll

/** 全屏状态的最小探针：把 store 状态投影成 DOM 属性，用于验证「同步提交」契约 */
const Probe = () => {
  const open = useUIStore((s) => s.fullscreenOpen)
  return createElement('div', { 'data-open': open ? '1' : '0' })
}

function makeFile(id: string): MediaFile {
  return { id, file_path: `C:\\media\\${id}`, file_name: id } as unknown as MediaFile
}

function installStarter(start: (cb: () => void) => FakeElement): void {
  doc.startViewTransition = (cb: () => void) => start(cb)
}

function resetStore(): void {
  act(() => {
    useUIStore.setState({
      fullscreenOpen: false,
      fullscreenIndex: 0,
      fullscreenFiles: null,
      fullscreenTargetImg: null
    })
  })
}

beforeEach(() => {
  control.throwOnFlushSync = false
  observedSelectors.length = 0
  installStarter((cb) => {
    cb()
    return { finished: Promise.resolve() }
  })
  resetStore()
})

afterEach(() => {
  cleanup()
  if (originalStarter === undefined) {
    delete doc.startViewTransition
  } else {
    doc.startViewTransition = originalStarter
  }
  document.querySelectorAll = originalQSA
  resetStore()
  vi.restoreAllMocks()
})

describe('openFullscreen：View Transitions 同步提交契约（RC1）', () => {
  it('核心：回调返回（即拍新快照前）时，订阅组件的 DOM 必须已更新（修复前为异步 → 红灯）', () => {
    render(createElement(Probe))
    expect(document.querySelector('[data-open]')?.getAttribute('data-open')).toBe('0')

    let observedAtSnapshot: string | null = null
    installStarter((cb) => {
      cb()
      observedAtSnapshot = document.querySelector('[data-open]')?.getAttribute('data-open') ?? null
      return { finished: Promise.resolve() }
    })

    act(() => {
      useUIStore.getState().openFullscreen(0, [makeFile('a.jpg')])
    })

    expect(observedAtSnapshot, '回调返回时 DOM 尚未反映新状态 → 新快照会抓到旧画面').toBe('1')
  })

  it('正常：openFullscreen 携带 files 时写入 fullscreenFiles', () => {
    const files = [makeFile('a.jpg'), makeFile('b.jpg')]
    act(() => {
      useUIStore.getState().openFullscreen(1, files)
    })
    expect(useUIStore.getState().fullscreenFiles).toBe(files)
    expect(useUIStore.getState().fullscreenIndex).toBe(1)
  })
})

describe('active transition 注册表（G2：换源须避开动画窗口）', () => {
  it('openFullscreen 注册进行中的过渡，finished 落定后换源约束才解除', async () => {
    let resolveFinished: (() => void) | null = null
    installStarter((cb) => {
      cb()
      return {
        finished: new Promise<void>((resolve) => {
          resolveFinished = resolve
        })
      }
    })

    act(() => {
      useUIStore.getState().openFullscreen(0, [makeFile('a.jpg')])
    })
    expect(useUIStore.getState().fullscreenOpen).toBe(true)

    let settled = false
    void whenTransitionSettled().then(() => {
      settled = true
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(settled, '过渡未结束前不得视为已结束（否则换源落在动画窗口内）').toBe(false)

    await act(async () => {
      resolveFinished?.()
      await Promise.resolve()
    })
    expect(settled).toBe(true)
  })

  it('closeFullscreen 后注册表清空（不悬挂已结束过渡的引用）', async () => {
    // beforeEach 默认 starter 返回已 resolve 的 finished
    act(() => {
      useUIStore.getState().openFullscreen(0, [makeFile('a.jpg')])
    })
    act(() => {
      useUIStore.getState().closeFullscreen()
    })
    await act(async () => {
      await Promise.resolve()
    })
    let settled = false
    void whenTransitionSettled().then(() => {
      settled = true
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(settled).toBe(true)
  })
})

describe('closeFullscreen：反向过渡与清理', () => {
  it('边界：fullscreenTargetImg 为 null 时仍能关闭且不抛错', () => {
    act(() => {
      useUIStore.setState({ fullscreenOpen: true, fullscreenTargetImg: null })
    })
    expect(() => useUIStore.getState().closeFullscreen()).not.toThrow()
    expect(useUIStore.getState().fullscreenOpen).toBe(false)
  })

  it('边界：transition.finished 拒绝时不产生未处理拒绝，状态已关闭', () => {
    installStarter((cb) => {
      cb()
      return { finished: Promise.reject(new Error('interrupted')) }
    })
    act(() => {
      useUIStore.setState({ fullscreenOpen: true })
    })
    expect(() => useUIStore.getState().closeFullscreen()).not.toThrow()
    expect(useUIStore.getState().fullscreenOpen).toBe(false)
  })
})

describe('全文档扫描移除（RC3）：开关全屏不得再执行 style 子串选择器', () => {
  it('openFullscreen 不调用 querySelectorAll("[style*=view-transition-name]")', () => {
    document.querySelectorAll = function (this: Document, selector: string) {
      observedSelectors.push(selector)
      return originalQSA.call(this, selector)
    } as typeof document.querySelectorAll

    act(() => {
      useUIStore.getState().openFullscreen(0, [makeFile('a.jpg')])
    })

    expect(observedSelectors.filter((s) => s.includes('view-transition-name'))).toEqual([])
  })

  it('closeFullscreen 不调用 querySelectorAll("[style*=view-transition-name]")', () => {
    act(() => {
      useUIStore.setState({ fullscreenOpen: true })
    })
    document.querySelectorAll = function (this: Document, selector: string) {
      observedSelectors.push(selector)
      return originalQSA.call(this, selector)
    } as typeof document.querySelectorAll

    act(() => {
      useUIStore.getState().closeFullscreen()
    })

    expect(observedSelectors.filter((s) => s.includes('view-transition-name'))).toEqual([])
  })
})

describe('降级链：任一环节异常都必须保证状态正确', () => {
  it('异常：startViewTransition 同步抛错 → 降级并仍打开全屏', () => {
    installStarter(() => {
      throw new Error('VT boom')
    })
    expect(() => useUIStore.getState().openFullscreen(0, [makeFile('a.jpg')])).not.toThrow()
    expect(useUIStore.getState().fullscreenOpen).toBe(true)
  })

  it('异常：flushSync 抛错 → 回落普通提交，全屏仍打开', () => {
    control.throwOnFlushSync = true
    expect(() => useUIStore.getState().openFullscreen(0, [makeFile('a.jpg')])).not.toThrow()
    expect(useUIStore.getState().fullscreenOpen).toBe(true)
    expect(useUIStore.getState().fullscreenIndex).toBe(0)
  })
})

describe('参数校验：openFullscreen(index, files)', () => {
  it('边界：index 非法（NaN / -1 / Infinity）→ 不打开', () => {
    act(() => {
      useUIStore.getState().openFullscreen(NaN)
      useUIStore.getState().openFullscreen(-1)
      useUIStore.getState().openFullscreen(Infinity)
    })
    expect(useUIStore.getState().fullscreenOpen).toBe(false)
  })

  it('边界：files 为字符串（非数组）→ 当作未提供，按图库语义处理', () => {
    act(() => {
      useUIStore.getState().openFullscreen(0, 'not-an-array' as unknown as MediaFile[])
    })
    expect(useUIStore.getState().fullscreenOpen).toBe(true)
    expect(useUIStore.getState().fullscreenFiles).toBeNull()
  })

  it('边界：files 为空数组 → 拒绝打开（避免「点了没反应」的非法态）', () => {
    act(() => {
      useUIStore.getState().openFullscreen(0, [])
    })
    expect(useUIStore.getState().fullscreenOpen).toBe(false)
  })

  it('边界：index 越界（>= files.length）→ 拒绝打开', () => {
    act(() => {
      useUIStore.getState().openFullscreen(2, [makeFile('a.jpg'), makeFile('b.jpg')])
    })
    expect(useUIStore.getState().fullscreenOpen).toBe(false)
  })

  it('边界：files 为 null → 按图库语义（fullscreenFiles 为 null）', () => {
    act(() => {
      useUIStore.getState().openFullscreen(0, null as unknown as MediaFile[])
    })
    expect(useUIStore.getState().fullscreenFiles).toBeNull()
  })
})
