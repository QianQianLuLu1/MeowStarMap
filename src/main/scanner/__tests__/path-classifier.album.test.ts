/**
 * @layer L1
 * @module src/main/scanner/path-classifier + src/main/utils/media-constants
 * @coverage 原生相册子目录识别（NikkiPhotos_HighQuality / NikkiPhotos_LowQuality 等相册目录
 *           按子目录名称归类到对应相册分类；未匹配走 unknown 兜底）
 * @remarks 纯函数单测，不依赖 DB / worker 桩。验证相册类型归类正确、互不混同、未知有兜底。
 *
 * 运行：npx vitest run src/main/scanner/__tests__/path-classifier.album.test.ts
 */
import { describe, it, expect } from 'vitest'
import { extractAlbumTypeFromPath } from '../path-classifier'
import {
  getAlbumTypeFromDirName,
  ALBUM_TYPE_UNKNOWN,
  ALBUM_TYPE_MAP
} from '../../utils/media-constants'

describe('原生相册子目录识别（extractAlbumTypeFromPath / getAlbumTypeFromDirName）', () => {
  it('NikkiPhotos_HighQuality → 高清相册类型（非 unknown）', () => {
    const got = getAlbumTypeFromDirName('NikkiPhotos_HighQuality')
    expect(got).not.toBe(ALBUM_TYPE_UNKNOWN)
    // 大小写归一：键名小写亦可命中
    expect(got).toBe(getAlbumTypeFromDirName('nikkiphotos_highquality'))
  })

  it('NikkiPhotos_LowQuality → 独立低清相册类型（与高清不同、非 unknown）', () => {
    const hq = getAlbumTypeFromDirName('NikkiPhotos_HighQuality')
    const lq = getAlbumTypeFromDirName('NikkiPhotos_LowQuality')
    expect(lq).not.toBe(ALBUM_TYPE_UNKNOWN)
    expect(lq).not.toBe(hq)
  })

  it('未匹配目录名 → unknown 兜底', () => {
    expect(getAlbumTypeFromDirName('RandomDir123')).toBe(ALBUM_TYPE_UNKNOWN)
  })

  it('extractAlbumTypeFromPath 从完整路径正确提取父目录相册类型', () => {
    const p = 'X6Game\\Saved\\GamePlayPhotos\\123456789\\NikkiPhotos_HighQuality\\a.jpg'
    expect(extractAlbumTypeFromPath(p)).toBe(getAlbumTypeFromDirName('NikkiPhotos_HighQuality'))
  })

  it('MagazinePhotos / Videos 等原生相册子目录映射到对应类型（非 unknown）', () => {
    expect(Object.keys(ALBUM_TYPE_MAP)).toContain('magazinephotos')
    expect(Object.keys(ALBUM_TYPE_MAP)).toContain('videos')
    expect(getAlbumTypeFromDirName('MagazinePhotos')).not.toBe(ALBUM_TYPE_UNKNOWN)
    expect(getAlbumTypeFromDirName('Videos')).not.toBe(ALBUM_TYPE_UNKNOWN)
  })

  it('不同原生相册子目录归类互不混同', () => {
    const types = [
      getAlbumTypeFromDirName('NikkiPhotos_HighQuality'),
      getAlbumTypeFromDirName('NikkiPhotos_LowQuality'),
      getAlbumTypeFromDirName('MagazinePhotos'),
      getAlbumTypeFromDirName('Videos')
    ]
    expect(new Set(types).size).toBe(types.length)
  })
})
