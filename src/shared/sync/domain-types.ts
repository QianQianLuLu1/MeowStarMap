/**
 * NikkiSync 领域类型（domain types）
 *
 * 逐字移植自 NikkiSync/packages/core/src/types.ts（commit 284d4a6；
 * 2026-10-25 兼容层对齐至上游 b422193：identity.gameVersionEnglishName、
 * camera 的 rotation/zoom/cameraYaw/cameraPitch/cameraLoc、新增 pose——全部为可选字段追加），
 * 由本目录 protocol.ts 原名 re-export（上游契约：PC 端不得另建 DTO）。
 *
 * 维护规则：本文件正文禁止就地修改协议语义；上游演进时按文件 diff 重新移植，
 * 并同步更新 protocol.test.ts 的逐值断言。详见同目录 README.md。
 */

export const METADATA_SCHEMA_VERSION = 1 as const

export type MetadataSchemaVersion = typeof METADATA_SCHEMA_VERSION
export type IsoDateTime = string
export type AssetId = string
export type ResourceId = string
export type Revision = number

export const ASSET_TYPES = ['photo', 'motion_photo', 'video', 'unknown'] as const
export type AssetType = (typeof ASSET_TYPES)[number]

export const RESOURCE_ROLES = [
  'source_primary',
  'source_high_quality',
  'source_low_quality',
  'source_motion',
  'derived_thumbnail',
  'derived_preview'
] as const
export type ResourceRole = (typeof RESOURCE_ROLES)[number]

export const ASSET_STATES = ['ready', 'resolving', 'missing', 'deleted'] as const
export type AssetState = (typeof ASSET_STATES)[number]

export interface MediaResource {
  resourceId: ResourceId
  role: ResourceRole
  fileName: string
  mimeType: string
  fileExt: string
  sizeBytes: number
  sha256: string
  width?: number
  height?: number
  durationMs?: number
  modifiedAt?: IsoDateTime
  /** Present only for PC-internal/debug responses; never required by mobile clients. */
  sourcePathHint?: string
}

export interface MotionAssetInfo {
  stillResourceId: ResourceId
  motionResourceId: ResourceId
  /** Frame in the motion track corresponding to the displayed still. -1 means unknown/unset. */
  presentationTimestampUs?: number
  sourceCodec?: string
  sourceContainer?: string
  resolver?: {
    method: 'embedded_id' | 'filename' | 'timestamp' | 'heuristic' | 'manual'
    confidence: number
  }
}

export interface InfinityPhotoMetadata {
  schemaVersion: MetadataSchemaVersion
  identity: {
    uid?: string
    gameVersion?: string
    /** English display name of the game version (upstream b422193, optional). */
    gameVersionEnglishName?: string
    sourceAssetId?: string
  }
  capture: {
    capturedAt?: IsoDateTime
  }
  camera: {
    focalLength?: number
    apertureSection?: number
    exposure?: number
    brightness?: number
    contrast?: number
    saturation?: number
    vibrance?: number
    highlights?: number
    shadows?: number
    vignetteIntensity?: number
    bloomIntensity?: number
    bloomThreshold?: number
    portraitMode?: boolean
    rotation?: number
    zoom?: number
    cameraYaw?: number
    cameraPitch?: number
    cameraLoc?: Record<string, unknown>
  }
  /** Camera pose (upstream b422193, optional; inline object type verbatim from upstream). */
  pose?: { id?: string; name?: string; strength?: number }
  filter?: {
    id?: string
    name?: string
    strength?: number
  }
  lighting?: {
    id?: string
    name?: string
    strength?: number
  }
  photography?: Record<string, unknown>
  nikki?: Record<string, unknown>
  dressing?: {
    clothes?: unknown[]
    eureka?: unknown[]
    [key: string]: unknown
  }
  interactions?: unknown[]
  location?: {
    id?: string
    name?: string
    [key: string]: unknown
  }
  /** Lossless escape hatch for unnormalized game fields. */
  raw?: {
    socialPhoto?: unknown
    cameraParams?: unknown
    [key: string]: unknown
  }
}

export interface NikkiAsset {
  schemaVersion: 1
  assetId: AssetId
  type: AssetType
  state: AssetState
  source: {
    game: 'infinity_nikki'
    uid?: string
    discoveredAt: IsoDateTime
    capturedAt?: IsoDateTime
  }
  resources: MediaResource[]
  motion?: MotionAssetInfo
  metadata?: InfinityPhotoMetadata
  revision: Revision
  deletedAt?: IsoDateTime
}

export interface TemplatePhotoContext {
  imageUri: string
  metadata?: InfinityPhotoMetadata
  asset: {
    id: AssetId
    type: AssetType
    width?: number
    height?: number
    hasMotion: boolean
  }
}

export interface AssetResolverCandidate {
  stillResourceId: ResourceId
  motionResourceId: ResourceId
  score: number
  confidence: number
  method: 'embedded_id' | 'filename' | 'timestamp' | 'heuristic' | 'manual'
  reasons: string[]
}
