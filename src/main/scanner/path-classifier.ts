/**
 * Scanner 路径分类纯函数（从 scanner/index.ts 抽取）
 *
 * 设计原则：
 * - 纯函数，无副作用，不依赖 electron/sharp/ffmpeg
 * - 可独立单元测试（characterization tests）
 * - 三个函数共同决定每张照片入库时的 media_source/album_type/account_uid
 */
import path from 'path'
import { getAlbumTypeFromDirName } from '../utils/media-constants'

// UID 正则：6-12 位数字，允许首位为 0，被路径分隔符包围
// 与上游 nikki_albums 的 ^\d{6,12}$ 保持一致
const UID_REGEX = /[\\/](\d{6,12})[\\/]/

/**
 * 从文件路径提取账号 UID
 * 未匹配时返回 'default'（默认账号，用于无法识别 UID 的历史数据）
 */
export function extractUidFromPath(filePath: string): string {
  const match = filePath.match(UID_REGEX)
  return match ? match[1] : 'default'
}

/**
 * 从文件路径提取相册类型
 * 通过文件所在父目录名匹配 ALBUM_TYPE_MAP（不区分大小写）
 * 例如：D:\InfinityNikki\Saved\ScreenShot\123456789\photo.jpg → '游戏截图'
 * 未匹配到任何签名时返回 '其他'
 */
export function extractAlbumTypeFromPath(filePath: string): string {
  // 取文件所在目录名（path.dirname 后再 basename）
  const parentDir = path.dirname(filePath)
  const parentDirName = path.basename(parentDir)
  return getAlbumTypeFromDirName(parentDirName)
}

/**
 * 从文件路径识别媒体来源：'game'（用户拍摄）/ 'launcher'（启动器/游戏缓存）/ 'cloud'（用户云相册）
 *
 * 判定规则（顺序敏感）：
 * 1. 路径含 "Launcher\cache" → launcher（启动器缓存目录，如登录页背景、活动图）
 * 2. 路径含 "\MallPic\" → launcher（游戏内商城缓存素材，非用户拍摄）
 * 3. 路径含 "\X6Game\Saved\ScreenShot\" → launcher（游戏内置截图，非拍照功能拍摄）
 * 4. 路径含 "\CloudPhotos\Temp\" → launcher（云照片临时缓存，可能是浏览他人照片的缓存）
 * 5. 路径含 "\CloudPhotos\" 且不含 "\CloudPhotos\Temp\" → cloud（用户自己的云相册）
 * 6. 其余 → game（用户使用游戏内拍照功能拍摄的照片）
 *
 * 注意：规则 4 必须在规则 5 之前，避免 Temp 路径被误归为 cloud
 * 修复说明：原实现含宽泛的 \cache\、\thumbnail、\preview\、\temp\ 匹配，会误判用户存放于
 * 含上述关键词目录下的正常照片为 launcher，已移除该宽泛匹配
 */
export function extractMediaSourceFromPath(filePath: string): 'game' | 'launcher' | 'cloud' {
  // 路径分隔符统一为反斜杠（Windows），便于子串匹配
  const normalized = filePath.replace(/\//g, '\\').toLowerCase()
  if (normalized.includes('launcher\\cache')) {
    return 'launcher'
  }
  // 商城图是游戏内缓存的商城素材（webstatic.papegames.com 下载的图片），非用户拍摄
  // 路径特征：...\X6Game\Saved\MallPic\https=##webstatic...
  if (normalized.includes('\\mallpic\\')) {
    return 'launcher'
  }
  // 游戏内置截图（F12/截图键）保存在 X6Game\Saved\ScreenShot\，文件名为时间戳格式，不含 UID
  // 与游戏内拍照功能（GamePlayPhotos\$uid$\NikkiPhotos_*）不同，截图非用户主动拍摄
  // TDD 修复：原匹配 '\\x6game\\screenshot\\' 漏掉实际路径中的 'Saved' 段，导致游戏截图被误分类为 game
  if (normalized.includes('\\x6game\\saved\\screenshot\\')) {
    return 'launcher'
  }
  // 语义澄清（无限暖暖标准安装树）：
  // - X6Game\Saved\ScreenShot\（含 Saved 段）→ launcher（缓存板块，非用户主动拍摄）
  // - X6Game\ScreenShot\（无 Saved 段，用户主动截取的游戏内截图）→ 走默认分支返回 'game'，归属「图库」
  // - X6Game\Video\（游戏内视频）→ 同样走默认分支返回 'game'，归属「图库」
  // 图库放行由 media-repository 的 GALLERY_PATH_CONDITION 显式匹配这两个目录（HQ ∪ X6Game/ScreenShot ∪ X6Game/Video），
  // 缓存板块反向排除，二者对称。请勿改动默认分支语义，否则会破坏上述图库/缓存归属。
  // 云照片临时缓存目录，文件名为纯数字（如 1654626739.jpeg），非用户拍摄
  if (normalized.includes('\\cloudphotos\\temp\\')) {
    return 'launcher'
  }
  // F3 修复：CloudPhotos 非 Temp 子目录才是用户自己的云相册（项目硬约束 launcher/account/cloud 三类）
  // 必须在 \cloudphotos\temp\ 判断之后，避免 Temp 路径被误归为 cloud
  if (normalized.includes('\\cloudphotos\\')) {
    return 'cloud'
  }
  return 'game'
}
