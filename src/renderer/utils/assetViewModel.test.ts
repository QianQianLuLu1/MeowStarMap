import { describe, expect, it } from 'vitest'
import type { AssetSummary, MediaResource } from '../../shared/sync/protocol'
import { toAssetViewModel } from './assetViewModel'

/**
 * 资产视图模型单测（阶段 4 · 渲染层唯一转换点）。
 *
 * 关注的是「组件拿到的字段对不对」，而不是协议本身：协议形状由
 * `nikkisyncContractTypes.test.ts` 与仓储层测试承担。
 */

const summary = (over: Partial<AssetSummary> = {}): AssetSummary => ({
  assetId: 'a/1',
  type: 'photo',
  state: 'ready',
  capturedAt: '2026-10-01T08:00:00.000Z',
  revision: 12,
  hasMotion: false,
  hasMetadata: false,
  ...over
})

const resource = (over: Partial<MediaResource> = {}): MediaResource => ({
  resourceId: 'r-hq',
  role: 'source_high_quality',
  fileName: 'IMG_0001.png',
  mimeType: 'image/png',
  fileExt: '.png',
  sizeBytes: 2048,
  sha256: 'ab',
  width: 2560,
  height: 1440,
  ...over
})

const paths: Record<string, string> = {
  'r-hq': 'D:/Game/X6Game/NikkiPhotos_HighQuality/IMG_0001.png',
  'r-lq': 'D:/Game/X6Game/NikkiPhotos_LowQuality/IMG_0001.png',
  'r-motion': 'D:/Game/X6Game/NikkiPhotos_HighQuality/IMG_0001.mp4',
  'r-video': 'D:/Game/X6Game/ScreenShot/clip.mp4'
}

describe('toAssetViewModel 静图', () => {
  it('优先高质量源，路径/名称/尺寸/时间按组件口径落位', () => {
    const file = toAssetViewModel({
      summary: summary(),
      resources: [resource(), resource({ resourceId: 'r-lq', role: 'source_low_quality' })],
      pathsByResourceId: paths
    })
    expect(file.id).toBe('a/1')
    expect(file.file_path).toBe(paths['r-hq'])
    expect(file.file_name).toBe('IMG_0001.png')
    expect(file.file_ext).toBe('.png')
    expect(file.file_type).toBe('image')
    expect(file.file_size).toBe(2048)
    expect(file.width).toBe(2560)
    expect(file.height).toBe(1440)
    expect(file.created_at).toBe('2026-10-01T08:00:00.000Z')
    expect(file.album_type).toBe('HQ')
    expect(file.media_source).toBe('game')
  })

  it('thumbnail 恒为空：上游不产出派生缩略图，交给既有按需生成流水线', () => {
    const file = toAssetViewModel({
      summary: summary(),
      resources: [resource()],
      pathsByResourceId: paths
    })
    expect(file.thumbnail).toBeUndefined()
  })

  it('无高质量源时回落主源，album_type 记 LQ', () => {
    const file = toAssetViewModel({
      summary: summary(),
      resources: [resource({ resourceId: 'r-video', role: 'source_primary' })],
      pathsByResourceId: paths
    })
    expect(file.file_path).toBe(paths['r-video'])
    expect(file.album_type).toBe('LQ')
  })

  it('协议里没有的概念一律留空，不借用别的字段', () => {
    const file = toAssetViewModel({
      summary: summary(),
      resources: [resource()],
      pathsByResourceId: paths
    })
    expect(file.is_corrupted).toBeUndefined()
    expect(file.corrupted_reason).toBeUndefined()
    expect(file.is_duplicate).toBeUndefined()
    expect(file.original_id).toBeUndefined()
    expect(file.outfit).toBeUndefined()
    expect(file.is_favorite).toBe(false)
    expect(file.rating).toBe(0)
    expect(file.tags).toEqual([])
  })

  it('capturedAt 缺失时如实给空串（上游 summary 不带 discoveredAt，不伪造时间）', () => {
    const file = toAssetViewModel({
      summary: summary({ capturedAt: undefined }),
      resources: [resource({ modifiedAt: undefined })],
      pathsByResourceId: paths
    })
    expect(file.created_at).toBe('')
    expect(file.modified_at).toBe('')
  })
})

describe('toAssetViewModel 视频与实况', () => {
  it('video 资产选非 motion 源，时长按秒给', () => {
    const file = toAssetViewModel({
      summary: summary({ type: 'video' }),
      resources: [resource({ resourceId: 'r-video', role: 'source_primary', durationMs: 12500 })],
      pathsByResourceId: paths
    })
    expect(file.file_type).toBe('video')
    expect(file.duration).toBe(12.5)
    expect(file.nikkisync?.motionVideoPath).toBeUndefined()
  })

  it('motion_photo 同时给出静图路径与视频资源号，并把时长取到视频上', () => {
    const file = toAssetViewModel({
      summary: summary({ type: 'motion_photo', hasMotion: true }),
      resources: [
        resource(),
        resource({
          resourceId: 'r-motion',
          role: 'source_motion',
          fileExt: '.mp4',
          durationMs: 3000
        })
      ],
      pathsByResourceId: paths
    })
    expect(file.file_type).toBe('image')
    expect(file.file_path).toBe(paths['r-hq'])
    expect(file.duration).toBe(3)
    expect(file.nikkisync?.hasMotion).toBe(true)
    expect(file.nikkisync?.motionVideoPath).toBe(paths['r-motion'])
    expect(file.nikkisync?.motionVideoResourceId).toBe('r-motion')
  })

  it('motion 源不会被当成显示源（避免实况卡片直接放视频）', () => {
    const file = toAssetViewModel({
      summary: summary({ type: 'motion_photo' }),
      resources: [
        resource({ resourceId: 'r-motion', role: 'source_motion' }),
        resource({ resourceId: 'r-lq', role: 'source_low_quality' })
      ],
      pathsByResourceId: paths
    })
    expect(file.file_path).toBe(paths['r-lq'])
  })
})

describe('toAssetViewModel 状态与叠加层', () => {
  it('state=missing 映射 is_missing，state=deleted 映射 is_deleted', () => {
    const missing = toAssetViewModel({
      summary: summary({ state: 'missing' }),
      resources: [],
      pathsByResourceId: {}
    })
    expect(missing.is_missing).toBe(true)
    const deleted = toAssetViewModel({
      summary: summary({ state: 'deleted' }),
      resources: [],
      pathsByResourceId: {}
    })
    expect(deleted.is_deleted).toBe(true)
  })

  it('无资源的资产仍产出条目（路径为空串，不崩列表）', () => {
    const file = toAssetViewModel({ summary: summary(), resources: [], pathsByResourceId: {} })
    expect(file.file_path).toBe('')
    expect(file.file_name).toBe('a/1')
    expect(file.file_size).toBe(0)
  })

  it('叠加层字段按 asset_id 合并进来', () => {
    const file = toAssetViewModel({
      summary: summary(),
      resources: [resource()],
      pathsByResourceId: paths,
      edit: {
        assetId: 'a/1',
        isFavorite: true,
        rating: 5,
        tags: ['花'],
        notes: 'n',
        categoryId: 3,
        outfit: 'spring',
        sceneCategory: 'screenshot',
        sceneTime: 'night',
        isHidden: false,
        deletedAt: null,
        updatedAt: '2026-10-14'
      }
    })
    expect(file.is_favorite).toBe(true)
    expect(file.rating).toBe(5)
    expect(file.tags).toEqual(['花'])
    expect(file.category_id).toBe(3)
    expect(file.outfit).toBe('spring')
    expect(file.scene_time).toBe('night')
    expect(file.notes).toBe('n')
  })
})
