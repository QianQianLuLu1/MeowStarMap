import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { flushSync } from 'react-dom'
// RC1/RC3：全屏共享元素过渡的能力判定与标记生命周期收敛为独立模块，消除散落三处的重复判定
import {
  canUseViewTransition,
  clearFullscreenSource,
  markFullscreenSource,
  releaseFullscreenSource,
  setActiveTransition
} from '../utils/view-transition'
// C-S2：从 shared 直接导入场景分类，不再经 mediaStore 中转，消除 uiStore ↔ mediaStore 循环依赖
import type {
  SceneCategory,
  SceneTime,
  SceneCategoryConfig,
  SceneTimeConfig
} from '../../shared/scene-category'
import { SCENE_CATEGORIES, SCENE_TIMES } from '../../shared/scene-category'
// P2-U6：GroupDimension 类型移至 shared/dimension.ts，此处导入并重新导出保持向后兼容
import type { GroupDimension } from '../../shared/dimension'
export type { GroupDimension }

/**
 * P3-1：View Transitions API 未包含在当前 TS DOM lib 类型定义中，
 * 以类型化包装暴露 startViewTransition（浏览器不支持时返回 undefined，调用方走降级路径）。
 */
interface ViewTransitionLike {
  finished: Promise<void>
}

function getViewTransitionStarter(): ((callback: () => void) => ViewTransitionLike) | undefined {
  // 能力判定（含 SSR、不支持、动效减弱）统一由 utils/view-transition 负责
  if (!canUseViewTransition()) return undefined
  const doc = document as Document & {
    startViewTransition: (cb: () => void) => ViewTransitionLike
  }
  // P3-1：必须通过 document.startViewTransition 调用，保持 this 绑定。
  // 若直接返回 doc.startViewTransition 引用再独立调用，会因丢失 this 抛出
  // "TypeError: Illegal invocation"，导致 openFullscreen 中断、全屏查看器无法打开。
  return (callback: () => void) => doc.startViewTransition(callback)
}

/**
 * RC1：把状态写入强制为「同步提交」。
 *
 * View Transitions 的回调被浏览器在捕获旧快照之后调用，此时已脱离 React 事件批处理上下文，
 * React 会按默认 lane 异步调度渲染；而浏览器在回调返回后的下一渲染机会即捕获新快照。
 * 二者赛跑会让新快照抓到尚未挂载 FullscreenViewer 的旧画面，并把 React render 摊进动画
 * 窗口导致掉帧。故此处用 flushSync 在回调返回前完成提交；flushSync 不可用（渲染期调用等
 * 场景）时回落普通提交，保证状态必然置位，不阻断全屏开关。
 */
function commitFullscreenState(patch: () => void): void {
  try {
    flushSync(patch)
  } catch {
    patch()
  }
}

export type ViewLevel =
  | 'gallery'
  | 'detail'
  | 'editor'
  | 'categories'
  | 'settings'
  | 'recycle-bin'
  | 'favorites'
  | 'duplicates'
  | 'launcher-cache'
  | 'resonance-records'
  | 'screenshots'
  | 'sync-gallery'
  // 同步服务二级子页：从设置页 `sync` 分组剥离而来，入口在同步图库工具栏。
  | 'sync-service'
export type ViewMode = 'grid' | 'list' | 'timeline' | 'masonry' | 'event-timeline'

/**
 * 支持多选的媒体板块集合：图库 / 截图 / 收藏（含启动器缓存）。
 * 三者复用同一个 GalleryPage 与同一份 selectedMediaIds，切换时必须清理选中态，
 * 否则会把 A 板块选中的 id 带到 B 板块（B 板块无这些 id，但批量操作栏会残留常驻）。
 *
 * 阶段 5 的 `sync-gallery` **刻意不加入**本集合：它有自己的 `syncGalleryStore` 列表与
 * 资产 id 命名空间（`asset_id`，与 `media_files.id` 不同源），选中态不与 GalleryPage
 * 共享，因此不需要——也不应该——在切换时清掉图库的选中集。
 */
const MULTI_SELECT_VIEWS = new Set<ViewLevel>([
  'gallery',
  'screenshots',
  'favorites',
  'launcher-cache'
])
export type FilterType = 'all' | 'image' | 'video'
export type SortBy = 'date' | 'name' | 'size' | 'resolution' | 'rating'

// P0-03：智能分组维度（详细注释保留在此供查阅，类型定义移至 shared/dimension.ts）
// album_type：游戏相册类型（基于父文件夹名映射，22 类）
// scene_category：拍摄场景（基于 scene_category 字段）
// scene_time：拍摄时段（基于 scene_time 字段）
// outfit：套装标注（基于 outfit 字段）
// file_type：文件类型（image/video）
// none：不分组（默认）

// T11：幻灯片播放配置
export type SlideshowOrder = 'sequence' | 'shuffle'
export type SlideshowTransition = 'fade' | 'slide' | 'none'

export interface SlideshowConfig {
  order: SlideshowOrder
  // P2-C13：interval 类型需覆盖 FullscreenViewer UI 实际提供的所有选项 [1000, 2000, 3000, 5000, 8000]
  // 保留 10000 以兼容旧版本持久化数据
  interval: 1000 | 2000 | 3000 | 5000 | 8000 | 10000
  transition: SlideshowTransition
  loop: boolean
  skipVideo: boolean
}

// XMP 元数据：详情页读取后通过此字段传递给编辑器，编辑器挂载时消费并清空
// 不持久化（仅内存态），避免重启后残留导致编辑器自动应用旧参数
export interface PendingEditorMetadata {
  params: Record<string, unknown>
  filter: { name: string; category: string; params: unknown } | null
  filterIntensity: number
  watermark: Record<string, unknown> | null
  exportTimestamp: string
  sourceFileName: string
}

interface UIState {
  // 当前视图层级
  currentView: ViewLevel
  viewStack: ViewLevel[]
  // 侧边栏展开状态
  sidebarCollapsed: boolean
  // 选中的媒体文件ID列表（多选）；当前焦点派生自 selectedMediaIds[0]（见 selectFocusedMediaId）
  selectedMediaIds: string[]
  // 多选模式开关：true 时卡片显示可见勾选框，点击卡片等价于切换选中而非打开全屏。
  // 属于临时交互状态，不持久化（与 selectedMediaIds 一致，重启后重置为 false）
  multiSelectMode: boolean
  // 当前分类ID
  currentCategoryId: number | null
  // 搜索关键词
  searchQuery: string
  // 排序方式
  sortBy: SortBy
  sortOrder: 'asc' | 'desc'
  // 视图模式
  viewMode: ViewMode
  // 筛选条件
  filterType: FilterType
  filterDateRange: [Date | null, Date | null]
  filterRating: number | null
  // 游戏内场景分类多选筛选
  selectedSceneCategories: SceneCategory[]
  // F-O1：场景时段多选筛选（基于图像亮度）
  selectedSceneTimes: SceneTime[]
  // F-O1：套装筛选（空字符串表示不筛选）
  filterOutfit: string
  // T02：仅看丢失文件开关（true 时只显示 is_missing=true 的记录）
  showMissingOnly: boolean
  // 损坏文件容错：仅看损坏文件开关（true 时只显示 is_corrupted=true 的记录）
  // 与 showMissingOnly 互斥：开启 showCorruptedOnly 时自动关闭 showMissingOnly
  showCorruptedOnly: boolean
  // P0-03：智能分组维度（'none' 表示不分组）
  groupDimension: GroupDimension
  // P0-03：当前选中的分组 key（'all' 表示显示全部，其他值表示按该 key 过滤）
  selectedGroupKey: string
  // P1-01：显示重复项开关（false 时隐藏 is_duplicate=1 的文件，true 时显示全部）
  showDuplicates: boolean
  // 全屏浏览状态
  fullscreenOpen: boolean
  fullscreenIndex: number
  // FIX(dup-fullscreen)：打开全屏时显式指定的文件列表（如重复文件页的摊平列表）；
  // null = 使用图库 filteredFiles（图库/详情页路径语义不变）。仅内存态，不持久化
  fullscreenFiles: import('../stores/mediaStore').MediaFile[] | null
  // P3-1：关闭全屏时的共享元素过渡目标 img（卡片缩略图 DOM 引用）
  fullscreenTargetImg: HTMLElement | null
  // T11：幻灯片播放状态
  slideshowOpen: boolean
  slideshowStartIndex: number
  slideshowConfig: SlideshowConfig

  // Actions
  navigateTo: (view: ViewLevel) => void
  goBack: () => void
  toggleSidebar: () => void
  selectMedia: (id: string | null) => void
  toggleMediaSelection: (id: string) => void
  setSelectedMediaIds: (ids: string[]) => void
  clearSelection: () => void
  setMultiSelectMode: (on: boolean) => void
  setCategory: (id: number | null) => void
  setSearchQuery: (query: string) => void
  setSortBy: (sort: SortBy) => void
  toggleSortOrder: () => void
  setViewMode: (mode: ViewMode) => void
  setFilterType: (type: FilterType) => void
  setFilterDateRange: (range: [Date | null, Date | null]) => void
  setFilterRating: (rating: number | null) => void
  setSelectedSceneCategories: (categories: SceneCategory[]) => void
  toggleSceneCategory: (category: SceneCategory, isCtrl?: boolean) => void
  clearSceneCategories: () => void
  selectAllSceneCategories: () => void
  // F-O1：场景时段 actions
  setSelectedSceneTimes: (times: SceneTime[]) => void
  toggleSceneTime: (time: SceneTime, isCtrl?: boolean) => void
  clearSceneTimes: () => void
  selectAllSceneTimes: () => void
  // F-O1：套装筛选
  setFilterOutfit: (outfit: string) => void
  // T02：切换仅看丢失
  setShowMissingOnly: (show: boolean) => void
  // 损坏文件容错：切换仅看损坏
  setShowCorruptedOnly: (show: boolean) => void
  // P0-03：智能分组维度 actions
  setGroupDimension: (dim: GroupDimension) => void
  setSelectedGroupKey: (key: string) => void
  // P1-01：切换显示重复项
  setShowDuplicates: (show: boolean) => void
  openFullscreen: (index: number, files?: import('../stores/mediaStore').MediaFile[]) => void
  closeFullscreen: () => void
  // T11：幻灯片播放 actions
  openSlideshow: (startIndex: number) => void
  closeSlideshow: () => void
  setSlideshowConfig: (config: Partial<SlideshowConfig>) => void
  // XMP 元数据：详情页 → 编辑器 跨页面参数传递
  pendingEditorMetadata: PendingEditorMetadata | null
  setPendingEditorMetadata: (data: PendingEditorMetadata | null) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      currentView: 'gallery',
      viewStack: ['gallery'],
      sidebarCollapsed: false,
      selectedMediaIds: [],
      multiSelectMode: false,
      currentCategoryId: null,
      searchQuery: '',
      sortBy: 'date',
      sortOrder: 'desc',
      viewMode: 'grid',
      filterType: 'all',
      filterDateRange: [null, null],
      filterRating: null,
      selectedSceneCategories: [],
      // F-O1：场景时段与套装筛选默认值
      selectedSceneTimes: [],
      filterOutfit: '',
      // T02：默认不开启"仅看丢失"
      showMissingOnly: false,
      // 损坏文件容错：默认不开启"仅看损坏"
      showCorruptedOnly: false,
      // P0-03：智能分组默认不分组
      groupDimension: 'none',
      selectedGroupKey: 'all',
      // P1-01：默认隐藏重复项（is_duplicate=1），用户可手动开启查看
      showDuplicates: false,
      fullscreenOpen: false,
      fullscreenIndex: 0,
      fullscreenFiles: null,
      fullscreenTargetImg: null,
      // T11：幻灯片默认配置——顺序播放、3秒间隔、淡入淡出、关闭循环、跳过视频
      slideshowOpen: false,
      slideshowStartIndex: 0,
      slideshowConfig: {
        order: 'sequence',
        interval: 3000,
        transition: 'fade',
        loop: false,
        skipVideo: true
      },
      // XMP 元数据：初始为 null，详情页读取后设置，编辑器挂载消费后清空
      pendingEditorMetadata: null,
      setPendingEditorMetadata: (data) => set({ pendingEditorMetadata: data }),

      navigateTo: (view) => {
        const { viewStack, multiSelectMode, selectedMediaIds } = get()
        if (viewStack[viewStack.length - 1] !== view) {
          // 多选态跨板块隔离：切换到任一媒体板块时清空选中并退出多选模式，
          // 避免图库 / 截图 / 收藏 共用同一份 selectedMediaIds 造成选中态串味
          const resetSelection =
            MULTI_SELECT_VIEWS.has(view) && (multiSelectMode || selectedMediaIds.length > 0)
          // 页面切换改用 CSS page-enter 动画（View Transitions 的整页快照交叉淡入会产生闪烁）
          set({
            currentView: view,
            viewStack: [...viewStack, view],
            ...(resetSelection ? { selectedMediaIds: [], multiSelectMode: false } : {})
          })
        }
      },

      goBack: () => {
        const { viewStack } = get()
        if (viewStack.length > 1) {
          const newStack = viewStack.slice(0, -1)
          set({
            currentView: newStack[newStack.length - 1],
            viewStack: newStack
          })
        }
      },

      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

      selectMedia: (id) => set({ selectedMediaIds: id ? [id] : [] }),

      setSelectedMediaIds: (ids) => set({ selectedMediaIds: ids }),

      toggleMediaSelection: (id) => {
        const { selectedMediaIds } = get()
        const index = selectedMediaIds.indexOf(id)
        if (index === -1) {
          set({ selectedMediaIds: [...selectedMediaIds, id] })
        } else {
          const newIds = [...selectedMediaIds]
          newIds.splice(index, 1)
          set({ selectedMediaIds: newIds })
        }
      },

      clearSelection: () => set({ selectedMediaIds: [] }),

      setMultiSelectMode: (on) =>
        set(on ? { multiSelectMode: true } : { multiSelectMode: false, selectedMediaIds: [] }),

      setCategory: (id) => set({ currentCategoryId: id }),

      setSearchQuery: (query) => set({ searchQuery: query }),

      setSortBy: (sort) => set({ sortBy: sort }),

      toggleSortOrder: () =>
        set((state) => ({ sortOrder: state.sortOrder === 'asc' ? 'desc' : 'asc' })),

      setViewMode: (mode) => set({ viewMode: mode }),

      setFilterType: (type) => set({ filterType: type }),

      setFilterDateRange: (range) => set({ filterDateRange: range }),

      setFilterRating: (rating) => set({ filterRating: rating }),

      setSelectedSceneCategories: (categories) => set({ selectedSceneCategories: categories }),

      toggleSceneCategory: (category, isCtrl) => {
        const { selectedSceneCategories } = get()
        if (isCtrl) {
          const exists = selectedSceneCategories.includes(category)
          set({
            selectedSceneCategories: exists
              ? selectedSceneCategories.filter((c) => c !== category)
              : [...selectedSceneCategories, category]
          })
        } else {
          set({ selectedSceneCategories: [category] })
        }
      },

      clearSceneCategories: () => set({ selectedSceneCategories: [] }),

      selectAllSceneCategories: () => {
        set({ selectedSceneCategories: SCENE_CATEGORIES.map((c: SceneCategoryConfig) => c.key) })
      },

      // F-O1：场景时段 actions
      setSelectedSceneTimes: (times) => set({ selectedSceneTimes: times }),

      toggleSceneTime: (time, isCtrl) => {
        const { selectedSceneTimes } = get()
        if (isCtrl) {
          const exists = selectedSceneTimes.includes(time)
          set({
            selectedSceneTimes: exists
              ? selectedSceneTimes.filter((t) => t !== time)
              : [...selectedSceneTimes, time]
          })
        } else {
          set({ selectedSceneTimes: [time] })
        }
      },

      clearSceneTimes: () => set({ selectedSceneTimes: [] }),

      selectAllSceneTimes: () => {
        set({ selectedSceneTimes: SCENE_TIMES.map((c: SceneTimeConfig) => c.key) })
      },

      // F-O1：套装筛选
      setFilterOutfit: (outfit) => set({ filterOutfit: outfit }),

      // T02：切换仅看丢失
      setShowMissingOnly: (show) =>
        set(
          show ? { showMissingOnly: true, showCorruptedOnly: false } : { showMissingOnly: false }
        ),

      // 损坏文件容错：切换仅看损坏（与 showMissingOnly 互斥，避免同时启用导致空列表）
      setShowCorruptedOnly: (show) =>
        set(
          show ? { showCorruptedOnly: true, showMissingOnly: false } : { showCorruptedOnly: false }
        ),

      // P0-03：智能分组维度 actions
      // 切换分组维度时重置已选分组 key，避免旧 key 与新维度错位
      setGroupDimension: (dim) => set({ groupDimension: dim, selectedGroupKey: 'all' }),
      setSelectedGroupKey: (key) => set({ selectedGroupKey: key }),

      // P1-01：切换显示重复项
      setShowDuplicates: (show) => set({ showDuplicates: show }),

      openFullscreen: (index, files) => {
        // 参数校验：index 必须为有限非负数
        if (!Number.isFinite(index) || index < 0) {
          return
        }
        // 参数校验：files 必须是数组（非数组一律视为「沿用图库 filteredFiles」；
        // 数组为空或 index 越界会造成 activeFiles[index] 为 undefined、
        // 组件早退返回 null，即用户感知的「点了没反应」，应在此拦截
        const explicitFiles = Array.isArray(files) ? files : null
        if (explicitFiles && index >= explicitFiles.length) {
          return
        }
        // P3-1：用 View Transitions API 实现共享元素过渡（缩略图→全屏图放大）
        // 调用方需在调用前给源卡片 img 设置 view-transition-name: 'fullscreen-media'
        const apply = () => {
          // 状态置位优先：即便后续 DOM/过渡操作异常，全屏也必定打开
          // FIX(dup-fullscreen)：同携带打开时所在的文件列表，FullscreenViewer 优先使用
          // RC1：在回调返回前同步提交，保证新快照能抓到已挂载的全屏查看器
          commitFullscreenState(() => {
            set({ fullscreenOpen: true, fullscreenIndex: index, fullscreenFiles: explicitFiles })
          })
          // RC3：仅清理已登记的源元素引用，避免全文档 style 子串扫描
          clearFullscreenSource()
        }
        const startViewTransition = getViewTransitionStarter()
        if (startViewTransition) {
          try {
            const transition = startViewTransition(apply)
            // G2：登记进行中的过渡，原图换源（FullscreenViewer）据此避开动画窗口
            setActiveTransition(transition)
          } catch {
            // View Transitions 调用失败（不支持/抛错）降级为直接打开
            setActiveTransition(null)
            apply()
          }
        } else {
          setActiveTransition(null)
          apply()
        }
      },

      closeFullscreen: () => {
        // P3-1：关闭时实现反向共享元素过渡（全屏图→缩略图缩小）
        const { fullscreenTargetImg } = get()
        let transitionSupported = false
        const apply = () => {
          // 状态置位优先
          // RC1：同样在回调返回前同步提交
          commitFullscreenState(() => {
            set({ fullscreenOpen: false, fullscreenTargetImg: null, fullscreenFiles: null })
          })
          // 仅在确有过渡时才给目标卡片打标记；不支持时打了没人清理会残留 view-transition-name
          if (transitionSupported) {
            markFullscreenSource(fullscreenTargetImg)
          }
        }
        const startViewTransition = getViewTransitionStarter()
        transitionSupported = startViewTransition !== undefined
        if (startViewTransition) {
          try {
            const transition = startViewTransition(apply)
            // G2：关闭同样产生过渡（反向共享元素），登记供换源约束使用
            setActiveTransition(transition)
            // 过渡完成后清除残留的 view-transition-name（O(1)，仅按登记引用）
            transition.finished
              .finally(() => {
                clearFullscreenSource()
                // G3：关闭后组件已卸载，释放记忆的源元素引用与注册表，避免悬挂引用
                releaseFullscreenSource()
                setActiveTransition(null)
              })
              .catch(() => {})
          } catch {
            setActiveTransition(null)
            apply()
          }
        } else {
          setActiveTransition(null)
          apply()
        }
      },

      // T11：幻灯片播放 actions
      openSlideshow: (startIndex) => set({ slideshowOpen: true, slideshowStartIndex: startIndex }),

      closeSlideshow: () => set({ slideshowOpen: false }),

      setSlideshowConfig: (config) =>
        set((state) => ({
          slideshowConfig: { ...state.slideshowConfig, ...config }
        }))
    }),
    {
      name: 'wxnn-ui-store',
      partialize: (state) => ({
        viewMode: state.viewMode,
        sortBy: state.sortBy,
        sortOrder: state.sortOrder,
        filterType: state.filterType,
        sidebarCollapsed: state.sidebarCollapsed,
        // U-O4 修正：selectedSceneCategories 不持久化，避免重启后残留筛选导致页面空态
        // 场景分类筛选属于临时交互状态，每次启动应重置为默认空数组
        // T11：幻灯片配置持久化（slideshowOpen 与 slideshowStartIndex 不持久化，每次重启需用户主动启动）
        slideshowConfig: state.slideshowConfig
      })
    }
  )
)

// 当前焦点媒体 = 多选数组首项；派生值，避免与 selectedMediaIds 维护两份状态而失步
export const selectFocusedMediaId = (s: UIState): string | null => s.selectedMediaIds[0] ?? null
