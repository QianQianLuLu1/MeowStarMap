// @vitest-environment jsdom
/**
 * @layer L3
 * @module src/renderer/stores/uiStore
 * @coverage persist partialize 配置：selectedSceneCategories 不持久化
 * @dependencies fs（源码结构检查）+ uiStore 行为验证
 * @remarks 任务 2（P0）验证：partialize 移除 selectedSceneCategories，避免重启后残留筛选导致页面空态。
 *
 * 测试策略：useUIStore.persist API 在 node 环境不可用（localStorage 未注入），
 *   且项目中无该 API 使用先例。参考 GalleryPage.test.tsx 和 right-click-wiring.test.ts
 *   的结构性检查模式，直接验证 partialize 源码配置契约，稳定可维护。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { useUIStore } from './uiStore'

const uiStoreSrc = fs.readFileSync(
  path.resolve(process.cwd(), 'src', 'renderer', 'stores', 'uiStore.ts'),
  'utf-8'
)

/** 提取 partialize 函数体（从 "partialize: (state) => ({" 到对应 "})" 闭合） */
function extractPartializeBody(src: string): string {
  const marker = 'partialize: (state) => ({'
  const startIdx = src.indexOf(marker)
  expect(startIdx, 'partialize 配置未找到').toBeGreaterThan(-1)
  const bodyStart = startIdx + marker.length
  const bodyEnd = src.indexOf('})', bodyStart)
  expect(bodyEnd, 'partialize 闭合未找到').toBeGreaterThan(bodyStart)
  return src.slice(startIdx, bodyEnd + 2)
}

/** 移除注释行，避免注释中的字段名被误判为持久化字段 */
function stripComments(body: string): string {
  return body
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

describe('uiStore partialize 配置（任务 2）', () => {
  it('partialize 配置应存在', () => {
    expect(uiStoreSrc).toContain('partialize:')
    expect(uiStoreSrc).toContain("name: 'wxnn-ui-store'")
  })

  it('selectedSceneCategories 不应被持久化（U-O4 修正）', () => {
    const partializeBody = extractPartializeBody(uiStoreSrc)
    const codeLines = stripComments(partializeBody)

    expect(
      codeLines,
      'partialize 不应含 selectedSceneCategories 作为持久化字段（仅允许在注释中出现）'
    ).not.toMatch(/selectedSceneCategories/)
    // 注释应存在，说明是有意移除
    expect(partializeBody).toContain('U-O4')
  })

  it('应持久化 viewMode / sortBy / sortOrder / filterType / sidebarCollapsed / slideshowConfig', () => {
    const partializeBody = extractPartializeBody(uiStoreSrc)

    expect(partializeBody).toMatch(/viewMode:\s*state\.viewMode/)
    expect(partializeBody).toMatch(/sortBy:\s*state\.sortBy/)
    expect(partializeBody).toMatch(/sortOrder:\s*state\.sortOrder/)
    expect(partializeBody).toMatch(/filterType:\s*state\.filterType/)
    expect(partializeBody).toMatch(/sidebarCollapsed:\s*state\.sidebarCollapsed/)
    expect(partializeBody).toMatch(/slideshowConfig:\s*state\.slideshowConfig/)
  })

  it('不应持久化临时交互状态', () => {
    const partializeBody = extractPartializeBody(uiStoreSrc)
    const codeLines = stripComments(partializeBody)

    const temporaryStates = [
      'filterRating',
      'showMissingOnly',
      'showCorruptedOnly',
      'groupDimension',
      'selectedGroupKey',
      'showDuplicates',
      'searchQuery',
      'currentView',
      'selectedSceneTimes',
      'filterOutfit',
      'filterDateRange'
    ]

    for (const state of temporaryStates) {
      expect(codeLines, `partialize 不应含 ${state}（临时交互状态不应持久化）`).not.toContain(state)
    }
  })
})

describe('uiStore 默认状态与行为', () => {
  it('selectedSceneCategories 默认值应为空数组', () => {
    const state = useUIStore.getState()
    expect(state.selectedSceneCategories).toEqual([])
  })

  it('setSelectedSceneCategories 应能更新场景分类', () => {
    useUIStore.getState().setSelectedSceneCategories(['screenshot', 'collage'])
    expect(useUIStore.getState().selectedSceneCategories).toEqual(['screenshot', 'collage'])
    // 重置
    useUIStore.getState().setSelectedSceneCategories([])
  })

  it("navigateTo('screenshots') 应将 currentView 切换为 'screenshots'", () => {
    useUIStore.getState().navigateTo('screenshots')
    expect(useUIStore.getState().currentView).toBe('screenshots')
    // 重置，避免影响其它用例
    useUIStore.getState().navigateTo('gallery')
  })
})

/**
 * 多选模式（图库 / 截图 / 收藏 三大板块）
 * @coverage multiSelectMode 默认关闭、可切换、跨板块清理、不持久化
 */
describe('uiStore 多选模式（multiSelectMode）', () => {
  afterEach(() => {
    useUIStore.setState({
      multiSelectMode: false,
      selectedMediaIds: [],
      currentView: 'gallery',
      viewStack: ['gallery']
    })
  })

  it('multiSelectMode 默认值应为 false', () => {
    expect(useUIStore.getState().multiSelectMode).toBe(false)
  })

  it('setMultiSelectMode 应能开启与关闭多选模式', () => {
    useUIStore.getState().setMultiSelectMode(true)
    expect(useUIStore.getState().multiSelectMode).toBe(true)
    useUIStore.getState().setMultiSelectMode(false)
    expect(useUIStore.getState().multiSelectMode).toBe(false)
  })

  it('在三大板块之间切换应清空选中并退出多选模式', () => {
    const store = useUIStore.getState()
    store.setMultiSelectMode(true)
    store.setSelectedMediaIds(['1', '2'])
    useUIStore.getState().navigateTo('screenshots')
    expect(useUIStore.getState().selectedMediaIds).toEqual([])
    expect(useUIStore.getState().multiSelectMode).toBe(false)

    // 收藏板块同样需要清理
    const s2 = useUIStore.getState()
    s2.setMultiSelectMode(true)
    s2.setSelectedMediaIds(['3'])
    useUIStore.getState().navigateTo('favorites')
    expect(useUIStore.getState().selectedMediaIds).toEqual([])
    expect(useUIStore.getState().multiSelectMode).toBe(false)
  })

  it('同一板块内重复 navigateTo 不触发清理（保留选中态）', () => {
    const store = useUIStore.getState()
    store.navigateTo('gallery')
    store.setMultiSelectMode(true)
    store.setSelectedMediaIds(['7'])
    useUIStore.getState().navigateTo('gallery')
    expect(useUIStore.getState().selectedMediaIds).toEqual(['7'])
    expect(useUIStore.getState().multiSelectMode).toBe(true)
  })

  it('multiSelectMode 不应被持久化，且初始状态声明为 false', () => {
    const partializeBody = stripComments(extractPartializeBody(uiStoreSrc))
    expect(
      partializeBody,
      'partialize 不应含 multiSelectMode（临时交互状态不应持久化）'
    ).not.toContain('multiSelectMode')
    expect(uiStoreSrc, 'uiStore 初始状态应声明 multiSelectMode: false').toMatch(
      /multiSelectMode:\s*false/
    )
  })
})

/**
 * 根因回归：openFullscreen 必须通过 document.startViewTransition 调用并保持 this 绑定。
 * 脱离 this 调用原生方法会抛 "TypeError: Illegal invocation"，导致 set(fullscreenOpen:true)
 * 永不执行、全屏查看器无法打开。jsdom 默认不存在 startViewTransition，此处用模拟原生
 * 行为的桩函数复现该错误（与真实 Chromium 一致：this !== document 即抛 Illegal invocation）。
 */
describe('openFullscreen 与 View Transitions 调用契约（图库全屏预览根因回归）', () => {
  const original = (document as unknown as { startViewTransition?: unknown }).startViewTransition

  afterEach(() => {
    if (original === undefined) {
      delete (document as unknown as { startViewTransition?: unknown }).startViewTransition
    } else {
      ;(document as unknown as { startViewTransition?: unknown }).startViewTransition = original
    }
    useUIStore.setState({ fullscreenOpen: false, fullscreenIndex: -1, fullscreenTargetImg: null })
  })

  it('startViewTransition 存在时，openFullscreen 必须以 document 为 this 调用，避免 Illegal invocation', () => {
    const spy = vi.fn(function (this: unknown, cb: () => void) {
      if (this !== document) throw new TypeError('Illegal invocation')
      cb()
      return { finished: Promise.resolve() }
    })
    ;(document as unknown as { startViewTransition?: unknown }).startViewTransition = spy

    // 不应抛错；且必须真正打开全屏（set 被执行）
    expect(() => useUIStore.getState().openFullscreen(3)).not.toThrow()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(useUIStore.getState().fullscreenOpen).toBe(true)
    expect(useUIStore.getState().fullscreenIndex).toBe(3)
  })
})

/**
 * 健壮性回归（T2）：openFullscreen/closeFullscreen 必须在 View Transitions 调用失败、
 * DOM 清理抛错、非法 index 等异常下仍保证全屏状态正确置位，杜绝"点击无反应/卡死"。
 */
describe('openFullscreen/closeFullscreen 健壮性（T2 兜底与参数校验）', () => {
  const docAny = document as unknown as { startViewTransition?: unknown }
  const originalVT = docAny.startViewTransition

  afterEach(() => {
    if (originalVT === undefined) delete docAny.startViewTransition
    else docAny.startViewTransition = originalVT
    useUIStore.setState({ fullscreenOpen: false, fullscreenIndex: -1, fullscreenTargetImg: null })
    vi.restoreAllMocks()
  })

  it('startViewTransition 同步抛错时应降级并仍打开全屏', () => {
    docAny.startViewTransition = () => {
      throw new Error('VT boom')
    }
    expect(() => useUIStore.getState().openFullscreen(2)).not.toThrow()
    expect(useUIStore.getState().fullscreenOpen).toBe(true)
    expect(useUIStore.getState().fullscreenIndex).toBe(2)
  })

  it('apply 内 DOM 清理抛错（querySelectorAll 抛错）时状态仍置位', () => {
    const spy = vi.fn(function (this: unknown, cb: () => void) {
      if (this !== document) throw new TypeError('Illegal invocation')
      cb()
      return { finished: Promise.resolve() }
    })
    docAny.startViewTransition = spy
    const origQSA = document.querySelectorAll
    document.querySelectorAll = () => {
      throw new Error('DOM boom')
    }
    expect(() => useUIStore.getState().openFullscreen(4)).not.toThrow()
    expect(useUIStore.getState().fullscreenOpen).toBe(true)
    expect(useUIStore.getState().fullscreenIndex).toBe(4)
    document.querySelectorAll = origQSA
  })

  it('非法 index（NaN / -1）应被安全忽略', () => {
    useUIStore.getState().openFullscreen(NaN)
    expect(useUIStore.getState().fullscreenOpen).toBe(false)
    useUIStore.getState().openFullscreen(-1)
    expect(useUIStore.getState().fullscreenOpen).toBe(false)
  })

  it('closeFullscreen：transition.finished 拒绝时不抛未处理异常且关闭状态置位', () => {
    docAny.startViewTransition = (cb: () => void) => {
      cb()
      return { finished: Promise.reject(new Error('interrupted')) }
    }
    useUIStore.setState({ fullscreenOpen: true })
    expect(() => useUIStore.getState().closeFullscreen()).not.toThrow()
    expect(useUIStore.getState().fullscreenOpen).toBe(false)
    return Promise.resolve()
  })
})
