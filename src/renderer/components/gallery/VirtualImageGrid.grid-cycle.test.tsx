/**
 * @vitest-environment jsdom
 * @module src/renderer/components/gallery/VirtualImageGrid
 * @remarks 针对图库主页 `Maximum call stack size exceeded` 的回归测试。
 *
 * 背景（取证过程见 docs/plans/2026-09-29-fix-gallery-stack-overflow.md）：
 * 渲染进程故障日志中的堆栈（274747-long/2026-09-29 v2.5.1）全部落在
 * react-virtuoso 代码块的响应式内核上：
 *   U() 发布 → at()(combineLatest) 输入处理器 → M() 再发布 → gridDimensions(2904)
 * 即第三方网格响应式图内部的「发布 → 订阅 → 再发布」同歩回路。
 * 该回路由「测量值重新发布」驱动，本项目侧有两个放大器：
 *  ① components 引用随 columns 变化而变更 → React 重建 List 子树 → 测量重发布；
 *  ② 同一网格同时传入 overscan 与 increaseViewportBy 两个视口放大旋钮。
 *
 * 本文件用「记录型 VirtuosoGrid 探针」在 jsdom 下对这两个放大器做确定性断言，
 * 修复前必须红灯；同时保留正常/异常/边界三类场景，防止修复引入回归。
 *
 * 2026-10-01 审查修复 T1（docs/plans/2026-10-01-fix-thumbnail-review-fixes.md）：
 * 错误链终点闭环行为测试复用本文件的真渲染探针（见文末 describe）。
 */
import React from 'react'
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, act, fireEvent, waitFor } from '@testing-library/react'
import type { MediaFile } from '../../stores/mediaStore'
import { VirtualImageGrid } from './VirtualImageGrid'

// —— 记录型 react-virtuoso 探针：透传渲染，并把每次渲染收到的 props 收集起来 ——
const virtuosoRecords = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }))

const { VirtuosoGridMock } = vi.hoisted(() => {
  const ReactLib = require('react') as typeof React
  const VirtuosoGrid = (props: Record<string, unknown>) => {
    virtuosoRecords.list.push(props)
    const data = (props.data as MediaFile[] | undefined) ?? []
    const itemContent = props.itemContent as
      ((index: number, item: MediaFile) => React.ReactNode) | undefined
    const computeItemKey = props.computeItemKey as
      ((index: number, item: MediaFile) => string | number) | undefined
    return ReactLib.createElement(
      'div',
      { role: 'grid' },
      data
        .slice(0, 60)
        .map((item, i) =>
          ReactLib.createElement(
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

// jsdom 下 clientWidth 恒为 0，此处用原型 getter 注入可控宽度以驱动响应式列数 effect
let fakeClientWidth = 1200

beforeAll(() => {
  vi.stubGlobal('reportError', vi.fn())
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return fakeClientWidth
    }
  })
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

beforeEach(() => {
  virtuosoRecords.list = []
  fakeClientWidth = 1200
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

describe('VirtualImageGrid — 网格测量回路回归（Maximum call stack size exceeded）', () => {
  it('① components 引用在 columns 变化时必须保持稳定（不得重建 List 子树）', () => {
    render(<VirtualImageGrid items={makeItems(3000)} {...baseProps} />)

    expect(virtuosoRecords.list.length).toBeGreaterThan(0)
    const before = virtuosoRecords.list[virtuosoRecords.list.length - 1].components as
      Record<string, unknown> | undefined
    expect(before?.List).toBeTypeOf('function')

    // 宽度从 1200 → 700（列数 5 → 3），触发 ResizeObserver / resize 驱动的 setColumns
    fakeClientWidth = 700
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })

    const after = virtuosoRecords.list[virtuosoRecords.list.length - 1].components as
      Record<string, unknown> | undefined
    // 引用必须前后一致：不一致会让 react-virtuoso 卸载重建整个 List 子树，
    // 触发 itemDimensions/gap/viewport 测量重新发布，把网格推入测量回路。
    expect(after?.List).toBe(before?.List)

    // 引用稳定的同时，列数仍须跟随宽度更新（证明 ref 化没有让布局失效）：
    // 700px → DEFAULT_COLUMNS_BREAKPOINTS 命中 480 档 → 3 列
    const List = (after as { List: React.ComponentType }).List as unknown as React.FC
    const { container } = render(<List />)
    const template =
      (container.firstElementChild as HTMLElement | null)?.style?.gridTemplateColumns ?? ''
    expect(template).toContain('repeat(3,')
  })

  it('② 不得同时向同一 VirtuosoGrid 传入 overscan 与 increaseViewportBy', () => {
    render(<VirtualImageGrid items={makeItems(3000)} {...baseProps} />)
    const props = virtuosoRecords.list[virtuosoRecords.list.length - 1]
    const hasOverscan = props.overscan !== undefined
    const hasIncreaseViewportBy = props.increaseViewportBy !== undefined
    // 两个视口放大旋钮叠加会让网格维度计算的可见区间远超实际需求，放大环路不收敛窗口
    expect(hasOverscan && hasIncreaseViewportBy).toBe(false)
  })
})

describe('VirtualImageGrid — 正常 / 异常 / 边界', () => {
  it('③ 正常：3000 条数据挂载成功且首屏卡片可见，不抛 RangeError', () => {
    let renderError: unknown = null
    let cardCount = 0
    let hasGrid = false
    try {
      const { container } = render(<VirtualImageGrid items={makeItems(3000)} {...baseProps} />)
      hasGrid = container.querySelector('[role="grid"]') !== null
      cardCount = container.querySelectorAll('.media-card').length
    } catch (e) {
      renderError = e
    }
    expect(String((renderError as Error)?.message ?? '')).not.toMatch(
      /Maximum call stack size exceeded/
    )
    expect(renderError).toBeNull()
    expect(hasGrid).toBe(true)
    expect(cardCount).toBeGreaterThan(0)
  })

  it('④ 异常：items 非数组（null）时降级为空且不抛错', () => {
    expect(() =>
      render(<VirtualImageGrid items={null as unknown as MediaFile[]} {...baseProps} />)
    ).not.toThrow()
  })

  it('⑤ 边界：宽度退化为 0 时自定义 List 的列数仍为有限正整数', () => {
    fakeClientWidth = 0
    render(<VirtualImageGrid items={makeItems(10)} {...baseProps} />)
    const components = virtuosoRecords.list[virtuosoRecords.list.length - 1].components as {
      List: React.ComponentType
    }
    const List = components.List as unknown as React.FC
    const { container } = render(<List />)
    const grid = container.firstElementChild as HTMLElement | null
    const template = grid?.style?.gridTemplateColumns ?? ''
    const matched = template.match(/repeat\((\d+)/)
    expect(matched).not.toBeNull()
    expect(Number(matched?.[1])).toBeGreaterThanOrEqual(1)
  })

  it('⑥ 首个可视范围立即生成，后续范围变化保持 300ms 防抖', () => {
    vi.useFakeTimers()
    const generate = vi.fn(() => new Promise<string | null>(() => {}))
    const originalElectronApi = window.electronAPI
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { thumbnail: { generate } }
    })

    try {
      const items = makeItems(3).map((item, index) => ({
        ...item,
        file_path: `/p/initial-${Date.now()}-${index}.jpg`,
        thumbnail: undefined
      })) as MediaFile[]
      render(<VirtualImageGrid items={items} {...baseProps} />)
      const rangeChanged = virtuosoRecords.list[virtuosoRecords.list.length - 1]
        .rangeChanged as (range: { startIndex: number; endIndex: number }) => void

      act(() => rangeChanged({ startIndex: 0, endIndex: 1 }))
      expect(generate).toHaveBeenCalledTimes(2)

      act(() => rangeChanged({ startIndex: 1, endIndex: 2 }))
      expect(generate).toHaveBeenCalledTimes(2)
      act(() => vi.advanceTimersByTime(299))
      expect(generate).toHaveBeenCalledTimes(2)
      act(() => vi.advanceTimersByTime(1))
      expect(generate).toHaveBeenCalledTimes(3)
    } finally {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: originalElectronApi
      })
      vi.useRealTimers()
    }
  })
})

// —— round2 N5：切板块（items 整体替换、可视区间编号不变）必须重新调度按需生成 ——
//
// 缺陷现象（用户报「切板块要重新等一遍」的机制，本机打包态实测）：
// 图库 → 启动器缓存 切换时网格组件不卸载，两板块的可视区间编号相同（0..N），
// react-virtuoso 因此不再触发 rangeChanged；而 `generateVisibleRange` 在本组件里
// **唯一的调用点就是 rangeChanged** ⇒ 新板块的 NULL 缩略图卡片一次 IPC 都不发，
// showSkeleton 条件（!showThumb && !hasError && !generateFailed && !!file_path）恒成立，
// 骨架永久停留。
//
// 实测佐证：`.cache/perf-real` 副本整轮 R3（缓存/分类/回收站 各等 10s）期间缓存目录
// 新增文件 0 个，而 R3b 手工直调 generate 4 次立刻产出 4 个缓存文件——生成能力正常，
// 缺的是触发。
describe('VirtualImageGrid — 切板块后重新调度按需生成（round2 N5）', () => {
  const makeNullThumbItems = (n: number, tag: string): MediaFile[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `${tag}-${i}`,
      file_type: 'image',
      thumbnail: null,
      file_path: `/switch/${tag}/${i}.jpg`,
      file_name: `${i}.jpg`,
      file_size: 2048,
      is_favorite: false,
      is_missing: false,
      is_corrupted: false
    })) as unknown as MediaFile[]

  /** 统一装好 fake timers + generate 桩，并在结束后还原（桩返回永不 settle 的 Promise，只数调用） */
  const withGenerateStub = (run: (generate: ReturnType<typeof vi.fn>) => void): void => {
    vi.useFakeTimers()
    const generate = vi.fn(() => new Promise<string | null>(() => {}))
    const original = window.electronAPI
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { thumbnail: { generate } }
    })
    try {
      run(generate)
    } finally {
      Object.defineProperty(window, 'electronAPI', { configurable: true, value: original })
      vi.useRealTimers()
    }
  }

  const latestRangeChanged = () =>
    virtuosoRecords.list[virtuosoRecords.list.length - 1].rangeChanged as (range: {
      startIndex: number
      endIndex: number
    }) => void

  it('① 正常：可视区间已定为 0..5，items 由空数组换成 6 条 NULL 缩略图 → 必须发满 6 次生成', () => {
    withGenerateStub((generate) => {
      const { rerender } = render(<VirtualImageGrid items={[]} {...baseProps} />)
      act(() => latestRangeChanged()({ startIndex: 0, endIndex: 5 }))
      // 空数据不得发请求（避免把「还没加载完」误当成「该生成」）
      expect(generate).not.toHaveBeenCalled()

      // 切板块：只换数据，不再触发 rangeChanged —— 这一步在修复前不发任何 IPC
      rerender(<VirtualImageGrid items={makeNullThumbItems(6, 'sec1')} {...baseProps} />)
      act(() => {
        vi.advanceTimersByTime(300)
      })
      expect(generate).toHaveBeenCalledTimes(6)
    })
  })

  it('② 边界：可视区间 0..5 而 items 有 10 条 → 只为可视区发 6 次，不越界扫描', () => {
    withGenerateStub((generate) => {
      const { rerender } = render(<VirtualImageGrid items={[]} {...baseProps} />)
      act(() => latestRangeChanged()({ startIndex: 0, endIndex: 5 }))
      rerender(<VirtualImageGrid items={makeNullThumbItems(10, 'sec2')} {...baseProps} />)
      act(() => {
        vi.advanceTimersByTime(300)
      })
      expect(generate).toHaveBeenCalledTimes(6)
    })
  })

  it('③ 异常：切走再切回同一路径 → 复用模块级请求去重，不得重复发 IPC', () => {
    withGenerateStub((generate) => {
      const items = makeNullThumbItems(3, 'sec3')
      const { rerender } = render(<VirtualImageGrid items={[]} {...baseProps} />)
      act(() => latestRangeChanged()({ startIndex: 0, endIndex: 2 }))
      rerender(<VirtualImageGrid items={items} {...baseProps} />)
      act(() => {
        vi.advanceTimersByTime(300)
      })
      expect(generate).toHaveBeenCalledTimes(3)

      // 再切回同一批数据（新数组引用、同 file_path）：请求去重必须挡住重复 IPC
      rerender(<VirtualImageGrid items={makeNullThumbItems(3, 'sec3')} {...baseProps} />)
      act(() => {
        vi.advanceTimersByTime(300)
      })
      expect(generate).toHaveBeenCalledTimes(3)
    })
  })
})

// —— 审查修复 T1：错误链终点闭环（docs/plans/2026-10-01-fix-thumbnail-review-fixes.md）——
// 缺陷：DB thumbnail 非空但 404 时 onError 就地重建；重建失败不改变 URL（不会再有
// 第二次 onError）→ markFailed 永不执行；重建成功但 &r=N 重载仍 404 的二次 onError
// 走 Map 命中分支无动作 → 两种场景卡片都永久卡在骨架态，占位警告图标永不出现。
describe('VirtualImageGrid — 错误链终点闭环（审查修复 T1）', () => {
  let generateMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    generateMock = vi.fn()
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      thumbnail: { generate: generateMock }
    }
  })

  const makeErrorChainItem = (id: string, filePath: string): MediaFile =>
    ({
      id,
      file_type: 'image',
      thumbnail: filePath.replace('/p/', '/t/'),
      file_path: filePath,
      file_name: 'photo.jpg',
      file_size: 1024,
      is_favorite: false,
      is_missing: false,
      is_corrupted: false
    }) as unknown as MediaFile

  // 失败终态断言：ThumbReveal（img + 骨架）卸载，MediaThumbPlaceholder 警告图标可见
  const expectTerminalPlaceholder = async (container: HTMLElement) => {
    await waitFor(() => {
      expect(container.querySelector('img')).toBeNull()
      expect(container.querySelector('.skeleton')).toBeNull()
      expect(container.querySelector('svg')).not.toBeNull()
    })
  }

  it('① 异常：standard 404 + 就地重建失败 → 终止为占位警告图标（不得永久卡骨架）', async () => {
    // 重建失败：generate 返回 null，URL 不变不会再触发第二次 onError
    generateMock.mockResolvedValue(null)
    const { container } = render(
      <VirtualImageGrid items={[makeErrorChainItem('f-err-a', '/p/a.jpg')]} {...baseProps} />
    )
    const img = container.querySelector('img') as HTMLImageElement
    expect(img).toBeTruthy()
    fireEvent.error(img)
    await expectTerminalPlaceholder(container)
  })

  it('② 异常：重建成功但重载仍 404（二次 onError）→ 终止为占位警告图标', async () => {
    // 重建"成功"返回同路径 → bump 重试代次强制重载，但重载仍 404
    generateMock.mockResolvedValue('/t/b.jpg')
    const { container } = render(
      <VirtualImageGrid items={[makeErrorChainItem('f-err-b', '/p/b.jpg')]} {...baseProps} />
    )
    fireEvent.error(container.querySelector('img') as HTMLImageElement)
    // 先确认重建链路生效：src 以 &r=1 强制重载（可观察）
    await waitFor(() => {
      const reloaded = container.querySelector('img') as HTMLImageElement | null
      expect(reloaded?.getAttribute('src')).toContain('&r=1')
    })
    // 重载仍 404：二次 onError 必须落占位，而非停留骨架
    fireEvent.error(container.querySelector('img') as HTMLImageElement)
    await expectTerminalPlaceholder(container)
  })
})
