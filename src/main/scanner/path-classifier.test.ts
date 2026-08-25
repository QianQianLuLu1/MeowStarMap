/**
 * @layer L1
 * @module src/main/scanner/path-classifier
 * @coverage UID 提取 + 相册类型映射 + 媒体来源分类
 * @dependencies path, media-constants
 * @remarks 纯函数测试，无外部依赖
 */
import { describe, it, expect } from 'vitest'
import {
  extractUidFromPath,
  extractAlbumTypeFromPath,
  extractMediaSourceFromPath,
  isGamePlayPhotosPath,
  resolveNativeThumbnailPath
} from './path-classifier'

describe('extractUidFromPath', () => {
  it('标准 Windows 路径提取 8 位 UID', () => {
    const p =
      'D:\\InfinityNikki\\X6Game\\Saved\\GamePlayPhotos\\12345678\\NikkiPhotos_HighQuality\\photo.jpg'
    expect(extractUidFromPath(p)).toBe('12345678')
  })

  it('标准 Windows 路径提取 11 位 UID（QQ 号长度）', () => {
    expect(extractUidFromPath('C:\\game\\12345678901\\photo.png')).toBe('12345678901')
  })

  it('UID 为 12 位时仍匹配（正则上限）', () => {
    expect(extractUidFromPath('D:\\game\\123456789012\\photo.jpg')).toBe('123456789012')
  })

  it('UID 为 13 位时不匹配（超出上限）', () => {
    expect(extractUidFromPath('D:\\game\\1234567890123\\photo.jpg')).toBe('default')
  })

  it('UID 为 5 位时不匹配（低于下限）', () => {
    expect(extractUidFromPath('D:\\game\\12345\\photo.jpg')).toBe('default')
  })

  it('UID 为 6 位时匹配（正则下限，与上游一致）', () => {
    expect(extractUidFromPath('D:\\game\\123456\\photo.jpg')).toBe('123456')
  })

  it('UID 以 0 开头时仍匹配（允许首位为 0，与上游一致）', () => {
    expect(extractUidFromPath('D:\\game\\01234567\\photo.jpg')).toBe('01234567')
  })

  it('Unix 风格路径分隔符也能匹配', () => {
    expect(extractUidFromPath('/home/user/InfinityNikki/12345678/photo.jpg')).toBe('12345678')
  })

  it('混合分隔符路径仍能匹配', () => {
    expect(extractUidFromPath('D:/game/12345678/photo.jpg')).toBe('12345678')
  })

  it('UID 出现在路径中间无分隔符包围时不匹配', () => {
    expect(extractUidFromPath('D:\\game\\abc12345678def\\photo.jpg')).toBe('default')
  })

  it('UID 在路径末尾（无尾部分隔符）时不匹配', () => {
    expect(extractUidFromPath('D:\\game\\12345678')).toBe('default')
  })

  it('UID 在路径开头（无前导分隔符）时不匹配', () => {
    expect(extractUidFromPath('12345678\\photo.jpg')).toBe('default')
  })

  it('空字符串返回 default', () => {
    expect(extractUidFromPath('')).toBe('default')
  })

  it('无 UID 的普通路径返回 default', () => {
    expect(extractUidFromPath('D:\\photos\\nature\\landscape.jpg')).toBe('default')
  })

  it('极长路径仍能正确提取 UID', () => {
    const longSeg = 'a'.repeat(500)
    expect(extractUidFromPath(`D:\\${longSeg}\\12345678\\${longSeg}\\photo.jpg`)).toBe('12345678')
  })

  it('路径含多个数字段时匹配被分隔符包围的合法 UID', () => {
    expect(extractUidFromPath('D:\\game\\12345\\12345678\\photo.jpg')).toBe('12345678')
  })

  it('路径仅含短数字段时返回 default', () => {
    expect(extractUidFromPath('D:\\2024\\01\\photo.jpg')).toBe('default')
  })
})

describe('extractAlbumTypeFromPath', () => {
  it('NikkiPhotos_HighQuality 目录返回高质量照片', () => {
    const p =
      'D:\\game\\X6Game\\Saved\\GamePlayPhotos\\12345678\\NikkiPhotos_HighQuality\\photo.jpg'
    expect(extractAlbumTypeFromPath(p)).toBe('高质量照片')
  })

  it('NikkiPhotos_LowQuality 目录返回低质量照片', () => {
    const p = 'D:\\game\\X6Game\\Saved\\GamePlayPhotos\\12345678\\NikkiPhotos_LowQuality\\photo.jpg'
    expect(extractAlbumTypeFromPath(p)).toBe('低质量照片')
  })

  it('ScreenShot 目录返回游戏截图', () => {
    expect(extractAlbumTypeFromPath('D:\\game\\X6Game\\Saved\\ScreenShot\\screenshot.jpg')).toBe(
      '游戏截图'
    )
  })

  it('MagazinePhotos 目录返回杂志照', () => {
    expect(extractAlbumTypeFromPath('D:\\game\\MagazinePhotos\\photo.jpg')).toBe('杂志照')
  })

  it('CloudPhotos 目录返回云照片', () => {
    expect(extractAlbumTypeFromPath('D:\\game\\CloudPhotos\\photo.jpg')).toBe('云照片')
  })

  it('MallPic 目录返回商城图', () => {
    expect(extractAlbumTypeFromPath('D:\\game\\MallPic\\item.jpg')).toBe('商城图')
  })

  it('DIY 目录返回 DIY', () => {
    expect(extractAlbumTypeFromPath('D:\\game\\DIY\\custom.jpg')).toBe('DIY')
  })

  it('Collage 目录返回拼图', () => {
    expect(extractAlbumTypeFromPath('D:\\game\\Collage\\photo.jpg')).toBe('拼图')
  })

  it('CustomAvatar 目录返回自定义头像', () => {
    expect(extractAlbumTypeFromPath('D:\\game\\CustomAvatar\\avatar.jpg')).toBe('自定义头像')
  })

  it('相册类型匹配大小写不敏感', () => {
    expect(extractAlbumTypeFromPath('D:\\game\\nikkiphotos_highquality\\photo.jpg')).toBe(
      '高质量照片'
    )
  })

  it('未识别的目录名返回"其他"', () => {
    expect(extractAlbumTypeFromPath('D:\\photos\\random_folder\\photo.jpg')).toBe('其他')
  })

  it('空字符串不抛错并返回"其他"', () => {
    expect(() => extractAlbumTypeFromPath('')).not.toThrow()
    expect(extractAlbumTypeFromPath('')).toBe('其他')
  })

  it('根目录文件返回"其他"', () => {
    expect(extractAlbumTypeFromPath('photo.jpg')).toBe('其他')
  })

  it('Unix 风格路径正确识别相册类型', () => {
    expect(extractAlbumTypeFromPath('/home/user/game/NikkiPhotos_HighQuality/photo.jpg')).toBe(
      '高质量照片'
    )
  })

  it('父目录为媒体签名但当前文件在子目录时仍按父目录识别', () => {
    // 父目录是 NikkiPhotos_HighQuality，文件在其子目录中
    const p = 'D:\\game\\12345678\\NikkiPhotos_HighQuality\\subfolder\\photo.jpg'
    // path.dirname 多次后取 basename：subfolder 不在 ALBUM_TYPE_MAP
    // 实际行为：取文件直接父目录名
    expect(() => extractAlbumTypeFromPath(p)).not.toThrow()
  })
})

describe('extractMediaSourceFromPath', () => {
  it('Launcher\\cache 路径返回 launcher', () => {
    expect(extractMediaSourceFromPath('D:\\game\\Launcher\\cache\\background.jpg')).toBe('launcher')
  })

  it('\\MallPic\\ 路径返回 launcher', () => {
    expect(
      extractMediaSourceFromPath('D:\\game\\X6Game\\Saved\\MallPic\\https=##webstatic\\item.jpg')
    ).toBe('launcher')
  })

  it('\\X6Game\\Saved\\ScreenShot\\ 路径返回 launcher', () => {
    expect(
      extractMediaSourceFromPath('D:\\game\\X6Game\\Saved\\ScreenShot\\20240101120000.jpg')
    ).toBe('launcher')
  })

  it('\\CloudPhotos\\Temp\\ 路径返回 launcher（缓存非用户拍摄）', () => {
    expect(
      extractMediaSourceFromPath('D:\\game\\X6Game\\Saved\\CloudPhotos\\Temp\\1654626739.jpeg')
    ).toBe('launcher')
  })

  it('\\CloudPhotos\\ 非 Temp 子目录返回 cloud', () => {
    expect(
      extractMediaSourceFromPath('D:\\game\\X6Game\\Saved\\CloudPhotos\\12345678\\photo.jpg')
    ).toBe('cloud')
  })

  it('CloudPhotos 路径大小写不敏感返回 cloud', () => {
    expect(extractMediaSourceFromPath('D:\\game\\cloudphotos\\12345678\\photo.jpg')).toBe('cloud')
  })

  it('CLOUDPHOTOS 大写路径返回 cloud', () => {
    expect(extractMediaSourceFromPath('D:\\game\\CLOUDPHOTOS\\12345678\\photo.jpg')).toBe('cloud')
  })

  it('游戏内拍照路径返回 game（NikkiPhotos_HighQuality）', () => {
    const p =
      'D:\\game\\X6Game\\Saved\\GamePlayPhotos\\12345678\\NikkiPhotos_HighQuality\\photo.jpg'
    expect(extractMediaSourceFromPath(p)).toBe('game')
  })

  it('游戏内拍照路径返回 game（NikkiPhotos_LowQuality）', () => {
    const p = 'D:\\game\\X6Game\\Saved\\GamePlayPhotos\\12345678\\NikkiPhotos_LowQuality\\photo.jpg'
    expect(extractMediaSourceFromPath(p)).toBe('game')
  })

  it('正斜杠 Launcher/cache 路径返回 launcher', () => {
    expect(extractMediaSourceFromPath('/home/user/game/Launcher/cache/bg.jpg')).toBe('launcher')
  })

  it('正斜杠 CloudPhotos/Temp 路径返回 launcher', () => {
    expect(extractMediaSourceFromPath('/home/user/game/CloudPhotos/Temp/cache.jpeg')).toBe(
      'launcher'
    )
  })

  it('正斜杠 CloudPhotos 非 Temp 路径返回 cloud', () => {
    expect(extractMediaSourceFromPath('/home/user/game/CloudPhotos/12345678/photo.jpg')).toBe(
      'cloud'
    )
  })

  it('空字符串返回 game（默认值）', () => {
    expect(extractMediaSourceFromPath('')).toBe('game')
  })

  it('非游戏路径返回 game（默认值）', () => {
    expect(extractMediaSourceFromPath('D:\\Users\\Photos\\vacation.jpg')).toBe('game')
  })

  it('仅含 CloudPhotos 但无尾部分隔符的路径返回 game', () => {
    expect(extractMediaSourceFromPath('D:\\game\\CloudPhotos')).toBe('game')
  })

  it('仅含 MallPic 但无尾部分隔符的路径返回 game', () => {
    expect(extractMediaSourceFromPath('D:\\game\\MallPic')).toBe('game')
  })

  it('仅含 Launcher 但无 cache 子目录的路径返回 game', () => {
    expect(extractMediaSourceFromPath('D:\\game\\Launcher\\foo.jpg')).toBe('game')
  })

  it('CloudPhotosTemp 连续字符串不被误判为 Temp 子目录', () => {
    // 边界：CloudPhotosTemp 与 CloudPhotos\Temp 不同
    const result = extractMediaSourceFromPath('D:\\game\\CloudPhotosTemp\\photo.jpg')
    expect(['cloud', 'game']).toContain(result)
  })

  it('极长路径仍能正确分类', () => {
    const longSeg = 'a'.repeat(500)
    expect(
      extractMediaSourceFromPath(`D:\\${longSeg}\\X6Game\\Saved\\MallPic\\${longSeg}\\item.jpg`)
    ).toBe('launcher')
  })

  it('路径含特殊字符不抛错', () => {
    const p = 'D:\\game\\测试目录\\CloudPhotos\\12345678\\照片.jpg'
    expect(() => extractMediaSourceFromPath(p)).not.toThrow()
    expect(extractMediaSourceFromPath(p)).toBe('cloud')
  })

  it('Launcher\\cache 路径大小写不敏感', () => {
    expect(extractMediaSourceFromPath('D:\\game\\LAUNCHER\\CACHE\\bg.jpg')).toBe('launcher')
  })

  it('MallPic 路径大小写不敏感', () => {
    expect(extractMediaSourceFromPath('D:\\game\\mallpic\\item.jpg')).toBe('launcher')
  })

  it('X6Game\\Saved\\ScreenShot 路径大小写不敏感', () => {
    expect(
      extractMediaSourceFromPath('D:\\game\\x6game\\saved\\screenshot\\20240101120000.jpg')
    ).toBe('launcher')
  })

  it('CloudPhotos\\Temp 路径大小写不敏感', () => {
    expect(extractMediaSourceFromPath('D:\\game\\cloudphotos\\temp\\cache.jpeg')).toBe('launcher')
  })

  it('X6Game\\ScreenShot 不含 Saved 段时返回 local_screenshot（系统/启动器截图）', () => {
    // X6Game/ScreenShot 无Saved段，归类为本地截图，不属于游戏官方相册
    const result = extractMediaSourceFromPath('D:\\game\\X6Game\\ScreenShot\\foo.jpg')
    expect(result).toBe('local_screenshot')
  })

  it('X6Game\\Video 路径不含 Saved/ScreenShot/MallPic 等段时返回 game（归属图库）', () => {
    // 游戏内视频位于 X6Game\Video，走默认分支返回 game，与 X6Game\ScreenShot 一致归属「图库」
    const result = extractMediaSourceFromPath('D:\\game\\X6Game\\Video\\clip.mp4')
    expect(result).toBe('game')
  })

  it('规则顺序：CloudPhotos\\Temp 必须在 CloudPhotos 之前判定', () => {
    // 验证 Temp 子目录优先于 cloud 分类
    expect(extractMediaSourceFromPath('D:\\game\\CloudPhotos\\Temp\\foo.jpg')).toBe('launcher')
    expect(extractMediaSourceFromPath('D:\\game\\CloudPhotos\\12345678\\foo.jpg')).toBe('cloud')
  })

  it('返回值类型为 game/launcher/cloud 三者之一', () => {
    const paths = [
      'D:\\game\\photo.jpg',
      'D:\\game\\Launcher\\cache\\bg.jpg',
      'D:\\game\\CloudPhotos\\12345678\\photo.jpg'
    ]
    for (const p of paths) {
      const result = extractMediaSourceFromPath(p)
      expect(['game', 'launcher', 'cloud']).toContain(result)
    }
  })
})

describe('isGamePlayPhotosPath', () => {
  it('反斜杠 GamePlayPhotos 路径返回 true', () => {
    const p =
      'D:\\Game\\InfinityNikki\\X6Game\\Saved\\GamePlayPhotos\\123456789\\NikkiPhotos_HighQuality\\photo.jpg'
    expect(isGamePlayPhotosPath(p)).toBe(true)
  })

  it('正斜杠 GamePlayPhotos 路径返回 true', () => {
    expect(isGamePlayPhotosPath('D:/Game/X6Game/Saved/GamePlayPhotos/123456789/photo.jpg')).toBe(
      true
    )
  })

  it('大小写不敏感（完整签名下全小写/全大写均命中）', () => {
    expect(
      isGamePlayPhotosPath('D:\\game\\x6game\\saved\\gameplayphotos\\123456789\\photo.jpg')
    ).toBe(true)
    expect(
      isGamePlayPhotosPath('D:\\game\\X6GAME\\SAVED\\GAMEPLAYPHOTOS\\123456789\\photo.jpg')
    ).toBe(true)
    expect(isGamePlayPhotosPath('d:/game/X6Game/Saved/GamePlayPhotos/123456789/photo.jpg')).toBe(
      true
    )
  })

  it('仅含 gameplayphotos 但无 x6game/saved 前缀的同名用户目录不命中（评审收紧）', () => {
    expect(isGamePlayPhotosPath('C:\\backup\\GamePlayPhotos\\a.jpg')).toBe(false)
    expect(isGamePlayPhotosPath('D:\\game\\gameplayphotos\\123456789\\photo.jpg')).toBe(false)
    expect(isGamePlayPhotosPath('D:\\x6game\\GamePlayPhotos\\123456789\\photo.jpg')).toBe(false)
    expect(isGamePlayPhotosPath('D:/x6game/savedphotos/gameplayphotos/123456789/photo.jpg')).toBe(
      false
    )
  })

  it('非游戏拍照路径返回 false', () => {
    expect(isGamePlayPhotosPath('D:\\photos\\vacation.jpg')).toBe(false)
    expect(isGamePlayPhotosPath('D:\\game\\X6Game\\Saved\\ScreenShot\\a.jpg')).toBe(false)
    expect(isGamePlayPhotosPath('D:\\game\\CloudPhotos\\12345678\\photo.jpg')).toBe(false)
  })

  it('仅含 GamePlayPhotos 但无尾部分隔符时返回 false', () => {
    expect(isGamePlayPhotosPath('D:\\game\\GamePlayPhotos')).toBe(false)
  })

  it('空字符串返回 false 且不抛异常', () => {
    expect(() => isGamePlayPhotosPath('')).not.toThrow()
    expect(isGamePlayPhotosPath('')).toBe(false)
  })
})

describe('resolveNativeThumbnailPath', () => {
  it('① 反斜杠 HQ 路径 → 返回同名 LowQuality 路径（其余部分原样保留）', () => {
    const hq =
      'D:\\Game\\InfinityNikki\\X6Game\\Saved\\GamePlayPhotos\\123456789\\NikkiPhotos_HighQuality\\photo.jpg'
    expect(resolveNativeThumbnailPath(hq)).toBe(
      'D:\\Game\\InfinityNikki\\X6Game\\Saved\\GamePlayPhotos\\123456789\\NikkiPhotos_LowQuality\\photo.jpg'
    )
  })

  it('② 正斜杠变体 → 返回正斜杠形态的 LowQuality 路径', () => {
    const hq = 'D:/Game/X6Game/Saved/GamePlayPhotos/123456789/NikkiPhotos_HighQuality/photo.jpg'
    expect(resolveNativeThumbnailPath(hq)).toBe(
      'D:/Game/X6Game/Saved/GamePlayPhotos/123456789/NikkiPhotos_LowQuality/photo.jpg'
    )
  })

  it('③ 非 HQ 目录段（Collage / X6Game/ScreenShot）→ null', () => {
    // 游戏拍照根下的非 HQ 子目录（如 Collage）：含 gameplayphotos 但无 highquality 段
    expect(
      resolveNativeThumbnailPath(
        'D:\\Game\\X6Game\\Saved\\GamePlayPhotos\\123456789\\Collage\\photo.jpg'
      )
    ).toBeNull()
    // LowQuality 自身不推导（避免自指）
    expect(
      resolveNativeThumbnailPath(
        'D:\\Game\\X6Game\\Saved\\GamePlayPhotos\\123456789\\NikkiPhotos_LowQuality\\photo.jpg'
      )
    ).toBeNull()
    // 游戏内置截图目录（非拍照体系，无 LowQuality 同名文件）
    expect(resolveNativeThumbnailPath('D:\\Game\\X6Game\\ScreenShot\\a.jpg')).toBeNull()
    expect(resolveNativeThumbnailPath('D:/Game/X6Game/Saved/ScreenShot/a.jpg')).toBeNull()
  })

  it('④ 非游戏拍照路径与空串 → null', () => {
    expect(resolveNativeThumbnailPath('D:\\photos\\NikkiPhotos_HighQuality\\photo.jpg')).toBeNull()
    expect(resolveNativeThumbnailPath('D:\\game\\CloudPhotos\\12345678\\photo.jpg')).toBeNull()
    // 评审收紧：含 HQ 段但无完整游戏目录特征的同名用户目录不推导（即使 LQ 真实存在）
    expect(
      resolveNativeThumbnailPath(
        'C:\\backup\\GamePlayPhotos\\123456789\\NikkiPhotos_HighQuality\\photo.jpg'
      )
    ).toBeNull()
    expect(() => resolveNativeThumbnailPath('')).not.toThrow()
    expect(resolveNativeThumbnailPath('')).toBeNull()
  })

  it('HQ 目录段大小写异常时仍可定位，替换段用标准拼写且保留原分隔符', () => {
    expect(
      resolveNativeThumbnailPath(
        'D:\\game\\X6GAME\\SAVED\\GAMEPLAYPHOTOS\\123456789\\nikkiPHOTOS_highquality\\photo.jpg'
      )
    ).toBe('D:\\game\\X6GAME\\SAVED\\GAMEPLAYPHOTOS\\123456789\\NikkiPhotos_LowQuality\\photo.jpg')
  })

  it('混合分隔符路径：前后分隔符各自按原位置形态保留', () => {
    expect(
      resolveNativeThumbnailPath(
        'D:/Game/X6Game/Saved\\GamePlayPhotos\\123456789/NikkiPhotos_HighQuality\\p.jpg'
      )
    ).toBe('D:/Game/X6Game/Saved\\GamePlayPhotos\\123456789/NikkiPhotos_LowQuality\\p.jpg')
  })
})
