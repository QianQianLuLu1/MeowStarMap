/**
 * N1 红灯来源：local-photo-resolver-adapter.ts 与 LOCAL_PHOTO_METADATA_DEEP_ENTRY 尚不存在。
 *
 * 目标：把「电脑端优先本地解析照片」接成可运行的 PhotoMetadataResolver，
 * 复用本仓 koffi 解密服务的原始文本 + 上游 parseLocalPhotoMetadata，不新建 helper exe。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  createLocalPhotoResolverAdapter,
  validateLocalPhotoRequest,
  type LocalPhotoResolveRequest
} from './local-photo-resolver-adapter'
import { LOCAL_PHOTO_METADATA_DEEP_ENTRY } from './runtime-facade'

const CAMERA_TEXT = JSON.stringify(Array.from({ length: 31 }, (_, i) => (i === 14 ? '35' : '0')))
const PHOTO_TEXT = '{"CameraParams":"abc","PhotoInfo":{"cameraFocalLength":0.5}}'
const METADATA = { camera: { focalLength: 32.5 } }

const baseRequest: LocalPhotoResolveRequest = {
  sourcePhotoPath: 'D:/photos/sample.jpg',
  sourcePhotoSha256: 'a'.repeat(64),
  uid: '1234567890'
}

const makeAdapter = () => {
  const parseLocalPhotoMetadata = vi.fn(() => METADATA)
  const decodeRawTexts = vi.fn(async () => ({ cameraText: CAMERA_TEXT, photoText: PHOTO_TEXT }))
  const adapter = createLocalPhotoResolverAdapter({ decodeRawTexts, parseLocalPhotoMetadata })
  return { adapter, decodeRawTexts, parseLocalPhotoMetadata }
}

describe('local-photo resolver adapter', () => {
  it('declares the upstream deep entry for LocalPhotoMetadataResolver.js', () => {
    expect(LOCAL_PHOTO_METADATA_DEEP_ENTRY).toEqual(['metadata', 'LocalPhotoMetadataResolver.js'])
  })

  it('normal: resolves with provider local-photo and passes raw texts to the upstream normalizer', async () => {
    const { adapter, decodeRawTexts, parseLocalPhotoMetadata } = makeAdapter()
    expect(adapter.usesPhotoFile).toBe(true)
    expect(adapter.id).toBe('local-photo')

    const result = await adapter.resolve(baseRequest)
    expect(result.provider).toBe('local-photo')
    expect(result.providerVersion).toBe('2')
    expect(result.metadata).toEqual(METADATA)
    expect(decodeRawTexts).toHaveBeenCalledWith(
      baseRequest.sourcePhotoPath,
      baseRequest.uid,
      baseRequest.sourcePhotoSha256
    )
    expect(parseLocalPhotoMetadata).toHaveBeenCalledWith(CAMERA_TEXT, PHOTO_TEXT)
  })

  it('abnormal: rejects an invalid uid before touching the decoder', async () => {
    const { adapter, decodeRawTexts } = makeAdapter()
    await expect(adapter.resolve({ ...baseRequest, uid: 'uid-with-letters' })).rejects.toThrow(
      'Invalid local photo request'
    )
    expect(decodeRawTexts).not.toHaveBeenCalled()
  })

  it('abnormal: rejects a sha256 that is not 64 lowercase hex', async () => {
    expect(() => validateLocalPhotoRequest({ ...baseRequest, sourcePhotoSha256: 'XYZ' })).toThrow(
      'Invalid local photo request'
    )
  })

  it('abnormal: propagates decoder failure instead of returning empty metadata', async () => {
    const decodeRawTexts = vi.fn(async () => {
      throw new Error('decoder unavailable')
    })
    const adapter = createLocalPhotoResolverAdapter({
      decodeRawTexts,
      parseLocalPhotoMetadata: vi.fn(() => METADATA)
    })
    await expect(adapter.resolve(baseRequest)).rejects.toThrow('decoder unavailable')
  })

  it('boundary: rejects empty raw texts', async () => {
    const parseLocalPhotoMetadata = vi.fn(() => METADATA)
    const adapter = createLocalPhotoResolverAdapter({
      decodeRawTexts: vi.fn(async () => ({ cameraText: '', photoText: PHOTO_TEXT })),
      parseLocalPhotoMetadata
    })
    await expect(adapter.resolve(baseRequest)).rejects.toThrow('Invalid local photo request')
    expect(parseLocalPhotoMetadata).not.toHaveBeenCalled()
  })

  it('boundary: accepts uid of exactly 20 digits', () => {
    expect(validateLocalPhotoRequest({ ...baseRequest, uid: '1'.repeat(20) })).toEqual({
      filePath: baseRequest.sourcePhotoPath,
      uid: '1'.repeat(20),
      sha256: baseRequest.sourcePhotoSha256
    })
  })
})
