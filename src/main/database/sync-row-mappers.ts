import path from 'path'
import {
  CHANGE_TYPES,
  type AssetState,
  type AssetType,
  type ChangeRecord,
  type ChangeType,
  type InfinityPhotoMetadata,
  type MediaResource,
  type MotionAssetInfo,
  type ResourceId,
  type Revision,
  type AssetSummary,
  type NikkiAsset
} from '../../shared/sync/protocol'

/**
 * media_files 行 → NikkiSync 协议对象的纯映射函数。
 *
 * - 无数据库、无文件 I/O 依赖：输入为普通行对象与已计算好的 sha256，
 *   便于单元测试与阶段 3 服务层复用（对齐上游 row-mappers.ts 的定位）。
 * - 协议类型一律来自 src/shared/sync/protocol（Phase 1 移植契约，禁止另建 DTO）。
 * - resourceId 约定：`res_{mediaId}_primary` / `res_{mediaId}_thumbnail` / `res_{videoId}_motion`。
 */

/** media_files 行中适配层所需的字段子集（列名与数据库一致） */
export interface SyncMediaRow {
  id: number
  file_path: string
  file_name: string
  file_type: string
  file_ext: string
  file_size: number
  width: number | null
  height: number | null
  duration: number | null
  created_at: string
  modified_at: string
  thumbnail: string | null
  account_uid: string
  indexed_at: string
  is_deleted: number
  deleted_at: string | null
  is_missing: number
  is_corrupted: number
  editor_metadata: string | null
  sha256: string | null
}

/** sync_motion_links 行（sync-metadata-repository 读取侧共用形状） */
export interface MotionLinkRow {
  still_media_id: number
  motion_media_id: number
  method: string
  confidence: number
  presentation_timestamp_us: number | null
}

/** 未知扩展名的兜底 MIME（协议未约束具体值，字节流按附件处理） */
export const FALLBACK_MIME = 'application/octet-stream'

/** 扩展名 → MIME 映射（键小写、无前导点；覆盖 WXNN 图库常见格式） */
export const MIME_BY_EXT: ReadonlyMap<string, string> = new Map([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
  ['bmp', 'image/bmp'],
  ['tif', 'image/tiff'],
  ['tiff', 'image/tiff'],
  ['avif', 'image/avif'],
  ['heic', 'image/heic'],
  ['heif', 'image/heif'],
  ['mp4', 'video/mp4'],
  ['m4v', 'video/mp4'],
  ['mov', 'video/quicktime'],
  ['mkv', 'video/x-matroska'],
  ['webm', 'video/webm'],
  ['avi', 'video/x-msvideo']
])

export function mimeFromExt(ext: string): string {
  const normalized = ext.trim().replace(/^\.+/, '').toLowerCase()
  return MIME_BY_EXT.get(normalized) ?? FALLBACK_MIME
}

export function mapAssetType(fileType: string, hasMotionLink: boolean): AssetType {
  if (fileType === 'image') return hasMotionLink ? 'motion_photo' : 'photo'
  if (fileType === 'video') return 'video'
  return 'unknown'
}

export function mapAssetState(input: {
  isDeleted: number | boolean
  isMissing: number | boolean
  isCorrupted: number | boolean
}): AssetState {
  if (input.isDeleted) return 'deleted'
  if (input.isMissing || input.isCorrupted) return 'missing'
  return 'ready'
}

function rowAssetState(row: SyncMediaRow): AssetState {
  return mapAssetState({
    isDeleted: row.is_deleted,
    isMissing: row.is_missing,
    isCorrupted: row.is_corrupted
  })
}

export function sourceResourceId(mediaId: number): ResourceId {
  return `res_${mediaId}_primary`
}

export function thumbnailResourceId(mediaId: number): ResourceId {
  return `res_${mediaId}_thumbnail`
}

export function motionResourceId(videoMediaId: number): ResourceId {
  return `res_${videoMediaId}_motion`
}

export type ResourceKind = 'primary' | 'thumbnail' | 'motion'

/** 解析本适配层生成的 resourceId；不匹配约定格式时返回 null */
export function parseResourceId(
  resourceId: string
): { mediaId: number; kind: ResourceKind } | null {
  const match = resourceId.match(/^res_(\d+)_(primary|thumbnail|motion)$/)
  if (!match) return null
  const mediaId = Number(match[1])
  if (!Number.isInteger(mediaId) || mediaId <= 0) return null
  return { mediaId, kind: match[2] as ResourceKind }
}

/** duration（秒，REAL）→ durationMs（毫秒整数）；仅视频行且值合法时输出 */
function durationMsOf(row: SyncMediaRow): number | undefined {
  if (row.file_type !== 'video') return undefined
  if (row.duration === null || !Number.isFinite(row.duration)) return undefined
  return Math.round(row.duration * 1000)
}

export function buildSourceResource(row: SyncMediaRow, sha256: string): MediaResource {
  return {
    resourceId: sourceResourceId(row.id),
    role: 'source_primary',
    fileName: row.file_name,
    mimeType: mimeFromExt(row.file_ext),
    fileExt: row.file_ext,
    sizeBytes: row.file_size,
    sha256,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    durationMs: durationMsOf(row),
    modifiedAt: row.modified_at || undefined
  }
}

/**
 * 派生缩略图资源。缩略图文件大小不入库：默认 0，调用方可传入实测值
 * （阶段 3 流式层以 fs.stat 为准，此处仅供资源清单展示）。
 */
export function buildThumbnailResource(
  row: SyncMediaRow,
  sha256: string,
  sizeBytes = 0
): MediaResource | null {
  if (!row.thumbnail) return null
  const fileName = path.basename(row.thumbnail)
  const fileExt = path.extname(fileName).replace(/^\.+/, '')
  return {
    resourceId: thumbnailResourceId(row.id),
    role: 'derived_thumbnail',
    fileName,
    mimeType: mimeFromExt(fileExt),
    fileExt,
    sizeBytes,
    sha256,
    modifiedAt: row.modified_at || undefined
  }
}

export function buildMotionResource(videoRow: SyncMediaRow, sha256: string): MediaResource {
  return {
    resourceId: motionResourceId(videoRow.id),
    role: 'source_motion',
    fileName: videoRow.file_name,
    mimeType: mimeFromExt(videoRow.file_ext),
    fileExt: videoRow.file_ext,
    sizeBytes: videoRow.file_size,
    sha256,
    width: videoRow.width ?? undefined,
    height: videoRow.height ?? undefined,
    durationMs: durationMsOf(videoRow),
    modifiedAt: videoRow.modified_at || undefined
  }
}

/** sync_motion_links.method 的合法取值（DDL CHECK 与协议 resolver 五枚举一一对应） */
type MotionResolverMethod = NonNullable<MotionAssetInfo['resolver']>['method']

/** method 取值由 sync_motion_links 的 CHECK 约束限定为 resolver 五枚举 */
export function buildMotionInfo(link: MotionLinkRow): MotionAssetInfo {
  return {
    stillResourceId: sourceResourceId(link.still_media_id),
    motionResourceId: motionResourceId(link.motion_media_id),
    presentationTimestampUs: link.presentation_timestamp_us ?? undefined,
    resolver: {
      method: link.method as MotionResolverMethod,
      confidence: link.confidence
    }
  }
}

/**
 * editor_metadata（应用自写 base64 JSON）→ 协议 metadata。
 * 协议未定义 WXNN 编辑器字段语义：整体无损放入 raw（协议注释明示的逃生舱），
 * identity/capture 由媒体行填充；缺失或损坏时静默降级为 undefined。
 * 隐私契约（阶段 6 E2E 红灯→绿灯，对齐上游 row-mappers）：raw 中的
 * nativeParamPayload / nativeParamNuan5Md5（NUAN5 解密载荷/校验键）不得出库，
 * 其余键（含 nativeParamToken）原样保留。
 */
export function buildPhotoMetadata(
  input: Pick<SyncMediaRow, 'account_uid' | 'modified_at' | 'editor_metadata'>
): InfinityPhotoMetadata | undefined {
  const { editor_metadata: editorMetadata } = input
  if (!editorMetadata) return undefined
  try {
    const parsed: unknown = JSON.parse(editorMetadata)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const raw = { ...(parsed as Record<string, unknown>) }
    delete raw.nativeParamPayload
    delete raw.nativeParamNuan5Md5
    return {
      schemaVersion: 1,
      identity: { uid: input.account_uid || undefined },
      capture: { capturedAt: input.modified_at || undefined },
      camera: {},
      raw
    }
  } catch {
    return undefined
  }
}

export interface MapAssetInput {
  row: SyncMediaRow
  resources: MediaResource[]
  /** 仅在存在 motion 链接时由调用方传入 */
  motion?: MotionAssetInfo
  metadata?: InfinityPhotoMetadata
  revision: Revision
}

export function mapToNikkiAsset(input: MapAssetInput): NikkiAsset {
  const { row } = input
  const state = rowAssetState(row)
  return {
    schemaVersion: 1,
    assetId: String(row.id),
    type: mapAssetType(row.file_type, input.motion !== undefined),
    state,
    source: {
      game: 'infinity_nikki',
      uid: row.account_uid || undefined,
      discoveredAt: row.indexed_at,
      capturedAt: row.modified_at || undefined
    },
    resources: input.resources,
    ...(input.motion ? { motion: input.motion } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    revision: input.revision,
    ...(state === 'deleted' && row.deleted_at ? { deletedAt: row.deleted_at } : {})
  }
}

export interface MapSummaryInput {
  row: SyncMediaRow
  hasMotionLink: boolean
  revision: Revision
}

export function mapToAssetSummary(input: MapSummaryInput): AssetSummary {
  const { row, hasMotionLink, revision } = input
  return {
    assetId: String(row.id),
    type: mapAssetType(row.file_type, hasMotionLink),
    state: rowAssetState(row),
    capturedAt: row.modified_at || undefined,
    uid: row.account_uid || undefined,
    revision,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    hasMotion: hasMotionLink,
    hasMetadata: row.editor_metadata !== null && row.editor_metadata !== '',
    ...(row.thumbnail ? { thumbnailResourceId: thumbnailResourceId(row.id) } : {}),
    // 预览降级链：有派生缩略图用缩略图，否则回退源文件（对齐上游"派生优先、源兜底"）
    previewResourceId: row.thumbnail ? thumbnailResourceId(row.id) : sourceResourceId(row.id)
  }
}

export function mapChangeRow(row: {
  revision: number
  event_type: string
  asset_id: string
  occurred_at: string
}): ChangeRecord {
  if (!(CHANGE_TYPES as readonly string[]).includes(row.event_type)) {
    throw new Error(`unknown change event_type: ${row.event_type}`)
  }
  return {
    revision: row.revision,
    type: row.event_type as ChangeType,
    assetId: row.asset_id,
    occurredAt: row.occurred_at
  }
}

export interface SyncCursor {
  sortKey: string
  id: number
}

export function encodeCursor(cursor: SyncCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.sortKey, id: cursor.id })).toString('base64url')
}

export function decodeCursor(cursor: string): SyncCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new Error('invalid sync cursor: not base64url-encoded JSON')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('invalid sync cursor: payload is not an object')
  }
  const t = (parsed as { t?: unknown }).t
  const id = (parsed as { id?: unknown }).id
  if (typeof t !== 'string' || t === '') {
    throw new Error('invalid sync cursor: missing sortKey')
  }
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    throw new Error('invalid sync cursor: missing asset id')
  }
  return { sortKey: t, id }
}
