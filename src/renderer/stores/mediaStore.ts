import { create } from 'zustand'
import { toFileUrl } from '../utils/file'
import i18n from '../i18n'
// C-S2：从 shared 导入场景分类，消除渲染进程跨边界导入主进程模块
import type { SceneCategory, SceneTime } from '../../shared/scene-category'
// P1-01：读取 showDuplicates 状态用于服务端过滤 is_duplicate=1
// C-S2 修复：uiStore 已改为从 shared 直接导入，不再反向导入 mediaStore，循环依赖消除
import { useUIStore } from './uiStore'

// 保持兼容性：从 utils/file 重新导出版本统一的 toFileUrl
export { toFileUrl }
export type { SceneCategory, SceneTime }
export {
  SCENE_CATEGORIES,
  SCENE_TIMES,
  OUTFIT_PRESETS,
  getSceneCategoryLabel,
  getSceneTimeLabel
} from '../../shared/scene-category'

export interface MediaFile {
  id: string
  file_path: string
  file_name: string
  file_type: 'image' | 'video'
  file_ext: string
  file_size: number
  width?: number
  height?: number
  duration?: number
  created_at: string
  modified_at: string
  thumbnail?: string
  tags: string[]
  category_id?: number
  rating: number
  is_favorite: boolean
  notes: string
  scene_category: SceneCategory
  // F-O1：基于图像亮度的场景时段
  scene_time?: SceneTime
  // F-O1：手动套装标注
  outfit?: string
  // P0-02：角色档案 UID
  account_uid?: string
  // P0-03：游戏相册类型
  album_type?: string
  // 媒体来源：'game'（游戏内拍摄）/ 'launcher'（启动器缓存）/ 'cloud'（用户云相册）
  media_source?: 'game' | 'launcher' | 'cloud'
  // F-S6 回收站：软删除标记与删除时间
  is_deleted?: boolean
  deleted_at?: string | null
  // T02：文件完整性校验（外部移动/删除标记）
  is_missing?: boolean
  // P1-01：智能去重标记（is_duplicate=1 表示该文件是某重复组的非推荐保留项）
  is_duplicate?: boolean
  // P1-01：推荐保留的文件 id（NULL 表示独立文件或推荐保留项本身）
  original_id?: number | null
  // 损坏文件容错：is_corrupted=true 表示文件存在但内容无法读取/解码（图片损坏、视频无法解析等）
  // 用于图库默认视图过滤（hideCorrupted）与"仅看损坏"筛选器（corruptedOnly）
  is_corrupted?: boolean
  // 损坏文件容错：最后一次失败原因摘要（≤200 字符），用于诊断面板展示
  corrupted_reason?: string | null
}

// P0-02：角色档案接口
export interface CharacterProfile {
  uid: string
  nickname: string
  avatar: string | null
  created_at: string
  last_active_at: string | null
}

export interface Category {
  id: number
  name: string
  icon: string
  color: string
  sort_order: number
  parent_id?: number
  is_system: boolean
  children?: Category[]
}

interface MediaState {
  // 媒体文件列表
  mediaFiles: MediaFile[]
  // 分类列表
  categories: Category[]
  // 加载状态
  loading: boolean
  // 无限滚动分页：currentPage 是已加载的最后一页页码（首屏为 0）
  currentPage: number
  // 服务端是否还有下一页（由 media.list 的 hasMore 派生）
  hasMoreMedia: boolean
  // 追加加载中标志位，防止滚动到底时重复触发
  loadingMore: boolean
  // 扫描进度
  scanProgress: {
    scanning: boolean
    scanned: number
    found: number
    currentPath: string
    status: 'idle' | 'running' | 'completed' | 'failed'
  }
  // 当前编辑的媒体
  editingMedia: MediaFile | null
  // F-S6 回收站：已软删除的媒体列表
  recycleBinFiles: MediaFile[]
  recycleBinLoading: boolean
  // 回收站分页：与图库同构（total 来自服务端，用于"全部删除"这类需要真实总量的场景）
  recycleBinTotal: number
  recycleBinPage: number
  recycleBinHasMore: boolean
  recycleBinLoadingMore: boolean
  // P0-02：角色档案管理
  currentProfileUid: string // 当前选中的角色档案 UID（'all' 表示全部档案）
  profiles: CharacterProfile[] // 所有角色档案列表

  // Actions
  setMediaFiles: (files: MediaFile[]) => void
  addMediaFiles: (files: MediaFile[]) => void
  updateMediaFile: (id: string, updates: Partial<MediaFile>) => void
  deleteMediaFiles: (ids: string[]) => void
  setCategories: (categories: Category[]) => void
  setLoading: (loading: boolean) => void
  setScanProgress: (progress: Partial<MediaState['scanProgress']>) => void
  setEditingMedia: (media: MediaFile | null) => void
  setRecycleBinFiles: (files: MediaFile[]) => void
  setRecycleBinLoading: (loading: boolean) => void
  // P0-02：角色档案 actions
  setCurrentProfileUid: (uid: string) => void
  setProfiles: (profiles: CharacterProfile[]) => void
}

export const useMediaStore = create<MediaState>((set, _get) => ({
  mediaFiles: [],
  categories: [],
  loading: false,
  currentPage: 0,
  hasMoreMedia: false,
  loadingMore: false,
  scanProgress: {
    scanning: false,
    scanned: 0,
    found: 0,
    currentPath: '',
    status: 'idle'
  },
  editingMedia: null,
  recycleBinFiles: [],
  recycleBinLoading: false,
  recycleBinTotal: 0,
  recycleBinPage: 0,
  recycleBinHasMore: false,
  recycleBinLoadingMore: false,
  // P0-02：默认显示全部档案
  currentProfileUid: 'all',
  profiles: [],

  setMediaFiles: (files) => set({ mediaFiles: files }),

  addMediaFiles: (files) =>
    set((state) => ({
      mediaFiles: [...state.mediaFiles, ...files]
    })),

  // 纯 reducer：仅更新本地状态，不执行任何副作用
  updateMediaFile: (id, updates) =>
    set((state) => ({
      mediaFiles: state.mediaFiles.map((file) => (file.id === id ? { ...file, ...updates } : file))
    })),

  deleteMediaFiles: (ids) =>
    set((state) => ({
      mediaFiles: state.mediaFiles.filter((file) => !ids.includes(file.id))
    })),

  setCategories: (categories) => set({ categories }),

  setLoading: (loading) => set({ loading }),

  setScanProgress: (progress) =>
    set((state) => ({
      scanProgress: { ...state.scanProgress, ...progress }
    })),

  setEditingMedia: (media) => set({ editingMedia: media }),

  setRecycleBinFiles: (files) => set({ recycleBinFiles: files }),

  setRecycleBinLoading: (loading) => set({ recycleBinLoading: loading }),

  // P0-02：角色档案 actions
  setCurrentProfileUid: (uid) => set({ currentProfileUid: uid }),
  setProfiles: (profiles) => set({ profiles })
}))

// 异步 action：先持久化到数据库，再更新本地状态
export async function updateMediaFileAndPersist(
  id: string,
  updates: Partial<MediaFile>
): Promise<{ success: boolean; message?: string }> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    useMediaStore.getState().updateMediaFile(id, updates)
    return { success: true }
  }

  try {
    const numericId = Number(id)
    const promises: Promise<unknown>[] = []

    if ('tags' in updates && Array.isArray(updates.tags)) {
      promises.push(window.electronAPI.mediaAction.updateTags(numericId, updates.tags))
    }
    if ('rating' in updates && typeof updates.rating === 'number') {
      promises.push(window.electronAPI.mediaAction.updateRating(numericId, updates.rating))
    }
    if ('is_favorite' in updates && typeof updates.is_favorite === 'boolean') {
      promises.push(window.electronAPI.mediaAction.updateFavorite(numericId, updates.is_favorite))
    }
    if ('notes' in updates && typeof updates.notes === 'string') {
      promises.push(window.electronAPI.mediaAction.updateNotes(numericId, updates.notes))
    }
    if (
      'category_id' in updates &&
      (typeof updates.category_id === 'number' || updates.category_id === undefined)
    ) {
      promises.push(
        window.electronAPI.mediaAction.updateCategory(numericId, updates.category_id ?? null)
      )
    }
    // F-O1：套装标注持久化
    if ('outfit' in updates && typeof updates.outfit === 'string') {
      promises.push(window.electronAPI.mediaAction.updateOutfit(numericId, updates.outfit))
    }

    await Promise.all(promises)
    useMediaStore.getState().updateMediaFile(id, updates)
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(i18n.t('mediaStore.log.persistFailed'), message)
    return { success: false, message }
  }
}

// 从数据库加载媒体文件和分类
// 修复 A-G1/F-S3/C-S1：使用分页加载，避免万级文件一次性加载导致 OOM
// 首次加载第一页（500 条），后续可通过 loadMoreMedia 追加加载
// P0-02：按当前选中的角色档案 UID 过滤
const MEDIA_PAGE_SIZE = 500

/**
 * 从数据库查询媒体文件与分类列表（纯查询，不写 store）。
 *
 * 本函数只负责取数：函数体内没有任何 set(...) 调用，返回 { files, categories, total, hasMore } 或 null。
 * 调用方必须自行把结果写入 store（setMediaFiles / setCategories），否则 UI 不会更新。
 * 推荐直接使用 useRefreshMedia hook，它已封装「取数 + 写 store + 失败重试」，可杜绝返回值被丢弃。
 */
export async function fetchMediaFromDatabase(): Promise<{
  files: MediaFile[]
  categories: Category[]
  total?: number
  hasMore?: boolean
} | null> {
  if (!window.electronAPI?.media?.list || !window.electronAPI?.category?.list) {
    console.error(
      i18n.t('mediaStore.log.noElectronApi') +
        !!window.electronAPI?.media?.list +
        ', category.list=' +
        !!window.electronAPI?.category?.list
    )
    return null
  }

  try {
    // P0-02：从 store 读取当前选中的角色档案 UID
    const currentProfileUid = useMediaStore.getState().currentProfileUid
    // P1-01：根据 uiStore.showDuplicates 决定是否服务端过滤 is_duplicate=1
    // showDuplicates=true 时不过滤（返回全部），false 时只返回 is_duplicate=0
    const showDuplicates = useUIStore.getState().showDuplicates
    // 损坏文件容错：根据 uiStore.showCorruptedOnly 决定服务端过滤策略
    // showCorruptedOnly=true 时仅返回 is_corrupted=1 的记录（"仅看损坏"筛选器）
    // showCorruptedOnly=false 时返回全部记录（含损坏），损坏文件在前端显示占位图 + 损坏角标
    // 与 showMissingOnly 策略对称：默认显示损坏文件（带角标），用户可手动开启"仅看损坏"筛选
    const showCorruptedOnly = useUIStore.getState().showCorruptedOnly
    // 根据当前视图决定媒体来源过滤：
    // 图库视图（gallery）：传 undefined 让后端走默认排除 launcher + galleryHighQualityOnly=true 过滤到 HQ
    // 缓存视图（launcher-cache）：传 'launcher'（后端已扩展为包含所有非 HQ 文件）
    // 其他视图（favorites/duplicates 等）：传 undefined 保持原行为
    const currentView = useUIStore.getState().currentView
    const isGalleryView = currentView === 'gallery'
    const isCacheView = currentView === 'launcher-cache'
    const mediaSource: 'game' | 'launcher' | 'cloud' | undefined = isCacheView
      ? 'launcher'
      : undefined
    // 图库板块启用高质量照片目录过滤：仅显示 ...GamePlayPhotos/{uid}/NikkiPhotos_HighQuality 下的图片
    // 非图库视图（favorites/duplicates/recycle-bin 等）传 false 保持原行为
    const galleryHighQualityOnly = isGalleryView
    const mediaResult = await window.electronAPI.media.list({
      page: 0,
      pageSize: MEDIA_PAGE_SIZE,
      accountUid: currentProfileUid,
      hideDuplicates: !showDuplicates,
      corruptedOnly: showCorruptedOnly,
      mediaSource,
      galleryHighQualityOnly
    })
    // preload 的 call() 已解包 IpcResponse 并在失败时抛出 IpcError，此处仅需防御性检查数据存在
    if (!mediaResult) {
      console.error(i18n.t('mediaStore.log.mediaListNull'))
      return null
    }
    if (!mediaResult.files) {
      console.error(
        i18n.t('mediaStore.log.filesEmpty'),
        JSON.stringify({ total: mediaResult.total, hasMore: mediaResult.hasMore })
      )
      return null
    }
    const categoryResult = await window.electronAPI.category.list()
    if (!categoryResult) {
      console.error(i18n.t('mediaStore.log.categoryListNull'))
      return null
    }
    if (!categoryResult.categories) {
      console.error(i18n.t('mediaStore.log.categoriesEmpty'))
      return null
    }

    // 首屏加载即重置分页游标：所有"整表刷新"入口（扫描完成、切换视图、设置页操作等）
    // 都经过本函数，游标随列表一起复位，避免 loadNextMediaPage 从陈旧页码继续翻页
    useMediaStore.setState({
      currentPage: 0,
      hasMoreMedia: mediaResult.hasMore ?? false,
      loadingMore: false
    })

    return {
      files: mediaResult.files as MediaFile[],
      categories: categoryResult.categories as Category[],
      total: mediaResult.total,
      hasMore: mediaResult.hasMore
    }
  } catch (error) {
    console.error(
      i18n.t('mediaStore.log.fetchError'),
      error instanceof Error ? error.message : String(error),
      error
    )
    return null
  }
}

/**
 * 扫描/取消后统一刷新媒体列表：取数 + 写 store。
 * 所有扫描完成/取消路径共用此函数，消除 ScanButton 与 ScanProgress 各处重复调用 fetchMediaFromDatabase 导致的多次 DB 读取。
 */
export async function refreshMediaAfterScan(): Promise<void> {
  // fetchMediaFromDatabase 内部已吞掉异常并返回 null，此处无需再 try/catch
  const res = await fetchMediaFromDatabase()
  if (res) {
    useMediaStore.getState().setMediaFiles(res.files)
  }
}

// 追加加载更多媒体文件（无限滚动）
// P0-02：按当前选中的角色档案 UID 过滤
export async function loadMoreMedia(
  page: number
): Promise<{ files: MediaFile[]; hasMore: boolean } | null> {
  if (!window.electronAPI?.media?.list) return null

  try {
    const currentProfileUid = useMediaStore.getState().currentProfileUid
    // P1-01：与 fetchMediaFromDatabase 保持一致的 hideDuplicates 策略
    const showDuplicates = useUIStore.getState().showDuplicates
    // 损坏文件容错：与 fetchMediaFromDatabase 保持一致的 corruptedOnly 策略
    const showCorruptedOnly = useUIStore.getState().showCorruptedOnly
    // 与 fetchMediaFromDatabase 保持一致的 mediaSource 策略
    const currentView = useUIStore.getState().currentView
    const isGalleryView = currentView === 'gallery'
    const isCacheView = currentView === 'launcher-cache'
    const mediaSource: 'game' | 'launcher' | 'cloud' | undefined = isCacheView
      ? 'launcher'
      : undefined
    // 与 fetchMediaFromDatabase 保持一致：图库板块启用高质量照片目录过滤
    const galleryHighQualityOnly = isGalleryView
    const mediaResult = await window.electronAPI.media.list({
      page,
      pageSize: MEDIA_PAGE_SIZE,
      accountUid: currentProfileUid,
      hideDuplicates: !showDuplicates,
      corruptedOnly: showCorruptedOnly,
      mediaSource,
      galleryHighQualityOnly
    })
    if (!mediaResult.files) return null
    return {
      files: mediaResult.files as MediaFile[],
      hasMore: mediaResult.hasMore ?? false
    }
  } catch (error) {
    console.error(i18n.t('mediaStore.log.loadMoreFailed'), error)
    return null
  }
}

// OFFSET 分页在两次请求之间可能因新增/删除记录而错位，按 id 去重避免重复 key
function dedupeAgainst(existing: MediaFile[], incoming: MediaFile[]): MediaFile[] {
  const existingIds = new Set(existing.map((f) => f.id))
  return incoming.filter((f) => !existingIds.has(f.id))
}

// 无限滚动入口：滚动到底时追加下一页并写入 store
// 与 loadMoreMedia 的分工：loadMoreMedia 只负责取数，本函数负责游标推进、去重追加与并发保护
export async function loadNextMediaPage(): Promise<void> {
  const { loadingMore, hasMoreMedia, currentPage } = useMediaStore.getState()
  // 并发保护：VirtuosoGrid 的 endReached 在一次触底中可能连续触发多次
  if (loadingMore || !hasMoreMedia) return

  useMediaStore.setState({ loadingMore: true })
  try {
    const nextPage = currentPage + 1
    const result = await loadMoreMedia(nextPage)
    // 取数失败时保持游标与 hasMoreMedia 不变，用户再次触底即可重试（错误已由 loadMoreMedia 记录）
    if (!result) return

    const freshFiles = dedupeAgainst(useMediaStore.getState().mediaFiles, result.files)
    if (freshFiles.length > 0) {
      useMediaStore.getState().addMediaFiles(freshFiles)
    }
    useMediaStore.setState({ currentPage: nextPage, hasMoreMedia: result.hasMore })
  } finally {
    useMediaStore.setState({ loadingMore: false })
  }
}

// P0-02：加载角色档案列表
export async function loadProfiles(): Promise<CharacterProfile[] | null> {
  if (!window.electronAPI?.profile?.list) return null
  try {
    const result = await window.electronAPI.profile.list()
    const profiles = result.profiles as CharacterProfile[]
    useMediaStore.getState().setProfiles(profiles)
    return profiles
  } catch (error) {
    console.error(i18n.t('mediaStore.log.loadProfilesFailed'), error)
    return null
  }
}

// 回收站单页条数：回收站条目自带缩略图渲染，比图库列表更重，取比 MEDIA_PAGE_SIZE 更小的值
const RECYCLE_BIN_PAGE_SIZE = 200

// F-S6 回收站：加载已软删除的媒体文件列表（首页）
// 待确认#3：改用 useMediaStore.setState 直接更新，避免 getState 快照持有过期引用
// 所有回收站操作（恢复/彻底删除/清空）完成后都会调用本函数，因此这里同时复位分页游标
export async function loadRecycleBin(): Promise<MediaFile[] | null> {
  if (!window.electronAPI?.media?.list) return null
  useMediaStore.setState({ recycleBinLoading: true })
  try {
    const result = await window.electronAPI.media.list({
      deletedOnly: true,
      page: 0,
      pageSize: RECYCLE_BIN_PAGE_SIZE
    })
    const files = result.files as MediaFile[]
    useMediaStore.setState({
      recycleBinFiles: files,
      recycleBinTotal: result.total ?? files.length,
      recycleBinPage: 0,
      recycleBinHasMore: result.hasMore ?? false,
      recycleBinLoadingMore: false,
      recycleBinLoading: false
    })
    return files
  } catch (error) {
    console.error(i18n.t('mediaStore.log.loadRecycleBinFailed'), error)
    return null
  } finally {
    // T16：无论成功/失败/异常，都重置 loading 标志，避免 UI 卡在加载中状态
    useMediaStore.setState({ recycleBinLoading: false })
  }
}

// 回收站无限滚动：滚动到底时追加下一页
// 与 loadNextMediaPage 同构，但作用于独立的 recycleBin* 游标，两者互不干扰
export async function loadNextRecycleBinPage(): Promise<void> {
  if (!window.electronAPI?.media?.list) return
  const { recycleBinLoadingMore, recycleBinHasMore, recycleBinPage } = useMediaStore.getState()
  // 并发保护：Virtuoso 的 endReached 在一次触底中可能连续触发多次
  if (recycleBinLoadingMore || !recycleBinHasMore) return

  useMediaStore.setState({ recycleBinLoadingMore: true })
  try {
    const nextPage = recycleBinPage + 1
    const result = await window.electronAPI.media.list({
      deletedOnly: true,
      page: nextPage,
      pageSize: RECYCLE_BIN_PAGE_SIZE
    })
    if (!result?.files) return
    const incoming = result.files as MediaFile[]
    const state = useMediaStore.getState()
    useMediaStore.setState({
      recycleBinFiles: [
        ...state.recycleBinFiles,
        ...dedupeAgainst(state.recycleBinFiles, incoming)
      ],
      recycleBinTotal: result.total ?? state.recycleBinTotal,
      recycleBinPage: nextPage,
      recycleBinHasMore: result.hasMore ?? false
    })
  } catch (error) {
    // 取数失败时保持游标不变，用户再次触底即可重试
    console.error(i18n.t('mediaStore.log.loadRecycleBinMoreFailed'), error)
  } finally {
    useMediaStore.setState({ recycleBinLoadingMore: false })
  }
}
