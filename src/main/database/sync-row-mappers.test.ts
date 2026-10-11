import { describe, it, expect } from 'vitest'

/**
 * sync-row-mappers 单元测试（纯映射函数，无数据库依赖）
 *
 * 编号对应 docs/sync-integration/02-sync-repository-plan.md §9：
 *   正常 M1–M7 / 异常·边界 M8–M10（+ metadata 构造 M11–M12）
 */

import {
  MIME_BY_EXT,
  mimeFromExt,
  mapAssetType,
  mapAssetState,
  sourceResourceId,
  thumbnailResourceId,
  motionResourceId,
  parseResourceId,
  buildSourceResource,
  buildThumbnailResource,
  buildMotionResource,
  buildMotionInfo,
  buildPhotoMetadata,
  mapToNikkiAsset,
  mapToAssetSummary,
  mapChangeRow,
  encodeCursor,
  decodeCursor,
  type SyncMediaRow,
  type MotionLinkRow
} from './sync-row-mappers'

// ============================================================================
// 夹具
// ============================================================================

const BASE_ROW: SyncMediaRow = {
  id: 7,
  file_path: 'D:/photos/IMG_0001.jpg',
  file_name: 'IMG_0001.jpg',
  file_type: 'image',
  file_ext: 'jpg',
  file_size: 1024,
  width: 1920,
  height: 1080,
  duration: null,
  created_at: '2026-01-01T00:00:00.000Z',
  modified_at: '2026-01-02T03:04:05.000Z',
  thumbnail: 'D:/photos/.thumbs/IMG_0001.jpg',
  account_uid: 'default',
  indexed_at: '2026-01-03T00:00:00.000Z',
  is_deleted: 0,
  deleted_at: null,
  is_missing: 0,
  is_corrupted: 0,
  editor_metadata: null,
  sha256: null
}

function makeRow(overrides: Partial<SyncMediaRow> = {}): SyncMediaRow {
  return { ...BASE_ROW, ...overrides }
}

const BASE_LINK: MotionLinkRow = {
  still_media_id: 7,
  motion_media_id: 9,
  method: 'filename',
  confidence: 1,
  presentation_timestamp_us: null
}

const SHA = 'a'.repeat(64)

// ============================================================================
// 正常（M1–M7）
// ============================================================================

describe('mapAssetType', () => {
  it('M1a image + motion 链接 → motion_photo', () => {
    expect(mapAssetType('image', true)).toBe('motion_photo')
  })
  it('M1b image 无链接 → photo', () => {
    expect(mapAssetType('image', false)).toBe('photo')
  })
  it('M1c video → video（无论是否链接，链接排除在仓储层处理）', () => {
    expect(mapAssetType('video', false)).toBe('video')
  })
  it('M1d 未知 file_type → unknown', () => {
    expect(mapAssetType('audio', false)).toBe('unknown')
  })
})

describe('mapAssetState', () => {
  it('M2a ready：三项标记全 0', () => {
    expect(mapAssetState({ isDeleted: 0, isMissing: 0, isCorrupted: 0 })).toBe('ready')
  })
  it('M2b missing：is_missing=1', () => {
    expect(mapAssetState({ isDeleted: 0, isMissing: 1, isCorrupted: 0 })).toBe('missing')
  })
  it('M2c missing：is_corrupted=1 视同 missing', () => {
    expect(mapAssetState({ isDeleted: 0, isMissing: 0, isCorrupted: 1 })).toBe('missing')
  })
  it('M2d deleted 优先级最高（同时 missing 仍为 deleted）', () => {
    expect(mapAssetState({ isDeleted: 1, isMissing: 1, isCorrupted: 0 })).toBe('deleted')
  })
})

describe('mimeFromExt', () => {
  it('M3a 常见映射：jpg/png/mp4/mov', () => {
    expect(mimeFromExt('jpg')).toBe('image/jpeg')
    expect(mimeFromExt('png')).toBe('image/png')
    expect(mimeFromExt('mp4')).toBe('video/mp4')
    expect(mimeFromExt('mov')).toBe('video/quicktime')
  })
  it('M10a 未知扩展名 → application/octet-stream', () => {
    expect(mimeFromExt('xyz')).toBe('application/octet-stream')
  })
  it('M10b 空扩展名 → application/octet-stream', () => {
    expect(mimeFromExt('')).toBe('application/octet-stream')
  })
  it('M10c 大小写不敏感且容忍前导点', () => {
    expect(mimeFromExt('JPG')).toBe('image/jpeg')
    expect(mimeFromExt('.PNG')).toBe('image/png')
  })
  it('M3b MIME 表覆盖计划清单且值合法', () => {
    for (const mime of MIME_BY_EXT.values()) {
      expect(mime).toMatch(/^(image|video)\/[\w.+-]+$/)
    }
  })
})

describe('resource 构造', () => {
  it('M3c buildSourceResource 图片：无 durationMs，宽高直传', () => {
    const r = buildSourceResource(makeRow(), SHA)
    expect(r.resourceId).toBe('res_7_primary')
    expect(r.role).toBe('source_primary')
    expect(r.fileName).toBe('IMG_0001.jpg')
    expect(r.mimeType).toBe('image/jpeg')
    expect(r.fileExt).toBe('jpg')
    expect(r.sizeBytes).toBe(1024)
    expect(r.sha256).toBe(SHA)
    expect(r.width).toBe(1920)
    expect(r.height).toBe(1080)
    expect(r.durationMs).toBeUndefined()
    expect(r.modifiedAt).toBe('2026-01-02T03:04:05.000Z')
  })
  it('M3d buildSourceResource 视频：duration 秒 → durationMs 毫秒', () => {
    const r = buildSourceResource(
      makeRow({ file_type: 'video', file_ext: 'mp4', duration: 2.345, width: 3840, height: 2160 }),
      SHA
    )
    expect(r.mimeType).toBe('video/mp4')
    expect(r.durationMs).toBe(2345)
  })
  it('M9a duration=0 → durationMs=0（合法值）', () => {
    const r = buildSourceResource(makeRow({ file_type: 'video', duration: 0 }), SHA)
    expect(r.durationMs).toBe(0)
  })
  it('M9b duration=null → durationMs 缺省', () => {
    const r = buildSourceResource(makeRow({ file_type: 'video', duration: null }), SHA)
    expect(r.durationMs).toBeUndefined()
  })
  it('M4a buildThumbnailResource：thumbnail 存在 → derived_thumbnail 资源', () => {
    const r = buildThumbnailResource(makeRow(), SHA)
    expect(r).not.toBeNull()
    expect(r?.role).toBe('derived_thumbnail')
    expect(r?.resourceId).toBe('res_7_thumbnail')
  })
  it('M4b buildThumbnailResource：thumbnail 为 null → null', () => {
    expect(buildThumbnailResource(makeRow({ thumbnail: null }), SHA)).toBeNull()
  })
  it('M4c buildMotionResource：role=source_motion，resourceId 用视频行 id', () => {
    const videoRow = makeRow({ id: 9, file_type: 'video', file_ext: 'mov' })
    const r = buildMotionResource(videoRow, SHA)
    expect(r.role).toBe('source_motion')
    expect(r.resourceId).toBe('res_9_motion')
    expect(r.mimeType).toBe('video/quicktime')
    expect(r.durationMs).toBeUndefined() // 静图行夹具无 duration；视频行经 M3d 单测
  })
})

describe('motion info 与 resourceId 解析', () => {
  it('M4d buildMotionInfo：still/motion 资源 id 与 resolver 透传', () => {
    const info = buildMotionInfo(BASE_LINK)
    expect(info.stillResourceId).toBe('res_7_primary')
    expect(info.motionResourceId).toBe('res_9_motion')
    expect(info.resolver).toEqual({ method: 'filename', confidence: 1 })
    expect(info.presentationTimestampUs).toBeUndefined()
  })
  it('M4e buildMotionInfo：presentation_timestamp_us 有值时透传', () => {
    const info = buildMotionInfo({ ...BASE_LINK, presentation_timestamp_us: 1500 })
    expect(info.presentationTimestampUs).toBe(1500)
  })
  it('M6b resourceId 三件套生成/解析往返', () => {
    expect(sourceResourceId(7)).toBe('res_7_primary')
    expect(thumbnailResourceId(7)).toBe('res_7_thumbnail')
    expect(motionResourceId(9)).toBe('res_9_motion')
    expect(parseResourceId('res_7_primary')).toEqual({ mediaId: 7, kind: 'primary' })
    expect(parseResourceId('res_9_motion')).toEqual({ mediaId: 9, kind: 'motion' })
    expect(parseResourceId('res_7_thumbnail')).toEqual({ mediaId: 7, kind: 'thumbnail' })
  })
})

describe('mapToNikkiAsset', () => {
  it('M5a photo：schemaVersion/source/metadata 缺省/无 motion', () => {
    const asset = mapToNikkiAsset({
      row: makeRow(),
      resources: [buildSourceResource(makeRow(), SHA)],
      revision: 3
    })
    expect(asset.schemaVersion).toBe(1)
    expect(asset.assetId).toBe('7')
    expect(asset.type).toBe('photo')
    expect(asset.state).toBe('ready')
    expect(asset.source.game).toBe('infinity_nikki')
    expect(asset.source.uid).toBe('default')
    expect(asset.source.discoveredAt).toBe('2026-01-03T00:00:00.000Z')
    expect(asset.source.capturedAt).toBe('2026-01-02T03:04:05.000Z')
    expect(asset.resources).toHaveLength(1)
    expect(asset.motion).toBeUndefined()
    expect(asset.metadata).toBeUndefined()
    expect(asset.deletedAt).toBeUndefined()
    expect(asset.revision).toBe(3)
  })
  it('M5b motion_photo：motion 字段存在', () => {
    const asset = mapToNikkiAsset({
      row: makeRow(),
      resources: [
        buildSourceResource(makeRow(), SHA),
        buildMotionResource(makeRow({ id: 9 }), SHA)
      ],
      motion: buildMotionInfo(BASE_LINK),
      revision: 0
    })
    expect(asset.type).toBe('motion_photo')
    expect(asset.motion?.stillResourceId).toBe('res_7_primary')
    expect(asset.motion?.motionResourceId).toBe('res_9_motion')
  })
  it('M5c deleted：deletedAt 仅 deleted 态输出', () => {
    const deleted = mapToNikkiAsset({
      row: makeRow({ is_deleted: 1, deleted_at: '2026-02-01T00:00:00.000Z' }),
      resources: [],
      revision: 1
    })
    expect(deleted.state).toBe('deleted')
    expect(deleted.deletedAt).toBe('2026-02-01T00:00:00.000Z')
    const missing = mapToNikkiAsset({
      row: makeRow({ is_missing: 1, deleted_at: '2026-02-01T00:00:00.000Z' }),
      resources: [],
      revision: 1
    })
    expect(missing.state).toBe('missing')
    expect(missing.deletedAt).toBeUndefined()
  })
})

describe('mapToAssetSummary', () => {
  it('M6a photo summary：hasMotion=false、hasMetadata=false、preview 回退 primary', () => {
    const s = mapToAssetSummary({
      row: makeRow({ thumbnail: null }),
      hasMotionLink: false,
      revision: 5
    })
    expect(s.assetId).toBe('7')
    expect(s.type).toBe('photo')
    expect(s.state).toBe('ready')
    expect(s.revision).toBe(5)
    expect(s.hasMotion).toBe(false)
    expect(s.hasMetadata).toBe(false)
    expect(s.thumbnailResourceId).toBeUndefined()
    expect(s.previewResourceId).toBe('res_7_primary')
    expect(s.gameVersion).toBeUndefined()
    expect(s.gameVersionSource).toBeUndefined()
  })
  it('M6c motion_photo + metadata：thumbnail 同时作为 thumbnail/preview 资源', () => {
    const s = mapToAssetSummary({
      row: makeRow({ editor_metadata: 'e30=' }),
      hasMotionLink: true,
      revision: 2
    })
    expect(s.type).toBe('motion_photo')
    expect(s.hasMotion).toBe(true)
    expect(s.hasMetadata).toBe(true)
    expect(s.thumbnailResourceId).toBe('res_7_thumbnail')
    expect(s.previewResourceId).toBe('res_7_thumbnail')
  })
})

describe('mapChangeRow', () => {
  it('M7a 字段对齐协议 ChangeRecord', () => {
    const c = mapChangeRow({
      revision: 12,
      event_type: 'asset.created',
      asset_id: '7',
      occurred_at: '2026-03-01T00:00:00.000Z'
    })
    expect(c).toEqual({
      revision: 12,
      type: 'asset.created',
      assetId: '7',
      occurredAt: '2026-03-01T00:00:00.000Z'
    })
  })
})

describe('cursor 编解码', () => {
  it('M7b encode→decode 往返一致', () => {
    const encoded = encodeCursor({ sortKey: '2026-01-02T03:04:05.000Z', id: 7 })
    expect(encoded).not.toContain('=')
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
    expect(decodeCursor(encoded)).toEqual({ sortKey: '2026-01-02T03:04:05.000Z', id: 7 })
  })
})

// ============================================================================
// 异常 / 边界（M8–M12）
// ============================================================================

describe('decodeCursor 异常输入', () => {
  it('M8a 非法 base64 → 抛错', () => {
    expect(() => decodeCursor('!!!not-base64url!!!')).toThrow()
  })
  it('M8b JSON 缺字段 → 抛错', () => {
    const bad = Buffer.from(JSON.stringify({ t: 'x' })).toString('base64url')
    expect(() => decodeCursor(bad)).toThrow()
  })
  it('M8c id 非数字 → 抛错', () => {
    const bad = Buffer.from(JSON.stringify({ t: 'x', id: 'abc' })).toString('base64url')
    expect(() => decodeCursor(bad)).toThrow()
  })
  it('M8d 合法 base64 但非 JSON → 抛错', () => {
    const bad = Buffer.from('plain text').toString('base64url')
    expect(() => decodeCursor(bad)).toThrow()
  })
})

describe('mapChangeRow 异常输入', () => {
  it('M8e 非法 event_type → 抛错', () => {
    expect(() =>
      mapChangeRow({ revision: 1, event_type: 'asset.exploded', asset_id: '7', occurred_at: 'x' })
    ).toThrow()
  })
})

describe('parseResourceId 异常输入', () => {
  it('S11 前置：非法 resourceId → null', () => {
    expect(parseResourceId('')).toBeNull()
    expect(parseResourceId('res_7')).toBeNull()
    expect(parseResourceId('res_7_unknown')).toBeNull()
    expect(parseResourceId('res_abc_primary')).toBeNull()
    expect(parseResourceId('res_-1_primary')).toBeNull()
  })
})

describe('buildPhotoMetadata（editor_metadata 无损逃生舱）', () => {
  it('M11a editor_metadata 为 null → undefined', () => {
    expect(buildPhotoMetadata(makeRow({ editor_metadata: null }))).toBeUndefined()
  })
  it('M11b 合法 JSON → raw 透传 + identity/capture 由行填充', () => {
    const md = buildPhotoMetadata(
      makeRow({ editor_metadata: JSON.stringify({ outfit: '星海', rating: 5 }) })
    )
    expect(md).toBeDefined()
    expect(md?.schemaVersion).toBe(1)
    expect(md?.identity.uid).toBe('default')
    expect(md?.capture.capturedAt).toBe('2026-01-02T03:04:05.000Z')
    expect(md?.camera).toEqual({})
    expect(md?.raw).toEqual({ outfit: '星海', rating: 5 })
  })
  it('M11c 损坏 JSON → undefined（静默降级）', () => {
    expect(buildPhotoMetadata(makeRow({ editor_metadata: '{not json' }))).toBeUndefined()
  })
  it('M11d JSON 但非对象（数组/标量）→ undefined', () => {
    expect(buildPhotoMetadata(makeRow({ editor_metadata: '[1,2]' }))).toBeUndefined()
    expect(buildPhotoMetadata(makeRow({ editor_metadata: '"str"' }))).toBeUndefined()
  })
})

describe('mapToNikkiAsset 集成 metadata', () => {
  it('M12a buildPhotoMetadata 产物可直接作为 metadata 输入', () => {
    const metadata = buildPhotoMetadata(makeRow({ editor_metadata: '{"k":1}' }))
    const asset = mapToNikkiAsset({
      row: makeRow({ editor_metadata: '{"k":1}' }),
      resources: [],
      revision: 1,
      metadata
    })
    expect(asset.metadata?.raw).toEqual({ k: 1 })
    expect(asset.metadata?.schemaVersion).toBe(1)
  })
})
