/**
 * @vitest-environment jsdom
 * @module src/renderer/components/gallery/GalleryStackOverflow
 * @remarks 针对「图库」板块概率性 "Maximum call stack size exceeded" 的基础测试：
 *  - ① 大列表挂载：VirtualImageGrid 处理 ≥3000 条 items 不抛栈溢出，且首屏卡片成功渲染；
 *     items 非数组时降级为空不抛错（参数校验）。
 *  - ② 区域级 ErrorBoundary 捕获该递归错误（错误信息可见），并按 resetKeys 变化自动恢复。
 *
 * 说明：react-virtuoso 的 VirtuosoGrid 在 jsdom 下无法执行真实布局/测量，且该递归属第三方库行为
 * （GitHub issue #946，4.x 未根治），故测试①对 react-virtuoso 做轻量透传 mock，仅校验本组件逻辑；
 * 真实的递归崩溃是否会被「局部降级而非整页崩溃」由测试②的边界捕获验证。
 *
 * React 19.2 注意事项：并发渲染出错时 React 会中止整轮渲染、改为同步重渲染整根恢复
 * （组件函数因此会被再次执行，"只抛一次"的闭包计数器写法会失效），被中止轮次还会经全局
 * reportError 上报可恢复错误（jsdom 派发 window error 事件，被 vitest 记为未处理错误）。
 * 故测试②的 Thrower 用 props 驱动抛错，beforeAll 中 stub 掉全局 reportError 仅静默该上报。
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { MediaFile } from '../../stores/mediaStore'
import { VirtualImageGrid } from './VirtualImageGrid'
import { ErrorBoundary } from '../common/ErrorBoundary'
import { ZoneErrorFallback } from '../common/ErrorFallback'

// —— react-virtuoso 轻量透传 mock：直接调用 itemContent，避免 jsdom 布局限制 ——
const { VirtuosoGridMock } = vi.hoisted(() => {
  const React = require('react')
  const VirtuosoGrid = (props: {
    data?: MediaFile[]
    itemContent?: (index: number, item: MediaFile) => React.ReactNode
    computeItemKey?: (index: number, item: MediaFile) => string | number
  }) => {
    const { data = [], itemContent, computeItemKey } = props
    return React.createElement(
      'div',
      { role: 'grid' },
      data
        .slice(0, 60)
        .map((item, i) =>
          React.createElement(
            'div',
            { key: computeItemKey ? computeItemKey(i, item) : i },
            itemContent ? itemContent(i, item) : null
          )
        )
    )
  }
  return { VirtuosoGridMock: VirtuosoGrid }
})
vi.mock('react-virtuoso', () => ({ VirtuosoGrid: VirtuosoGridMock }))

// jsdom 缺失的浏览器 API，VirtualImageGrid 的 effect 依赖
beforeAll(() => {
  // React 19.2 并发渲染出错并同步恢复时，默认 onRecoverableError 会调用全局 reportError，
  // jsdom 下派发 window error 事件被 vitest 记为未处理错误；此处仅静默该上报，
  // 错误边界本身的捕获行为不受影响。
  vi.stubGlobal('reportError', vi.fn())
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  if (!window.matchMedia) {
    // @ts-expect-error 测试环境补 matchMedia
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {}
    }))
  }
})

const makeItems = (n: number): MediaFile[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `f${i}`,
    file_type: i % 3 === 0 ? 'video' : 'image',
    thumbnail: `/t/${i}.jpg`,
    file_path: `/p/${i}.jpg`,
    file_name: `file${i}.jpg`,
    file_size: 1024 * (i + 1),
    is_favorite: false,
    is_missing: false,
    is_corrupted: false,
    duration: i % 3 === 0 ? 30 : undefined
  })) as unknown as MediaFile[]

const baseProps = {
  selectedIds: [] as string[],
  onSelect: () => {},
  onHover: () => {},
  onContextMenu: () => {}
}

describe('GalleryStackOverflow — 大列表挂载（防递归 + 参数校验）', () => {
  it('挂载 3000 条 items 不抛 Maximum call stack size exceeded 且渲染首屏卡片', () => {
    const items = makeItems(3000)
    let renderError: unknown = null
    let cardCount = 0
    let hasGrid = false
    try {
      const { container } = render(<VirtualImageGrid items={items} {...baseProps} />)
      hasGrid = container.querySelector('[role="grid"]') !== null
      cardCount = container.querySelectorAll('.media-card').length
    } catch (e) {
      renderError = e
    }
    // 明确不抛栈溢出
    expect(String((renderError as Error)?.message ?? '')).not.toMatch(
      /Maximum call stack size exceeded/
    )
    expect(renderError).toBeNull()
    expect(hasGrid).toBe(true)
    expect(cardCount).toBeGreaterThan(0)
  })

  it('items 非数组（null）时降级为空不抛错（参数校验兜底）', () => {
    expect(() =>
      render(<VirtualImageGrid items={null as unknown as MediaFile[]} {...baseProps} />)
    ).not.toThrow()
  })
})

describe('GalleryStackOverflow — 区域级 ErrorBoundary 捕获递归并自动恢复', () => {
  it('捕获 Maximum call stack size exceeded 且 resetKeys 变化后恢复', () => {
    // props 驱动抛错：React 19.2 错误恢复会再次执行组件函数，闭包"只抛一次"计数器会失效；
    // shouldThrow 保持 true 时每一轮渲染都抛错，边界在同步恢复轮确定性地捕获。
    const Thrower = ({ shouldThrow }: { shouldThrow: boolean }) => {
      if (shouldThrow) {
        throw new RangeError('Maximum call stack size exceeded')
      }
      return <div data-testid="recovered">recovered</div>
    }

    const { rerender } = render(
      <ErrorBoundary resetKeys={[0]} fallback={ZoneErrorFallback}>
        <Thrower shouldThrow />
      </ErrorBoundary>
    )

    // ① 捕获：错误信息在区域级 fallback 中可见
    expect(screen.getByText(/Maximum call stack size exceeded/)).toBeTruthy()

    // ② resetKeys 未变化时不应自动恢复：即使子组件自身已"自愈"，错误态仍保持
    rerender(
      <ErrorBoundary resetKeys={[0]} fallback={ZoneErrorFallback}>
        <Thrower shouldThrow={false} />
      </ErrorBoundary>
    )
    expect(screen.queryByTestId('recovered')).toBeNull()

    // ③ resetKeys 变化 → 自动重置，子组件重新挂载并成功渲染
    rerender(
      <ErrorBoundary resetKeys={[1]} fallback={ZoneErrorFallback}>
        <Thrower shouldThrow={false} />
      </ErrorBoundary>
    )
    expect(screen.getByTestId('recovered')).toBeTruthy()
  })
})
