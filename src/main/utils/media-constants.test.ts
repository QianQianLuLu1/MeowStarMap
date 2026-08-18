import { describe, it, expect } from 'vitest'
import {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  MEDIA_EXTENSIONS,
  VIDEO_EXPORT_FORMATS,
  getMimeType,
  getExtFromMime,
  isImageExt,
  isVideoExt,
  isMediaExt
} from './media-constants'

describe('media-constants', () => {
  describe('扩展名集合', () => {
    it('图片扩展名集合包含 jpg/jpeg/png/webp/gif/bmp/tiff/tif', () => {
      expect(IMAGE_EXTENSIONS.has('.jpg')).toBe(true)
      expect(IMAGE_EXTENSIONS.has('.jpeg')).toBe(true)
      expect(IMAGE_EXTENSIONS.has('.png')).toBe(true)
      expect(IMAGE_EXTENSIONS.has('.webp')).toBe(true)
      expect(IMAGE_EXTENSIONS.has('.gif')).toBe(true)
      expect(IMAGE_EXTENSIONS.has('.bmp')).toBe(true)
      expect(IMAGE_EXTENSIONS.has('.tiff')).toBe(true)
      expect(IMAGE_EXTENSIONS.has('.tif')).toBe(true)
    })

    it('视频扩展名集合包含 mp4/mov/avi/mkv/webm/wmv', () => {
      expect(VIDEO_EXTENSIONS.has('.mp4')).toBe(true)
      expect(VIDEO_EXTENSIONS.has('.mov')).toBe(true)
      expect(VIDEO_EXTENSIONS.has('.avi')).toBe(true)
      expect(VIDEO_EXTENSIONS.has('.mkv')).toBe(true)
      expect(VIDEO_EXTENSIONS.has('.webm')).toBe(true)
      expect(VIDEO_EXTENSIONS.has('.wmv')).toBe(true)
    })

    it('媒体集合是图片与视频的并集', () => {
      expect(MEDIA_EXTENSIONS.size).toBe(IMAGE_EXTENSIONS.size + VIDEO_EXTENSIONS.size)
      for (const ext of IMAGE_EXTENSIONS) expect(MEDIA_EXTENSIONS.has(ext)).toBe(true)
      for (const ext of VIDEO_EXTENSIONS) expect(MEDIA_EXTENSIONS.has(ext)).toBe(true)
    })

    it('视频导出格式白名单不含 mkv/wmv（编码器限制）', () => {
      expect(VIDEO_EXPORT_FORMATS).toContain('mp4')
      expect(VIDEO_EXPORT_FORMATS).toContain('webm')
      expect(VIDEO_EXPORT_FORMATS).toContain('gif')
      expect(VIDEO_EXPORT_FORMATS).not.toContain('mkv')
      expect(VIDEO_EXPORT_FORMATS).not.toContain('wmv')
    })
  })

  describe('getMimeType', () => {
    it('小写扩展名返回正确 MIME', () => {
      expect(getMimeType('.jpg')).toBe('image/jpeg')
      expect(getMimeType('.png')).toBe('image/png')
      expect(getMimeType('.mp4')).toBe('video/mp4')
    })

    it('大写扩展名也能识别（大小写不敏感）', () => {
      expect(getMimeType('.JPG')).toBe('image/jpeg')
      expect(getMimeType('.MP4')).toBe('video/mp4')
    })

    it('未知扩展名返回 application/octet-stream', () => {
      expect(getMimeType('.xyz')).toBe('application/octet-stream')
      expect(getMimeType('.')).toBe('application/octet-stream')
      expect(getMimeType('')).toBe('application/octet-stream')
    })
  })

  describe('getExtFromMime', () => {
    it('已知 MIME 返回扩展名（无点号）', () => {
      expect(getExtFromMime('image/jpeg')).toBe('jpg')
      expect(getExtFromMime('image/png')).toBe('png')
      expect(getExtFromMime('video/mp4')).toBe('mp4')
    })

    it('未知 MIME 返回默认值 jpg', () => {
      expect(getExtFromMime('application/unknown')).toBe('jpg')
    })
  })

  describe('isImageExt / isVideoExt / isMediaExt', () => {
    it('isImageExt 大小写不敏感', () => {
      expect(isImageExt('.jpg')).toBe(true)
      expect(isImageExt('.JPG')).toBe(true)
      expect(isImageExt('.mp4')).toBe(false)
    })

    it('isVideoExt 大小写不敏感', () => {
      expect(isVideoExt('.mp4')).toBe(true)
      expect(isVideoExt('.MP4')).toBe(true)
      expect(isVideoExt('.jpg')).toBe(false)
    })

    it('isMediaExt 同时识别图片与视频', () => {
      expect(isMediaExt('.jpg')).toBe(true)
      expect(isMediaExt('.mp4')).toBe(true)
      expect(isMediaExt('.doc')).toBe(false)
    })
  })
})
