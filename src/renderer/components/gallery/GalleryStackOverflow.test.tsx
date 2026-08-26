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
    let attempt = 0
    const Thrower = () => {
      attempt += 1
      if (attempt <= 1) {
        throw new RangeError('Maximum call stack size exceeded')
      }
      return <div data-testid="recovered">recovered</div>
    }

    const { rerender } = render(
      <ErrorBoundary resetKeys={[0]} fallback={ZoneErrorFallback}>
        <Thrower />
      </ErrorBoundary>
    )

    // ① 捕获：错误信息在区域级 fallback 中可见
    expect(screen.getByText(/Maximum call stack size exceeded/)).toBeTruthy()

    // ② resetKeys 变化 → 自动恢复，子组件重新挂载
    rerender(
      <ErrorBoundary resetKeys={[1]} fallback={ZoneErrorFallback}>
        <Thrower />
      </ErrorBoundary>
    )
    expect(screen.getByTestId('recovered')).toBeTruthy()
  })
})
