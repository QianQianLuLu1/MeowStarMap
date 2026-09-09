import { describe, it, expect } from 'vitest'
import { resolveExportEncoding, EXPORT_JPEG_QUALITY } from './export-encoding'

/**
 * @layer L3
 * @module src/renderer/utils/export-encoding
 * @coverage 导出编码决策（MIME + 质量），供 useImageProcessor 与批量应用共用
 * @dependencies 无（纯函数）
 * @remarks node 环境；不依赖 DOM
 */

describe('resolveExportEncoding', () => {
  describe('正常流程', () => {
    it.each([
      ['jpg', 'image/jpeg'],
      ['jpeg', 'image/jpeg'],
      ['.JPG', 'image/jpeg'],
      ['PNG', 'image/png'],
      ['.png', 'image/png'],
      ['webp', 'image/webp'],
      ['.WEBP', 'image/webp']
    ])('扩展名 %s → %s', (ext, expected) => {
      expect(resolveExportEncoding(ext).mimeType).toBe(expected)
    })

    it.each([
      ['image/jpeg', 'image/jpeg'],
      ['image/png', 'image/png'],
      ['image/webp', 'image/webp']
    ])('MIME %s → %s', (mime, expected) => {
      expect(resolveExportEncoding(mime).mimeType).toBe(expected)
    })

    it('带查询串的扩展名也能正确识别（media:// URL）', () => {
      expect(resolveExportEncoding('jpg?path=%2Fa%2Fb').mimeType).toBe('image/jpeg')
    })

    it('JPEG 使用最高导出质量（单次编码，q100）', () => {
      expect(resolveExportEncoding('jpg').quality).toBe(1)
      expect(EXPORT_JPEG_QUALITY).toBe(1)
    })

    it('PNG 使用无损质量 1', () => {
      expect(resolveExportEncoding('png').quality).toBe(1)
    })

    it('WebP 使用最高质量 1', () => {
      expect(resolveExportEncoding('webp').quality).toBe(1)
    })
  })

  describe('边界与非法值', () => {
    it.each([
      ['空字符串', ''],
      ['null', null],
      ['undefined', undefined],
      ['未知扩展名', 'bmp'],
      ['未知 MIME', 'text/plain'],
      ['纯点号', '.'],
      ['空白', '   ']
    ])('%s → 回落 image/jpeg', (_name, input) => {
      expect(resolveExportEncoding(input).mimeType).toBe('image/jpeg')
      expect(resolveExportEncoding(input).quality).toBe(EXPORT_JPEG_QUALITY)
    })

    it('返回值恒为受支持的三种 MIME 之一', () => {
      const allowed = ['image/jpeg', 'image/png', 'image/webp']
      for (const input of ['jpg', 'png', 'webp', 'tiff', '', null, 'IMAGE/PNG']) {
        expect(allowed).toContain(resolveExportEncoding(input).mimeType)
      }
    })
  })
})
