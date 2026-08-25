import type Database from 'better-sqlite3'
import type { DatabaseWorkerBridge } from './worker/database-worker-bridge'
import type { DbStatement } from './worker/worker-protocol'
import type { SearchableDocRow } from '../../shared/types/ipc'
import { ImportRootRepository, normalizeRootPath } from './import-root-repository'
import { chunkArray } from './sql-chunk'
import { logger } from '../utils/logger'
import { t } from '../i18n'

/**
 * Slice 6：MediaRepository — media.ts SQL 访问层抽离
 *
 * 改造（2026-07-20）：写操作走独立 utilityProcess（database-worker）
 * - 写方法（INSERT/UPDATE/DELETE/事务）改为 async，通过 workerBridge 调用 worker 进程
 * - 查询方法保留同步，直接走主进程 db 连接（读多写少，且查询需要同步语义）
 * - 未注入 workerBridge 时（如测试场景），写方法降级为同步直写主进程 db
 *
 * 设计目标：
 *   1. 将 media.ts 中 34 个 IPC handler 内联的 SQL 全部集中到此 Repository
 *   2. Repository 仅负责 SQL 访问（prepare/run/all/get/transaction），不含 IPC、不含副作用
 *      （dialog/shell.trashItem/fs.access/notifyMediaUpdated 均留在 handler）
 *   3. Repository 是测试接缝（seam）：可对内存数据库（new Database(':memory:')）实例化
 *      并验证 SQL 行为，无需 mock Electron API
 *   4. 行为等价：所有 SQL 字符串、placeholder 顺序、事务边界、缓存读写均与原 media.ts 一致
 *
 * 分区：
 *   - Media files：media_files 表的 21 个 media:* handler 的 SQL
 *   - Categories：categories 表的 5 个 category:* handler 的 SQL
 *   - Profiles：character_profiles + media_files.account_uid 的 7 个 profile:* handler 的 SQL
 *   - Duplicates：duplicate:listGroups 的 SQL（查询 media_files 的 is_duplicate/original_id）
 *
 * 缓存策略：
 *   - media_count 缓存读取由 Repository.listMedia 内部处理（直接 SQL 访问 app_settings）
 *   - 缓存写入由 Application.notifyMediaUpdated() 负责（保持原状，跨文件改动最小化）
 *   - 默认视图（仅 is_deleted=0）命中缓存；非默认视图实时 COUNT
 */

// ============================================================================
// Row Types — 与 media_files / categories / character_profiles 表结构对应
// 数值型布尔字段（is_favorite/is_deleted/is_missing/is_duplicate/is_system）保持
// raw DB 值（0/1），由 IPC handler 在响应塑形时转为 boolean
// ============================================================================

/**
 * R5：media_count 缓存 TTL（24 小时）。
 * 超过此时长强制走真实 COUNT 并重建缓存，避免长期陈旧。
 */
const MEDIA_COUNT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 图库板块目录限制的 WHERE 条件：仅匹配游戏内高质量照片目录
 * …\X6Game\Saved\GamePlayPhotos\{uid}\NikkiPhotos_HighQuality\xxx.jpg
 *
 * - 统一将反斜杠替换为正斜杠后小写匹配，规避 Windows 路径大小写差异
 * - REPLACE 只替换反斜杠，正斜杠路径同样可匹配
 * - 仅由 listMedia 的 galleryHighQualityOnly=true 引用，其余板块查询不受影响
 */
const GALLERY_HQ_PATH_CONDITION =
  "(LOWER(REPLACE(file_path, '\\', '/')) LIKE '%/gameplayphotos/%' AND LOWER(REPLACE(file_path, '\\', '/')) LIKE '%/nikkiphotos_highquality/%')"

/**
 * 图库板块的放行条件（HQ ∪ X6Game/Video）：
 * 1. 游戏内高质量照片目录：GamePlayPhotos/{uid}/NikkiPhotos_HighQuality，即官方游戏相册主路径
 * 2. 游戏内视频目录：X6Game/Video，游戏内录制的视频内容
 * 注意：X6Game/ScreenShot 路径已独立归类为本地截图，不再属于游戏相册，不在此条件范围内
 * 仅由 listMedia 的 galleryHighQualityOnly=true 引用。
 */
const GALLERY_PATH_CONDITION =
  `${GALLERY_HQ_PATH_CONDITION}` +
  " OR LOWER(REPLACE(file_path, '\\', '/')) LIKE '%/x6game/video/%'"

/**
 * 缓存板块的反向过滤条件：排除图库板块已覆盖的所有路径（HQ ∪ X6Game/ScreenShot ∪ X6Game/Video）。
 * 用于 launcher-cache 视图，使其包含所有不在图库放行范围内的文件。
 * 注意：必须与 GALLERY_PATH_CONDITION 完全对称（即 NOT (GALLERY_PATH_CONDITION)）。
 */
const NOT_IN_GALLERY_PATH_CONDITION = `NOT (${GALLERY_PATH_CONDITION})`

/** 与 GALLERY_HQ_PATH_CONDITION 同口径的路径归一化表达式（小写 + 正斜杠） */
const NORMALIZED_PATH_EXPR = "LOWER(REPLACE(file_path, '\\', '/'))"

/**
 * LIKE 转义符。归一化后列值与参数均不含反斜杠（已被 REPLACE / normalizeRootPath 转为正斜杠），
 * 因此反斜杠可安全用作转义符。SQLite 字符串字面量不处理反斜杠，'\' 即单个反斜杠。
 */
const LIKE_ESCAPE_CHAR = '\\'

/**
 * 转义 LIKE 模式中的通配符，避免目录名里的 '_' / '%' 被当作通配。
 * 例：'c:/my_photos' 未转义时会误匹配 'c:/myXphotos'。
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `${LIKE_ESCAPE_CHAR}${ch}`)
}

/** media_files 完整行（listMedia 返回，tags 已解析为 string[]） */
export interface MediaRow {
  id: number
  file_path: string
  file_name: string
  file_type: 'image' | 'video'
  file_ext: string
  file_size: number
  width: number | null
  height: number | null
  duration: number | null
  created_at: string
  modified_at: string
  thumbnail: string | null
  tags: string[]
  category_id: number | null
  rating: number
  is_favorite: number
  notes: string
  scene_category: string | null
  scene_time: string
  outfit: string
  account_uid: string
  album_type: string
  is_deleted: number
  deleted_at: string | null
  is_missing: number
  is_duplicate: number
  original_id: number | null
  media_source: string
  // 损坏文件容错：is_corrupted=1 表示文件存在但内容无法读取/解码
  is_corrupted: number
  corrupted_count: number
  corrupted_reason: string | null
}

/** 用于 findDuplicates 的候选行（含宽高、收藏、评分用于评分函数） */
export interface DuplicateCandidateRow {
  id: number
  file_path: string
  file_name: string
  file_type: string
  file_size: number
  modified_at: string
  width: number | null
  height: number | null
  is_favorite: number
  rating: number
}

/** 用于 findSimilar 的 pHash 行 */
export interface PhashRow {
  id: number
  file_path: string
  file_name: string
  file_type: string
  file_size: number
  modified_at: string
  width: number | null
  height: number | null
  is_favorite: number
  rating: number
  phash: string
  // R7：phash 计算时的文件 mtime/size，用于 similar-handler 触发 stale 检测
  phash_mtime: number | null
  phash_file_size: number | null
}

/** 套装图鉴聚合统计行 */
export interface OutfitAggRow {
  outfit: string
  count: number
  latest_created: string
  latest_modified: string
}

/** 套装最新一张媒体（用于封面） */
export interface OutfitLatestRow {
  file_path: string
  thumbnail: string | null
}

/** 重复分组查询行（is_duplicate=1 的文件） */
export interface DuplicateGroupRow {
  id: number
  file_path: string
  file_name: string
  file_type: string
  file_size: number
  modified_at: string
  width: number | null
  height: number | null
  is_favorite: number
  rating: number
  original_id: number
}

/** 重复分组推荐保留项行（无 original_id 字段） */
export interface OriginalRow {
  id: number
  file_path: string
  file_name: string
  file_type: string
  file_size: number
  modified_at: string
  width: number | null
  height: number | null
  is_favorite: number
  rating: number
}

/** 简化的 id+path 行（用于 trashItem / 场景分析等） */
export interface IdPathRow {
  id: number
  file_path: string
}

/** 分类表行 */
export interface CategoryRow {
  id: number
  name: string
  icon: string
  color: string
  sort_order: number
  parent_id: number | null
  is_system: number
}

/** 角色档案行 */
export interface ProfileRow {
  uid: string
  nickname: string
  avatar: string | null
  created_at: string
  last_active_at: string | null
}

/** 角色档案基础统计 */
export interface ProfileBaseStats {
  total_count: number
  image_count: number
  video_count: number
  total_size: number
  earliest_time: string | null
  latest_time: string | null
}

/** Top N 偏好统计行（outfit / scene_category / scene_time 通用） */
export interface ProfileTopStatRow {
  key: string
  cnt: number
}

/** 分组统计行（getGroupCounts 返回） */
export interface GroupCountRow {
  key: string
  count: number
}

// ============================================================================
// Options & Result Types
// ============================================================================

export type MediaSortOrder = 'asc' | 'desc'
export type MediaSourceFilter = 'game' | 'launcher' | 'cloud' | 'local_screenshot' | 'all'
export type GroupDimension = 'album_type' | 'scene_category' | 'scene_time' | 'outfit' | 'file_type'

export interface MediaListOptions {
  page?: number
  pageSize?: number
  includeDeleted?: boolean
  deletedOnly?: boolean
  sortBy?: string
  sortOrder?: string
  accountUid?: string
  albumType?: string
  hideDuplicates?: boolean
  mediaSource?: MediaSourceFilter
  // 损坏文件筛选：true 时仅返回 is_corrupted=1 的记录
  corruptedOnly?: boolean
  // 默认隐藏损坏文件：true 时过滤掉 is_corrupted=1 的记录（图库默认视图）
  hideCorrupted?: boolean
  // 图库板块目录限制：true 时仅返回 ...\GamePlayPhotos\{uid}\NikkiPhotos_HighQuality 下的图片
  // 仅图库（gallery）视图传入；缓存/收藏/回收站/重复等板块不受影响
  galleryHighQualityOnly?: boolean
}

export interface MediaListResult {
  rows: MediaRow[]
  /** 仅在 usePagination=true 时返回 */
  total?: number
  page?: number
  pageSize?: number
  hasMore?: boolean
}

// ============================================================================
// MediaRepository
// ============================================================================

export class MediaRepository {
  /**
   * @param db 主进程数据库连接（查询用，同步）
   * @param workerBridge 写 worker 桥接（写用，async）。未注入时降级为同步直写 db
   * @param dbPath 数据库文件路径（workerBridge.ensureWorker 需要）
   */
  constructor(
    private readonly db: Database.Database,
    private readonly workerBridge: DatabaseWorkerBridge | null = null,
    private readonly dbPath: string = ''
  ) {}

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /** 生成 N 个 ? 占位符，用于 IN (...) 子句 */
  private placeholders(count: number): string {
    return Array.from({ length: count }, () => '?').join(',')
  }

  /**
   * 把大 id 数组按 SQL 参数上限分片，逐片套用同一模板生成语句，整体放进一个事务。
   * 分片后仍是一个事务，因此"要么全改要么全不改"的语义不变。
   *
   * @param build 接收当前分片及其占位符串，返回该片对应的语句（调用方自行决定参数顺序）
   */
  private async runChunkedTransaction(
    ids: number[],
    build: (idsChunk: number[], placeholders: string) => DbStatement
  ): Promise<void> {
    const statements = chunkArray(ids).map((chunk) => build(chunk, this.placeholders(chunk.length)))
    await this.runTransaction(statements)
  }

  /**
   * 分片执行 IN (...) 查询并按分片顺序合并结果。
   * 同步执行（读走主进程连接），与未分片时的返回结构一致。
   */
  private queryChunked<T>(
    ids: number[],
    build: (idsChunk: number[], placeholders: string) => DbStatement
  ): T[] {
    const rows: T[] = []
    for (const chunk of chunkArray(ids)) {
      const { sql, params } = build(chunk, this.placeholders(chunk.length))
      rows.push(...(this.db.prepare(sql).all(...(params ?? [])) as T[]))
    }
    return rows
  }

  /**
   * 同步执行单条写操作（降级路径：workerBridge 未注入时使用）。
   * 与 worker 端 executeStatement 行为一致：prepare(sql).run(params)
   */
  private syncRun(sql: string, params?: unknown[]): Database.RunResult {
    return this.db.prepare(sql).run(params ?? [])
  }

  /**
   * 同步执行事务（降级路径：workerBridge 未注入时使用）。
   * 与 worker 端 executeTransaction 行为一致：所有 statements 在同一事务中。
   */
  private syncTransaction(statements: DbStatement[]): { changes: number; lastInsertRowid: number } {
    let changes = 0
    let lastInsertRowid = 0
    const tx = this.db.transaction(() => {
      for (const stmt of statements) {
        const result = this.db.prepare(stmt.sql).run(stmt.params ?? [])
        changes += result.changes
        if (typeof result.lastInsertRowid === 'bigint') {
          lastInsertRowid = Number(result.lastInsertRowid)
        } else {
          lastInsertRowid = result.lastInsertRowid
        }
      }
    })
    tx()
    return { changes, lastInsertRowid }
  }

  /**
   * 走 worker 执行单条写操作；未注入 bridge 时降级为同步。
   * 返回值与 Database.RunResult 兼容（lastInsertRowid 已转 number）。
   */
  private async runWrite(sql: string, params?: unknown[]): Promise<Database.RunResult> {
    if (!this.workerBridge) {
      const result = this.syncRun(sql, params)
      return {
        changes: result.changes,
        lastInsertRowid:
          typeof result.lastInsertRowid === 'bigint'
            ? Number(result.lastInsertRowid)
            : result.lastInsertRowid
      } as Database.RunResult
    }
    // worker bridge 必须有 dbPath
    const dbPath = this.dbPath
    const result = await this.workerBridge.execute(dbPath, sql, params)
    return result as Database.RunResult
  }

  /**
   * 走 worker 执行事务；未注入 bridge 时降级为同步事务。
   */
  private async runTransaction(statements: DbStatement[]): Promise<Database.RunResult> {
    if (statements.length === 0) {
      return { changes: 0, lastInsertRowid: 0 } as Database.RunResult
    }
    if (!this.workerBridge) {
      return this.syncTransaction(statements) as Database.RunResult
    }
    const result = await this.workerBridge.transaction(this.dbPath, statements)
    return result as Database.RunResult
  }

  /**
   * 安全解析 media_files.tags 字段（可能是 JSON 字符串、数组或 null），失败回退空数组
   * 单条损坏的 tags 不应让整个 media:list IPC 抛错
   */
  private parseTagsField(tags: unknown): string[] {
    if (Array.isArray(tags)) return tags
    if (typeof tags !== 'string' || tags.length === 0) return []
    try {
      const parsed = JSON.parse(tags)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /**
   * 读取导入根（仅启用态），转为可直接用于 LIKE 的前缀参数（小写 + 正斜杠 + 通配符转义 + '/%' 后缀）。
   * 供图库板块放行：已关闭（disabled=1）的目录不返回，从而不在图库显示。
   *
   * 旧库尚未创建 import_roots 表时降级为空数组：图库退回"仅高清目录放行"，
   * 功能受限但不影响可用性，优于让整个 media:list 抛错。
   */
  private buildImportRootLikeParams(): string[] {
    let roots: string[]
    try {
      roots = new ImportRootRepository(this.db).listEnabledImportRoots()
    } catch (err) {
      logger.warn(
        t('main.db.log.importRootsGalleryFailed'),
        err instanceof Error ? err.message : err
      )
      return []
    }
    return this.buildRootLikeParams(roots)
  }

  /**
   * 读取导入根（启用 + 已关闭，全量），转为 LIKE 前缀参数。
   * 供缓存板块排除：无论目录是否关闭，其下文件都不应出现在缓存（缓存=图库补集）。
   *
   * 旧库尚未创建 import_roots 表时降级为空数组：缓存不退化为额外排除，功能不受影响。
   */
  private buildImportRootLikeParamsAll(): string[] {
    let roots: string[]
    try {
      roots = new ImportRootRepository(this.db).listAllImportRootPrefixes()
    } catch (err) {
      logger.warn(t('main.db.log.importRootsCacheFailed'), err instanceof Error ? err.message : err)
      return []
    }
    return this.buildRootLikeParams(roots)
  }

  /** 将导入根列表归一化为 LIKE 前缀参数（小写 + 正斜杠 + 通配符转义 + '/%' 后缀） */
  private buildRootLikeParams(roots: string[]): string[] {
    const params: string[] = []
    for (const root of roots) {
      const normalized = normalizeRootPath(root).toLowerCase()
      if (normalized) params.push(`${escapeLikePattern(normalized)}/%`)
    }
    return params
  }

  /**
   * media:list 的 WHERE 子句构建
   * 返回 { whereClause, whereParams, isDefaultView }
   * isDefaultView：仅含 is_deleted=0（无其他过滤参数），用于 media_count 缓存命中判断
   */
  private buildListWhereClause(options: MediaListOptions): {
    whereClause: string
    whereParams: unknown[]
    isDefaultView: boolean
  } {
    const includeDeleted = options.includeDeleted === true
    const deletedOnly = options.deletedOnly === true
    const accountUid = options.accountUid
    const albumType = options.albumType
    // 缓存视图（mediaSource='launcher'）的导入根排除前缀参数，紧随 media_source 条件后在 whereParams 中追加
    let launcherRootLikeParams: string[] = []
    // hideDuplicates 在回收站视图（deletedOnly）下不应用，避免软删除的重复项消失
    const hideDuplicates = options.hideDuplicates === true && !deletedOnly
    const mediaSource = options.mediaSource
    // 损坏文件筛选：corruptedOnly 优先于 hideCorrupted（互斥）
    const corruptedOnly = options.corruptedOnly === true
    const hideCorrupted = options.hideCorrupted === true && !corruptedOnly

    const conditions: string[] = []
    if (deletedOnly) {
      conditions.push('is_deleted = 1')
    } else if (!includeDeleted) {
      conditions.push('is_deleted = 0')
    }
    if (accountUid && accountUid !== 'all') {
      conditions.push('account_uid = ?')
    }
    if (albumType && albumType !== 'all') {
      conditions.push('album_type = ?')
    }
    if (hideDuplicates) {
      conditions.push('is_duplicate = 0')
    }
    if (mediaSource && mediaSource !== 'all') {
      if (mediaSource === 'launcher') {
        // 缓存视图：排除图库 HQ 路径，显示所有非 HQ 文件（含非 HQ game + launcher + cloud）
        // 并排除任意 import_roots 之下文件（启用或已关闭均排除），使指定目录媒体只存在于图库，
        // 缓存成为图库补集——修复"已关闭的指定目录仍残留在缓存板块"的显示缺陷。
        const computedRootParams = this.buildImportRootLikeParamsAll()
        let rootExclusion = ''
        if (computedRootParams.length > 0) {
          const rootConditions = computedRootParams
            .map(() => `${NORMALIZED_PATH_EXPR} LIKE ? ESCAPE '${LIKE_ESCAPE_CHAR}'`)
            .join(' OR ')
          rootExclusion = ` AND NOT (${rootConditions})`
          launcherRootLikeParams = computedRootParams
        }
        conditions.push(
          `(COALESCE(media_source, 'game') = 'launcher' OR COALESCE(media_source, 'game') = 'cloud' OR (COALESCE(media_source, 'game') = 'game' AND ${NOT_IN_GALLERY_PATH_CONDITION}))${rootExclusion}`
        )
      } else {
        conditions.push('media_source = ?')
      }
    } else if (!mediaSource) {
      // 默认视图：包含 game + cloud（用户拍摄 + 云相册），排除 launcher 缓存
      // NULL 安全：SQL 中 NULL != 'launcher' 返回 NULL（非 TRUE），会错误排除 NULL 记录
      // 使用 COALESCE 确保 NULL 值被视为 'game'（与 schema DEFAULT 'game' 语义一致）
      conditions.push("COALESCE(media_source, 'game') != 'launcher'")
    }
    // 图库板块目录限制：游戏内高质量照片目录（…\GamePlayPhotos\{uid}\NikkiPhotos_HighQuality）
    // 或任一已登记导入根之下的文件——导入根让用户手动导入的目录同样在图库可见。
    // 该条件使视图脱离默认状态，media_count 缓存不命中（走实时 COUNT）
    const galleryHighQualityOnly = options.galleryHighQualityOnly === true
    const importRootLikeParams = galleryHighQualityOnly ? this.buildImportRootLikeParams() : []
    if (galleryHighQualityOnly) {
      if (importRootLikeParams.length === 0) {
        conditions.push(GALLERY_PATH_CONDITION)
      } else {
        const rootConditions = importRootLikeParams
          .map(() => `${NORMALIZED_PATH_EXPR} LIKE ? ESCAPE '${LIKE_ESCAPE_CHAR}'`)
          .join(' OR ')
        conditions.push(`(${GALLERY_PATH_CONDITION} OR ${rootConditions})`)
      }
    }
    if (corruptedOnly) {
      conditions.push('is_corrupted = 1')
    } else if (hideCorrupted) {
      conditions.push('is_corrupted = 0')
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''
    const whereParams: unknown[] = []
    if (accountUid && accountUid !== 'all') whereParams.push(accountUid)
    if (albumType && albumType !== 'all') whereParams.push(albumType)
    // 缓存视图（mediaSource='launcher'）的条件已内联为常量 NOT_IN_GALLERY_HQ_CONDITION，不传参
    if (mediaSource && mediaSource !== 'all' && mediaSource !== 'launcher')
      whereParams.push(mediaSource)
    // 缓存视图的导入根排除参数：conditions 中该条件位于 media_source 之后，参数需紧随其后
    if (mediaSource === 'launcher') whereParams.push(...launcherRootLikeParams)
    // 顺序必须与 conditions 中图库导入根条件的位置一致（紧随 media_source 之后）
    whereParams.push(...importRootLikeParams)

    // 默认视图：conditions 仅含 'is_deleted = 0' 与 "media_source != 'launcher'"
    // 用于 media_count 缓存命中判断；其他过滤参数（accountUid/albumType 等）会使视图脱离默认状态
    const isDefaultView =
      conditions.length === 2 &&
      conditions[0] === 'is_deleted = 0' &&
      conditions[1] === "COALESCE(media_source, 'game') != 'launcher'"

    return { whereClause, whereParams, isDefaultView }
  }

  // ==========================================================================
  // Media files: Single-row mutations（写操作，async 走 worker）
  // ==========================================================================

  /**
   * R8：用户面向变更统一刷新 updated_at，供 operation_history 乐观锁比对。
   * 仅在用户可见字段（rating/favorite/tags/notes/category/outfit/scene_time/is_deleted）变更时触发，
   * worker 内部维护字段（thumbnail/phash/is_missing/is_duplicate 等）不刷新，避免误判冲突。
   */
  private static readonly UPDATED_AT_CLAUSE = "updated_at = datetime('now', 'localtime')"

  /** media:updateRating */
  async updateRating(mediaId: number, rating: number): Promise<void> {
    await this.runWrite(
      `UPDATE media_files SET rating = ?, ${MediaRepository.UPDATED_AT_CLAUSE} WHERE id = ?`,
      [rating, mediaId]
    )
  }

  /** media:updateFavorite */
  async updateFavorite(mediaId: number, isFavorite: boolean): Promise<void> {
    await this.runWrite(
      `UPDATE media_files SET is_favorite = ?, ${MediaRepository.UPDATED_AT_CLAUSE} WHERE id = ?`,
      [isFavorite ? 1 : 0, mediaId]
    )
  }

  /** media:updateTags */
  async updateTags(mediaId: number, tags: string[]): Promise<void> {
    await this.runWrite(
      `UPDATE media_files SET tags = ?, ${MediaRepository.UPDATED_AT_CLAUSE} WHERE id = ?`,
      [JSON.stringify(tags), mediaId]
    )
  }

  /** media:updateNotes */
  async updateNotes(mediaId: number, notes: string): Promise<void> {
    await this.runWrite(
      `UPDATE media_files SET notes = ?, ${MediaRepository.UPDATED_AT_CLAUSE} WHERE id = ?`,
      [notes, mediaId]
    )
  }

  /** media:updateCategory */
  async updateCategory(mediaId: number, categoryId: number | null): Promise<void> {
    await this.runWrite(
      `UPDATE media_files SET category_id = ?, ${MediaRepository.UPDATED_AT_CLAUSE} WHERE id = ?`,
      [categoryId, mediaId]
    )
  }

  /** media:updateOutfit */
  async updateOutfit(mediaId: number, outfit: string): Promise<void> {
    await this.runWrite(
      `UPDATE media_files SET outfit = ?, ${MediaRepository.UPDATED_AT_CLAUSE} WHERE id = ?`,
      [outfit, mediaId]
    )
  }

  /** media:analyzeSceneTime — 单条 scene_time 更新 */
  async updateSceneTime(mediaId: number, sceneTime: string): Promise<void> {
    await this.runWrite(
      `UPDATE media_files SET scene_time = ?, ${MediaRepository.UPDATED_AT_CLAUSE} WHERE id = ?`,
      [sceneTime, mediaId]
    )
  }

  // ==========================================================================
  // Media files: Batch mutations (delete / restore / softDelete)
  // ==========================================================================

  /** media:delete — 物理删除单条数据库记录 */
  async hardDelete(mediaId: number): Promise<void> {
    await this.runWrite('DELETE FROM media_files WHERE id = ?', [mediaId])
  }

  /** media:softDelete — 批量软删除（标记 is_deleted=1 + deleted_at） */
  async softDeleteBatch(mediaIds: number[]): Promise<void> {
    if (mediaIds.length === 0) return
    await this.runChunkedTransaction(mediaIds, (ids, placeholders) => ({
      sql: `UPDATE media_files SET is_deleted = 1, deleted_at = datetime('now'), ${MediaRepository.UPDATED_AT_CLAUSE} WHERE id IN (${placeholders}) AND is_deleted = 0`,
      params: ids
    }))
  }

  /** media:restore — 批量恢复（清除软删除标记） */
  async restoreBatch(mediaIds: number[]): Promise<void> {
    if (mediaIds.length === 0) return
    await this.runChunkedTransaction(mediaIds, (ids, placeholders) => ({
      sql: `UPDATE media_files SET is_deleted = 0, deleted_at = NULL, ${MediaRepository.UPDATED_AT_CLAUSE} WHERE id IN (${placeholders}) AND is_deleted = 1`,
      params: ids
    }))
  }

  /**
   * media:permanentDelete 阶段1 — 幂等软删除标记
   * 回收站记录已 is_deleted=1，直接彻底删除场景也标记一次
   * 逐条 UPDATE，事务包裹
   */
  async softDeleteForPermanentDelete(mediaIds: number[]): Promise<void> {
    if (mediaIds.length === 0) return
    const statements: DbStatement[] = mediaIds.map((id) => ({
      sql: `UPDATE media_files SET is_deleted = 1, deleted_at = datetime("now"), ${MediaRepository.UPDATED_AT_CLAUSE} WHERE id = ?`,
      params: [id]
    }))
    await this.runTransaction(statements)
  }

  /**
   * 软删某导入根（指定目录扫描登记目录）前缀下的媒体记录，使其进入回收站可恢复。
   * 返回受影响（被标记软删）的行数。
   *
   * - 复用 NORMALIZED_PATH_EXPR（小写 + 正斜杠）与 escapeLikePattern 做 '<root>/%' 前缀匹配，
   *   规避 Windows 路径大小写差异与目录名里的 '_' / '%' 通配误伤。
   * - normalizeRootPath 结果为空（空/非法路径）时直接 no-op 返回 0，绝不生成 `LIKE '%'` 误删全库。
   * - 仅标记 is_deleted=1，不硬删，符合应用「回收站可恢复」数据模型。
   */
  async softDeleteByRootPath(rootPath: string): Promise<number> {
    const normalized = normalizeRootPath(rootPath).toLowerCase()
    if (!normalized) return 0
    const pattern = `${escapeLikePattern(normalized)}/%`
    const { changes } = await this.runWrite(
      `UPDATE media_files SET is_deleted = 1, deleted_at = datetime('now'), ${MediaRepository.UPDATED_AT_CLAUSE} WHERE ${NORMALIZED_PATH_EXPR} LIKE ? ESCAPE '\\' AND is_deleted = 0`,
      [pattern]
    )
    return changes
  }

  /**
   * media:permanentDelete 阶段3 / media:emptyRecycleBin — 物理删除数据库记录
   * 事务包裹，与原实现一致
   */
  async hardDeleteBatch(mediaIds: number[]): Promise<void> {
    if (mediaIds.length === 0) return
    await this.runChunkedTransaction(mediaIds, (ids, placeholders) => ({
      sql: `DELETE FROM media_files WHERE id IN (${placeholders})`,
      params: ids
    }))
  }

  /** media:cleanupMissing — 清理所有 is_missing=1 的记录，返回删除条数 */
  async cleanupMissingRecords(): Promise<number> {
    const result = await this.runWrite('DELETE FROM media_files WHERE is_missing = 1')
    return result.changes
  }

  /**
   * R8：读取媒体记录的 updated_at（乐观锁快照比对用）。
   * 返回 ISO 风格字符串（datetime('now','localtime') 格式），或 NULL（旧库未迁移/未被用户操作过）。
   */
  getMediaUpdatedAt(mediaId: number): string | null {
    const row = this.db.prepare('SELECT updated_at FROM media_files WHERE id = ?').get(mediaId) as
      { updated_at: string | null } | undefined
    return row?.updated_at ?? null
  }

  /** media:removeMissing — 删除单条 missing 记录，返回是否删除成功 */
  async removeMissingRecord(mediaId: number): Promise<boolean> {
    const result = await this.runWrite('DELETE FROM media_files WHERE id = ? AND is_missing = 1', [
      mediaId
    ])
    return result.changes > 0
  }

  // ==========================================================================
  // Media files: Corrupted status mutations（损坏文件容错）
  // ==========================================================================

  /**
   * 标记文件为损坏（is_corrupted=1）并记录原因。
   * - 累加 corrupted_count，达到阈值（1 次）后置 is_corrupted=1
   * - 与 missing_count 防抖机制不同：损坏是确定性的（解码失败不会自愈），无需防抖
   * - reason 截断为 200 字符，避免过长错误信息占用存储
   */
  async markCorrupted(mediaId: number, reason: string): Promise<void> {
    const truncatedReason = reason.slice(0, 200)
    await this.runWrite(
      'UPDATE media_files SET is_corrupted = 1, corrupted_count = corrupted_count + 1, corrupted_reason = ? WHERE id = ?',
      [truncatedReason, mediaId]
    )
  }

  /**
   * 清除损坏标记（文件被修复或重新解码成功时调用）。
   * 重置 corrupted_count 与 corrupted_reason。
   */
  async clearCorrupted(mediaId: number): Promise<void> {
    await this.runWrite(
      'UPDATE media_files SET is_corrupted = 0, corrupted_count = 0, corrupted_reason = NULL WHERE id = ?',
      [mediaId]
    )
  }

  /** media:cleanupCorrupted — 清理所有 is_corrupted=1 的记录，返回删除条数 */
  async cleanupCorruptedRecords(): Promise<number> {
    const result = await this.runWrite('DELETE FROM media_files WHERE is_corrupted = 1')
    return result.changes
  }

  /** media:removeCorrupted — 删除单条损坏记录，返回是否删除成功 */
  async removeCorruptedRecord(mediaId: number): Promise<boolean> {
    const result = await this.runWrite(
      'DELETE FROM media_files WHERE id = ? AND is_corrupted = 1',
      [mediaId]
    )
    return result.changes > 0
  }

  /**
   * 根据 file_path 查询媒体记录 id（用于扫描器在写入失败时标记损坏）。
   * 返回 id 或 undefined（记录不存在时）。
   */
  getMediaIdByPath(filePath: string): number | undefined {
    const row = this.db.prepare('SELECT id FROM media_files WHERE file_path = ?').get(filePath) as
      { id: number } | undefined
    return row?.id
  }

  // ==========================================================================
  // Edit history（写操作，走 worker）
  // ==========================================================================

  /**
   * R11：editor:save 的 edit_history 写入走 worker。
   *
   * 记录一条编辑历史。thumbnail 始终为 null（Bug #09-F2：该列是死字段，
   * backupPath 已在 backup_service 内部管理，无需在 edit_history 重复存储）。
   *
   * 与 EditorService 原直接 `db.prepare().run()` 行为等价，但通过 workerBridge 走独立
   * utilityProcess，保证所有 DB 写入走统一通道（synchronous=NORMAL 下避免主进程直写）。
   */
  async recordEditHistory(mediaId: number, params: string): Promise<void> {
    await this.runWrite(
      'INSERT INTO edit_history (media_id, params, thumbnail, created_at) VALUES (?, ?, ?, datetime("now"))',
      [mediaId, params, null]
    )
  }

  // ==========================================================================
  // Media files: Queries（查询，保留同步直读主进程 db）
  // ==========================================================================

  /**
   * media:list — 分页查询媒体列表
   * 包含 media_count 缓存读取逻辑（默认视图命中缓存，非默认视图实时 COUNT）
   */
  listMedia(options: MediaListOptions): MediaListResult {
    const page = options.page
    const pageSize = options.pageSize
    const usePagination = typeof page === 'number' && typeof pageSize === 'number' && pageSize > 0

    const { whereClause, whereParams, isDefaultView } = this.buildListWhereClause(options)

    const selectColumns =
      'id, file_path, file_name, file_type, file_ext, file_size, width, height, duration, created_at, modified_at, thumbnail, tags, category_id, rating, is_favorite, notes, scene_category, scene_time, outfit, account_uid, album_type, is_deleted, deleted_at, is_missing, is_duplicate, original_id, media_source, is_corrupted, corrupted_count, corrupted_reason'

    // 排序白名单防止 SQL 注入
    const VALID_SORT_COLUMNS: Record<string, string> = {
      created_at: 'created_at',
      modified_at: 'modified_at',
      file_name: 'file_name',
      file_size: 'file_size',
      rating: 'rating'
    }
    const deletedOnly = options.deletedOnly === true
    const sortColumn =
      options.sortBy && VALID_SORT_COLUMNS[options.sortBy]
        ? VALID_SORT_COLUMNS[options.sortBy]
        : deletedOnly
          ? 'deleted_at'
          : 'created_at'
    const sortDirection = options.sortOrder === 'asc' ? 'ASC' : 'DESC'
    const orderBy = `ORDER BY ${sortColumn} ${sortDirection}`

    let rawRows: Array<Omit<MediaRow, 'tags'> & { tags: unknown }>
    if (usePagination) {
      const offset = page! * pageSize!
      rawRows = this.db
        .prepare(
          `SELECT ${selectColumns} FROM media_files ${whereClause} ${orderBy} LIMIT ? OFFSET ?`
        )
        .all(...whereParams, pageSize, offset) as Array<Omit<MediaRow, 'tags'> & { tags: unknown }>
    } else {
      rawRows = this.db
        .prepare(`SELECT ${selectColumns} FROM media_files ${whereClause} ${orderBy}`)
        .all(...whereParams) as Array<Omit<MediaRow, 'tags'> & { tags: unknown }>
    }

    // 解析 tags JSON 字段
    const rows: MediaRow[] = rawRows.map((r) => ({
      ...r,
      tags: this.parseTagsField(r.tags)
    }))

    const result: MediaListResult = { rows }

    if (usePagination) {
      let total: number
      if (isDefaultView) {
        // 默认视图：尝试 media_count 缓存
        const cached = this.getMediaCountCache()
        if (cached !== null) {
          total = cached
        } else {
          total = this.countMedia(whereClause, whereParams)
          // R5：缓存未命中时异步重建（走 worker），失败不阻塞读取结果
          // 旧实现的 setMediaCountCacheSync 同步直写已删除（与"所有写走 worker"架构一致）
          void this.setMediaCountCache(total).catch(() => {
            // 重建失败时静默；下次 listMedia 仍会走真实 COUNT 并再次尝试重建
          })
        }
      } else {
        total = this.countMedia(whereClause, whereParams)
      }
      result.total = total
      result.page = page
      result.pageSize = pageSize
      // hasMore 必须同时满足"还有下一页"和"本页已满"
      // 仅用 total 计算时，若 media_count 缓存已更新但前端列表尚未刷新（100ms 节流窗口），
      // 会出现 hasMore=true 但实际 rows.length<pageSize 的不一致提示
      result.hasMore = rows.length === pageSize && (page! + 1) * pageSize! < total
    }

    return result
  }

  /** COUNT 查询（使用与 listMedia 相同的 WHERE 子句） */
  private countMedia(whereClause: string, whereParams: unknown[]): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM media_files ${whereClause}`)
      .get(...whereParams) as { count: number }
    return row.count
  }

  /**
   * 读取 media_count 缓存（app_settings），未缓存/失效/过期返回 null。
   *
   * R5：强一致改造——除 media_count 外同时校验：
   *   - media_count_dirty = 1：refreshMediaCountCache 失败时显式标记失效，下次读取走真实 COUNT
   *   - media_count_updated_at：超过 MEDIA_COUNT_CACHE_TTL_MS（24h）强制重建，避免长期陈旧
   *
   * 三个 key 在同一次 SELECT 中读取，避免多次往返。旧库无 dirty/updated_at 时视为失效（触发首次重建）。
   */
  private getMediaCountCache(): number | null {
    const rows = this.db
      .prepare('SELECT key, value FROM app_settings WHERE key IN (?, ?, ?)')
      .all('media_count', 'media_count_dirty', 'media_count_updated_at') as Array<{
      key: string
      value: string
    }>
    if (rows.length === 0) return null
    // 同一 key 多次写入时（INSERT OR REPLACE）以最新值为准
    const map = new Map(rows.map((r) => [r.key, r.value]))
    const countStr = map.get('media_count')
    if (!countStr) return null
    let count: number
    try {
      count = JSON.parse(countStr)
      if (typeof count !== 'number' || count < 0) return null
    } catch {
      return null
    }
    // dirty 标记：1 表示上次刷新失败，缓存不可信
    const dirtyStr = map.get('media_count_dirty')
    if (dirtyStr !== undefined) {
      try {
        if (JSON.parse(dirtyStr) === 1) return null
      } catch {
        // 损坏的 dirty 值视为失效
        return null
      }
    } else {
      // 旧库无 dirty 字段：视为失效，触发首次重建并补齐字段
      return null
    }
    // TTL 校验：超过 24h 强制重建
    const tsStr = map.get('media_count_updated_at')
    if (tsStr === undefined) return null
    try {
      const ts = JSON.parse(tsStr)
      if (typeof ts !== 'number' || Date.now() - ts > MEDIA_COUNT_CACHE_TTL_MS) {
        return null
      }
    } catch {
      return null
    }
    return count
  }

  /**
   * 写入 media_count 缓存（async，走 worker 事务）。
   *
   * R5：原子写入 count + dirty=0 + updated_at=now 三个 key，确保读侧校验始终命中一致的快照。
   * 取代旧的 setMediaCountCacheSync 同步直写路径。
   */
  async setMediaCountCache(count: number): Promise<void> {
    await this.runTransaction([
      {
        sql: 'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)',
        params: ['media_count', JSON.stringify(count)]
      },
      {
        sql: 'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)',
        params: ['media_count_dirty', JSON.stringify(0)]
      },
      {
        sql: 'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)',
        params: ['media_count_updated_at', JSON.stringify(Date.now())]
      }
    ])
  }

  /**
   * R5：标记 media_count 缓存失效（dirty=1）。
   * refreshMediaCountCache 失败时调用，下次 listMedia 检测到 dirty=1 走真实 COUNT。
   * 仅写入单 key，不开事务（与正常路径写入复杂度对称即可）。
   */
  async markMediaCountDirty(): Promise<void> {
    await this.runWrite('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [
      'media_count_dirty',
      JSON.stringify(1)
    ])
  }

  /**
   * R13：原子写入单个 app_settings key，走 worker 事务。
   *
   * 取代 IPC handler 中 `dbManager.setSetting` 的同步直写路径：
   *   1. 写操作统一走 worker（与"所有写走 worker"架构一致）
   *   2. 单条事务包裹，便于未来扩展为多 key 原子写入
   *   3. 调用方可通过 await 确保落盘后再继续（同步 setSetting 无法保证）
   */
  async setSetting(key: string, value: unknown): Promise<void> {
    await this.runTransaction([
      {
        sql: 'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)',
        params: [key, JSON.stringify(value)]
      }
    ])
  }

  /**
   * Slice 7c-fix：刷新 media_count 缓存为默认视图会展示的未软删除记录数
   * 与 listMedia 默认视图 WHERE 完全一致（排除 launcher 缓存），避免缓存总数虚高。
   * 统一收口 media_count 的写入逻辑，消除 Application.notifyMediaUpdated 的直接 SQL 双写路径
   *
   * R5：刷新失败时由调用方（notifyMediaUpdated）通过 markMediaCountDirty 标记失效，
   * 不再 fire-and-forget 吞错——读侧会回退到真实 COUNT 并尝试重建。
   */
  async refreshMediaCountCache(): Promise<void> {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM media_files WHERE is_deleted = 0 AND COALESCE(media_source, 'game') != 'launcher'"
      )
      .get() as { count: number } | undefined
    if (row) {
      await this.setMediaCountCache(row.count)
    }
  }

  /** media:analyzeSceneTime — 查询待分析的图片记录 */
  getMediaForSceneAnalysis(mediaIds?: number[]): IdPathRow[] {
    if (mediaIds && mediaIds.length > 0) {
      return this.queryChunked<IdPathRow>(mediaIds, (ids, placeholders) => ({
        sql: `SELECT id, file_path FROM media_files WHERE id IN (${placeholders}) AND file_type = ?`,
        params: [...ids, 'image']
      }))
    }
    return this.db
      .prepare(
        "SELECT id, file_path FROM media_files WHERE scene_time = 'unknown' AND file_type = 'image' AND is_deleted = 0"
      )
      .all() as IdPathRow[]
  }

  /** media:permanentDelete / media:emptyRecycleBin — 查询文件路径 */
  getMediaPathsByIds(mediaIds: number[]): IdPathRow[] {
    if (mediaIds.length === 0) return []
    return this.queryChunked<IdPathRow>(mediaIds, (ids, placeholders) => ({
      sql: `SELECT id, file_path FROM media_files WHERE id IN (${placeholders})`,
      params: ids
    }))
  }

  /** media:emptyRecycleBin — 查询所有软删除记录 */
  getSoftDeletedMediaPaths(): IdPathRow[] {
    return this.db
      .prepare('SELECT id, file_path FROM media_files WHERE is_deleted = 1')
      .all() as IdPathRow[]
  }

  /** media:getOutfitStats — 聚合查询每个套装的张数 / 最新拍摄时间 */
  getOutfitAggStats(): OutfitAggRow[] {
    return this.db
      .prepare(
        `SELECT outfit, COUNT(*) as count, MAX(created_at) as latest_created, MAX(modified_at) as latest_modified
       FROM media_files
       WHERE is_deleted = 0 AND outfit IS NOT NULL AND outfit != ''
       GROUP BY outfit
       ORDER BY count DESC, latest_created DESC`
      )
      .all() as OutfitAggRow[]
  }

  /** media:getOutfitStats — 取每个套装最新一张作为封面 */
  getLatestOutfitMedia(outfit: string): OutfitLatestRow | undefined {
    return this.db
      .prepare(
        'SELECT file_path, thumbnail FROM media_files WHERE outfit = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT 1'
      )
      .get(outfit) as OutfitLatestRow | undefined
  }

  /** media:findDuplicates — 查询所有未软删除文件的元数据（用于 size+hash 分组） */
  getDuplicateCandidates(): DuplicateCandidateRow[] {
    return this.db
      .prepare(
        `SELECT id, file_path, file_name, file_type, file_size, modified_at, width, height, is_favorite, rating
       FROM media_files WHERE is_deleted = 0`
      )
      .all() as DuplicateCandidateRow[]
  }

  /** media:findSimilar — 查询所有已计算 pHash 的未软删除图片 */
  getPhashRows(): PhashRow[] {
    return this.db
      .prepare(
        `SELECT id, file_path, file_name, file_type, file_size, modified_at, width, height, is_favorite, rating, phash, phash_mtime, phash_file_size
       FROM media_files
       WHERE is_deleted = 0 AND phash IS NOT NULL AND phash != ''`
      )
      .all() as PhashRow[]
  }

  /** media:findSimilar — 已落库 pHash 行数（快速路径判断空库，避免全量载入） */
  getPhashCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM media_files
         WHERE is_deleted = 0 AND phash IS NOT NULL AND phash != ''`
      )
      .get() as { c: number }
    return row.c
  }

  /**
   * R7 stale 检测用的轻量采样：仅取 file_path / phash_mtime / phash_file_size，
   * 不取 phash 本体，避免主进程持有全部 pHash 字符串。
   * 用 ROW_NUMBER 取均匀间隔的 sampleSize 行（覆盖头/中/尾）。
   */
  getPhashStaleSample(sampleSize: number): Array<{
    id: number
    file_path: string
    phash_mtime: number | null
    phash_file_size: number | null
  }> {
    return this.db
      .prepare(
        `WITH ranked AS (
           SELECT id, file_path, phash_mtime, phash_file_size,
                  ROW_NUMBER() OVER (ORDER BY id) - 1 AS rn
           FROM media_files
           WHERE is_deleted = 0 AND phash IS NOT NULL AND phash != ''
         )
         SELECT id, file_path, phash_mtime, phash_file_size
         FROM ranked
         WHERE rn % ? = 0
         LIMIT ?`
      )
      .all(
        Math.max(1, Math.floor((this.getPhashCount() || 1) / Math.max(1, sampleSize))),
        sampleSize
      ) as Array<{
      id: number
      file_path: string
      phash_mtime: number | null
      phash_file_size: number | null
    }>
  }

  /**
   * 检测 FTS5 全文索引是否可用（media_fts 虚拟表是否已创建）
   * 由 ipc handler 在 media:search 中调用，决定走 FTS5 还是 LIKE fallback
   */
  isFts5Available(): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_fts'")
      .get() as { '1': number } | undefined
    return !!row
  }

  /**
   * 全文搜索文件名（性能重构 v3 改造项二）
   * - FTS5 可用时：MATCH 查询，命中 media_fts 虚拟表，性能 ≤ 100ms（万级数据）
   * - FTS5 不可用时：降级为 LIKE 查询，性能 ≤ 200ms（万级数据）
   * - 返回行结构包含 id 与 file_path，由调用方按需 join 完整 media_files 数据
   *
   * 注意：keyword 应由调用方转义 FTS5 特殊字符（如 "、*、: 等），
   *       本方法仅做基础 keyword 包装，不做完整 FTS5 语法解析
   */
  searchByFileName(
    keyword: string,
    limit = 200
  ): Array<{ id: number; file_path: string; file_name: string }> {
    const trimmed = keyword.trim()
    if (!trimmed) return []

    if (this.isFts5Available()) {
      // FTS5 路径：MATCH 查询
      // 用双引号包裹 keyword 作为 phrase 查询，避免被解释为 FTS5 语法
      // 同时支持前缀匹配：keyword* 自动匹配前缀
      const escaped = trimmed.replace(/"/g, '""')
      try {
        return this.db
          .prepare(
            `SELECT m.id, m.file_path, m.file_name
             FROM media_fts f
             JOIN media_files m ON m.id = f.rowid
             WHERE media_fts MATCH ?
               AND m.is_deleted = 0
             ORDER BY rank
             LIMIT ?`
          )
          .all(`"${escaped}"*`, limit) as Array<{
          id: number
          file_path: string
          file_name: string
        }>
      } catch (err) {
        // FTS5 查询语法错误时降级为 LIKE
        logger.warn(t('main.db.log.fts5QueryFallback'), err instanceof Error ? err.message : err)
      }
    }

    // LIKE fallback 路径
    return this.db
      .prepare(
        `SELECT id, file_path, file_name
         FROM media_files
         WHERE file_name LIKE ? AND is_deleted = 0
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(`%${trimmed}%`, limit) as Array<{ id: number; file_path: string; file_name: string }>
  }

  /**
   * search:buildDocs — 批量返回索引文档字段
   * 仅 SELECT 搜索所需列（id/file_name/tags/outfit/scene_category/notes/indexed_at）
   * tags 字段保持 DB 原始 JSON 字符串，由调用方按需 join 或分词
   * @param since 仅返回 indexed_at > since 的记录（增量模式），undefined 表示全量
   * @param limit  分页大小（建议 5000）
   * @param offset 分页偏移
   */
  getSearchDocs(since: string | undefined, limit: number, offset: number): SearchableDocRow[] {
    const params: unknown[] = []
    let where = 'is_deleted = 0'
    if (since) {
      where += ' AND indexed_at > ?'
      params.push(since)
    }
    params.push(limit, offset)
    return this.db
      .prepare(
        `SELECT id, file_name, tags, outfit, scene_category, notes, indexed_at
         FROM media_files
         WHERE ${where}
         ORDER BY id ASC
         LIMIT ? OFFSET ?`
      )
      .all(...params) as SearchableDocRow[]
  }

  /**
   * search:buildDocs — 返回待索引记录总数（用于分页拉取与启动校验）
   * 与 getSearchDocs 共用 where 子句
   */
  getSearchDocsCount(since: string | undefined): number {
    const params: unknown[] = []
    let where = 'is_deleted = 0'
    if (since) {
      where += ' AND indexed_at > ?'
      params.push(since)
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM media_files WHERE ${where}`)
      .get(...params) as { count: number }
    return row.count
  }

  /** media:getGroupCounts — 按维度统计分组数量 */
  getGroupCounts(
    dimension: GroupDimension,
    accountUid: string | undefined,
    mediaSource: MediaSourceFilter | undefined
  ): GroupCountRow[] {
    const conditions: string[] = ['is_deleted = 0']
    const params: unknown[] = []
    if (accountUid && accountUid !== 'all') {
      conditions.push('account_uid = ?')
      params.push(accountUid)
    }
    if (mediaSource && mediaSource !== 'all') {
      conditions.push('media_source = ?')
      params.push(mediaSource)
    }
    // outfit 维度需过滤空值（无套装标注的文件不计入分组）
    if (dimension === 'outfit') {
      conditions.push("outfit IS NOT NULL AND outfit != ''")
    }
    const whereFilter = conditions.join(' AND ')

    const rows = this.db
      .prepare(
        `SELECT ${dimension} as key, COUNT(*) as cnt FROM media_files WHERE ${whereFilter} GROUP BY ${dimension} ORDER BY cnt DESC`
      )
      .all(...params) as Array<{ key: string; cnt: number }>

    return rows.map((r) => ({ key: r.key, count: r.cnt }))
  }

  // ==========================================================================
  // Duplicates (is_duplicate / original_id 查询)
  // ==========================================================================

  /** duplicate:listGroups — 查询所有 is_duplicate=1 的文件 */
  getDuplicateGroupRows(): DuplicateGroupRow[] {
    return this.db
      .prepare(
        `SELECT id, file_path, file_name, file_type, file_size, modified_at, width, height, is_favorite, rating, original_id
       FROM media_files
       WHERE is_duplicate = 1 AND is_deleted = 0 AND original_id IS NOT NULL
       ORDER BY original_id, modified_at DESC`
      )
      .all() as DuplicateGroupRow[]
  }

  /** duplicate:listGroups — 查询每组 original_id 对应的推荐保留文件 */
  getOriginalsByIds(originalIds: number[]): OriginalRow[] {
    if (originalIds.length === 0) return []
    return this.queryChunked<OriginalRow>(originalIds, (ids, placeholders) => ({
      sql: `SELECT id, file_path, file_name, file_type, file_size, modified_at, width, height, is_favorite, rating
       FROM media_files WHERE id IN (${placeholders})`,
      params: ids
    }))
  }

  // ==========================================================================
  // Categories（写操作 async，查询同步）
  // ==========================================================================

  /** category:create — 返回新分类 id */
  async createCategory(
    name: string,
    icon: string,
    color: string,
    parentId: number | null
  ): Promise<number> {
    // 先查 max(sort_order)（查询，同步）
    const maxOrderRow = this.db
      .prepare('SELECT MAX(sort_order) as maxOrder FROM categories')
      .get() as { maxOrder: number | null } | undefined
    const maxOrder = maxOrderRow?.maxOrder || 0
    // 写入（走 worker）
    const result = await this.runWrite(
      'INSERT INTO categories (name, icon, color, sort_order, parent_id, is_system, created_at) VALUES (?, ?, ?, ?, ?, 0, datetime("now"))',
      [name, icon, color, maxOrder + 1, parentId]
    )
    return Number(result.lastInsertRowid)
  }

  /** category:update — 动态字段更新（fields 与 values 由 handler 构建白名单后传入） */
  async updateCategoryFields(id: number, fields: string[], values: unknown[]): Promise<void> {
    if (fields.length === 0) return
    const setClause = fields.join(', ')
    await this.runWrite(`UPDATE categories SET ${setClause} WHERE id = ?`, [...values, id])
  }

  /** FIX(组8-1): category:delete 前置查询——目标分类是否为系统分类（供 handler 守卫拒绝） */
  isSystemCategory(id: number): boolean {
    const row = this.db.prepare('SELECT is_system FROM categories WHERE id = ?').get(id) as
      { is_system: number } | undefined
    return row?.is_system === 1
  }

  /** category:delete — 级联清理 media_files.category_id + 删除分类（事务） */
  async deleteCategoryCascade(id: number): Promise<void> {
    await this.runTransaction([
      {
        sql: 'UPDATE media_files SET category_id = NULL WHERE category_id = ?',
        params: [id]
      },
      {
        sql: 'DELETE FROM categories WHERE id = ? AND is_system = 0',
        params: [id]
      }
    ])
  }

  /** category:reorder — 批量更新 sort_order + parent_id（事务） */
  async reorderCategories(
    orders: Array<{ id: number; sort_order: number; parent_id?: number | null }>
  ): Promise<void> {
    if (orders.length === 0) return
    const statements: DbStatement[] = orders.map((order) => ({
      sql: 'UPDATE categories SET sort_order = ?, parent_id = ? WHERE id = ?',
      params: [order.sort_order, order.parent_id ?? null, order.id]
    }))
    await this.runTransaction(statements)
  }

  /** category:list — 查询全部分类（按 sort_order 排序） */
  listCategories(): CategoryRow[] {
    return this.db
      .prepare(
        'SELECT id, name, icon, color, sort_order, parent_id, is_system FROM categories ORDER BY sort_order'
      )
      .all() as CategoryRow[]
  }

  // ==========================================================================
  // Profiles (character_profiles + media_files.account_uid)
  // ==========================================================================

  /** profile:list — 查询全角色档案（按 created_at 升序） */
  listProfiles(): ProfileRow[] {
    return this.db
      .prepare(
        'SELECT uid, nickname, avatar, created_at, last_active_at FROM character_profiles ORDER BY created_at ASC'
      )
      .all() as ProfileRow[]
  }

  /** profile:add — 新增角色档案 */
  async addProfile(uid: string, nickname: string, avatar: string | null): Promise<void> {
    await this.runWrite(
      "INSERT INTO character_profiles (uid, nickname, avatar, created_at) VALUES (?, ?, ?, datetime('now'))",
      [uid, nickname, avatar]
    )
  }

  /** profile:update — 动态字段更新（sets 与 params 由 handler 构建白名单后传入） */
  async updateProfileFields(uid: string, sets: string[], params: unknown[]): Promise<void> {
    if (sets.length === 0) return
    const setClause = sets.join(', ')
    await this.runWrite(`UPDATE character_profiles SET ${setClause} WHERE uid = ?`, [
      ...params,
      uid
    ])
  }

  /** profile:delete — 删除档案前将该档案下的文件迁移到默认档案（事务） */
  async deleteProfileAndReassign(uid: string): Promise<void> {
    await this.runTransaction([
      {
        sql: "UPDATE media_files SET account_uid = 'default' WHERE account_uid = ?",
        params: [uid]
      },
      {
        sql: 'DELETE FROM character_profiles WHERE uid = ?',
        params: [uid]
      }
    ])
  }

  /** profile:setCurrent — 更新 last_active_at */
  async touchProfileActive(uid: string): Promise<void> {
    await this.runWrite(
      "UPDATE character_profiles SET last_active_at = datetime('now') WHERE uid = ?",
      [uid]
    )
  }

  /** profile:transferFiles — 校验目标档案存在 */
  getProfileByUid(uid: string): { uid: string } | undefined {
    return this.db.prepare('SELECT uid FROM character_profiles WHERE uid = ?').get(uid) as
      { uid: string } | undefined
  }

  /** profile:transferFiles — 批量更新 media_files.account_uid（事务） */
  async transferFilesToProfile(mediaIds: number[], targetUid: string): Promise<void> {
    if (mediaIds.length === 0) return
    await this.runChunkedTransaction(mediaIds, (ids, placeholders) => ({
      sql: `UPDATE media_files SET account_uid = ? WHERE id IN (${placeholders})`,
      params: [targetUid, ...ids]
    }))
  }

  /** profile:getStats — 基础统计（总数 / 图片数 / 视频数 / 总大小 / 最早最晚时间） */
  getProfileBaseStats(uid: string): ProfileBaseStats {
    const row = this.db
      .prepare(
        `SELECT
        COUNT(*) as total_count,
        SUM(CASE WHEN file_type = 'image' THEN 1 ELSE 0 END) as image_count,
        SUM(CASE WHEN file_type = 'video' THEN 1 ELSE 0 END) as video_count,
        COALESCE(SUM(file_size), 0) as total_size,
        MIN(created_at) as earliest_time,
        MAX(created_at) as latest_time
      FROM media_files
      WHERE account_uid = ? AND is_deleted = 0`
      )
      .get(uid) as ProfileBaseStats
    return row
  }

  /** profile:getStats — Top 5 套装偏好 */
  getProfileTopOutfits(uid: string, limit = 5): ProfileTopStatRow[] {
    return this.db
      .prepare(
        `SELECT outfit as key, COUNT(*) as cnt
      FROM media_files
      WHERE account_uid = ? AND is_deleted = 0 AND outfit IS NOT NULL AND outfit != ''
      GROUP BY outfit
      ORDER BY cnt DESC
      LIMIT ?`
      )
      .all(uid, limit) as ProfileTopStatRow[]
  }

  /** profile:getStats — Top 5 场景偏好 */
  getProfileTopScenes(uid: string, limit = 5): ProfileTopStatRow[] {
    return this.db
      .prepare(
        `SELECT scene_category as key, COUNT(*) as cnt
      FROM media_files
      WHERE account_uid = ? AND is_deleted = 0 AND scene_category IS NOT NULL
      GROUP BY scene_category
      ORDER BY cnt DESC
      LIMIT ?`
      )
      .all(uid, limit) as ProfileTopStatRow[]
  }

  /** profile:getStats — 时段偏好分布（日间/黄昏/夜间占比） */
  getProfileTimeDistribution(uid: string): ProfileTopStatRow[] {
    return this.db
      .prepare(
        `SELECT scene_time as key, COUNT(*) as cnt
      FROM media_files
      WHERE account_uid = ? AND is_deleted = 0
      GROUP BY scene_time`
      )
      .all(uid) as ProfileTopStatRow[]
  }

  // ==========================================================================
  // Transaction accessor（供 handler 在多阶段事务场景使用）
  // ==========================================================================

  /**
   * 暴露事务接口：statements 数组在同一事务中执行，任一失败回滚。
   * 改造前是 db.transaction(fn)() 形式，调用方传入闭包；
   * 改造后改为 statements 数组形式，便于跨进程序列化为 DbStatement[]。
   *
   * 兼容场景：handler 中已有"先查再写"的多阶段流程（如 permanentDelete 三阶段），
   * 各阶段单独 await 调用对应的写方法即可，无需用 transaction 包装。
   */
  async transaction(statements: DbStatement[]): Promise<Database.RunResult> {
    return this.runTransaction(statements)
  }
}
