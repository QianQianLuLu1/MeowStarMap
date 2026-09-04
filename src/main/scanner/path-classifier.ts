/**
 * Scanner 路径分类纯函数（从 scanner/index.ts 抽取）
 *
 * 设计原则：
 * - 纯函数，无副作用，不依赖 electron/sharp/ffmpeg
 * - 可独立单元测试（characterization tests）
 * - 三个函数共同决定每张照片入库时的 media_source/album_type/account_uid
 */
import path from 'path'
import { resolveAlbumType } from '../utils/media-constants'

// UID 正则（无锚点回退）：6-12 位纯数字、被路径分隔符包围。
// 仅用于非官方相册路径（导入根/解密降级等）的旧行为兜底——真实路径中常出现
// 用户名、年份等 1-5 位无关数字段（如 C:\Users\10001），回退规则保留位数
// 启发式以避免误提取；官方相册上下文的 UID 判定见下方锚点正则（任意位数）。
const UID_REGEX = /[\\/](\d{6,12})[\\/]/
// 官方相册锚点：路径中存在 GamePlayPhotos 目录段（大小写不敏感、需尾部分隔符）。
const GPP_ANCHOR_DIR = /[\\/]gameplayphotos[\\/]/i
// 锚点 UID：紧随 GamePlayPhotos 目录段的纯数字一级子目录（^\d+$，任意位数，
// 对齐 uid-discovery 的纯数字判定规范，不硬编码位数）。
const GPP_ANCHOR_UID = /[\\/]gameplayphotos[\\/](\d+)[\\/]/i

/**
 * 从文件路径提取账号 UID
 *
 * 锚点优先：路径位于官方相册子树内（含 GamePlayPhotos 目录段）时，
 * 只认紧随其后的纯数字一级子目录（任意位数），避免路径更早位置的无关数字段
 * （用户名/年份/临时目录名等）抢先命中导致 UID 串号；锚点存在但其后无纯数字
 * 子目录（如相册根下的散图）按无 UID 处理。
 *
 * 非官方相册路径（如导入根、解密降级）回退为首个被分隔符包围的 6-12 位纯数字段，
 * 与历史实现保持一致。未匹配时返回 'default'（默认账号，用于无法识别 UID 的历史数据）
 */
export function extractUidFromPath(filePath: string): string {
  if (!filePath) return 'default'
  if (GPP_ANCHOR_DIR.test(filePath)) {
    const anchored = filePath.match(GPP_ANCHOR_UID)
    return anchored ? anchored[1] : 'default'
  }
  const match = filePath.match(UID_REGEX)
  return match ? match[1] : 'default'
}

// 官方相册目录特征（含无 Saved 的兼容变体），带尾部分隔符以避免误伤同名用户目录
const GAMEPLAYPHOTOS_TREE_SEGMENTS = [
  '\\x6game\\saved\\gameplayphotos\\',
  '\\x6game\\gameplayphotos\\'
]

/**
 * 判断文件路径是否位于官方相册（GamePlayPhotos）子树内。
 *
 * 与 isGamePlayPhotosPath 的差异：后者仅认标准 `\X6Game\Saved\GamePlayPhotos\`
 * （用于缩略图复用等必须精确的场景），本函数额外覆盖无 Saved 的兼容变体，
 * 用于相册分类等只需判定"是否官方相册上下文"的场景。空串返回 false，不抛异常。
 */
export function isGamePlayPhotosTree(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false
  const normalized = filePath.replace(/\//g, '\\').toLowerCase()
  return GAMEPLAYPHOTOS_TREE_SEGMENTS.some((seg) => normalized.includes(seg))
}

/**
 * 从文件路径提取相册类型
 * 通过文件所在父目录名匹配 ALBUM_TYPE_MAP（不区分大小写）
 * 例如：D:\InfinityNikki\Saved\ScreenShot\123456789\photo.jpg → '游戏截图'
 * 未匹配到任何签名时返回 '其他'
 *
 * @param keepRawName 未命中映射时是否保留原目录名。默认按路径自动判定：
 *   位于 GamePlayPhotos 子树内时开启（需求四.2：打卡相册/旅行手帐等目录按原名分类），
 *   其余路径保持"其他"兜底，避免改变通用目录与历史数据的分类语义。
 */
export function extractAlbumTypeFromPath(filePath: string, keepRawName?: boolean): string {
  // 取文件所在目录名（path.dirname 后再 basename）
  const parentDir = path.dirname(filePath)
  const parentDirName = path.basename(parentDir)
  return resolveAlbumType(parentDirName, keepRawName ?? isGamePlayPhotosTree(filePath))
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

/**
 * P0-02 根因修复：账号 UID 合法性闸门。
 *
 * 背景：extractUidFromPath 用宽松正则 /[\\/](\d+)[\\/]/ 从任意路径段提取 UID，
 * 会命中时间戳（如 ScreenShot\1700000000\a.jpg）、活动 ID、嵌套数字目录等虚拟数字段，
 * 直接注册即产生无媒体文件的「虚拟档案」，导致设置-档案管理列表显示与真实检测路径不符。
 *
 * 闸门语义（与 worker-entry.scanDirectory 两处分支一致）：
 * - validUids 为空（null/undefined/空 Set）：保留旧行为，原样返回 rawUid（向后兼容导入向导单目录扫描）。
 *   空 Set 无意义（discoverUidsFromGameDirs 返回 []，即全新账号未拍照或目录 IO/权限异常被吞），
 *   若误判为「有效空集闸门」会令所有文件归 default 并跳过注册，造成静默零档案写入退化，故回退旧行为。
 * - rawUid 为 'default'：始终返回 'default'（调用方据此决定是否 autoRegisterUid）。
 * - 否则：命中真实 UID 集合（来自 discoverUidsFromGameDirs，即 GamePlayPhotos 一级纯数字子目录）
 *   则返回 rawUid；否则视为虚拟数字段，归 'default' 且不注册档案。
 *
 * 纯函数、无副作用，不依赖 electron，可独立单元测试。
 */
export function gateAccountUid(rawUid: string, validUids?: Set<string> | null): string {
  if (!validUids || validUids.size === 0) return rawUid // 空允许集无意义，回退旧行为
  if (rawUid === 'default') return 'default'
  return validUids.has(rawUid) ? rawUid : 'default'
}

/**
 * P0-02 可观测性：判定某次闸门拦截是否「应被计入诊断计数 gatedVirtualUidCount」。
 *
 * 命中条件需同时满足：
 * - rawUid !== 'default'：路径本身含 UID 段（否则归 default 是合法的「路径本无 UID」）；
 * - gatedUid === 'default'：闸门结果为 default（即被拦截）；
 * - validUids 非空：闸门确实生效（空集合时 gateAccountUid 回退旧行为，不拦截）。
 *
 * 该判定精确区分「路径本无 UID（合法归 default）」与「路径含虚拟段被拦截归 default」，
 * 仅在后者累加计数，供 SCAN_COMPLETE 上报并与 nikki_albums 核对。
 *
 * 纯函数、无副作用，便于独立单元测试。
 */
export function isGatedVirtualUid(
  rawUid: string,
  gatedUid: string,
  validUids?: Set<string> | null
): boolean {
  return rawUid !== 'default' && gatedUid === 'default' && !!validUids && validUids.size > 0
}
