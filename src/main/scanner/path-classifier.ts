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
 * 从文件路径识别媒体来源：'game'（用户拍摄）/ 'launcher'（启动器/游戏缓存）/ 'cloud'（用户云相册）/ 'local_screenshot'（系统/启动器截图）
 *
 * 判定规则（顺序敏感）：
 * 1. 路径含 "Launcher\cache" → launcher（启动器缓存目录，如登录页背景、活动图）
 * 2. 路径含 "\MallPic\" → launcher（游戏内商城缓存素材，非用户拍摄）
 * 3. 路径含 "\X6Game\Saved\ScreenShot\" → launcher（游戏内置截图，非拍照功能拍摄）
 * 4. 路径含 "\X6Game\ScreenShot\"（无Saved段） → local_screenshot（系统/启动器截图，不属于游戏内官方相册）
 * 5. 路径含 "\CloudPhotos\Temp\" → launcher（云照片临时缓存，可能是浏览他人照片的缓存）
 * 6. 路径含 "\CloudPhotos\" 且不含 "\CloudPhotos\Temp\" → cloud（用户自己的云相册）
 * 7. 其余 → game（用户使用游戏内拍照功能拍摄的照片，主要来自GamePlayPhotos路径）
 *
 * 注意：规则 5 必须在规则 6 之前，避免 Temp 路径被误归为 cloud
 * 修复说明：原实现含宽泛的 \cache\、\thumbnail、\preview\、\temp\ 匹配，会误判用户存放于
 * 含上述关键词目录下的正常照片为 launcher，已移除该宽泛匹配
 */
export function extractMediaSourceFromPath(
  filePath: string
): 'game' | 'launcher' | 'cloud' | 'local_screenshot' {
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
  // - X6Game\ScreenShot\（无 Saved 段，系统/启动器截图）→ local_screenshot（独立归类为本地截图，不关联任何游戏UID）
  // - X6Game\Video\（游戏内视频）→ 同样走默认分支返回 'game'，归属「官方游戏相册」
  // 仅当路径含X6Game\ScreenShot且不含Saved段时才归类为local_screenshot，避免误匹配其他路径
  if (
    normalized.includes('\\x6game\\screenshot\\') &&
    !normalized.includes('\\x6game\\saved\\screenshot\\')
  ) {
    return 'local_screenshot'
  }
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

/**
 * 判断路径是否属于游戏内拍照目录（GamePlayPhotos）
 *
 * 归一化口径与 extractMediaSourceFromPath 一致：正斜杠统一为反斜杠 + 小写后子串匹配。
 * 评审收紧：必须命中完整游戏目录特征 \X6Game\Saved\GamePlayPhotos\，
 * 防止用户自建的同名目录（如 C:\backup\GamePlayPhotos\）被误豁免。
 * 空串返回 false，不抛异常。
 */
export function isGamePlayPhotosPath(filePath: string): boolean {
  if (!filePath) return false
  const normalized = filePath.replace(/\//g, '\\').toLowerCase()
  return normalized.includes('\\x6game\\saved\\gameplayphotos\\')
}

/**
 * 由 HQ（高清原图）路径推导同名的游戏原生 LQ（低清缩略图）路径。
 *
 * 仅当路径含完整游戏目录特征 \X6Game\Saved\GamePlayPhotos\ 且含 \NikkiPhotos_HighQuality\
 * 目录段时生效（评审收紧：同名用户目录不推导）：
 * 在归一化（小写 + 反斜杠）字符串上大小写不敏感定位 HQ 目录段，再映射回原路径
 * 同位置替换为 NikkiPhotos_LowQuality；原路径其余部分的大小写与正/反斜杠分隔符
 * 原样保留（前/后分隔符各自取原路径对应位置的字符）。若原目录段大小写异常，
 * 替换段统一使用标准拼写 'NikkiPhotos_LowQuality'。
 *
 * 其余情况（非游戏拍照路径、非 HQ 目录段、空串）返回 null。
 */
export function resolveNativeThumbnailPath(hqPath: string): string | null {
  if (!hqPath) return null
  // 归一化只做 /→\ 与小写转换，字符串长度不变，索引与原路径一一对应
  const normalized = hqPath.replace(/\//g, '\\').toLowerCase()
  if (!normalized.includes('\\x6game\\saved\\gameplayphotos\\')) return null
  const HQ_SEGMENT = '\\nikkiphotos_highquality\\'
  const idx = normalized.indexOf(HQ_SEGMENT)
  if (idx === -1) return null
  // 原路径上 HQ 目录段的前/后分隔符（保留原始正/反斜杠形态）
  const leadingSep = hqPath.charAt(idx)
  const trailingSep = hqPath.charAt(idx + HQ_SEGMENT.length - 1)
  const before = hqPath.slice(0, idx)
  const after = hqPath.slice(idx + HQ_SEGMENT.length)
  return `${before}${leadingSep}NikkiPhotos_LowQuality${trailingSep}${after}`
}
