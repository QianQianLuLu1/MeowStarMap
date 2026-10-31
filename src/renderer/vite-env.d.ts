/// <reference types="vite/client" />

declare module '*.svg' {
  const content: React.FunctionComponent<React.SVGAttributes<SVGElement>>
  export default content
}

declare module '*.png' {
  const content: string
  export default content
}

type ExportFormat = 'jpg' | 'jpeg' | 'png' | 'webp' | 'original'

// P0-F2：与主进程 ExportOptions 接口保持一致（含 useDefaultDir 字段）
interface ExportOptions {
  quality?: number
  format?: ExportFormat
  namingPattern?: string
  useDefaultDir?: boolean
}

// F-S10：重复文件检测返回的单条记录（对应主进程 DuplicateItem 接口）
interface DuplicateItem {
  id: number
  file_path: string
  file_name: string
  file_type: string
  file_size: number
  modified_at: string
  width: number | null
  height: number | null
  is_favorite: boolean
  rating: number
}

// T03：套装图鉴统计（对应主进程 OutfitStat 接口）
interface OutfitStat {
  outfit: string
  count: number
  latestCreatedAt: string
  coverFilePath: string
  coverThumbnail: string | null
  /** N3：封面行媒体类型——视频封面无缩略图时渲染占位，绝不把视频文件当 <img> src */
  coverFileType: 'image' | 'video' | null
}

// 日志管理：故障类型与故障记录（与主进程 logger.ts 保持同步）
// P2-D：补全 FaultType 缺失的 4 个类型（与 settings/shared.tsx 保持一致）
type FaultType =
  | 'uncaughtException'
  | 'unhandledRejection'
  | 'rendererCrash'
  | 'rendererError'
  | 'ipcError'
  | 'manual'
  | 'rendererComponent'
  | 'rendererPromise'
  | 'rendererResource'
  | 'exitDiagnosis'

interface FaultRecord {
  id: string
  timestamp: string
  type: FaultType
  summary: string
  detail: string
  context?: Record<string, unknown>
  file: string
  // P0-1 新增环境信息字段（旧日志可能缺失，UI 兜底显示"未知"）
  appVersion?: string
  electronVersion?: string
  nodeVersion?: string
  platform?: string
  osVersion?: string
  pid?: number
  uptime?: number
}

// T01：数据库备份记录
interface BackupRecord {
  filename: string
  filePath: string
  size: number
  createdAt: string
}

// T13：崩溃 dump 文件元信息（对应主进程 CrashRecord 接口）
// P2-D：新增 crashReason / topFrame 字段（与 settings/shared.tsx 保持一致）
interface CrashRecord {
  filename: string
  filePath: string
  size: number
  mtime: string
  processType: string
  crashReason?: string
  topFrame?: string
}

// T14：导入文件预览信息
interface ImportFilePreview {
  sourcePath: string
  fileName: string
  size: number
  mtime: string
  ext: string
  isVideo: boolean
}

// T14：导入命名规则与分类策略类型
type ImportNamingRule = 'keep' | 'date' | 'seq'
type ImportCategorize = 'flat' | 'byDate' | 'byMonth'
type ImportConflictStrategy = 'skip' | 'rename' | 'overwrite'

// T14：导入选项
interface ImportOptions {
  namingRule: ImportNamingRule
  categorize: ImportCategorize
  conflictStrategy: ImportConflictStrategy
  seqStart?: number
}

/**
 * 游戏安装目录候选（契约同 src/main/scanner/game-directory-discovery.ts 的 GameRootCandidate）。
 * mtimeMs 用于需求三.3 的「默认选中修改时间最新的目录」。
 */
interface GameRootCandidate {
  path: string
  /** 目录修改时间（毫秒）；读取失败时为 0 */
  mtimeMs: number
  /** 该根下是否存在 GamePlayPhotos（Saved 变体或其无 Saved 兼容变体） */
  hasGamePlayPhotos: boolean
  source: 'custom' | 'official' | 'steam' | 'epic'
}

// 搭配码 structured 解析结果（阶段 1）；与主进程 ClothDiyStructuredOutfit 保持一致，
// 见 src/main/types/decryption.ts（数据契约 docs/plans/cloth-outfit-data-contract.md §4）
interface ClothDiyStructuredCloth {
  /** 服装完整 ID */
  id: number
  /** 部位类型（从 ID 拆解） */
  clothType: number
  /** 状态（从 ID 拆解） */
  state: number
  /** 服装系列（从 ID 拆解） */
  species: number
  /** 款型（从 ID 拆解） */
  outfitFeature: number
}

interface ClothDiyStructuredOutfit {
  /** 动作 ID；缺省/0/负数/非整数/字符串时省略 */
  poseId?: number
  /** 身着服饰列表（wearingClothes 投影，保持原顺序，ID ≤ 0 或非有限数跳过） */
  clothes: ClothDiyStructuredCloth[]
}

interface WindowElectronAPI {
  // preload 已通过 contextBridge 暴露；renderer 在就绪时调用通知主进程（对应 ipcRenderer.send('renderer:ready')）
  reportReady: () => void
  scanner: {
    start: (options?: {
      path?: string
      incremental?: boolean
      customKnownPaths?: string[]
      excludedPaths?: string[]
      fullScan?: boolean
    }) => Promise<{ success: boolean; message?: string; filesFound?: number }>
    stop: () => Promise<{ success: boolean }>
    // 建议改#6：明确 status 返回结构，统一引用 shared 的 ScannerStatus 契约
    // （主进程 getStatus 与 preload 均引用同一类型，避免三端各写一份）
    status: () => Promise<import('../../shared/types/progress').ScannerStatus>
    onProgress: (
      callback: (progress: { scanned: number; found: number; currentPath: string }) => void
    ) => () => void
    onComplete: (
      callback: (result: { success: boolean; message: string; filesFound?: number }) => void
    ) => () => void
    // R12：扫描半可见性提示——主进程检测到 interrupted 扫描记录时广播
    onInterrupted: (callback: (payload: { count: number }) => void) => () => void
    // 全链路诊断：读取结构化扫描轨迹 / 清空 / 导出到文件
    getScanLog: () => Promise<ScanLogEntry[]>
    clearScanLog: () => Promise<{ ok: boolean }>
    exportScanLog: (format?: 'json' | 'log') => Promise<{
      ok: boolean
      path?: string
      count?: number
    }>
    // 需求三.3：枚举全部游戏目录候选（含来源、修改时间、是否含 GamePlayPhotos）
    detectGameRoots: (options?: { customPaths?: string[] }) => Promise<GameRootCandidate[]>
  }
  decrypt: {
    decodeFile: (
      filePath: string,
      albumType: string,
      uid?: string
    ) => Promise<{
      ok: boolean
      data?: {
        hasParams: boolean
        camera?: {
          focalLength: number
          apertureSection: number
          brightness: number
          exposure: number
          contrast: number
          saturation: number
          vibrance: number
          highlights: number
          shadows: number
          vignetteIntensity: number
          bloomIntensity: number
          bloomThreshold: number
          portraitMode: boolean
          filter?: { id: string; strength: number }
          light?: { id: string; strength: number }
          rawParams: string
          // RichCameraParams 新增字段
          zoom: number
          rotation: number
          cameraYaw: number
          cameraPitch: number
          cameraLoc: { x: number; y: number; z: number } | null
          pose: number
          framedMoment: number
          momoHidden: 'enabled' | 'disabled' | null
        }
        photography?: {
          edit: { enabled: boolean; hasSticker: boolean; hasText: boolean }
          date: { day: number } | null
          time: { hour: number; minute: number; second: number } | null
          location: { pos: { x: number; y: number; z: number }; name: string | null } | null
          weather: number | null
          photoWall: number[]
          tasks: Array<{ type: 'puzzle' | 'risk' | 'interactive'; tag: number }>
        }
        nikki?: {
          giantState: boolean
          hidden: boolean
          loc: { x: number; y: number; z: number } | null
          rot: { yaw: number; pitch: number; roll: number } | null
          scale: { x: number; y: number; z: number } | null
        }
        dressing?: {
          clothes: Array<{
            id: number
            clothType: number
            clothTypeName: string | null
            state: number
            species: number
          }>
          eureka: Array<{
            id: number
            level: number
            color: number
            attachmentPoint: number
            outfit: number
          }>
        }
        interactions?: {
          mount: {
            id: number | string
            loc: { x: number; y: number; z: number }
            rot: { yaw: number; pitch: number; roll: number }
            scale: { x: number; y: number; z: number }
          } | null
          carrier: {
            id: number | string
            loc: { x: number; y: number; z: number }
            rot: { yaw: number; pitch: number; roll: number }
            scale: { x: number; y: number; z: number }
          } | null
          interactions: Array<{
            id: number | string
            loc: { x: number; y: number; z: number }
            rot: { yaw: number; pitch: number; roll: number }
            scale: { x: number; y: number; z: number }
          }>
        }
        error?: string
        /** 文件本身不包含该参数（空态语义，区别于真实错误） */
        notContained?: boolean
      }
      message?: string
    }>
    // Group 2: 相机参数加密
    encodeCameraParams: (
      jsonText: string
    ) => Promise<{ ok: boolean; data?: string; message?: string }>
    // Group 3: 染色分享码解码
    decodeClothDiy: (codeStr: string) => Promise<{
      ok: boolean
      data?: {
        timestamp?: number
        uidBytes?: string
        networkData?: string
        /** 结构化解析结果（阶段 1）：解析成功为投影对象，解析失败为 null，networkData 缺省时缺省 */
        structured?: ClothDiyStructuredOutfit | null
      }
      message?: string
    }>
    // Group 4: 家园建造分享码解码
    decodeHomeBuild: (codeStr: string) => Promise<{
      ok: boolean
      data?: { server?: number; networkData?: string }
      message?: string
    }>
    // Group 5: 服饰数据批量查询（阶段 2，第三方 gongeo.us 数据源；
    // 数据源失败静默降级为空对象；类型真相源 src/shared/types/electron-api.ts）
    lookupCloth: (ids: number[]) => Promise<{
      ok: boolean
      data?: Record<string, import('../../shared/types/electron-api').ClothDataInfo>
      message?: string
    }>
    // Group 6: 清空搭配码网络结果缓存（阶段 3；本阶段无 UI；
    // 类型真相源 src/shared/types/electron-api.ts）
    clearClothCache: () => Promise<{
      ok: boolean
      data: { clearedCount: number; clearedSize: number }
      message?: string
    }>
  }
  file: {
    delete: (filePaths: string[]) => Promise<{ success: boolean; message: string }>
    deletePermanent: (filePaths: string[]) => Promise<{ success: boolean; message: string }>
    copy: (
      sourcePaths: string[],
      targetDir: string
    ) => Promise<{ success: boolean; message: string; actualPaths?: string[] }>
    move: (
      sourcePaths: string[],
      targetDir: string
    ) => Promise<{ success: boolean; message: string; actualPaths?: string[] }>
    // FIX(组21-2): 与 preload.ts 的 FileOperationResult.renamed 保持一致——
    // rename 落盘路径可能含自动追加的扩展名，撤销历史需要真实的 newPath
    rename: (
      oldPath: string,
      newName: string
    ) => Promise<{
      success: boolean
      message: string
      renamed?: { oldPath: string; newPath: string; newFileName: string }[]
    }>
    // T12：批量重命名返回结构
    batchRename: (operations: { oldPath: string; newName: string }[]) => Promise<{
      success: boolean
      message: string
      renamed: { oldPath: string; newPath: string; newFileName: string }[]
      failed: { oldPath: string; message: string }[]
    }>
    export: (
      filePaths: string[],
      targetDir: string,
      options?: ExportOptions
    ) => Promise<{ success: boolean; message: string }>
    saveAs: (
      filePath: string,
      targetDir: string,
      newName?: string
    ) => Promise<{ success: boolean; message: string; newPath?: string }>
    getExif: (filePath: string) => Promise<{
      camera?: string
      lens?: string
      aperture?: string
      shutter?: string
      iso?: number
      focalLength?: string
      gps?: { latitude: number; longitude: number }
      dateTaken?: string
      width?: number
      height?: number
    }>
  }
  editor: {
    save: (
      filePath: string,
      dataUrl: string,
      options?: { format?: string; quality?: number; params?: string }
    ) => Promise<{ success: boolean; message: string; filePath?: string }>
    saveAs: (
      dataUrl: string,
      options?: { directory?: string; fileName?: string; format?: string; quality?: number }
    ) => Promise<{ success: boolean; message: string; filePath?: string }>
    exportPreset: (preset: {
      name: string
      category: string
      params: string
    }) => Promise<{ success: boolean; id?: number; message?: string }>
    loadPresets: () => Promise<{ success: boolean; presets: unknown[]; message?: string }>
    deletePreset: (id: string | number) => Promise<{ success: boolean; message?: string }>
    exportPresetToFile: (preset: {
      name: string
      category: string
      params: unknown
    }) => Promise<{ success: boolean; filePath?: string; canceled?: boolean; message?: string }>
    importPresetFromFile: () => Promise<{
      success: boolean
      preset?: unknown
      canceled?: boolean
      filePath?: string
      message?: string
    }>
    // XMP 元数据：导出含参数副本（单图）
    exportWithMetadata: (
      sourcePath: string,
      metadata: {
        params: Record<string, unknown>
        filter: { name: string; category: string; params: unknown } | null
        filterIntensity: number
        watermark: Record<string, unknown> | null
      },
      options?: {
        targetDir?: string
        fileName?: string
        format?: 'jpg' | 'jpeg' | 'png' | 'webp'
        quality?: number
      }
    ) => Promise<{ success: boolean; message: string; outputPath?: string }>
    // XMP 元数据：批量导出含参数副本
    batchExportWithMetadata: (
      sourcePaths: string[],
      metadata: {
        params: Record<string, unknown>
        filter: { name: string; category: string; params: unknown } | null
        filterIntensity: number
        watermark: Record<string, unknown> | null
      },
      options: {
        targetDir: string
        format?: 'jpg' | 'jpeg' | 'png' | 'webp'
        quality?: number
      }
    ) => Promise<{
      success: boolean
      successCount: number
      failedCount: number
      outputPaths: string[]
      failures: Array<{ sourcePath: string; error: string }>
      message: string
    }>
    // XMP 元数据：读取已写入的编辑参数（一键恢复）
    readMetadata: (filePath: string) => Promise<{
      schemaVersion: number
      appVersion: string
      exportTimestamp: string
      params: Record<string, unknown>
      filter: { name: string; category: string; params: string } | null
      filterIntensity: number
      watermark: Record<string, unknown> | null
    } | null>
  }
  watermark: {
    apply: (
      config: unknown,
      filePaths: string[],
      targetDir: string
    ) => Promise<{ success: boolean; message: string; processed: number }>
    saveTemplate: (
      name: string,
      config: string
    ) => Promise<{ success: boolean; id?: number; message?: string }>
    loadTemplates: () => Promise<unknown[]>
    deleteTemplate: (id: number) => Promise<{ success: boolean; message?: string }>
    onProgress: (callback: (progress: { current: number; total: number }) => void) => () => void
  }
  category: {
    create: (
      name: string,
      options?: { icon?: string; color?: string; parentId?: number }
    ) => Promise<{ success: boolean; id?: number; message?: string }>
    update: (
      id: number,
      updates: { name?: string; icon?: string; color?: string; parent_id?: number | null }
    ) => Promise<{ success: boolean; message?: string }>
    delete: (id: number) => Promise<{ success: boolean; message?: string }>
    reorder: (
      orders: Array<{ id: number; sort_order: number; parent_id?: number }>
    ) => Promise<{ success: boolean; message?: string }>
    list: () => Promise<{ success: boolean; categories: unknown[]; message?: string }>
  }
  // P0-B：删除 tag 命名空间类型定义（IPC 已移除）
  mediaAction: {
    updateRating: (
      mediaId: number,
      rating: number
    ) => Promise<{ success: boolean; message?: string }>
    // P0-D：删除 toggleFavorite 类型定义
    updateFavorite: (
      mediaId: number,
      isFavorite: boolean
    ) => Promise<{ success: boolean; message?: string }>
    updateTags: (mediaId: number, tags: string[]) => Promise<{ success: boolean; message?: string }>
    updateNotes: (mediaId: number, notes: string) => Promise<{ success: boolean; message?: string }>
    updateCategory: (
      mediaId: number,
      categoryId: number | null
    ) => Promise<{ success: boolean; message?: string }>
    // F-O1：更新套装标注
    updateOutfit: (
      mediaId: number,
      outfit: string
    ) => Promise<{ success: boolean; message?: string }>
    // F-O1：批量分析场景时段
    analyzeSceneTime: (
      mediaIds?: number[]
    ) => Promise<{ success: boolean; message?: string; analyzed?: number }>
    // 物理删除数据库记录（配合文件永久删除场景，与 softDelete 语义不同，不合并）
    delete: (mediaId: number) => Promise<{ success: boolean; message?: string }>
    softDelete: (mediaIds: number[]) => Promise<{ success: boolean; message: string }>
    restore: (mediaIds: number[]) => Promise<{ success: boolean; message: string }>
    // #fix-permanent-delete-error-toast：与主进程真实 data 对齐（无 success 字段，部分失败以 failedCount 判定）
    permanentDelete: (
      mediaIds: number[]
    ) => Promise<{ message: string; deletedCount: number; failedCount: number }>
    emptyRecycleBin: () => Promise<{ message: string }>
    // T02：丢失记录清理（批量 / 单条）
    cleanupMissing: () => Promise<{ success: boolean; message: string; cleared?: number }>
    removeMissing: (mediaId: number) => Promise<{ success: boolean; message: string }>
    // 损坏文件容错：清理所有 is_corrupted=1 的记录（批量 / 单条）
    // 注：preload `call` 在失败时抛出 IpcError，成功时返回 { message, cleared }
    // 此处 success 字段为兼容旧类型声明保留，实际运行时为 undefined
    cleanupCorrupted: () => Promise<{ message: string; cleared: number }>
    removeCorrupted: (mediaId: number) => Promise<{ message: string }>
    // T03：套装图鉴统计
    getOutfitStats: () => Promise<{ success: boolean; message?: string; stats: OutfitStat[] }>
  }
  video: {
    thumbnail: (filePath: string) => Promise<unknown>
    metadata: (filePath: string) => Promise<{
      success: boolean
      message?: string
      path?: string
      size?: number
      duration?: number
      width?: number
      height?: number
      codec?: string
      frameRate?: number
    }>
    export: (
      filePath: string,
      targetDir: string,
      format: string
    ) => Promise<{ success: boolean; message: string }>
    captureFrame: (
      filePath: string,
      currentTime: number,
      targetDir?: string
    ) => Promise<{ success: boolean; message: string; filePath?: string }>
    // F-S9：视频裁剪与调速
    trim: (
      filePath: string,
      startTime: number,
      endTime: number,
      targetDir: string
    ) => Promise<{ success: boolean; message: string; filePath?: string }>
    changeSpeed: (
      filePath: string,
      speed: number,
      targetDir: string
    ) => Promise<{ success: boolean; message: string; filePath?: string }>
    // P1-05：导出 Apple Live Photo（JPG + MOV 配对文件，含 ContentIdentifier UUID）
    exportLivePhoto: (
      filePath: string,
      targetDir: string
    ) => Promise<{
      success: boolean
      message: string
      jpgPath?: string
      movPath?: string
      uuid?: string
    }>
    // 视频编辑（调色 + 水印 + 可选裁剪/调速/格式）→ utilityProcess 渲染 ffmpeg
    edit: (payload: {
      task: {
        inputPath: string
        outputPath: string
        params: unknown
        watermark?: unknown | null
        trim?: { start: number; end: number } | null
        speed?: number | null
        format?: string | null
      }
    }) => Promise<{
      success: boolean
      taskId: string
      message?: string
      outputPath?: string
    }>
    // 批量视频编辑
    editBatch: (payload: {
      tasks: Array<{
        inputPath: string
        outputPath: string
        params: unknown
        watermark?: unknown | null
        trim?: { start: number; end: number } | null
        speed?: number | null
        format?: string | null
      }>
      concurrency?: number
    }) => Promise<{
      success: boolean
      taskId: string
      failedIndexes: number[]
      message?: string
    }>
  }
  dialog: {
    selectDirectory: () => Promise<string | null>
    openFile: (options?: {
      properties?: string[]
      filters?: { name: string; extensions: string[] }[]
    }) => Promise<string | null>
    saveFile: (options?: {
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
    }) => Promise<string | null>
    showMessageBox: (options: {
      type?: string
      title?: string
      message: string
      buttons?: string[]
    }) => Promise<number>
  }
  thumbnail: {
    // P1-03：quality='low' 返回 64px 低质量缩略图（首屏快速预览）
    // quality='high' 返回 512px 高清缩略图（高分屏 DPR ≥ 2 时使用）
    generate: (filePath: string, quality?: 'low' | 'standard' | 'high') => Promise<string | null>
  }
  media: {
    list: (options?: {
      page?: number
      pageSize?: number
      /** keyset 深分页游标：提供则忽略 page/pageSize 走 keyset 分支（性能重构） */
      cursor?: { sortValue: string | number | null; id: number } | null
      includeDeleted?: boolean
      deletedOnly?: boolean
      sortBy?: string
      sortOrder?: string
      accountUid?: string
      albumType?: string
      hideDuplicates?: boolean
      mediaSource?: 'game' | 'launcher' | 'cloud' | 'local_screenshot' | 'all'
      // 损坏文件容错：corruptedOnly=true 仅返回 is_corrupted=1 的记录（"仅看损坏"筛选器）
      corruptedOnly?: boolean
      // 损坏文件容错：hideCorrupted=true 过滤掉 is_corrupted=1 的记录（图库默认视图）
      hideCorrupted?: boolean
      // 图库板块目录限制：true 时仅返回 GamePlayPhotos/{uid}/NikkiPhotos_HighQuality 下的图片，
      // 以及 X6Game/ScreenShot（游戏内截图）、X6Game/Video（游戏内视频）下的媒体
      galleryHighQualityOnly?: boolean
    }) => Promise<{
      success: boolean
      files: unknown[]
      message?: string
      total?: number
      page?: number
      pageSize?: number
      hasMore?: boolean
      /** keyset 下一页游标（深分页优先），无更多页时为 null（性能重构） */
      nextCursor?: { sortValue: string | number | null; id: number } | null
    }>
    // 性能重构 v3：全文搜索文件名（FTS5 优先，LIKE fallback）
    search: (
      keyword: string,
      limit?: number
    ) => Promise<{
      success: boolean
      message?: string
      results: Array<{ id: number; file_path: string; file_name: string }>
      total: number
      usedFts5: boolean
    }>
    // F-S10：重复文件检测——返回 sha256 hash 重复分组及统计信息
    // P1-01：返回值新增 bestItemIds（每组推荐保留的 id，基于评分）
    findDuplicates: () => Promise<{
      success: boolean
      message?: string
      duplicates: DuplicateItem[][]
      bestItemIds: (number | null)[]
      totalGroups: number
      totalFiles: number
      wastedBytes: number
      scannedFiles: number
    }>
    // T05：基于 pHash 的相似图检测——返回汉明距离≤threshold 的图片分组
    // P1-01：返回值新增 bestItemIds（每组推荐保留的 id，基于评分）
    findSimilar: (options?: { threshold?: number }) => Promise<{
      success: boolean
      message?: string
      duplicates: DuplicateItem[][]
      bestItemIds: (number | null)[]
      totalGroups: number
      totalFiles: number
      wastedBytes: number
      scannedFiles: number
      // 相似检测特有：实际使用的阈值与已计算 phash 的图片数
      threshold: number
      hashedFiles: number
    }>
    // T05：手动触发 phash 补算
    generatePhash: () => Promise<{
      success: boolean
      message?: string
      processed?: number
      total?: number
    }>
    // P0-03：智能媒体分组——按维度统计分组数量
    getGroupCounts: (
      dimension: string,
      accountUid?: string,
      mediaSource?: 'game' | 'launcher' | 'cloud' | 'local_screenshot' | 'all'
    ) => Promise<{
      success: boolean
      message?: string
      groups: Array<{ key: string; count: number }>
    }>
    // P1-01：手动触发重复标记（基于 pHash 极严格阈值 + 评分推荐保留）
    markDuplicates: () => Promise<{
      success: boolean
      message?: string
      markedDuplicates: number
      totalGroups: number
    }>
    // P1-01：查询已标记的重复分组（is_duplicate=1 按 original_id 聚合）
    listDuplicateGroups: () => Promise<{
      success: boolean
      message?: string
      groups: Array<{
        originalId: number
        original: DuplicateItem | null
        duplicates: DuplicateItem[]
      }>
      totalGroups: number
    }>
    // 全文搜索：批量拉取索引文档（启动重建 / 增量拉取）
    // id 为 DB INTEGER 类型，渲染进程与 MediaFile.id（string）对齐时需 String(id)
    searchBuildDocs: (options?: {
      since?: string
      limit?: number
      /** 游标：仅返回 id > afterId 的记录；取代原 offset */
      afterId?: number
      /** 是否一次性计算 total（全表 COUNT）；默认 false */
      includeTotal?: boolean
    }) => Promise<{
      success: boolean
      message?: string
      docs: Array<{
        id: number
        file_name: string
        tags: string
        outfit: string
        scene_category: string | null
        notes: string
        indexed_at: string
      }>
      total: number
      hasMore: boolean
    }>
    // 全文搜索：导出索引片段到 userData（持久化）
    searchExportIndex: (
      segments: Array<{ key: string; data: string }>,
      schemaHash?: string
    ) => Promise<{ success: boolean; message?: string; saved: boolean; path: string }>
    // 全文搜索：从 userData 导入索引片段
    searchImportIndex: () => Promise<{
      success: boolean
      message?: string
      segments: Array<{ key: string; data: string }>
      fileSize: number
      exportedAt: string
      schemaHash: string
    }>
    onUpdated: (callback: () => void) => () => void
  }
  // P0-02：角色档案管理
  profile: {
    list: () => Promise<{
      success: boolean
      message?: string
      profiles: Array<{
        uid: string
        nickname: string
        avatar: string | null
        created_at: string
        last_active_at: string | null
      }>
    }>
    add: (
      uid: string,
      nickname: string,
      avatar?: string
    ) => Promise<{ success: boolean; message?: string }>
    update: (
      uid: string,
      nickname?: string,
      avatar?: string
    ) => Promise<{ success: boolean; message?: string }>
    delete: (uid: string) => Promise<{ success: boolean; message?: string }>
    setCurrent: (uid: string) => Promise<{ success: boolean; message?: string }>
    getStats: (uid: string) => Promise<{
      success: boolean
      message?: string
      stats: {
        totalCount: number
        imageCount: number
        videoCount: number
        totalSize: number
        earliestTime: string | null
        latestTime: string | null
        topOutfits: Array<{ outfit: string; cnt: number }>
        topScenes: Array<{ scene_category: string; cnt: number }>
        timeDistribution: Array<{ scene_time: string; cnt: number }>
      } | null
    }>
    // P1-04：跨档案转移——批量更新 media_files.account_uid
    transferFiles: (
      mediaIds: number[],
      targetUid: string
    ) => Promise<{ success: boolean; message?: string }>
  }
  uiTheme: {
    get: () => Promise<{ theme: 'default' | 'soft-pink-luxury' }>
    set: (theme: 'default' | 'soft-pink-luxury') => Promise<{ success: boolean }>
  }
  shell: {
    openExternal: (url: string) => Promise<{ success: boolean }>
    openPath: (dirPath: string) => Promise<{ success: boolean; message?: string }>
    // 在资源管理器中打开文件所在位置并选中该文件
    showItemInFolder: (filePath: string) => Promise<{ success: boolean; message?: string }>
  }
  settings: {
    get: (key: string, defaultValue?: unknown) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<{ success: boolean }>
  }
  // 导出偏好专用通道（export.defaultDir / export.namingPattern 属安全敏感项，不走 settings:set）
  export: {
    setDefaultDir: (dir: string) => Promise<{ saved: boolean }>
    setNamingPattern: (pattern: string) => Promise<{ saved: boolean }>
  }
  data: {
    clear: () => Promise<{ success: boolean; message: string }>
  }
  // T01：数据库备份管理
  backup: {
    // P1-04：支持按档案备份（文件名加入 _{uid} 后缀以便识别）
    create: (options?: {
      accountUid?: string
    }) => Promise<{ success: boolean; backup?: BackupRecord; message?: string }>
    list: () => Promise<{
      success: boolean
      backups: BackupRecord[]
      backupDir: string
      message?: string
    }>
    restore: (filename: string) => Promise<{ success: boolean; message?: string }>
    delete: (filename: string) => Promise<{ success: boolean; message?: string }>
    // 自定义目录支持
    setDir: (dir: string) => Promise<{ success: boolean; needRestart: boolean; message: string }>
    resetDir: () => Promise<{ success: boolean; needRestart: boolean; message: string }>
    getDir: () => Promise<string>
    // R9：备份恢复后置修复事件订阅
    onRestored: (
      callback: (payload: {
        restoredAt: string
        needPhashRecheck: boolean
        needDuplicateRecheck: boolean
      }) => void
    ) => () => void
  }
  // T08：WiFi 局域网分享 + T09 剪贴板分享
  share: {
    startWifi: (filePaths: string[]) => Promise<{
      url: string
      port: number
      pin: string
      fileCount: number
      timeoutMs: number
    }>
    stopWifi: () => Promise<{ stopped: boolean }>
    // P0-D：删除 wifiStatus 类型定义
    // T09：复制文件到剪贴板（CF_HDROP 格式）
    copyFiles: (
      filePaths: string[]
    ) => Promise<{ success: boolean; message: string; count: number; skipped: number }>
    // T09：检测渠道应用状态（installed=已安装，running=正在运行，installPath=可执行文件路径）
    // 契约修复：主进程 share:detectApp 实际返回 {installed, running, installPath}（无 success 字段），
    // 与 shared/types/electron-api.ts 的 ShareDetectAppResult 保持一致；此前误声明 success 导致渲染端恒判未安装
    detectApp: (channelId: string) => Promise<{
      installed: boolean
      running: boolean
      installPath: string | null
    }>
    // T09：启动目标应用（用于"已安装未运行"场景，用户点击"打开 XX"按钮）
    launchApp: (channelId: string) => Promise<{ success: boolean; message: string }>
  }
  // sync-integration 阶段5：NikkiSync 同步服务器（形状快照自 shared/types/electron-api.ts）
  sync: {
    getStatus: () => Promise<{
      available: boolean
      running: boolean
      host: string
      port: number
      connections: number
      serverId: string | null
      serverName: string | null
      pairedDeviceCount: number
      tlsFingerprintSha256: string | null
      lanHost: string
    }>
    startServer: () => Promise<{
      available: boolean
      running: boolean
      host: string
      port: number
      connections: number
      serverId: string | null
      serverName: string | null
      pairedDeviceCount: number
      tlsFingerprintSha256: string | null
      lanHost: string
    }>
    stopServer: () => Promise<{
      available: boolean
      running: boolean
      host: string
      port: number
      connections: number
      serverId: string | null
      serverName: string | null
      pairedDeviceCount: number
      tlsFingerprintSha256: string | null
      lanHost: string
    }>
    createPairingQr: () => Promise<{
      /** NS1|... 七段二维码内容（渲染层经 qrcode 生成 SVG） */
      content: string
      expiresAt: string
      serverId: string
      host: string
      port: number
      tlsFingerprintSha256: string
    }>
    listDevices: () => Promise<
      Array<{
        deviceId: string
        deviceName: string
        platform: 'ios' | 'android'
        appVersion: string | null
        pairedAt: string
        lastSeenAt: string | null
        lastAckRevision: number
      }>
    >
    revokeDevice: (deviceId: string) => Promise<
      Array<{
        deviceId: string
        deviceName: string
        platform: 'ios' | 'android'
        appVersion: string | null
        pairedAt: string
        lastSeenAt: string | null
        lastAckRevision: number
      }>
    >
  }
  // sync-integration 阶段2：内嵌 NikkiSync Runtime（运行态/扫描/资产只读查询）
  // 返回体为 NikkiSync 协议 DTO（上游 row-mappers 产出），本层零转换 => 资产业务字段以 unknown 承接
  nikkisync: {
    getRuntimeStatus: () => Promise<{
      state:
        | 'unavailable'
        | 'idle'
        | 'starting'
        | 'running'
        | 'scanning'
        | 'degraded'
        | 'stopping'
        | 'error'
      dbPath: string
      linkReady: boolean
      /** 上游 `scanner.getStatus()` 展平：status / installation? / lastScan? */
      scannerStatus?: string
      installation?: unknown
      lastScan?: unknown
      tables?: string[]
      /** 阶段 3：同步服务状态随会话一并给出 */
      sync?: {
        available?: boolean
        running: boolean
        host: string
        port: number
        secure?: boolean
        serverId?: string
        mdnsEnabled: boolean
        tlsFingerprintSha256?: string
        pairedDeviceCount?: number
        lanHost?: string
        error?: string
        /** K4：连接诊断段（观测面；纯聚合既有状态） */
        diagnostics?: import('../shared/types/electron-api').NikkiSyncDiagnosticsInfo
      }
      /** K1：本会话真实发生的启动阶段（scanner/runtime-ready/lan-listen/cached-metadata） */
      startupStages?: Array<{ stage: string; at: string }>
      /**
       * K7：最近一次扫描的诊断聚合计数（上游 scanDiagnosticSummary——仅计数，
       * 绝不序列化路径/UID/文件名/原始错误；未扫描/老链接缺省，teardown 清空）
       */
      scanDiagnostics?: unknown
      error?: string
      hint?: string
    }>
    startScan: (input?: { gameRoot?: string; path?: string }) => Promise<unknown>
    getAssets: (
      input?: import('../shared/types/electron-api').NikkiSyncAssetQueryInfo
    ) => Promise<import('../shared/types/electron-api').NikkiSyncAssetPageInfo>
    getAssetDetail: (
      assetId: string
    ) => Promise<import('../shared/types/electron-api').NikkiSyncAssetDetailInfo>
    getResource: (
      input: import('../shared/types/electron-api').NikkiSyncResourceQueryInfo
    ) => Promise<import('../shared/sync/protocol').MediaResource | string>
    // ---- sync-integration 阶段4：查询面扩容（批量资源 / 增量变更 / 搜索 / 统计）----
    getResourceRecords: <M extends 'meta' | 'path'>(input: {
      assetIds: string[]
      mode: M
    }) => Promise<import('../shared/types/electron-api').NikkiSyncResourceRecordsFor<M>>
    getChanges: (
      input: import('../shared/types/electron-api').NikkiSyncChangesQueryInfo
    ) => Promise<import('../shared/types/electron-api').NikkiSyncChangesInfo>
    searchSuits: (
      input: import('../shared/types/electron-api').NikkiSyncSearchQueryInfo
    ) => Promise<import('../shared/types/electron-api').NikkiSyncSuitSearchInfo>
    searchClothing: (
      input: import('../shared/types/electron-api').NikkiSyncSearchQueryInfo
    ) => Promise<import('../shared/types/electron-api').NikkiSyncClothingSearchInfo>
    profileStats: () => Promise<import('../shared/types/electron-api').NikkiSyncProfileStatsInfo>
    onLibraryChanged: (cb: () => void) => () => void
    // ---- sync-integration 阶段3：上游 NikkiSync LocalSyncServer 的启停与配对管理 ----
    getServerStatus: () => Promise<{
      available: boolean
      running: boolean
      host: string
      port: number
      secure?: boolean
      serverId?: string
      mdnsEnabled: boolean
      tlsFingerprintSha256?: string
      /** 自签证书 PEM（公开材料，不含私钥） */
      serverCertificatePem?: string
      pairedDeviceCount?: number
      lanHost?: string
      error?: string
      /** K4：连接诊断段（观测面；纯聚合既有状态） */
      diagnostics?: import('../shared/types/electron-api').NikkiSyncDiagnosticsInfo
    }>
    startServer: (input?: { port?: number; mdnsEnabled?: boolean }) => Promise<{
      available: boolean
      running: boolean
      host: string
      port: number
      secure?: boolean
      serverId?: string
      mdnsEnabled: boolean
      tlsFingerprintSha256?: string
      serverCertificatePem?: string
      pairedDeviceCount?: number
      lanHost?: string
      error?: string
    }>
    stopServer: () => Promise<{
      available: boolean
      running: boolean
      host: string
      port: number
      secure?: boolean
      serverId?: string
      mdnsEnabled: boolean
      tlsFingerprintSha256?: string
      serverCertificatePem?: string
      pairedDeviceCount?: number
      lanHost?: string
      error?: string
    }>
    getPairingCode: () => Promise<{
      content: string
      expiresAt: string
      serverId: string
      host: string
      port: number
      tlsFingerprintSha256: string
      /** K5：多 host 配对时的备选地址（≤8；单 host NS1 形态缺省） */
      hosts?: string[]
    }>
    getPairedDevices: () => Promise<
      Array<{
        deviceId: string
        deviceName: string
        platform: 'ios' | 'android'
        appVersion?: string
        pairedAt: string
        lastSeenAt: string | null
      }>
    >
    revokeDevice: (deviceId: string) => Promise<
      Array<{
        deviceId: string
        deviceName: string
        platform: 'ios' | 'android'
        appVersion?: string
        pairedAt: string
        lastSeenAt: string | null
      }>
    >
    // ---- K2：在线解析同意（解析开启的会话上才有；否则 PRECONDITION_FAILED）----
    getMetadataConsent: () => Promise<
      import('../shared/types/electron-api').NikkiSyncMetadataConsentInfo
    >
    setMetadataConsent: (
      input: import('../shared/types/electron-api').NikkiSyncMetadataConsentSetInput
    ) => Promise<import('../shared/types/electron-api').NikkiSyncMetadataConsentInfo>
    // ---- K3：游戏版本推断（上游静态表，纯本地无出站）----
    resolveGameVersion: (
      input?: import('../shared/types/electron-api').NikkiSyncGameVersionQueryInfo
    ) => Promise<import('../shared/types/electron-api').NikkiSyncGameVersionInfo>
    // ---- K6：额外照片目录（仅作用于同步库扫描器）----
    getExtraDirectories: () => Promise<
      import('../shared/types/electron-api').NikkiSyncExtraDirectoriesInfo
    >
    inspectExtraDirectory: (input: {
      path: string
      source?: 'spinning_momo'
    }) => Promise<import('../shared/types/electron-api').NikkiSyncExtraDirectoryProposalInfo>
    addExtraDirectory: (input: {
      id: string
    }) => Promise<import('../shared/types/electron-api').NikkiSyncExtraDirectoriesInfo>
    removeExtraDirectory: (input: {
      id: string
    }) => Promise<import('../shared/types/electron-api').NikkiSyncExtraDirectoriesInfo>
    // K9：目录来源标注（spinning_momo / other，仅 images 目录）
    setExtraDirectorySource: (
      input: import('../shared/types/electron-api').NikkiSyncExtraDirectorySourceInput
    ) => Promise<import('../shared/types/electron-api').NikkiSyncExtraDirectoriesInfo>
    rescanExtraDirectories: () => Promise<
      import('../shared/types/electron-api').NikkiSyncExtraDirectoriesInfo
    >
    // ---- K9：账号同步作用域（上游 AccountSyncSettings；会话无 accounts ⇒ PRECONDITION_FAILED）----
    getSyncAccounts: () => Promise<import('../shared/types/electron-api').NikkiSyncSyncAccountsInfo>
    previewSyncAccount: (input: {
      assetId: string
    }) => Promise<import('../shared/types/electron-api').NikkiSyncSyncAccountPreviewInfo>
    setSyncAccountSelection: (
      input: import('../shared/types/electron-api').NikkiSyncSyncAccountSelectionInput
    ) => Promise<import('../shared/types/electron-api').NikkiSyncSyncAccountsInfo>
    // K8：整理队列（批量删除；开关默认关，PRECONDITION_FAILED 指向同步服务页开关）
    getOrganizerQueue: () => Promise<
      import('../shared/types/electron-api').NikkiSyncOrganizerViewInfo
    >
    decideOrganizerItem: (input: {
      id: string
      approve: boolean
    }) => Promise<Array<import('../shared/types/electron-api').NikkiSyncOrganizerItemInfo>>
    approveOrganizerItems: (input: {
      ids: string[]
    }) => Promise<import('../shared/types/electron-api').NikkiSyncOrganizerApproveResultInfo>
  }
  // sync-integration 阶段4：资产编辑叠加层（本 App 专有编辑，按 NikkiSync asset_id 归键）
  assetEdits: {
    list: (
      assetIds: string[]
    ) => Promise<{ edits: import('../shared/types/electron-api').AssetEditsInfo[] }>
    set: (
      assetId: string,
      patch: import('../shared/types/electron-api').AssetEditsPatchInfo
    ) => Promise<{ edit: import('../shared/types/electron-api').AssetEditsInfo | null }>
  }
  // T10：缩略图缓存管理
  cache: {
    getStats: () => Promise<{
      success: boolean
      message?: string
      totalSize?: number
      fileCount?: number
      limit?: number
      cacheDir?: string
    }>
    clean: () => Promise<{
      success: boolean
      message?: string
      clearedSize?: number
      clearedCount?: number
    }>
    setLimit: (
      limitBytes: number
    ) => Promise<{ success: boolean; message?: string; applied: boolean; evicted: number }>
    enforceLimit: () => Promise<{
      success: boolean
      message?: string
      evicted: number
      totalSize?: number
      fileCount?: number
    }>
    // 自定义目录支持
    setDir: (dir: string) => Promise<{ success: boolean; needRestart: boolean; message: string }>
    resetDir: () => Promise<{ success: boolean; needRestart: boolean; message: string }>
    getDir: () => Promise<string>
  }
  log: {
    // 获取所有故障列表（按时间倒序）
    listFaults: () => Promise<{ success: boolean; faults: FaultRecord[]; message?: string }>
    // 获取单个故障详情
    getFaultDetail: (
      id: string
    ) => Promise<{ success: boolean; fault?: FaultRecord; message?: string }>
    // 打开日志目录
    openDirectory: () => Promise<{ success: boolean; message: string }>
    // 获取日志目录路径
    getDirectoryPath: () => Promise<{ success: boolean; path: string }>
    // 获取日志统计信息
    getStats: () => Promise<{
      success: boolean
      faultCount: number
      totalSize: number
      fileCount: number
      oldestTimestamp: string | null
      message?: string
    }>
    // 导出全部日志为 zip（主进程会弹出保存对话框）
    exportZip: () => Promise<{ success: boolean; message?: string; canceled?: boolean }>
    // 清空所有日志
    clear: () => Promise<{ success: boolean; message: string; cleared: number }>
    // 自定义目录支持
    setDir: (dir: string) => Promise<{ success: boolean; needRestart: boolean; message: string }>
    resetDir: () => Promise<{ success: boolean; needRestart: boolean; message: string }>
    getDir: () => Promise<string>
    // P0-2：渲染进程错误上报到主进程 faults 日志（与 preload.ts 签名保持一致）
    reportRendererError: (payload: {
      message: string
      stack?: string
      componentStack?: string
      filename?: string
      lineno?: number
      colno?: number
      source: 'ErrorBoundary' | 'window.onerror' | 'unhandledrejection'
    }) => Promise<{ success: boolean; message?: string }>
  }
  // T13：崩溃报告管理
  crash: {
    // 列出所有崩溃 dump 文件（按时间倒序）
    list: () => Promise<{ success: boolean; crashes: CrashRecord[]; message?: string }>
    // 获取崩溃目录统计信息
    getStats: () => Promise<{
      success: boolean
      fileCount: number
      totalSize: number
      oldestTime: string | null
      message?: string
    }>
    // 打开崩溃目录（系统资源管理器）
    openDirectory: () => Promise<{ success: boolean; message: string }>
    // 清空所有崩溃 dump 文件
    clear: () => Promise<{ success: boolean; cleared: number; message: string }>
    // 自定义目录支持
    setDir: (dir: string) => Promise<{ success: boolean; needRestart: boolean; message: string }>
    resetDir: () => Promise<{ success: boolean; needRestart: boolean; message: string }>
    getDir: () => Promise<string>
  }
  // 应用控制（重启等）
  app: {
    relaunch: () => Promise<{ success: boolean }>
    // 需求五.2：以管理员权限重启（扫描目录权限不足 E003 时使用）
    relaunchAsAdmin: () => Promise<{ ok: boolean }>
    // U1：获取应用版本号，避免渲染层硬编码
    getVersion: () => Promise<string>
    // GPU 状态只读探针（app:gpu-status）：硬件加速开关态/活动显卡/特性降级/独显偏好
    getGpuStatus: () => Promise<{
      hardwareAcceleration: { enabled: boolean; reason: string }
      fallback: { active: boolean; consecutiveFailures: number; fallbackVersion: string | null }
      discretePreference: { mode: 'auto' | 'high-performance'; registry: string | null }
      featureStatus: Record<string, string> | null
      gpus: Array<{
        vendorId: string | null
        deviceId: string | null
        vendor: string | null
        device: string | null
        active: boolean | null
      }> | null
      activeGpu: string | null
      electronVersion: string
      platform: string
    }>
    // 自动更新：手动触发检查（生产环境有效，dev 下主进程 no-op）
    checkUpdate: () => Promise<{ checking: boolean }>
    // 自动更新：用户确认后开始下载
    downloadUpdate: () => Promise<{ downloading: boolean }>
    // 自动更新：用户确认「安装并重启」
    installUpdate: () => Promise<{ installing: boolean }>
    // 自动更新：订阅主进程推送的更新状态/进度
    onUpdate: (
      callback: (payload: {
        stage: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
        version?: string
        percent?: number
        releaseNotes?: string
        releaseName?: string
        errorMessage?: string
        readyToInstall?: boolean
      }) => void
    ) => () => void
  }
  // 性能重构 v3 改造项三：统一任务进度通道
  // - task.onProgress 订阅 task:progress 事件（主进程节流 4~6 FPS 推送）
  // - task.cancel 触发 task:cancel IPC，主进程通过 TaskRegistry 触发 AbortController.abort()
  task: {
    cancel: (taskId: string) => Promise<{ cancelled: boolean; taskId: string }>
    onProgress: (
      callback: (progress: {
        taskId: string
        taskType:
          'scan' | 'duplicate' | 'batch' | 'watermark' | 'import' | 'video-edit' | 'indexing' // 扫描后长任务（缩略图 / pHash / 场景分析）
        phase: 'preparing' | 'processing' | 'finalizing' | 'done' | 'cancelled' | 'error'
        current: number
        total: number
        percent: number
        processedPerSec?: number
        etaMs?: number
        message?: string
        startedAt: number
        canCancel: boolean
        // scan 任务特有子行字段（与 shared 契约保持一致）
        currentPath?: string
        found?: number
      }) => void
    ) => () => void
    // 挂载即拉快照：补偿订阅前丢失的进度事件（等效重放），无活动任务时返回 null
    getActive: () => Promise<{
      taskId: string
      taskType: 'scan' | 'duplicate' | 'batch' | 'watermark' | 'import' | 'video-edit' | 'indexing'
      phase: 'preparing' | 'processing' | 'finalizing' | 'done' | 'cancelled' | 'error'
      current: number
      total: number
      percent: number
      processedPerSec?: number
      etaMs?: number
      message?: string
      startedAt: number
      canCancel: boolean
      currentPath?: string
      found?: number
    } | null>
  }
  // T14：文件导入向导
  import: {
    // 预览源目录中的待导入文件（仅元信息）
    preview: (
      sourceDir: string
    ) => Promise<{ success: boolean; files: ImportFilePreview[]; message?: string }>
    // 执行批量导入
    run: (
      sourcePaths: string[],
      targetBaseDir: string,
      options: ImportOptions
    ) => Promise<{
      success: boolean
      message: string
      imported: Array<{ sourcePath: string; targetPath: string }>
      failed: Array<{ sourcePath: string; message: string }>
      skipped: Array<{ sourcePath: string; reason: string }>
      /** 登记导入根或触发扫描失败的警告信息（非致命，已复制文件不受影响） */
      warnings?: string[]
    }>
    // 进度回调
    onProgress: (callback: (progress: { current: number; total: number }) => void) => () => void
  }

  // FIX(组1-2): 补齐 importRoot 域声明——preload 已暴露但 WindowElectronAPI 缺失，
  // scan-sections.tsx 的既有引用长期报 TS2339；clearFailed/clearErrorMessage 为本次新增返回字段
  importRoot: {
    list: () => Promise<string[]>
    removeRoot: (
      rootPath: string,
      clearRecords: boolean
    ) => Promise<{
      removed: boolean
      cleared: number
      clearFailed: boolean
      clearErrorMessage?: string
    }>
  }

  // 建议改#9：操作历史持久化（支持跨重启撤销）
  operationHistory: {
    add: (record: {
      operationType: string
      mediaId?: number
      payload: unknown
      description: string
      createdAt: string
    }) => Promise<{ success: boolean; id?: number; message?: string }>
    list: (limit?: number) => Promise<{
      success: boolean
      records: Array<{
        id: number
        operationType: string
        mediaId: number | null
        payload: string
        description: string
        createdAt: string
        snapshotUpdatedAt: string | null
      }>
      message?: string
    }>
    remove: (id: number) => Promise<{ success: boolean; message?: string }>
    clear: () => Promise<{ success: boolean; message?: string }>
    // R8：撤销前乐观锁冲突检测
    checkConflict: (
      operationId: number
    ) => Promise<{ success: boolean; conflict?: boolean; reason?: string; message?: string }>
  }
  // 插件系统管理 API（与主进程 pluginHost 通信）
  plugin: {
    list: () => Promise<import('../../shared/types/plugin').PluginFullInfo[]>
    detail: (name: string) => Promise<import('../../shared/types/plugin').PluginFullInfo>
    install: (specifiers: string[]) => Promise<import('../../shared/types/plugin').PluginFullInfo[]>
    uninstall: (name: string) => Promise<import('../../shared/types/plugin').PluginFullInfo[]>
    toggleActive: (
      name: string,
      active: boolean
    ) => Promise<import('../../shared/types/plugin').PluginFullInfo>
    checkUpdate: (name: string) => Promise<{ name: string; latestVersion: string | false }>
    update: (name: string) => Promise<{ name: string; success: boolean }>
    getPluginsPath: () => Promise<string>
    reportError: (name: string, errorMessage: string) => Promise<{ success: boolean }>
  }
  // 共鸣录板块（离线本地功能：记录 / 衣橱 / 导入导出；契约同 src/main/preload/api/resonance.ts）
  resonance: {
    getData: () => Promise<import('../../shared/types/resonance').ResonanceGetDataResult>
    addManualRecord: (
      bannerId: string,
      itemId: string,
      obtainedAt: string
    ) => Promise<{ added: boolean }>
    updateManualRecord: (id: number, obtainedAt: string) => Promise<{ updated: boolean }>
    deleteRecord: (kind: 'pull' | 'edit', id: number) => Promise<{ deleted: boolean }>
    readImportFile: (
      filePath: string
    ) => Promise<import('../../shared/types/resonance').ResonanceReadImportFileResult>
    commitImport: (
      batch: import('../../shared/types/resonance').ResonanceCommitImportBatch
    ) => Promise<import('../../shared/types/resonance').ResonanceCommitImportResult>
    export: (
      filePath: string,
      payload: import('../../shared/types/resonance').ResonanceExportPayload
    ) => Promise<import('../../shared/types/resonance').ResonanceExportResult>
    updateWardrobe: (
      adds: Array<{
        category: import('../../shared/types/resonance').ResonanceWardrobeCategory
        itemId: number
      }>,
      removes: Array<{
        category: import('../../shared/types/resonance').ResonanceWardrobeCategory
        itemId: number
      }>
    ) => Promise<import('../../shared/types/resonance').ResonanceWardrobeUpdateResult>
    setWishlist: (
      wishlist: import('../../shared/types/resonance').ResonanceBannerWishlistData
    ) => Promise<{ wishlist: import('../../shared/types/resonance').ResonanceBannerWishlistData }>
    clearAll: () => Promise<{ cleared: boolean }>
  }
}

declare global {
  interface Window {
    electronAPI?: WindowElectronAPI
    /** 插件能力桥 API（仅插件代码使用，由 preload contextBridge 暴露） */
    pluginAPI?: import('../../shared/types/plugin').PluginAPI
    /** 渲染进程注入 i18next.t 函数（由 PluginRuntime.bootstrap 调用） */
    __setPluginI18nT?: (fn: (key: string, options?: Record<string, unknown>) => string) => void
    /**
     * pluggable-electron facade（收窄为只读，由 preload contextBridge 暴露）
     *
     * 变更类方法（install / uninstall / update / toggleActive）已刻意不暴露，
     * 请改用 electronAPI.plugin.*，那条链路在主进程有可信调用方校验。
     */
    pluggableElectronIpc?: {
      getActive: () => Promise<unknown>
      updatesAvailable: (plugin: unknown[]) => Promise<unknown>
    }
    /** IPC 错误类（由 preload 暴露，用于 instanceof 判断） */
    IpcError?: new (
      code: string,
      message: string,
      details?: unknown,
      userMessage?: string
    ) => Error & { code: string; userMessage?: string; details?: unknown }
  }
}

declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag'
  }
}

// 编译期常量：业务代码用 if (__PREVIEW__) 区分预览版/exe 版
// vite.config.ts 定义为 false（exe 版死代码消除）
// vite.preview.config.ts 定义为 true（预览版分支保留）
declare global {
  const __PREVIEW__: boolean

  // 全链路扫描诊断日志条目（与 scan-log-store.ts 保持一致，全局可见供诊断组件使用）
  type ScanLogKind = 'path-missing' | 'permission' | 'empty' | 'ok' | 'other'
  interface ScanLogEntry {
    id: number
    ts: number
    stage: string
    level: 'info' | 'warn' | 'error'
    kind: ScanLogKind
    message: string
    detail?: unknown
    /** 失败节点错误码（E001–E005），成功节点无此字段 */
    code?: string
  }
}

export {}
