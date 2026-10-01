/**
 * Vitest 全局 setup
 *
 * 为 jsdom 环境补齐浏览器原生 API：
 * - matchMedia（Tailwind / 组件库常调用）
 * - IntersectionObserver（虚拟列表 / 懒加载依赖）
 * - ResizeObserver（useContainerSize 等 hook 依赖）
 * - URL.createObjectURL（图片预览依赖）
 *
 * 同时注入 window.electronAPI 占位对象，组件内 `window.electronAPI?.xxx` 不会抛错；
 * 各测试用例可通过 vi.spyOn 或重新赋值覆盖具体方法。
 *
 * i18n：导入渲染层 i18n 配置以同步初始化 zh-CN 资源，
 * 使 useTranslation() 在测试中返回翻译值而非 key，
 * 保证测试断言可与用户可见文案对齐。
 */
import '@testing-library/jest-dom/vitest'
import { vi, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '../src/renderer/i18n'

// jsdom 环境补齐
if (typeof window !== 'undefined') {
  // zustand persist 中间件依赖 localStorage；vitest 1.6 + jsdom 默认未注入
  if (!window.localStorage) {
    const memStore = new Map<string, string>()
    const localStorageStub = {
      getItem: (key: string) => memStore.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memStore.set(key, String(value))
      },
      removeItem: (key: string) => {
        memStore.delete(key)
      },
      clear: () => {
        memStore.clear()
      },
      key: (index: number) => Array.from(memStore.keys())[index] ?? null,
      get length() {
        return memStore.size
      }
    }
    Object.defineProperty(window, 'localStorage', {
      value: localStorageStub,
      writable: true,
      configurable: true
    })
    Object.defineProperty(global, 'localStorage', {
      value: localStorageStub,
      writable: true,
      configurable: true
    })
  }

  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  }

  if (!('IntersectionObserver' in window)) {
    class MockIntersectionObserver {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
      takeRecords = vi.fn(() => [])
      root = null
      rootMargin = ''
      thresholds = []
      constructor(_cb: IntersectionObserverCallback) {}
    }
    ;(window as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
      MockIntersectionObserver
    ;(global as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
      MockIntersectionObserver
  }

  if (!('ResizeObserver' in window)) {
    class MockResizeObserver {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
      constructor(_cb: ResizeObserverCallback) {}
    }
    ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver
    ;(global as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver
  }

  if (!window.URL.createObjectURL) {
    Object.defineProperty(window.URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:mock'),
      writable: true
    })
    Object.defineProperty(window.URL, 'revokeObjectURL', {
      value: vi.fn(),
      writable: true
    })
  }

  // clipboard 兜底（jsdom 默认无 clipboard）
  if (!navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn(() => Promise.resolve()),
        readText: vi.fn(() => Promise.resolve(''))
      },
      writable: true,
      configurable: true
    })
  }
}

// motion/react mock：jsdom 环境下将 motion.div / motion.button 等代理为对应原生元素，
// 并剥离 whileHover / whileTap / layout / drag 等 motion 专属 props，
// 避免 React 19 将未知属性透传到 DOM 触发控制台警告。
// style / className / onClick / role / aria-* 等常规 DOM props 正常透传。
// 参考：https://github.com/cpa03/blueprintify/pull/510
vi.mock('motion/react', async () => {
  const React = await import('react')

  // motion 专属 props：不透传给原生 DOM，避免 React 19 未知属性警告
  const MOTION_PROPS = new Set([
    'whileHover',
    'whileTap',
    'whileFocus',
    'whileDrag',
    'whileInView',
    'layout',
    'layoutId',
    'layoutScroll',
    'drag',
    'dragControls',
    'dragConstraints',
    'dragElastic',
    'dragMomentum',
    'dragSnapToOrigin',
    'dragTransition',
    'dragDirectionLock',
    'onDrag',
    'onDragStart',
    'onDragEnd',
    'onDirectionLock',
    'onAnimationComplete',
    'onUpdate',
    'onHoverStart',
    'onHoverEnd',
    'onTap',
    'onTapStart',
    'onTapCancel',
    'onPan',
    'onPanStart',
    'onPanEnd',
    'animate',
    'transition',
    'variants',
    'initial',
    'exit',
    'custom',
    'inherit',
    'static'
  ])

  // motion.div / motion.button / motion.span / motion.aside 等代理为对应原生元素
  const motionProxy = new Proxy({} as Record<string, unknown>, {
    get: (_target, tag: string) => {
      if (typeof tag !== 'string') return undefined
      return React.forwardRef((props: Record<string, unknown>, ref: unknown) => {
        // 剥离 motion 专属 props，剩余 props（含 style/className/onClick/role/aria-*）透传给原生 DOM
        const rest: Record<string, unknown> = {}
        let children: unknown
        for (const key in props) {
          if (key === 'children') {
            children = props[key]
          } else if (!MOTION_PROPS.has(key)) {
            rest[key] = props[key]
          }
        }
        // React[tag] 对原生 HTML 标签为 undefined，回退到字符串标签名
        const Component = (React as unknown as Record<string, unknown>)[tag] || tag
        return React.createElement(Component, { ...rest, ref }, children as React.ReactNode)
      })
    }
  })

  return {
    motion: motionProxy,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      (children ?? null) as React.ReactNode,
    LayoutGroup: ({ children }: { children?: React.ReactNode }) =>
      (children ?? null) as React.ReactNode,
    MotionConfig: ({ children }: { children?: React.ReactNode }) =>
      (children ?? null) as React.ReactNode,
    // 视觉体系 v3：SegmentedControl 等组件消费 reduced-motion 感知；测试环境默认无减弱
    useReducedMotion: () => false
  }
})

// window.electronAPI 占位（组件内可选链调用，未注入时也不会抛错）
if (typeof global !== 'undefined') {
  const placeholder = new Proxy(
    {},
    {
      get: () => vi.fn(() => Promise.resolve(undefined))
    }
  )
  ;(global as unknown as { electronAPI?: unknown }).electronAPI = placeholder
  // node 环境无 window，仅在 jsdom 环境注入
  if (typeof window !== 'undefined') {
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = placeholder
  }
}

// 每个 it 后清理 DOM，避免状态泄漏（仅 jsdom 环境有效）
afterEach(() => {
  if (typeof document !== 'undefined') {
    cleanup()
    document.body.innerHTML = ''
  }
})
