import type { AssetEditsInfo } from '../../shared/types/electron-api'
import type { AssetSummary, MediaResource } from '../../shared/sync/protocol'
import type { MediaFile } from '../stores/mediaStore'

/**
 * NikkiSync Asset → 图库视图模型（阶段 4 · 唯一允许发生「模型转换」的地方）。
 *
 * 为什么必须有一处转换：图库组件消费的 `MediaFile` 有 ~25 个 snake_case 字段
 * （`stores/mediaStore.ts` 的 `MediaFile`），而协议侧的 `AssetSummary` 只有 14 个
 * camelCase 字段，且**不含任何绝对路径**。主进程侧的 IPC 是零转换薄转发
 * （`nikkisync-handler.ts` 的铁律），因此映射只能在渲染层做，且只能做在这一处纯函数里
 * ——散进 JSX 会既不可测又与「不改 UI 组件」的约束冲突。
 *
 * 缺什么就如实缺：`is_corrupted` / `is_duplicate` / `original_id` / `corrupted_reason`
 * 在 NikkiSync 协议里没有对应概念，一律留空（undefined），不伪造、不借用别的字段。
 * 用户专有编辑（收藏/评分/标签…）来自 `asset_edits` 叠加层，缺行即按默认值。
 */

/** 上游 `AssetSummary` 没有 `discoveredAt`，`capturedAt` 缺失时只能用空串占位。 */
const UNKNOWN_TIME = ''

/** 显示用的静图/视频资源挑选优先级（实况的 `source_motion` 视频不在这里选）。 */
const STILL_ROLE_ORDER = ['source_high_quality', 'source_primary', 'source_low_quality'] as const

function pickDisplayResource(resources: readonly MediaResource[]): MediaResource | undefined {
  for (const role of STILL_ROLE_ORDER) {
    const found = resources.find((resource) => resource.role === role)
    if (found) return found
  }
  return resources.find((resource) => resource.role !== 'source_motion')
}

/** 实况视频：`role === 'source_motion'`（由上游扫描聚合给出）。 */
function pickMotionResource(resources: readonly MediaResource[]): MediaResource | undefined {
  return resources.find((resource) => resource.role === 'source_motion')
}

/** 秒（渲染层 duration 口径）；上游给的是毫秒。 */
function toSeconds(durationMs: number | undefined): number | undefined {
  return typeof durationMs === 'number' && durationMs > 0 ? durationMs / 1000 : undefined
}

/** 视图模型：`MediaFile` 的字段口径 + 一段 NikkiSync 专有附加信息。 */
export interface AssetMediaFile extends MediaFile {
  nikkisync?: {
    assetId: string
    assetType: AssetSummary['type']
    state: AssetSummary['state']
    revision: number
    hasMotion: boolean
    hasMetadata: boolean
    gameVersion?: string
    /** 实况照片的视频路径（非实况为 undefined） */
    motionVideoPath?: string
    stillResourceId?: string
    motionVideoResourceId?: string
    /** 展示用资源（静图/视频）的内容哈希，来自上游 `resources.sha256` */
    sha256?: string
  }
}

export interface AssetViewModelInput {
  summary: AssetSummary
  /** 该资产的资源列表（来自 `get-resource-records` 的 meta 形态） */
  resources: MediaResource[]
  /** `resourceId -> 绝对路径`（来自 `get-resource-records` 的 path 形态） */
  pathsByResourceId: Record<string, string>
  /** 叠加层编辑，缺行即 undefined */
  edit?: AssetEditsInfo
}

/**
 * 纯函数：把一个资产映射成图库卡片/详情可用的视图模型。
 * 返回的 `file_path` 是资产静图/视频的绝对路径，缩略图交由既有按需生成流水线补齐
 * （上游从不产出 `derived_thumbnail`，见 04-ui-bridge-plan §0.1）。
 */
export function toAssetViewModel(input: AssetViewModelInput): AssetMediaFile {
  const { summary, resources, pathsByResourceId, edit } = input
  const display = pickDisplayResource(resources)
  const motion = pickMotionResource(resources)
  const filePath = display ? (pathsByResourceId[display.resourceId] ?? '') : ''
  const motionVideoPath = motion ? pathsByResourceId[motion.resourceId] : undefined
  const isVideo = summary.type === 'video'
  const isMotion = summary.type === 'motion_photo' || summary.hasMotion

  return {
    id: summary.assetId,
    file_path: filePath,
    file_name: display?.fileName ?? summary.assetId,
    file_type: isVideo ? 'video' : 'image',
    file_ext: display?.fileExt ?? '',
    file_size: display?.sizeBytes ?? 0,
    width: display?.width,
    height: display?.height,
    duration: isVideo ? toSeconds(display?.durationMs) : toSeconds(motion?.durationMs),
    created_at: summary.capturedAt ?? UNKNOWN_TIME,
    modified_at: display?.modifiedAt ?? summary.capturedAt ?? UNKNOWN_TIME,
    // 上游不产出派生缩略图 ⇒ 留空，由 useOnDemandThumbnails 按 file_path 生成
    thumbnail: undefined,
    tags: edit?.tags ?? [],
    category_id: edit?.categoryId ?? undefined,
    rating: edit?.rating ?? 0,
    is_favorite: edit?.isFavorite ?? false,
    notes: edit?.notes ?? '',
    scene_category: (edit?.sceneCategory as MediaFile['scene_category']) ?? undefined,
    scene_time: edit?.sceneTime as MediaFile['scene_time'],
    outfit: edit?.outfit ?? undefined,
    account_uid: summary.uid,
    // 面板门禁用的相册类型：有高质量源即 HQ（与本地数据源同口径的近似）
    album_type: display?.role === 'source_high_quality' ? 'HQ' : 'LQ',
    media_source: 'game',
    is_deleted: edit?.isHidden ?? summary.state === 'deleted',
    deleted_at: edit?.deletedAt ?? null,
    is_missing: summary.state === 'missing',
    // 协议侧无对应概念，如实留空
    is_duplicate: undefined,
    original_id: undefined,
    is_corrupted: undefined,
    corrupted_reason: undefined,
    nikkisync: {
      assetId: summary.assetId,
      assetType: summary.type,
      state: summary.state,
      revision: summary.revision,
      hasMotion: isMotion,
      hasMetadata: summary.hasMetadata,
      gameVersion: summary.gameVersion,
      motionVideoPath,
      stillResourceId: display?.resourceId,
      motionVideoResourceId: motion?.resourceId,
      sha256: display?.sha256
    }
  }
}
