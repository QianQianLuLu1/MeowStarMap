import type Database from 'better-sqlite3'
import {
  PROTOCOL_VERSION,
  isAssetType,
  type AssetDetailResponse,
  type AssetListQuery,
  type AssetListResponse,
  type ChangesResponse,
  type InfinityPhotoMetadata,
  type MediaResource,
  type MotionAssetInfo,
  type Revision,
  type ServerInfoResponse
} from '../../shared/sync/protocol'
import { SyncMetadataRepository } from './sync-metadata-repository'
import {
  buildMotionInfo,
  buildMotionResource,
  buildPhotoMetadata,
  buildSourceResource,
  buildThumbnailResource,
  decodeCursor,
  encodeCursor,
  mapToAssetSummary,
  mapToNikkiAsset,
  parseResourceId,
  type SyncMediaRow
} from './sync-row-mappers'
import { calculateFileHash } from '../utils/file-utils'

/**
 * 同步读取仓储 — 将 media_files（+ sync_motion_links / sync_change_journal）
 * 映射为 NikkiSync 协议查询响应（ServerInfo / AssetList / AssetDetail /
 * Metadata / ResourceLocation / Changes）。
 *
 * - 读路径全部同步（主进程连接），映射逻辑在 sync-row-mappers（纯函数）
 * - listAssets 为 keyset 分页：ORDER BY COALESCE(NULLIF(modified_at,''),created_at) DESC,
 *   id DESC，cursor 携带 (sortKey, id)；limit 钳制 [1, 500]（对齐上游服务端强制范围）
 * - 组合查询仅按"固定基线 + 固定片段白名单"拼接 SQL 文本（无任何用户数据进入
 *   SQL 文本），全部值经参数绑定；写操作仅 sha256 惰性缓存回写（同步直写，
 *   与 sync-metadata-repository 同款先例，bridge 形参保留待切回）
 * - sha256 协议必填而 media_files 原生缺失：源文件首次访问时计算并回写
 *   media_files.sha256 缓存列；缩略图小文件即时计算不落库
 * - 测试接缝：hashFile 可注入（默认 calculateFileHash）；内存数据库实例化
 */

export const DEFAULT_PAGE_LIMIT = 100
export const MAX_PAGE_LIMIT = 500

export type HashFileFn = (filePath: string) => Promise<string>

export interface SyncReadRepositoryDeps {
  /** 覆盖默认的 calculateFileHash（测试注入替身；阶段 3 可换批量哈希实现） */
  hashFile?: HashFileFn
}

// ============================================================================
// SQL 模板（完整静态字面量；与 sync-read-repository.test.ts 的 mock 一一对应）
// ============================================================================

const LIST_SELECT_PREFIX =
  'SELECT m.id, m.file_path, m.file_name, m.file_type, m.file_ext, m.file_size, m.width, m.height, m.duration, m.created_at, m.modified_at, m.thumbnail, m.account_uid, m.indexed_at, m.is_deleted, m.deleted_at, m.is_missing, m.is_corrupted, m.editor_metadata, m.sha256, CASE WHEN ml.still_media_id IS NULL THEN 0 ELSE 1 END AS has_motion_link, COALESCE((SELECT MAX(j.revision) FROM sync_change_journal j WHERE j.asset_id = CAST(m.id AS TEXT)), 0) AS derived_revision FROM media_files m LEFT JOIN sync_motion_links ml ON ml.still_media_id = m.id LEFT JOIN sync_motion_links mlv ON mlv.motion_media_id = m.id WHERE mlv.motion_media_id IS NULL AND m.is_duplicate = 0'
const FRAG_NOT_DELETED = ' AND m.is_deleted = 0'
const FRAG_TYPE_PHOTO = " AND m.file_type = 'image' AND ml.still_media_id IS NULL"
const FRAG_TYPE_MOTION = " AND m.file_type = 'image' AND ml.still_media_id IS NOT NULL"
const FRAG_TYPE_VIDEO = " AND m.file_type = 'video'"
const FRAG_TYPE_UNKNOWN = " AND m.file_type NOT IN ('image', 'video')"
const FRAG_AFTER =
  ' AND COALESCE((SELECT MAX(j2.revision) FROM sync_change_journal j2 WHERE j2.asset_id = CAST(m.id AS TEXT)), 0) > ?'
const FRAG_CURSOR =
  " AND (COALESCE(NULLIF(m.modified_at, ''), m.created_at) < ? OR (COALESCE(NULLIF(m.modified_at, ''), m.created_at) = ? AND m.id < ?))"
const LIST_ORDER_TAIL =
  " ORDER BY COALESCE(NULLIF(m.modified_at, ''), m.created_at) DESC, m.id DESC LIMIT ?"

const DETAIL_SELECT =
  'SELECT m.id, m.file_path, m.file_name, m.file_type, m.file_ext, m.file_size, m.width, m.height, m.duration, m.created_at, m.modified_at, m.thumbnail, m.account_uid, m.indexed_at, m.is_deleted, m.deleted_at, m.is_missing, m.is_corrupted, m.editor_metadata, m.sha256, COALESCE((SELECT MAX(j.revision) FROM sync_change_journal j WHERE j.asset_id = CAST(m.id AS TEXT)), 0) AS derived_revision FROM media_files m WHERE m.id = ?'
const MEDIA_BY_ID =
  'SELECT id, file_path, file_name, file_type, file_ext, file_size, width, height, duration, created_at, modified_at, thumbnail, account_uid, indexed_at, is_deleted, deleted_at, is_missing, is_corrupted, editor_metadata, sha256 FROM media_files WHERE id = ?'
const METADATA_BY_ID =
  'SELECT id, account_uid, modified_at, editor_metadata FROM media_files WHERE id = ?'
const SQL_SHA256_CACHE_UPDATE = 'UPDATE media_files SET sha256 = ? WHERE id = ?'

// ============================================================================
// 内部行类型
// ============================================================================

type DetailRow = SyncMediaRow & { derived_revision: number }

type ListRow = SyncMediaRow & { has_motion_link: number; derived_revision: number }

/** 列表排序键：modified_at 优先（≈拍摄时间），空串回退 created_at（与 SQL NULLIF 一致） */
function sortKeyOfRow(row: Pick<SyncMediaRow, 'modified_at' | 'created_at'>): string {
  return row.modified_at !== '' ? row.modified_at : row.created_at
}

/** assetId 协议侧为本仓储派生的数字字符串（String(media_files.id)） */
function parseAssetId(assetId: string): number {
  if (!/^\d+$/.test(assetId)) {
    throw new Error(`invalid assetId: ${assetId}`)
  }
  const id = Number(assetId)
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`invalid assetId: ${assetId}`)
  }
  return id
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT
  if (!Number.isInteger(limit)) {
    throw new Error(`invalid limit: ${String(limit)}`)
  }
  return Math.min(Math.max(limit, 1), MAX_PAGE_LIMIT)
}

export class SyncReadRepository {
  private readonly metadata: SyncMetadataRepository
  private readonly hashFile: HashFileFn

  constructor(
    private readonly db: Database.Database,
    workerBridge: unknown = null,
    dbPath: string = '',
    deps: SyncReadRepositoryDeps = {}
  ) {
    this.metadata = new SyncMetadataRepository(db, workerBridge, dbPath)
    this.hashFile = deps.hashFile ?? calculateFileHash
  }

  // ============ 服务器信息 ============

  async getServerInfo(): Promise<ServerInfoResponse> {
    const identity = await this.metadata.ensureServerIdentity()
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverId: identity.serverId,
      name: identity.serverName,
      libraryRevision: this.metadata.getCurrentRevision(),
      capabilities: {
        websocketEvents: true,
        rangeRequests: true,
        metadataV1: true,
        motionAssets: true
      }
    }
  }

  // ============ 分页图库 ============

  listAssets(query: AssetListQuery = {}): AssetListResponse {
    const limit = normalizeLimit(query.limit)
    if (query.type !== undefined && !isAssetType(query.type)) {
      throw new Error(`invalid type: ${String(query.type)}`)
    }
    if (
      query.afterRevision !== undefined &&
      (!Number.isInteger(query.afterRevision) || query.afterRevision < 0)
    ) {
      throw new Error(`invalid afterRevision: ${String(query.afterRevision)}`)
    }
    const includeDeleted = query.includeDeleted === true
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor)

    const fragments: string[] = []
    const params: unknown[] = []
    if (!includeDeleted) fragments.push(FRAG_NOT_DELETED)
    if (query.type === 'photo') fragments.push(FRAG_TYPE_PHOTO)
    else if (query.type === 'motion_photo') fragments.push(FRAG_TYPE_MOTION)
    else if (query.type === 'video') fragments.push(FRAG_TYPE_VIDEO)
    else if (query.type === 'unknown') fragments.push(FRAG_TYPE_UNKNOWN)
    if (query.afterRevision !== undefined) {
      fragments.push(FRAG_AFTER)
      params.push(query.afterRevision)
    }
    if (cursor) {
      fragments.push(FRAG_CURSOR)
      params.push(cursor.sortKey, cursor.sortKey, cursor.id)
    }
    const sql = LIST_SELECT_PREFIX + fragments.join('') + LIST_ORDER_TAIL
    params.push(limit + 1)

    const rows = this.db.prepare(sql).all(...params) as unknown as ListRow[]
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) =>
      mapToAssetSummary({
        row,
        hasMotionLink: row.has_motion_link === 1,
        revision: row.derived_revision
      })
    )
    // nextCursor 取自本页最后一行（limit+1 探测 hasMore，对齐上游服务端）
    const lastRow = rows[limit - 1]
    const nextCursor =
      hasMore && lastRow
        ? encodeCursor({ sortKey: sortKeyOfRow(lastRow), id: lastRow.id })
        : undefined
    return {
      items,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      libraryRevision: this.metadata.getCurrentRevision()
    }
  }

  // ============ 单资产详情 ============

  async getAssetDetail(assetId: string): Promise<AssetDetailResponse | null> {
    const id = parseAssetId(assetId)
    const row = this.db.prepare(DETAIL_SELECT).get(id) as DetailRow | undefined
    if (!row) return null

    const resources: MediaResource[] = []
    resources.push(buildSourceResource(row, await this.resolveSourceSha256(row)))
    if (row.thumbnail) {
      const thumbnailResource = buildThumbnailResource(row, await this.hashFile(row.thumbnail))
      if (thumbnailResource) resources.push(thumbnailResource)
    }
    let motion: MotionAssetInfo | undefined
    const link = this.metadata.getMotionLinkByStill(id)
    if (link) {
      const videoRow = this.db.prepare(MEDIA_BY_ID).get(link.motion_media_id) as
        SyncMediaRow | undefined
      if (videoRow) {
        resources.push(buildMotionResource(videoRow, await this.resolveSourceSha256(videoRow)))
        motion = buildMotionInfo(link)
      }
    }
    return {
      asset: mapToNikkiAsset({
        row,
        resources,
        motion,
        metadata: buildPhotoMetadata(row),
        revision: row.derived_revision
      })
    }
  }

  // ============ 元数据查询 ============

  async getAssetMetadata(assetId: string): Promise<InfinityPhotoMetadata | null> {
    const id = parseAssetId(assetId)
    const row = this.db.prepare(METADATA_BY_ID).get(id) as
      Pick<SyncMediaRow, 'account_uid' | 'modified_at' | 'editor_metadata'> | undefined
    if (!row) return null
    return buildPhotoMetadata(row) ?? null
  }

  // ============ 资源定位 ============

  async getResourceLocation(
    assetId: string,
    resourceId: string
  ): Promise<{ resource: MediaResource; absolutePath: string } | null> {
    const id = parseAssetId(assetId)
    const parsed = parseResourceId(resourceId)
    if (!parsed) return null

    if (parsed.kind === 'primary') {
      if (parsed.mediaId !== id) return null
      const row = this.db.prepare(MEDIA_BY_ID).get(id) as SyncMediaRow | undefined
      if (!row) return null
      return {
        resource: buildSourceResource(row, await this.resolveSourceSha256(row)),
        absolutePath: row.file_path
      }
    }
    if (parsed.kind === 'thumbnail') {
      if (parsed.mediaId !== id) return null
      const row = this.db.prepare(MEDIA_BY_ID).get(id) as SyncMediaRow | undefined
      if (!row?.thumbnail) return null
      const thumbnailResource = buildThumbnailResource(row, await this.hashFile(row.thumbnail))
      if (!thumbnailResource) return null
      return { resource: thumbnailResource, absolutePath: row.thumbnail }
    }
    // motion：resourceId 携带视频行 id，链接仍以 assetId（静图行）为锚
    const link = this.metadata.getMotionLinkByStill(id)
    if (!link || link.motion_media_id !== parsed.mediaId) return null
    const videoRow = this.db.prepare(MEDIA_BY_ID).get(parsed.mediaId) as SyncMediaRow | undefined
    if (!videoRow) return null
    return {
      resource: buildMotionResource(videoRow, await this.resolveSourceSha256(videoRow)),
      absolutePath: videoRow.file_path
    }
  }

  // ============ 增量变更 ============

  async getChanges(after: Revision, limit?: number): Promise<ChangesResponse> {
    if (!Number.isInteger(after) || after < 0) {
      throw new Error(`invalid after: ${String(after)}`)
    }
    const changes = this.metadata.listChangesAfter(after, limit ?? 1000)
    const minimum = this.metadata.getMinimumJournalRevision()
    return {
      changes,
      libraryRevision: this.metadata.getCurrentRevision(),
      fullResyncRequired: minimum !== null && after < minimum - 1
    }
  }

  // ============ 内部 ============

  /** 源文件 sha256：缓存列命中直接返回；未命中计算后回写缓存（同步直写） */
  private async resolveSourceSha256(row: SyncMediaRow): Promise<string> {
    if (row.sha256) return row.sha256
    const sha256 = await this.hashFile(row.file_path)
    this.db.prepare(SQL_SHA256_CACHE_UPDATE).run(sha256, row.id)
    row.sha256 = sha256
    return sha256
  }
}
