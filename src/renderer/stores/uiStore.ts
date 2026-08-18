import { create } from 'zustand'
import { persist } from 'zustand/middleware'
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
export type ViewMode = 'grid' | 'list' | 'timeline' | 'masonry' | 'event-timeline'
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
  openFullscreen: (index: number) => void
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
        const { viewStack } = get()
        if (viewStack[viewStack.length - 1] !== view) {
          // 页面切换改用 CSS page-enter 动画（View Transitions 的整页快照交叉淡入会产生闪烁）
          set({
            currentView: view,
            viewStack: [...viewStack, view]
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

      openFullscreen: (index) => {
        // P3-1：用 View Transitions API 实现共享元素过渡（缩略图→全屏图放大）
        // 调用方需在调用前给源卡片 img 设置 view-transition-name: 'fullscreen-media'
        const apply = () => {
          // 清除源元素的 view-transition-name，避免新快照与 FullscreenViewer img 冲突
          document.querySelectorAll('[style*="view-transition-name"]').forEach((el) => {
            ;(el as HTMLElement).style.viewTransitionName = ''
          })
          set({ fullscreenOpen: true, fullscreenIndex: index })
        }
        if (
          typeof document !== 'undefined' &&
          (document as any).startViewTransition &&
          !document.documentElement.classList.contains('reduce-motion')
        ) {
          ;(document as any).startViewTransition(apply)
        } else {
          apply()
        }
      },

      closeFullscreen: () => {
        // P3-1：关闭时实现反向共享元素过渡（全屏图→缩略图缩小）
        const { fullscreenTargetImg } = get()
        const apply = () => {
          // 移除 FullscreenViewer img 的 view-transition-name（旧快照已有，新快照不需要）
          const fullscreenImg = document.querySelector('[data-fullscreen-img]')
          if (fullscreenImg) {
            ;(fullscreenImg as HTMLElement).style.viewTransitionName = ''
          }
          // 给目标卡片 img 设置 view-transition-name（新快照中有，旧快照中没有）
          if (fullscreenTargetImg) {
            fullscreenTargetImg.style.viewTransitionName = 'fullscreen-media'
          }
          set({ fullscreenOpen: false, fullscreenTargetImg: null })
        }
        if (
          typeof document !== 'undefined' &&
          (document as any).startViewTransition &&
          !document.documentElement.classList.contains('reduce-motion')
        ) {
          const transition = (document as any).startViewTransition(apply)
          // 过渡完成后清除残留的 view-transition-name
          transition.finished.finally(() => {
            document.querySelectorAll('[style*="view-transition-name"]').forEach((el) => {
              ;(el as HTMLElement).style.viewTransitionName = ''
            })
          })
        } else {
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
