/**
 * @vitest-environment jsdom
 * @module src/renderer/components/layout/Sidebar
 * @coverage 侧边栏第 4 项（resonance-records）文案回归：
 *   nav.resonanceRecords 键曾整体缺失导致界面渲染原始 key 字符串，
 *   本测试在组件级锁定「第四项显示 共鸣录、不出现原始 key」。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Sidebar } from './Sidebar'

const { uiState, mediaState } = vi.hoisted(() => {
  const noop = () => {}
  return {
    uiState: {
      currentView: 'gallery',
      sidebarCollapsed: false,
      navigateTo: noop,
      toggleSidebar: noop,
      goBack: noop,
      viewStack: ['gallery'],
      groupDimension: 'none',
      setGroupDimension: noop
    },
    mediaState: {
      mediaFiles: [] as unknown[],
      categories: [],
      currentProfileUid: 'default',
      profiles: [],
      hasMoreMedia: false,
      // R-1：服务端真值计数（null = 未给出，组件回落数组长度）
      mediaTotalCount: null as number | null,
      mediaImageCount: null as number | null,
      mediaVideoCount: null as number | null,
      setMediaFiles: noop,
      setCurrentProfileUid: noop
    }
  }
})

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (s: typeof uiState) => unknown) => selector(uiState)
}))

vi.mock('../../stores/mediaStore', () => ({
  useMediaStore: (selector: (s: typeof mediaState) => unknown) => selector(mediaState),
  fetchMediaFromDatabase: vi.fn(async () => null),
  loadProfiles: vi.fn(async () => undefined)
}))

vi.mock('../../hooks/useFilteredMediaFiles', () => ({
  useFilteredMediaFiles: () => []
}))

// 流体滑块 Hook 依赖同模块的曲线常量，故透传真实实现，仅把 springSoft 降级为空对象
vi.mock('../../utils/motionPresets', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../utils/motionPresets')),
  springSoft: {}
}))

describe('Sidebar 第 4 项 nav.resonanceRecords', () => {
  it('第四个导航项显示「共鸣录」，且界面不出现原始 key 文本', () => {
    render(<Sidebar />)
    const navButtons = Array.from(document.querySelectorAll('button.nav-item'))
    // 10 个导航项：图库/截图/收藏/共鸣录/同步图库/缓存/分类/重复文件/回收站/设置
    expect(navButtons).toHaveLength(10)
    expect(navButtons[3].textContent).toBe('共鸣录')
    // 各项 title 与可见文本均取自 i18n，raw key 不得渲染
    expect(screen.getByTitle('共鸣录')).toBeTruthy()
    expect(screen.queryByText('nav.resonanceRecords')).toBeNull()
  })
})

describe('Sidebar 第 5 项 nav.syncGallery（阶段 5 同步图库独立入口）', () => {
  afterEach(() => {
    // 复位被本组用例替换掉的导航桩，避免污染同文件后续 describe
    uiState.navigateTo = () => {}
  })

  it('第五个导航项显示「同步图库」，且不出现原始 key 文本', () => {
    render(<Sidebar />)
    const navButtons = Array.from(document.querySelectorAll('button.nav-item'))
    expect(navButtons[4].textContent).toBe('同步图库')
    expect(screen.getByTitle('同步图库')).toBeTruthy()
    expect(screen.queryByText('nav.syncGallery')).toBeNull()
  })

  it('点击「同步图库」导航到 sync-gallery 视图', () => {
    const navigateTo = vi.fn()
    uiState.navigateTo = navigateTo
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('同步图库'))
    expect(navigateTo).toHaveBeenCalledWith('sync-gallery')
  })
})

describe('Sidebar 液态玻璃接入', () => {
  it('根元素携带 liquid-glass 类且保留 glass-panel', () => {
    render(<Sidebar />)
    const aside = document.querySelector('aside')
    expect(aside).not.toBeNull()
    expect(aside?.classList.contains('liquid-glass')).toBe(true)
    expect(aside?.classList.contains('liquid-glass--sidebar')).toBe(true)
    expect(aside?.classList.contains('glass-panel')).toBe(true)
  })

  it('角色档案下拉携带 data-glass-scroll-ignore（内部滚动不驱动边缘高光）', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByTitle('切换角色档案'))
    const menu = screen.getByRole('menu')
    expect(menu.hasAttribute('data-glass-scroll-ignore')).toBe(true)
  })
})

describe('Sidebar 图片/视频计数取库中真值（R-1 回归）', () => {
  // 回归（计划：docs/plans/2026-11-03-fix-media-recognized-count-500-limit-实施计划.md R-1）：
  // 这两个数字原先遍历「已加载分页数组」得出，首屏只有一页 ⇒ 恒等于 MEDIA_PAGE_SIZE（500），
  // 用户看到的是「识别数量被限制为最多 500」。真值口径来自主进程 typeCounts。
  const snapshot = { ...mediaState }

  afterEach(() => {
    Object.assign(mediaState, snapshot)
    mediaState.mediaFiles = []
    mediaState.hasMoreMedia = false
    mediaState.mediaTotalCount = null
    mediaState.mediaImageCount = null
    mediaState.mediaVideoCount = null
  })

  const makeFile = (id: number, fileType: 'image' | 'video') => ({
    id: String(id),
    file_type: fileType,
    file_name: `f${id}.bin`,
    file_size: 1024,
    tags: [] as string[],
    is_favorite: false,
    is_missing: false,
    is_corrupted: false,
    is_duplicate: false,
    is_deleted: false
  })

  /** 读「图片 / 视频」那一行右侧计数值的首个文本节点（其后再跟的是「过滤后」诊断提示） */
  const statValue = (label: string): string => {
    const row = screen.getByText(label).parentElement
    const spans = Array.from(row?.querySelectorAll(':scope > span') ?? [])
    return String(spans[spans.length - 1]?.firstChild?.textContent ?? '').trim()
  }

  it('列表未拉齐（hasMoreMedia=true）时用服务端分类型计数，而非已加载数组长度', () => {
    mediaState.mediaFiles = [makeFile(1, 'image'), makeFile(2, 'image'), makeFile(3, 'image')]
    mediaState.hasMoreMedia = true
    mediaState.mediaTotalCount = 1200
    mediaState.mediaImageCount = 900
    mediaState.mediaVideoCount = 300
    render(<Sidebar />)
    expect(statValue('图片')).toBe('900')
    expect(statValue('视频')).toBe('300')
  })

  it('列表已拉齐（hasMoreMedia=false）时用数组长度——服务端计数不是无脑优先', () => {
    mediaState.mediaFiles = [makeFile(1, 'image'), makeFile(2, 'image'), makeFile(3, 'video')]
    mediaState.hasMoreMedia = false
    // 刻意留下与服务端口径不同的陈旧值：若组件无脑取服务端计数，本用例即红
    mediaState.mediaTotalCount = 1200
    mediaState.mediaImageCount = 900
    mediaState.mediaVideoCount = 300
    render(<Sidebar />)
    expect(statValue('图片')).toBe('2')
    expect(statValue('视频')).toBe('1')
  })

  it('服务端计数缺失（null，如 nikkisync 数据源）时回落数组长度，不渲染 NaN', () => {
    mediaState.mediaFiles = [makeFile(1, 'image'), makeFile(2, 'video')]
    mediaState.hasMoreMedia = true
    mediaState.mediaTotalCount = null
    mediaState.mediaImageCount = null
    mediaState.mediaVideoCount = null
    render(<Sidebar />)
    expect(statValue('图片')).toBe('1')
    expect(statValue('视频')).toBe('1')
  })
})
