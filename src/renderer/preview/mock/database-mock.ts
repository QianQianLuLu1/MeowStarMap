// 数据库类操作 Mock：所有不涉及本地文件、仅读写 SQLite 的操作
// 返回静态 JSON / 内存可变数据，支持编辑/删除/恢复等操作的即时反馈

import i18n from '../../i18n'
import mediaSamplesRaw from './data/media-samples.json'
import categoriesRaw from './data/categories.json'
import profilesRaw from './data/profiles.json'
import outfitStatsRaw from './data/outfit-stats.json'
import editorPresetsRaw from './data/editor-presets.json'
import watermarkTemplatesRaw from './data/watermark-templates.json'
import { MOCK_THUMBNAILS } from './data/thumbnails'

// 内存中的可变数据副本（编辑/收藏/评分等操作即时反馈）
type MediaRecord = (typeof mediaSamplesRaw)[number] & {
  thumbnail?: string
  is_deleted?: boolean
  deleted_at?: string | null
}

// 不内联 base64 数据：thumbnail 字段使用 mock:// 路径，渲染时通过 resolver 按需解析
// 避免 71 条 base64 字符串（~1.75MB）进入 Zustand 状态和 Virtuoso 管道导致栈溢出
let mediaData: MediaRecord[] = (mediaSamplesRaw as MediaRecord[]).map((m) => ({
  ...m,
  thumbnail: `mock://thumb-${m.id}.jpg`
}))

let categoryData = [...categoriesRaw]
// 显式标注类型：JSON 推断的 last_active_at 为 string，但运行时支持 null
type ProfileRecord = {
  uid: string
  nickname: string
  avatar: string | null
  created_at: string
  last_active_at: string | null
}
const profileData: ProfileRecord[] = (profilesRaw as ProfileRecord[]).map((p) => ({ ...p }))
const settingsMap = new Map<string, unknown>()

// 默认档案 uid（与第一条 profile 对应，模拟 setCurrent 后的持久化）
let currentProfileUid = profileData[0]?.uid ?? ''

function paginate<T>(items: T[], page: number, pageSize: number): { slice: T[]; hasMore: boolean } {
  const start = Math.max(0, page) * pageSize
  const slice = items.slice(start, start + pageSize)
  return { slice, hasMore: start + pageSize < items.length }
}

// 缓存统计：基于「模拟数据/缓存」文件夹的真实文件信息
const MOCK_CACHE_FILES = [
  { name: '3RzYcMO3Jpxr5Wfa.ico', size: 737455 },
  { name: 'cSTqnPxBQOWYnYhq.webm', size: 74654762 },
  { name: 'cYC1b8hRewuyQwJZ.jpg', size: 447943 },
  { name: 'gJ5MIReuFak335bm.jpg', size: 301596 },
  { name: 'gJdrcqITdWB8dXUD.png', size: 591132 },
  { name: 'GUtvVMA3qwWhx2WU.png', size: 2890930 },
  { name: 'JsSksNEuN9m44yd8.jpg', size: 3907440 },
  { name: 'JvUPQ7o6CslQwbKr.jpg', size: 632091 },
  { name: 'kVa6nG44fdbfr0xl.webm', size: 52722078 },
  { name: 'wBeyEQFED31yp9h7.png', size: 2619559 },
  { name: 'x0uFmq3EgtqKeSlu.png', size: 4154693 }
]
const MOCK_CACHE_TOTAL = MOCK_CACHE_FILES.reduce((sum, f) => sum + f.size, 0)
let cacheState = {
  totalSize: MOCK_CACHE_TOTAL,
  fileCount: MOCK_CACHE_FILES.length,
  limit: 2 * 1024 * 1024 * 1024,
  cacheDir: 'C:\\Users\\Player\\AppData\\Roaming\\wxnn-photo-manager\\cache'
}

// 启动器缓存媒体记录：独立于图库数据，仅在 mediaSource='launcher' 时返回
// 避免缓存文件混入图库板块
const launcherCacheData: MediaRecord[] = MOCK_CACHE_FILES.map((f, i) => ({
  id: String(72 + i),
  file_path: `mock://sample-${72 + i}.jpg`,
  file_name: f.name,
  file_type: f.name.endsWith('.webm') ? 'video' : 'image',
  file_ext: '.' + f.name.split('.').pop(),
  file_size: f.size,
  width: 1280,
  height: 800,
  created_at: `2026-07-30T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
  modified_at: `2026-07-30T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
  is_favorite: false,
  rating: 0,
  tags: [],
  notes: '',
  outfit: '',
  account_uid: 'launcher-cache',
  album_type: 'launcher_cache',
  media_source: 'launcher',
  scene_category: 'launcher',
  scene_time: 'unknown',
  is_deleted: false,
  is_missing: false,
  is_corrupted: false,
  exif: undefined,
  thumbnail: `mock://thumb-${72 + i}.jpg`
}))

// 重复检测：从图库中挑选的重复文件分组（基于相同文件大小+尺寸的精确重复对）
const MOCK_DUPLICATE_GROUPS = [
  [
    {
      id: 3,
      file_path: 'mock://sample-3.jpg',
      file_name: 'Image_1784954823662_525.jpg',
      file_type: 'image',
      file_size: 433610,
      modified_at: '2026-07-25T04:47:03.662Z',
      width: 2560,
      height: 1600,
      is_favorite: false,
      rating: 3
    },
    {
      id: 23,
      file_path: 'mock://sample-23.jpg',
      file_name: 'Image_1785218270229_601.jpg',
      file_type: 'image',
      file_size: 433610,
      modified_at: '2026-07-28T05:57:50.229Z',
      width: 2560,
      height: 1600,
      is_favorite: false,
      rating: 3
    }
  ],
  [
    {
      id: 4,
      file_path: 'mock://sample-4.jpg',
      file_name: 'Image_1784954826320_941.jpg',
      file_type: 'image',
      file_size: 573291,
      modified_at: '2026-07-25T04:47:06.320Z',
      width: 2560,
      height: 1600,
      is_favorite: false,
      rating: 4
    },
    {
      id: 22,
      file_path: 'mock://sample-22.jpg',
      file_name: 'Image_1785218266544_561.jpg',
      file_type: 'image',
      file_size: 573291,
      modified_at: '2026-07-28T05:57:46.544Z',
      width: 2560,
      height: 1600,
      is_favorite: false,
      rating: 2
    }
  ],
  [
    {
      id: 5,
      file_path: 'mock://sample-5.jpg',
      file_name: 'Image_1784954837478_614.jpg',
      file_type: 'image',
      file_size: 670526,
      modified_at: '2026-07-25T04:47:17.478Z',
      width: 2560,
      height: 1600,
      is_favorite: true,
      rating: 5
    },
    {
      id: 21,
      file_path: 'mock://sample-21.jpg',
      file_name: 'Image_1785218259774_574.jpg',
      file_type: 'image',
      file_size: 670526,
      modified_at: '2026-07-28T05:57:39.774Z',
      width: 2560,
      height: 1600,
      is_favorite: true,
      rating: 1
    }
  ],
  [
    {
      id: 6,
      file_path: 'mock://sample-6.jpg',
      file_name: 'Image_1784954850438_859.jpg',
      file_type: 'image',
      file_size: 508782,
      modified_at: '2026-07-25T04:47:30.438Z',
      width: 2407,
      height: 1504,
      is_favorite: false,
      rating: 1
    },
    {
      id: 20,
      file_path: 'mock://sample-20.jpg',
      file_name: 'Image_1785218244864_486.jpg',
      file_type: 'image',
      file_size: 508782,
      modified_at: '2026-07-28T05:57:24.864Z',
      width: 2407,
      height: 1504,
      is_favorite: false,
      rating: 5
    }
  ]
]
const MOCK_BEST_ITEM_IDS = [3, 4, 5, 20]
const MOCK_WASTED_BYTES = MOCK_DUPLICATE_GROUPS.reduce(
  (sum, group) => sum + group[0].file_size * (group.length - 1),
  0
)

export const databaseMock = {
  // 媒体列表
  media: {
    list: async (options?: {
      page?: number
      pageSize?: number
      deletedOnly?: boolean
      accountUid?: string
      mediaSource?: string
    }) => {
      const page = options?.page ?? 0
      const pageSize = options?.pageSize ?? 500
      // mediaSource='launcher' 时从独立的缓存数据返回，不混入图库数据
      let source = mediaData
      if (options?.mediaSource === 'launcher') {
        source = launcherCacheData
      }
      let filtered = source
      if (options?.deletedOnly) {
        filtered = filtered.filter((m) => m.is_deleted === true)
      } else {
        filtered = filtered.filter((m) => !m.is_deleted)
      }
      // 'all' / undefined 表示不过滤档案（与主进程 buildListWhereClause 语义一致）
      if (options?.accountUid && options.accountUid !== 'all') {
        filtered = filtered.filter((m) => m.account_uid === options.accountUid)
      }
      if (
        options?.mediaSource &&
        options.mediaSource !== 'all' &&
        options.mediaSource !== 'launcher'
      ) {
        filtered = filtered.filter((m) => m.media_source === options.mediaSource)
      }
      const { slice, hasMore } = paginate(filtered, page, pageSize)
      return {
        success: true,
        files: slice,
        total: filtered.length,
        page,
        pageSize,
        hasMore
      }
    },
    search: async (keyword: string, limit?: number) => {
      const k = keyword.toLowerCase()
      const matched = mediaData
        .filter((m) => m.file_name.toLowerCase().includes(k))
        .slice(0, limit ?? 50)
      return {
        success: true,
        results: matched.map((m) => ({
          id: Number(m.id),
          file_path: m.file_path,
          file_name: m.file_name
        })),
        total: matched.length,
        usedFts5: false
      }
    },
    findDuplicates: async () => ({
      success: true,
      duplicates: MOCK_DUPLICATE_GROUPS,
      bestItemIds: MOCK_BEST_ITEM_IDS,
      totalGroups: MOCK_DUPLICATE_GROUPS.length,
      totalFiles: MOCK_DUPLICATE_GROUPS.reduce((sum, g) => sum + g.length, 0),
      wastedBytes: MOCK_WASTED_BYTES,
      scannedFiles: mediaData.length
    }),
    findSimilar: async () => ({
      success: true,
      duplicates: MOCK_DUPLICATE_GROUPS,
      bestItemIds: MOCK_BEST_ITEM_IDS,
      totalGroups: MOCK_DUPLICATE_GROUPS.length,
      totalFiles: MOCK_DUPLICATE_GROUPS.reduce((sum, g) => sum + g.length, 0),
      wastedBytes: MOCK_WASTED_BYTES,
      scannedFiles: mediaData.length,
      threshold: 5,
      hashedFiles: mediaData.length
    }),
    generatePhash: async () => ({
      success: true,
      message: i18n.t('mock.message.phashDone'),
      processed: mediaData.length,
      total: mediaData.length
    }),
    getGroupCounts: async (dimension: string) => {
      const counters: Record<string, Map<string, number>> = {}
      for (const m of mediaData) {
        const key = String((m as Record<string, unknown>)[dimension] ?? 'unknown')
        if (!counters[dimension]) counters[dimension] = new Map()
        counters[dimension].set(key, (counters[dimension].get(key) ?? 0) + 1)
      }
      const groups = Array.from(counters[dimension]?.entries() ?? []).map(([key, count]) => ({
        key,
        count
      }))
      return { success: true, groups }
    },
    markDuplicates: async () => ({
      success: true,
      message: i18n.t('mock.message.duplicatesMarked', {
        count: String(MOCK_DUPLICATE_GROUPS.reduce((sum, g) => sum + g.length - 1, 0))
      }),
      markedDuplicates: MOCK_DUPLICATE_GROUPS.reduce((sum, g) => sum + g.length - 1, 0),
      totalGroups: MOCK_DUPLICATE_GROUPS.length
    }),
    listDuplicateGroups: async () => ({
      success: true,
      groups: MOCK_DUPLICATE_GROUPS.map((group, i) => ({
        originalId: MOCK_BEST_ITEM_IDS[i] ?? group[0].id,
        original: group.find((f) => f.id === MOCK_BEST_ITEM_IDS[i]) ?? group[0],
        duplicates: group.filter((f) => f.id !== MOCK_BEST_ITEM_IDS[i])
      })),
      totalGroups: MOCK_DUPLICATE_GROUPS.length
    }),
    searchBuildDocs: async () => ({
      success: true,
      docs: [],
      total: 0,
      hasMore: false
    }),
    // eslint-disable-next-line no-restricted-syntax -- Mock 路径占位标识（数据值，非 UI 文案）
    searchExportIndex: async () => ({ success: true, saved: false, path: '预览版' }),
    searchImportIndex: async () => ({
      success: true,
      segments: [],
      fileSize: 0,
      exportedAt: new Date().toISOString(),
      schemaHash: ''
    })
  },

  // 分类
  category: {
    list: async () => ({ success: true, categories: categoryData }),
    create: async (name: string) => {
      const id = Date.now()
      categoryData.push({
        id,
        name,
        icon: '📁',
        color: '#888888',
        sort_order: categoryData.length + 1,
        parent_id: null,
        is_system: false
      })
      return { success: true, id }
    },
    update: async (id: number, updates: Record<string, unknown>) => {
      categoryData = categoryData.map((c) => (c.id === id ? { ...c, ...updates } : c))
      return { success: true }
    },
    delete: async (id: number) => {
      categoryData = categoryData.filter((c) => c.id !== id)
      return { success: true }
    },
    reorder: async () => ({ success: true })
  },

  // 角色档案
  profile: {
    list: async () => ({ success: true, profiles: profileData }),
    add: async (uid: string, nickname: string) => {
      profileData.push({
        uid,
        nickname,
        avatar: null,
        created_at: new Date().toISOString(),
        last_active_at: null
      })
      return { success: true }
    },
    update: async (uid: string, nickname?: string) => {
      const idx = profileData.findIndex((p) => p.uid === uid)
      if (idx >= 0 && nickname) profileData[idx].nickname = nickname
      return { success: true }
    },
    delete: async (uid: string) => {
      const idx = profileData.findIndex((p) => p.uid === uid)
      if (idx >= 0) profileData.splice(idx, 1)
      if (currentProfileUid === uid) currentProfileUid = profileData[0]?.uid ?? ''
      return { success: true }
    },
    setCurrent: async (uid: string) => {
      currentProfileUid = uid
      return { success: true }
    },
    getStats: async (_uid: string) => ({
      success: true,
      stats: {
        totalCount: mediaData.length,
        imageCount: mediaData.length,
        videoCount: 0,
        totalSize: mediaData.reduce((sum, m) => sum + m.file_size, 0),
        earliestTime: mediaData[0]?.created_at ?? null,
        latestTime: mediaData[mediaData.length - 1]?.created_at ?? null,
        topOutfits: [],
        topScenes: [],
        timeDistribution: []
      }
    }),
    transferFiles: async () => ({ success: true })
  },

  // 媒体操作（仅修改内存数据）
  mediaAction: {
    updateRating: async (mediaId: number, rating: number) => {
      const m = mediaData.find((x) => Number(x.id) === mediaId)
      if (m) m.rating = rating
      return { success: true }
    },
    updateFavorite: async (mediaId: number, isFavorite: boolean) => {
      const m = mediaData.find((x) => Number(x.id) === mediaId)
      if (m) m.is_favorite = isFavorite
      return { success: true }
    },
    updateTags: async (mediaId: number, tags: string[]) => {
      const m = mediaData.find((x) => Number(x.id) === mediaId)
      if (m) m.tags = tags
      return { success: true }
    },
    updateNotes: async (mediaId: number, notes: string) => {
      const m = mediaData.find((x) => Number(x.id) === mediaId)
      if (m) m.notes = notes
      return { success: true }
    },
    updateCategory: async () => ({ success: true }),
    updateOutfit: async (mediaId: number, outfit: string) => {
      const m = mediaData.find((x) => Number(x.id) === mediaId)
      if (m) m.outfit = outfit
      return { success: true }
    },
    analyzeSceneTime: async () => ({
      success: true,
      message: i18n.t('mock.message.batchAnalysisUnsupported'),
      analyzed: 0
    }),
    delete: async (mediaId: number) => {
      mediaData = mediaData.filter((m) => Number(m.id) !== mediaId)
      return { success: true }
    },
    softDelete: async (mediaIds: number[]) => {
      mediaData = mediaData.map((m) =>
        mediaIds.includes(Number(m.id))
          ? { ...m, is_deleted: true, deleted_at: new Date().toISOString() }
          : m
      )
      return {
        success: true,
        message: i18n.t('mock.message.softDeleted', { count: String(mediaIds.length) })
      }
    },
    restore: async (mediaIds: number[]) => {
      mediaData = mediaData.map((m) =>
        mediaIds.includes(Number(m.id)) ? { ...m, is_deleted: false, deleted_at: null } : m
      )
      return {
        success: true,
        message: i18n.t('mock.message.restored', { count: String(mediaIds.length) })
      }
    },
    permanentDelete: async (mediaIds: number[]) => {
      mediaData = mediaData.filter((m) => !mediaIds.includes(Number(m.id)))
      return {
        success: true,
        message: i18n.t('mock.message.permanentDeleted', { count: String(mediaIds.length) })
      }
    },
    emptyRecycleBin: async () => {
      const before = mediaData.length
      mediaData = mediaData.filter((m) => !m.is_deleted)
      const cleared = before - mediaData.length
      return {
        success: true,
        message: i18n.t('mock.message.recycleBinCleared', { count: String(cleared) })
      }
    },
    cleanupMissing: async () => ({
      success: true,
      message: i18n.t('mock.message.noMissingFiles'),
      cleaned: 0
    }),
    removeMissing: async () => ({ success: true, message: i18n.t('mock.message.noMissingFiles') }),
    cleanupCorrupted: async () => ({
      success: true,
      message: i18n.t('mock.message.noCorruptedFiles'),
      cleared: 0
    }),
    removeCorrupted: async () => ({
      success: true,
      message: i18n.t('mock.message.noCorruptedFiles')
    }),
    getOutfitStats: async () => ({ success: true, stats: outfitStatsRaw })
  },

  // 编辑器预设（仅查询，写入操作返回成功但不持久化）
  editor: {
    loadPresets: async () => ({ success: true, presets: editorPresetsRaw }),
    exportPreset: async () => ({ success: true, id: Date.now() }),
    deletePreset: async () => ({ success: true }),
    exportPresetToFile: async () => ({
      success: false,
      message: i18n.t('mock.message.exportFileUnsupported')
    }),
    importPresetFromFile: async () => ({
      success: false,
      message: i18n.t('mock.message.importFileUnsupported')
    }),
    readMetadata: async () => null
  },

  // 水印模板（仅查询）
  watermark: {
    loadTemplates: async () => watermarkTemplatesRaw,
    saveTemplate: async () => ({ success: true, id: Date.now() }),
    deleteTemplate: async () => ({ success: true })
  },

  // 备份管理（仅查询，操作返回空状态）
  backup: {
    // eslint-disable-next-line no-restricted-syntax -- Mock 路径占位标识（数据值，非 UI 文案）
    list: async () => ({ success: true, backups: [], backupDir: '预览版' }),
    // eslint-disable-next-line no-restricted-syntax -- Mock 路径占位标识（数据值，非 UI 文案）
    getDir: async () => '预览版'
  },

  // 缓存管理：基于「模拟数据/缓存」文件夹的真实文件信息
  cache: {
    getStats: async () => ({ ...cacheState }),
    clean: async () => {
      const cleared = { clearedSize: cacheState.totalSize, clearedCount: cacheState.fileCount }
      cacheState = { ...cacheState, totalSize: 0, fileCount: 0 }
      return cleared
    },
    setLimit: async (bytes: number) => {
      cacheState = { ...cacheState, limit: bytes }
      return { applied: true, evicted: 0 }
    },
    enforceLimit: async () => ({
      evicted: 0,
      totalSize: cacheState.totalSize,
      fileCount: cacheState.fileCount
    }),
    getDir: async () => cacheState.cacheDir,
    setDir: async () => ({
      success: true,
      needRestart: true,
      message: i18n.t('mock.message.noRestartNeeded')
    }),
    resetDir: async () => ({
      success: true,
      needRestart: true,
      message: i18n.t('mock.message.noRestartNeeded')
    })
  },

  // 日志管理（仅查询，返回空状态）
  log: {
    listFaults: async () => ({ success: true, faults: [] }),
    getFaultDetail: async () => ({ success: true, fault: null }),
    // eslint-disable-next-line no-restricted-syntax -- Mock 路径占位标识（数据值，非 UI 文案）
    getDirectoryPath: async () => ({ success: true, path: '预览版' }),
    getStats: async () => ({
      success: true,
      faultCount: 0,
      totalSize: 0,
      fileCount: 0,
      oldestTime: null
    }),
    // eslint-disable-next-line no-restricted-syntax -- Mock 路径占位标识（数据值，非 UI 文案）
    getDir: async () => '预览版',
    reportRendererError: async () => ({ success: true })
  },

  // 崩溃报告（仅查询，返回空状态）
  crash: {
    list: async () => ({ success: true, crashes: [] }),
    getStats: async () => ({
      success: true,
      fileCount: 0,
      totalSize: 0,
      oldestTime: null
    }),
    // eslint-disable-next-line no-restricted-syntax -- Mock 路径占位标识（数据值，非 UI 文案）
    getDir: async () => '预览版'
  },

  // 设置（localStorage 持久化）
  settings: {
    get: async (key: string, defaultValue?: unknown) => {
      if (settingsMap.has(key)) return settingsMap.get(key)
      try {
        const ls = localStorage.getItem(`wxnn-${key}`)
        if (ls !== null) return JSON.parse(ls)
      } catch {
        // localStorage 不可用或解析失败，回退默认值
      }
      return defaultValue
    },
    set: async (key: string, value: unknown) => {
      settingsMap.set(key, value)
      try {
        localStorage.setItem(`wxnn-${key}`, JSON.stringify(value))
      } catch {
        // localStorage 不可用静默忽略
      }
      return { success: true }
    }
  },

  // UI 主题（localStorage 持久化）
  uiTheme: {
    get: async () => {
      try {
        const raw = localStorage.getItem('wxnn-ui-theme')
        if (!raw) return { theme: 'default' as const }
        // themeStore 经 zustand persist 以 JSON 格式写同一个 key；
        // 兼容裸值（旧版本 mock set 写入的历史数据）与 persist JSON（{"state":{"theme":...}}）两种形态，
        // 否则 App 的 uiTheme.get 同步效果会把刚设置的主题回滚为默认
        let theme: string = raw
        try {
          const parsed = JSON.parse(raw) as { state?: { theme?: string } }
          if (parsed && typeof parsed === 'object' && parsed.state?.theme) {
            theme = parsed.state.theme
          }
        } catch {
          // 非 JSON：保持裸值
        }
        return {
          theme: (theme === 'soft-pink-luxury' ? theme : 'default') as
            'default' | 'soft-pink-luxury'
        }
      } catch {
        return { theme: 'default' as const }
      }
    },
    set: async (theme: 'default' | 'soft-pink-luxury') => {
      try {
        // 与 themeStore 的 zustand persist 同构写 JSON（默认 version 0），
        // 避免裸值覆盖 persist JSON 后重启解析失败回滚为默认主题
        localStorage.setItem('wxnn-ui-theme', JSON.stringify({ state: { theme }, version: 0 }))
      } catch {
        // 静默忽略
      }
      return { success: true }
    }
  },

  // 应用版本
  app: {
    getVersion: async () => '2.5.3'
  },

  // 操作历史
  operationHistory: {
    add: async () => ({ success: true, id: Date.now() }),
    list: async () => ({ success: true, records: [] }),
    remove: async () => ({ success: true }),
    clear: async () => ({ success: true })
  },

  // 缩略图（返回 SVG 占位图）
  thumbnail: {
    generate: async (filePath: string) => {
      // 从 mock://sample-N.jpg 提取序号
      const match = filePath?.match(/sample-(\d+)/)
      if (match) return MOCK_THUMBNAILS[match[1]] ?? null
      return null
    }
  },

  // 视频元数据（静态）
  video: {
    thumbnail: async () => ({ thumbnail: null, hasThumbnail: false }),
    metadata: async () => ({
      success: false,
      message: i18n.t('mock.message.videoMetadataUnsupported')
    })
  },

  // 分享应用检测（返回未安装）
  share: {
    detectApp: async () => ({
      success: true,
      installed: false,
      running: false,
      installPath: null
    })
  },

  // 对话框（浏览器原生降级）
  dialog: {
    selectDirectory: async () => null,
    openFile: async () => null,
    saveFile: async () => null,
    showMessageBox: async () => 0
  }
} as const
