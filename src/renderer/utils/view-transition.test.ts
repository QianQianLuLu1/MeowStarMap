// @vitest-environment jsdom
/**
 * @layer L3
 * @module src/renderer/utils/view-transition
 * @coverage 全屏共享元素过渡的能力判定与 view-transition-name 生命周期管理
 * @dependencies jsdom + 新增的 src/renderer/utils/view-transition.ts
 * @remarks
 *   根因回归：RC3 —— openFullscreen/closeFullscreen 原先用
 *   document.querySelectorAll('[style*="view-transition-name"]') 做全文档扫描来清理
 *   标记，在新快照拍摄前遍历整棵 DOM 并逐个写内联样式，造成可在动画起点观测到的卡顿。
 *   本套用例分别锁定：
 *     - 能力判定的三条边界（不支持 / 存在但非法 / 动效减弱）
 *     - 标记的登记与 O(1) 清理（不触碰 querySelectorAll）
 *     - 空值、重复登记、元素已被移除等非法/边界输入的静默处理
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  FULLSCREEN_VT_NAME,
  canUseViewTransition,
  markFullscreenSource,
  clearFullscreenSource
} from './view-transition'

// 用 unknown 覆盖 DOM lib 自带的 startViewTransition 签名，便于注入任意桩（含缺失/非函数）
const doc = document as unknown as { startViewTransition?: unknown }
const originalStarter = doc.startViewTransition

/** 造一个新的挂载元素，模拟图库卡片里的缩略图 img */
function createSourceImg(): HTMLElement {
  const img = document.createElement('img')
  img.setAttribute('data-media-id', 'test-media')
  document.body.appendChild(img)
  return img
}

function installStarter(value: unknown): void {
  if (value === undefined) {
    delete doc.startViewTransition
  } else {
    doc.startViewTransition = value
  }
}

beforeEach(() => {
  clearFullscreenSource()
  installStarter(undefined)
  document.documentElement.classList.remove('reduce-motion')
})

afterEach(() => {
  clearFullscreenSource()
  installStarter(originalStarter)
  document.documentElement.classList.remove('reduce-motion')
  document.body.innerHTML = ''
})

describe('view-transition：能力判定 canUseViewTransition', () => {
  it('正常：存在 startViewTransition 且未开启动效减弱 → true', () => {
    installStarter(() => ({ finished: Promise.resolve() }))
    expect(canUseViewTransition()).toBe(true)
  })

  it('异常：浏览器不支持（无 startViewTransition）→ false', () => {
    installStarter(undefined)
    expect(canUseViewTransition()).toBe(false)
  })

  it('异常：startViewTransition 存在但不是函数 → false', () => {
    installStarter({})
    expect(canUseViewTransition()).toBe(false)
  })

  it('异常：开启动效减弱（html.reduce-motion）→ false', () => {
    installStarter(() => ({ finished: Promise.resolve() }))
    document.documentElement.classList.add('reduce-motion')
    expect(canUseViewTransition()).toBe(false)
  })

  it('边界：doc 缺省回落全局 document（true），传 null 返回 false 且不抛错', () => {
    installStarter(() => ({ finished: Promise.resolve() }))
    expect(() => canUseViewTransition(undefined)).not.toThrow()
    expect(canUseViewTransition(undefined)).toBe(true)
    expect(canUseViewTransition(null)).toBe(false)
  })
})

describe('view-transition：共享元素标记生命周期', () => {
  it('契约：共享元素名固定为 fullscreen-media', () => {
    expect(FULLSCREEN_VT_NAME).toBe('fullscreen-media')
  })

  it('正常：markFullscreenSource 后元素持有 view-transition-name', () => {
    const img = createSourceImg()
    markFullscreenSource(img)
    expect(img.style.viewTransitionName).toBe(FULLSCREEN_VT_NAME)
  })

  it('正常：clearFullscreenSource 后元素不再持有 view-transition-name', () => {
    const img = createSourceImg()
    markFullscreenSource(img)
    clearFullscreenSource()
    expect(img.style.viewTransitionName).toBe('')
  })

  it('核心：清理走已登记引用，不执行全文档 querySelectorAll 扫描（RC3 回归）', () => {
    const img = createSourceImg()
    markFullscreenSource(img)
    const spy = vi.spyOn(document, 'querySelectorAll')

    clearFullscreenSource()

    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('边界：重复登记时旧引用被自动顶替，同一时刻最多一个标记元素', () => {
    const first = createSourceImg()
    const second = createSourceImg()
    markFullscreenSource(first)
    markFullscreenSource(second)

    expect(second.style.viewTransitionName).toBe(FULLSCREEN_VT_NAME)
    expect(first.style.viewTransitionName).toBe('')
  })

  it('边界：入参为 null / undefined → 空操作且不抛错', () => {
    expect(() => markFullscreenSource(null)).not.toThrow()
    expect(() => markFullscreenSource(undefined)).not.toThrow()
    expect(() => clearFullscreenSource()).not.toThrow()
  })

  it('边界：元素已从 DOM 移除后清理 → 不抛错', () => {
    const img = createSourceImg()
    markFullscreenSource(img)
    img.remove()
    expect(() => clearFullscreenSource()).not.toThrow()
  })

  it('边界：DOM 写入抛错（只读 style）被内部吞掉，不外泄', () => {
    const img = createSourceImg()
    Object.defineProperty(img, 'style', {
      get() {
        throw new Error('style boom')
      },
      configurable: true
    })
    expect(() => markFullscreenSource(img)).not.toThrow()
    expect(() => clearFullscreenSource()).not.toThrow()
  })
})

describe('view-transition：系统动效偏好 prefers-reduced-motion（G1）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('异常（核心）：系统开启 prefers-reduced-motion → 不使用 View Transitions', () => {
    // 背景：::view-transition-* 伪元素不受 globals.css 的
    // @media (prefers-reduced-motion: reduce) 规则约束（选择器不匹配伪元素），
    // 系统级「显示动画关闭」必须在 JS 侧判定后直接不启动过渡
    installStarter(() => ({ finished: Promise.resolve() }))
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    expect(canUseViewTransition()).toBe(false)
  })

  it('正常：系统未开启 prefers-reduced-motion → 不误伤正常用户', () => {
    installStarter(() => ({ finished: Promise.resolve() }))
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }))
    expect(canUseViewTransition()).toBe(true)
  })

  it('边界：matchMedia 不存在（SSR / node 环境）→ 回落其余判定且不抛错', () => {
    installStarter(() => ({ finished: Promise.resolve() }))
    vi.stubGlobal('matchMedia', undefined)
    expect(() => canUseViewTransition()).not.toThrow()
    expect(canUseViewTransition()).toBe(true)
  })

  it('边界：matchMedia 调用抛错 → 不外泄且不误伤', () => {
    installStarter(() => ({ finished: Promise.resolve() }))
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => {
        throw new Error('matchMedia boom')
      })
    )
    expect(() => canUseViewTransition()).not.toThrow()
    expect(canUseViewTransition()).toBe(true)
  })

  it('边界：doc 传 null 且系统动效减弱 → false 且不抛错', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    expect(() => canUseViewTransition(null)).not.toThrow()
    expect(canUseViewTransition(null)).toBe(false)
  })
})
