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
  resolveAlbumType,
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

describe('需求四.2：GamePlayPhotos 子树内未知相册子目录保留原目录名', () => {
  it('resolveAlbumType 开启保留原名时，未命中映射返回原目录名', () => {
    expect(resolveAlbumType('TravelJournal', true)).toBe('TravelJournal')
  })

  it('resolveAlbumType 开启保留原名时，命中映射仍返回中文标签', () => {
    expect(resolveAlbumType('NikkiPhotos_HighQuality', true)).toBe(
      getAlbumTypeFromDirName('NikkiPhotos_HighQuality')
    )
    expect(resolveAlbumType('NikkiPhotos_HighQuality', true)).not.toBe('NikkiPhotos_HighQuality')
  })

  it('resolveAlbumType 未开启保留原名时保持"其他"兜底', () => {
    expect(resolveAlbumType('TravelJournal', false)).toBe(ALBUM_TYPE_UNKNOWN)
    expect(resolveAlbumType('RandomDir123', false)).toBe(ALBUM_TYPE_UNKNOWN)
  })

  it('resolveAlbumType 空目录名一律兜底为"其他"，不返回空串', () => {
    expect(resolveAlbumType('', true)).toBe(ALBUM_TYPE_UNKNOWN)
    expect(resolveAlbumType('', false)).toBe(ALBUM_TYPE_UNKNOWN)
  })

  it('extractAlbumTypeFromPath：GamePlayPhotos（Saved 变体）下未知子目录返回原目录名', () => {
    const p = 'D:\\game\\X6Game\\Saved\\GamePlayPhotos\\123456789\\TravelJournal\\a.jpg'
    expect(extractAlbumTypeFromPath(p)).toBe('TravelJournal')
  })

  it('extractAlbumTypeFromPath：GamePlayPhotos（无 Saved 变体）下未知子目录同样返回原目录名', () => {
    const p = 'D:\\game\\X6Game\\GamePlayPhotos\\123456789\\TravelJournal\\a.jpg'
    expect(extractAlbumTypeFromPath(p)).toBe('TravelJournal')
  })

  it('extractAlbumTypeFromPath：非 GamePlayPhotos 路径的未知子目录仍归"其他"', () => {
    expect(extractAlbumTypeFromPath('D:\\photos\\TravelJournal\\a.jpg')).toBe(ALBUM_TYPE_UNKNOWN)
  })

  it('extractAlbumTypeFromPath：显式关闭保留原名时，GamePlayPhotos 下未知子目录也归"其他"', () => {
    const p = 'D:\\game\\X6Game\\Saved\\GamePlayPhotos\\123456789\\TravelJournal\\a.jpg'
    expect(extractAlbumTypeFromPath(p, false)).toBe(ALBUM_TYPE_UNKNOWN)
  })

  it('extractAlbumTypeFromPath：GamePlayPhotos 下已知子目录不受保留原名影响', () => {
    const p = 'D:\\game\\X6Game\\Saved\\GamePlayPhotos\\123456789\\NikkiPhotos_LowQuality\\a.jpg'
    expect(extractAlbumTypeFromPath(p)).toBe(getAlbumTypeFromDirName('NikkiPhotos_LowQuality'))
  })
})
