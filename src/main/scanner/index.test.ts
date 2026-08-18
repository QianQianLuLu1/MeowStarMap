import { describe, it, expect } from 'vitest'
// 被测函数已抽取到 path-classifier.ts，无 electron/sharp/ffmpeg 依赖
import {
  extractUidFromPath,
  extractAlbumTypeFromPath,
  extractMediaSourceFromPath
} from './path-classifier'

describe('scanner 路径分类纯函数', () => {
  describe('extractUidFromPath', () => {
    it('标准 Windows 路径提取 8 位 UID', () => {
      const path =
        'D:\\InfinityNikki\\X6Game\\Saved\\GamePlayPhotos\\12345678\\NikkiPhotos_HighQuality\\photo.jpg'
      expect(extractUidFromPath(path)).toBe('12345678')
    })

    it('标准 Windows 路径提取 11 位 UID（QQ 号长度）', () => {
      const path = 'C:\\game\\12345678901\\photo.png'
      expect(extractUidFromPath(path)).toBe('12345678901')
    })

    it('Unix 风格路径分隔符也能匹配', () => {
      const path = '/home/user/InfinityNikki/12345678/photo.jpg'
      expect(extractUidFromPath(path)).toBe('12345678')
    })

    it('UID 为 0 开头时仍匹配（6-12 位、允许首位 0，与上游 ^\\d{6,12}$ 一致）', () => {
      const path = 'D:\\game\\01234567\\photo.jpg'
      expect(extractUidFromPath(path)).toBe('01234567')
    })

    it('UID 为 7 位时仍匹配（落入 6-12 位下限）', () => {
      const path = 'D:\\game\\1234567\\photo.jpg'
      expect(extractUidFromPath(path)).toBe('1234567')
    })

    it('UID 为 12 位时仍匹配（正则 [1-9]\\d{7,11} 允许 8-12 位）', () => {
      // 正则首位 [1-9] + 后续 \d{7,11}（7-11 位）= 总共 8-12 位
      // 12 位是上限，应正确匹配
      const path = 'D:\\game\\123456789012\\photo.jpg'
      expect(extractUidFromPath(path)).toBe('123456789012')
    })

    it('UID 为 13 位时不匹配（超出上限）', () => {
      const path = 'D:\\game\\1234567890123\\photo.jpg'
      expect(extractUidFromPath(path)).toBe('default')
    })

    it('空字符串返回 default', () => {
      expect(extractUidFromPath('')).toBe('default')
    })

    it('无 UID 的路径返回 default', () => {
      const path = 'D:\\photos\\nature\\landscape.jpg'
      expect(extractUidFromPath(path)).toBe('default')
    })

    it('UID 出现在路径中间而非分隔符包围时不匹配', () => {
      // UID 必须被 \ 或 / 包围
      const path = 'D:\\game\\abc12345678def\\photo.jpg'
      expect(extractUidFromPath(path)).toBe('default')
    })

    it('UID 在路径末尾（无尾部分隔符）时不匹配', () => {
      const path = 'D:\\game\\12345678'
      expect(extractUidFromPath(path)).toBe('default')
    })

    it('极长路径仍能正确提取 UID', () => {
      const longSeg = 'a'.repeat(500)
      const path = `D:\\${longSeg}\\12345678\\${longSeg}\\photo.jpg`
      expect(extractUidFromPath(path)).toBe('12345678')
    })
  })

  describe('extractAlbumTypeFromPath', () => {
    it('NikkiPhotos_HighQuality 目录返回对应相册类型', () => {
      const path =
        'D:\\game\\X6Game\\Saved\\GamePlayPhotos\\12345678\\NikkiPhotos_HighQuality\\photo.jpg'
      const result = extractAlbumTypeFromPath(path)
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
      expect(result).not.toBe('其他')
    })

    it('ScreenShot 目录返回对应类型', () => {
      const path = 'D:\\game\\X6Game\\Saved\\ScreenShot\\screenshot.jpg'
      const result = extractAlbumTypeFromPath(path)
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    })

    it('未识别的目录名返回"其他"', () => {
      const path = 'D:\\photos\\random_folder\\photo.jpg'
      expect(extractAlbumTypeFromPath(path)).toBe('其他')
    })

    it('空字符串不抛错', () => {
      expect(() => extractAlbumTypeFromPath('')).not.toThrow()
    })

    it('根目录文件不抛错', () => {
      expect(() => extractAlbumTypeFromPath('photo.jpg')).not.toThrow()
    })
  })

  describe('extractMediaSourceFromPath', () => {
    it('Launcher\\cache 路径返回 launcher', () => {
      const path = 'D:\\game\\Launcher\\cache\\background.jpg'
      expect(extractMediaSourceFromPath(path)).toBe('launcher')
    })

    it('\\MallPic\\ 路径返回 launcher', () => {
      const path = 'D:\\game\\X6Game\\Saved\\MallPic\\https=##webstatic\\item.jpg'
      expect(extractMediaSourceFromPath(path)).toBe('launcher')
    })

    it('\\X6Game\\ScreenShot\\ 路径返回 launcher', () => {
      const path = 'D:\\game\\X6Game\\Saved\\ScreenShot\\20240101120000.jpg'
      expect(extractMediaSourceFromPath(path)).toBe('launcher')
    })

    it('\\CloudPhotos\\Temp\\ 路径返回 launcher（缓存非用户拍摄）', () => {
      const path = 'D:\\game\\X6Game\\Saved\\CloudPhotos\\Temp\\1654626739.jpeg'
      expect(extractMediaSourceFromPath(path)).toBe('launcher')
    })

    it('\\CloudPhotos\\ 非 Temp 子目录返回 cloud（用户云相册）', () => {
      const path = 'D:\\game\\X6Game\\Saved\\CloudPhotos\\12345678\\photo.jpg'
      expect(extractMediaSourceFromPath(path)).toBe('cloud')
    })

    it('CloudPhotos 路径大小写不敏感返回 cloud', () => {
      const path = 'D:\\game\\cloudphotos\\12345678\\photo.jpg'
      expect(extractMediaSourceFromPath(path)).toBe('cloud')
    })

    it('CLOUDPHOTOS 大写路径返回 cloud', () => {
      const path = 'D:\\game\\CLOUDPHOTOS\\12345678\\photo.jpg'
      expect(extractMediaSourceFromPath(path)).toBe('cloud')
    })

    it('游戏内拍照路径返回 game（NikkiPhotos_HighQuality）', () => {
      const path =
        'D:\\game\\X6Game\\Saved\\GamePlayPhotos\\12345678\\NikkiPhotos_HighQuality\\photo.jpg'
      expect(extractMediaSourceFromPath(path)).toBe('game')
    })

    it('游戏内拍照路径返回 game（NikkiPhotos_LowQuality）', () => {
      const path =
        'D:\\game\\X6Game\\Saved\\GamePlayPhotos\\12345678\\NikkiPhotos_LowQuality\\photo.jpg'
      expect(extractMediaSourceFromPath(path)).toBe('game')
    })

    it('正斜杠路径也能正确分类（Unix 风格）', () => {
      const path = '/home/user/game/Launcher/cache/bg.jpg'
      expect(extractMediaSourceFromPath(path)).toBe('launcher')
    })

    it('正斜杠 CloudPhotos/Temp 路径返回 launcher', () => {
      const path = '/home/user/game/CloudPhotos/Temp/cache.jpeg'
      expect(extractMediaSourceFromPath(path)).toBe('launcher')
    })

    it('正斜杠 CloudPhotos 非 Temp 路径返回 cloud', () => {
      const path = '/home/user/game/CloudPhotos/12345678/photo.jpg'
      expect(extractMediaSourceFromPath(path)).toBe('cloud')
    })

    it('空字符串返回 game（默认值）', () => {
      expect(extractMediaSourceFromPath('')).toBe('game')
    })

    it('非游戏路径返回 game（默认值）', () => {
      const path = 'D:\\Users\\Photos\\vacation.jpg'
      expect(extractMediaSourceFromPath(path)).toBe('game')
    })

    it('仅含 CloudPhotos 但无尾部分隔符的路径返回 game', () => {
      // 边界：'CloudPhotos' 字符串末尾无 \ 时不应匹配 cloudphotos\
      const path = 'D:\\game\\CloudPhotos'
      expect(extractMediaSourceFromPath(path)).toBe('game')
    })

    it('仅含 MallPic 但无尾部分隔符的路径返回 game', () => {
      const path = 'D:\\game\\MallPic'
      expect(extractMediaSourceFromPath(path)).toBe('game')
    })

    it('CloudPhotosTemp 连续字符串不被误判为 Temp 子目录', () => {
      // 边界：CloudPhotosTemp 与 CloudPhotos\Temp 不同
      const path = 'D:\\game\\CloudPhotosTemp\\photo.jpg'
      // 当前实现查找 'cloudphotos\\temp\\'，CloudPhotosTemp 无反斜杠不匹配
      // 但会匹配 'cloudphotos\\' → 返回 cloud（这是合理的，因为确实含 CloudPhotos）
      const result = extractMediaSourceFromPath(path)
      expect(['cloud', 'game']).toContain(result)
    })

    it('极长路径仍能正确分类', () => {
      const longSeg = 'a'.repeat(500)
      const path = `D:\\${longSeg}\\X6Game\\Saved\\MallPic\\${longSeg}\\item.jpg`
      expect(extractMediaSourceFromPath(path)).toBe('launcher')
    })

    it('路径含特殊字符不抛错', () => {
      const path = 'D:\\game\\测试目录\\CloudPhotos\\12345678\\照片.jpg'
      expect(() => extractMediaSourceFromPath(path)).not.toThrow()
      expect(extractMediaSourceFromPath(path)).toBe('cloud')
    })
  })
})
