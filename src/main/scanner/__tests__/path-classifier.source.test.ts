/**
 * @layer L1
 * @module src/main/scanner/path-classifier
 * @coverage 媒体来源分类（extractMediaSourceFromPath）+ UID 数字目录识别（extractUidFromPath）
 *           对齐 nikki_albums：
 *           - X6Game\ScreenShot（无 Saved 段）→ local_screenshot（系统/启动器截图，独立归类，不关联 UID）
 *           - X6Game\Saved\ScreenShot（含 Saved 段）→ launcher（游戏缓存板块）
 *           - X6Game\Video → game（官方游戏相册默认分支）
 *           - GamePlayPhotos\NikkiPhotos_HighQuality → game
 *           - GamePlayPhotos 锚点后的纯数字子目录（任意位数）= 账号 UID；
 *             无锚点路径回退 6-12 位启发式
 * @remarks 纯函数单测，不依赖 DB / worker 桩。
 *
 * 运行：npx vitest run src/main/scanner/__tests__/path-classifier.source.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  extractMediaSourceFromPath,
  extractUidFromPath,
  isGamePlayPhotosPath
} from '../path-classifier'

describe('媒体来源分类 extractMediaSourceFromPath', () => {
  it('X6Game\\ScreenShot（无 Saved 段）→ local_screenshot', () => {
    expect(
      extractMediaSourceFromPath('D:\\InfinityNikki\\X6Game\\ScreenShot\\123456789\\shot.jpg')
    ).toBe('local_screenshot')
  })

  it('X6Game\\Saved\\ScreenShot（含 Saved 段）→ launcher', () => {
    expect(
      extractMediaSourceFromPath(
        'D:\\InfinityNikki\\X6Game\\Saved\\ScreenShot\\20240101_120000.jpg'
      )
    ).toBe('launcher')
  })

  it('X6Game\\Video → game（官方游戏相册默认分支）', () => {
    expect(extractMediaSourceFromPath('D:\\InfinityNikki\\X6Game\\Video\\clip.mp4')).toBe('game')
  })

  it('GamePlayPhotos\\NikkiPhotos_HighQuality → game', () => {
    expect(
      extractMediaSourceFromPath(
        'D:\\InfinityNikki\\X6Game\\Saved\\GamePlayPhotos\\123456789\\NikkiPhotos_HighQuality\\a.jpg'
      )
    ).toBe('game')
  })

  it('local_screenshot 与 launcher 不混同（Saved 段是关键区分）', () => {
    const noSaved = extractMediaSourceFromPath('X\\X6Game\\ScreenShot\\x.jpg')
    const withSaved = extractMediaSourceFromPath('X\\X6Game\\Saved\\ScreenShot\\x.jpg')
    expect(noSaved).toBe('local_screenshot')
    expect(withSaved).toBe('launcher')
    expect(noSaved).not.toBe(withSaved)
  })
})

describe('账号 UID 数字目录识别 extractUidFromPath', () => {
  it('GamePlayPhotos 下纯数字子目录（任意位数）被识别为 UID', () => {
    expect(
      extractUidFromPath(
        'X\\X6Game\\Saved\\GamePlayPhotos\\123456789\\NikkiPhotos_HighQuality\\a.jpg'
      )
    ).toBe('123456789')
  })

  it('多 UID 文件夹各自独立识别（无串号）', () => {
    const a = extractUidFromPath(
      'G\\X6Game\\Saved\\GamePlayPhotos\\111111111\\NikkiPhotos_HighQuality\\a.jpg'
    )
    const b = extractUidFromPath(
      'G\\X6Game\\Saved\\GamePlayPhotos\\222222222\\NikkiPhotos_HighQuality\\b.jpg'
    )
    expect(a).toBe('111111111')
    expect(b).toBe('222222222')
    expect(a).not.toBe(b)
  })

  it('6 位与 12 位边界 UID 均被识别', () => {
    expect(extractUidFromPath('r\\GamePlayPhotos\\100000\\a.jpg')).toBe('100000')
    expect(extractUidFromPath('r\\GamePlayPhotos\\123456789012\\a.jpg')).toBe('123456789012')
  })

  it('非 UID 目录（如 NikkiPhotos_HighQuality 自身）→ default', () => {
    expect(extractUidFromPath('r\\GamePlayPhotos\\NikkiPhotos_HighQuality\\a.jpg')).toBe('default')
  })

  it('空路径 → default 且不抛异常', () => {
    expect(extractUidFromPath('')).toBe('default')
  })

  it('超过 12 位的纯数字段同样被识别为 UID（任意位数）', () => {
    // 纯数字判定不限制位数：13 位数字段同样命中
    expect(extractUidFromPath('r\\GamePlayPhotos\\1234567890123\\a.jpg')).toBe('1234567890123')
  })
})

describe('GamePlayPhotos 路径判定 isGamePlayPhotosPath', () => {
  it('含完整 X6Game\\Saved\\GamePlayPhotos 段 → true', () => {
    expect(
      isGamePlayPhotosPath(
        'D:\\x\\X6Game\\Saved\\GamePlayPhotos\\123\\NikkiPhotos_HighQuality\\a.jpg'
      )
    ).toBe(true)
  })

  it('空串 → false', () => {
    expect(isGamePlayPhotosPath('')).toBe(false)
  })
})
