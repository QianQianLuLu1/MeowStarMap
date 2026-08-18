import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useUIStore } from '../stores/uiStore'
import { useMediaStore, loadNextMediaPage, type MediaFile } from '../stores/mediaStore'
// P1-U4：复用共享字段映射函数，消除 dual-source-of-truth
import { getGroupFieldValue } from '../utils/group-field'
// 全文搜索（flexsearch）：索引就绪时优先用 flexsearch 召回；未就绪返回 null 触发降级
import { searchService } from '../search/search-service'

// C-O5：module-level 缓存（故意为之，多组件共享过滤结果）
// GalleryPage / DetailPage / FullscreenViewer 各自调用 useFilteredMediaFiles 时，
// 若所有依赖引用均未变化，直接返回上次结果，避免重复执行过滤+排序计算。
// 注意：依赖项通过引用比较，所以下游 store 必须返回稳定引用（zustand selector 模式）。
interface FilterCache {
  mediaFiles: MediaFile[] | null
  filterType: string | null
  searchQuery: string | null
  sortBy: string | null
  sortOrder: string | null
  selectedSceneCategories: unknown[] | null
  selectedSceneTimes: unknown[] | null
  filterOutfit: string | null
  currentCategoryId: number | null
  filterDateRange: unknown[] | null
  filterRating: number | null
  currentView: string | null
  showMissingOnly: boolean | null
  showCorruptedOnly: boolean | null
  groupDimension: string | null
  selectedGroupKey: string | null
  showDuplicates: boolean | null
  searchState: string | null
  value: MediaFile[]
}

const cache: FilterCache = {
  mediaFiles: null,
  filterType: null,
  searchQuery: null,
  sortBy: null,
  sortOrder: null,
  selectedSceneCategories: null,
  selectedSceneTimes: null,
  filterOutfit: null,
  currentCategoryId: null,
  filterDateRange: null,
  filterRating: null,
  currentView: null,
  showMissingOnly: null,
  showCorruptedOnly: null,
  groupDimension: null,
  selectedGroupKey: null,
  showDuplicates: null,
  searchState: null,
  value: []
}

export function useFilteredMediaFiles(): MediaFile[] {
  // C-O4：用 selector 订阅具体字段，避免订阅整个 store
  const mediaFiles = useMediaStore((s) => s.mediaFiles)
  const filterType = useUIStore((s) => s.filterType)
  const searchQuery = useUIStore((s) => s.searchQuery)
  const sortBy = useUIStore((s) => s.sortBy)
  const sortOrder = useUIStore((s) => s.sortOrder)
  const selectedSceneCategories = useUIStore((s) => s.selectedSceneCategories)
  const selectedSceneTimes = useUIStore((s) => s.selectedSceneTimes)
  const filterOutfit = useUIStore((s) => s.filterOutfit)
  const currentCategoryId = useUIStore((s) => s.currentCategoryId)
  const filterDateRange = useUIStore((s) => s.filterDateRange)
  const filterRating = useUIStore((s) => s.filterRating)
  const currentView = useUIStore((s) => s.currentView)
  const showMissingOnly = useUIStore((s) => s.showMissingOnly)
  // 损坏文件容错：仅看损坏文件筛选器
  const showCorruptedOnly = useUIStore((s) => s.showCorruptedOnly)
  // P0-03：智能分组维度与当前选中的分组 key
  const groupDimension = useUIStore((s) => s.groupDimension)
  const selectedGroupKey = useUIStore((s) => s.selectedGroupKey)
  // P1-01：显示重复项开关
  const showDuplicates = useUIStore((s) => s.showDuplicates)
  // 全文搜索：订阅 searchService 状态变化
  // 索引就绪后（loading → ready）触发 useMemo 重算，让当前 searchQuery 立即走 flexsearch
  const searchState = useSyncExternalStore(
    (cb) => searchService.onStateChange(cb),
    () => searchService.getState(),
    () => 'idle' as const
  )

  // FIX(组20-1): mediaFiles 是分页加载的子集（首屏仅 500 条），筛选/搜索若只作用于该子集，
  // 未滚动加载的文件既不参与搜索也不参与筛选，结果不完整。存在激活的筛选/搜索条件且
  // 还有未加载页时逐页拉齐全库：loadNextMediaPage 自带 loadingMore 并发保护，
  // 每页追加使 mediaFiles.length 变化并驱动本 effect 再次触发，直至 hasMoreMedia=false。
  const hasMoreMedia = useMediaStore((s) => s.hasMoreMedia)
  const mediaCount = mediaFiles.length
  const [rangeStart, rangeEnd] = filterDateRange
  const isFilteringActive =
    searchQuery !== '' ||
    filterType !== 'all' ||
    currentView === 'favorites' ||
    showMissingOnly ||
    showCorruptedOnly ||
    (groupDimension !== 'none' && selectedGroupKey !== 'all') ||
    selectedSceneCategories.length > 0 ||
    selectedSceneTimes.length > 0 ||
    filterOutfit !== '' ||
    currentCategoryId !== null ||
    rangeStart !== null ||
    rangeEnd !== null ||
    (filterRating !== null && filterRating > 0)
  useEffect(() => {
    // 回收站视图使用独立的 recycleBinFiles 数据源，不在此触发全库加载
    if (isFilteringActive && hasMoreMedia && currentView !== 'recycle-bin') {
      void loadNextMediaPage()
    }
  }, [isFilteringActive, hasMoreMedia, mediaCount, currentView])

  return useMemo(() => {
    // 命中缓存：所有依赖引用均未变化时直接返回上次结果
    if (
      cache.mediaFiles === mediaFiles &&
      cache.filterType === filterType &&
      cache.searchQuery === searchQuery &&
      cache.sortBy === sortBy &&
      cache.sortOrder === sortOrder &&
      cache.selectedSceneCategories === selectedSceneCategories &&
      cache.selectedSceneTimes === selectedSceneTimes &&
      cache.filterOutfit === filterOutfit &&
      cache.currentCategoryId === currentCategoryId &&
      cache.filterDateRange === filterDateRange &&
      cache.filterRating === filterRating &&
      cache.currentView === currentView &&
      cache.showMissingOnly === showMissingOnly &&
      cache.showCorruptedOnly === showCorruptedOnly &&
      cache.groupDimension === groupDimension &&
      cache.selectedGroupKey === selectedGroupKey &&
      cache.showDuplicates === showDuplicates &&
      cache.searchState === searchState
    ) {
      return cache.value
    }

    let files = [...mediaFiles]

    // F-S10：收藏夹视图仅显示 is_favorite=true 的媒体
    if (currentView === 'favorites') {
      files = files.filter((f) => f.is_favorite)
    }

    // T02：已丢失文件默认隐藏，仅在勾选"仅看丢失"时显示
    // 默认（showMissingOnly=false）过滤掉 is_missing===true，使其不出现在"全部"/收藏夹等视图
    // 字段为 undefined（存量/未扫描完整性）视为未丢失，使用 !== true 防御性判断，避免参数缺失误判
    if (showMissingOnly) {
      files = files.filter((f) => f.is_missing === true)
    } else {
      files = files.filter((f) => f.is_missing !== true)
    }

    // 损坏文件容错：仅看损坏文件筛选器
    // 与 showMissingOnly 互斥（uiStore 中切换时会自动关闭另一个），此处仍按"开启即过滤"语义独立判断
    if (showCorruptedOnly) {
      files = files.filter((f) => f.is_corrupted === true)
    }

    // P1-01：默认隐藏重复项（is_duplicate=1），用户开启 showDuplicates 时显示全部
    // 回收站视图不受此过滤影响（deletedOnly 由后端处理，前端 currentView='recycle-bin' 不在此过滤）
    if (!showDuplicates && currentView !== 'recycle-bin' && currentView !== 'duplicates') {
      files = files.filter((f) => !f.is_duplicate)
    }

    // P0-03：智能分组过滤
    // 维度：album_type / scene_category / scene_time / outfit / file_type
    // selectedGroupKey === 'all' 时显示该维度下全部文件（不应用分组过滤）
    if (groupDimension !== 'none' && selectedGroupKey !== 'all') {
      files = files.filter((f) => {
        const fieldValue = getGroupFieldValue(f, groupDimension)
        return fieldValue === selectedGroupKey
      })
    }

    if (filterType !== 'all') {
      files = files.filter((f) => f.file_type === filterType)
    }

    if (selectedSceneCategories.length > 0) {
      files = files.filter((f) => selectedSceneCategories.includes(f.scene_category))
    }

    // F-O1：场景时段筛选（基于图像亮度）
    if (selectedSceneTimes.length > 0) {
      files = files.filter((f) => f.scene_time && selectedSceneTimes.includes(f.scene_time))
    }

    // F-O1：套装筛选
    if (filterOutfit) {
      files = files.filter((f) => f.outfit === filterOutfit)
    }

    // 分类筛选
    if (currentCategoryId !== null) {
      files = files.filter((f) => f.category_id === currentCategoryId)
    }

    // 日期范围筛选
    const [startDate, endDate] = filterDateRange
    if (startDate || endDate) {
      files = files.filter((f) => {
        const fileDate = new Date(f.created_at)
        if (startDate && fileDate < startDate) return false
        if (endDate) {
          // endDate 取当天结束（23:59:59）
          const endOfDay = new Date(endDate)
          endOfDay.setHours(23, 59, 59, 999)
          if (fileDate > endOfDay) return false
        }
        return true
      })
    }

    // 评分筛选（显示评分 >= filterRating 的文件）
    if (filterRating !== null && filterRating > 0) {
      files = files.filter((f) => f.rating >= filterRating)
    }

    if (searchQuery) {
      // 全文搜索：优先用 flexsearch 召回（覆盖 file_name/tags/outfit/scene_category/notes 6 字段）
      // 索引未就绪时 search 返回 null → 降级到客户端过滤，保证可用性
      const matchedIds = searchService.search(searchQuery)
      if (matchedIds === null) {
        // 降级路径：索引未就绪/损坏，使用原有客户端过滤
        const query = searchQuery.toLowerCase()
        files = files.filter(
          (f) =>
            f.file_name.toLowerCase().includes(query) ||
            f.tags.some((t) => t.toLowerCase().includes(query)) ||
            // F-O1：搜索也匹配套装名
            (f.outfit ? f.outfit.toLowerCase().includes(query) : false) ||
            // F-O1：搜索也匹配场景分类与备注（与 flexsearch 索引字段对齐）
            (f.scene_category ? f.scene_category.toLowerCase().includes(query) : false) ||
            (f.notes ? f.notes.toLowerCase().includes(query) : false)
        )
      } else if (matchedIds.length === 0 && !searchService.isReady()) {
        // 防御性兜底：理论上 state !== 'ready' 时 search 返回 null 已降级，
        // 此分支覆盖极端时序（搜索调用瞬间索引状态变化），回退到客户端过滤
        console.warn('[Search] 索引未就绪，回退到本地搜索:', searchQuery)
        const query = searchQuery.toLowerCase()
        files = files.filter(
          (f) =>
            f.file_name.toLowerCase().includes(query) ||
            f.tags.some((t) => t.toLowerCase().includes(query)) ||
            (f.outfit ? f.outfit.toLowerCase().includes(query) : false) ||
            (f.scene_category ? f.scene_category.toLowerCase().includes(query) : false) ||
            (f.notes ? f.notes.toLowerCase().includes(query) : false)
        )
      } else {
        // flexsearch 召回路径：用命中的 id 集合过滤
        // matchedIds 是 DB INTEGER，需与 MediaFile.id（string）对齐
        const idSet = new Set(matchedIds.map(String))
        files = files.filter((f) => idSet.has(f.id))
      }
    }

    files.sort((a, b) => {
      let comparison = 0
      switch (sortBy) {
        case 'date':
          comparison = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          break
        case 'name':
          comparison = a.file_name.localeCompare(b.file_name)
          break
        case 'size':
          comparison = a.file_size - b.file_size
          break
        case 'resolution':
          comparison = (a.width || 0) * (a.height || 0) - (b.width || 0) * (b.height || 0)
          break
        case 'rating':
          comparison = a.rating - b.rating
          break
      }
      return sortOrder === 'asc' ? comparison : -comparison
    })

    // 写入缓存
    cache.mediaFiles = mediaFiles
    cache.filterType = filterType
    cache.searchQuery = searchQuery
    cache.sortBy = sortBy
    cache.sortOrder = sortOrder
    cache.selectedSceneCategories = selectedSceneCategories
    cache.selectedSceneTimes = selectedSceneTimes
    cache.filterOutfit = filterOutfit
    cache.currentCategoryId = currentCategoryId
    cache.filterDateRange = filterDateRange
    cache.filterRating = filterRating
    cache.currentView = currentView
    cache.showMissingOnly = showMissingOnly
    cache.showCorruptedOnly = showCorruptedOnly
    cache.groupDimension = groupDimension
    cache.selectedGroupKey = selectedGroupKey
    cache.showDuplicates = showDuplicates
    cache.searchState = searchState
    cache.value = files

    return files
  }, [
    mediaFiles,
    filterType,
    searchQuery,
    sortBy,
    sortOrder,
    selectedSceneCategories,
    selectedSceneTimes,
    filterOutfit,
    currentCategoryId,
    filterDateRange,
    filterRating,
    currentView,
    showMissingOnly,
    showCorruptedOnly,
    groupDimension,
    selectedGroupKey,
    showDuplicates,
    searchState
  ])
}

// P1-U4：getGroupFieldValue 已迁移至 utils/group-field.ts
