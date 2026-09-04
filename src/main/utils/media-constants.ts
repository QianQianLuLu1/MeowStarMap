/**
 * 媒体文件扩展名与 MIME 类型统一常量
 *
 * 解决 C-G1/C-O1：原先 scanner/index.ts、main/index.ts、thumbnail/generator.ts、
 * file-service.ts、watermark-service.ts 各自硬编码扩展名集合与 MIME 映射，
 * 集合内容存在差异（如 .tif vs .tiff、是否含 gif），且修改时容易遗漏。
 *
 * 本模块作为单一权威来源，所有媒体类型判定均应引用此处常量。
 */
import { t } from '../i18n'

/** 图片扩展名集合（含点号前缀，全小写） */
export const IMAGE_EXTENSIONS = new Set<string>([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.tiff',
  '.tif'
])

/** 视频扩展名集合（含点号前缀，全小写） */
export const VIDEO_EXTENSIONS = new Set<string>(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv'])

/** 全部媒体扩展名集合（图片 + 视频），用于路径白名单二次校验 */
export const MEDIA_EXTENSIONS = new Set<string>([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS])

/**
 * 视频导出格式白名单（无点号前缀）
 * 注意：导出格式与源文件可读格式不同——导出支持 gif（动图），但不支持 mkv/wmv（编码器限制）
 */
export const VIDEO_EXPORT_FORMATS = ['mp4', 'webm', 'gif', 'avi', 'mov'] as const

/** 扩展名（含点号）→ MIME 类型映射表 */
const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.wmv': 'video/x-ms-wmv'
}

/** MIME 类型 → 扩展名（无点号）映射表 */
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
  'video/x-ms-wmv': 'wmv'
}

/**
 * 根据扩展名（含点号，大小写不敏感）获取 MIME 类型
 * @param ext 扩展名，如 '.jpg'、'.MP4'
 * @returns MIME 类型，未知返回 'application/octet-stream'
 */
export function getMimeType(ext: string): string {
  return EXT_TO_MIME[ext.toLowerCase()] || 'application/octet-stream'
}

/**
 * 根据 MIME 类型获取扩展名（无点号）
 * @param mimeType MIME 类型，如 'image/jpeg'
 * @returns 扩展名（无点号），未知返回 'jpg'
 */
export function getExtFromMime(mimeType: string): string {
  return MIME_TO_EXT[mimeType] || 'jpg'
}

/** 判断扩展名（含点号）是否为图片 */
export function isImageExt(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase())
}

/** 判断扩展名（含点号）是否为视频 */
export function isVideoExt(ext: string): boolean {
  return VIDEO_EXTENSIONS.has(ext.toLowerCase())
}

/** 判断扩展名（含点号）是否为受支持的媒体格式 */
export function isMediaExt(ext: string): boolean {
  return MEDIA_EXTENSIONS.has(ext.toLowerCase())
}

/**
 * P0-03：游戏相册类型映射（对齐 RanAxro/nikki_albums 的 22 个相册文件夹）
 *
 * 与对标项目 Nikki Albums 的固定 19+3 相册类型不同，本映射仅作为
 * 智能分组的"游戏相册类型"维度，未匹配的文件夹归入"其他"类型，
 * 配合其他 5 个维度（场景/时段/套装/文件类型/自定义）实现动态分组。
 *
 * 键：文件夹名小写（不区分大小写匹配）
 * 值：中文显示标签
 */
export const ALBUM_TYPE_MAP: Record<string, string> = {
  // ===== 游戏内主要相册文件夹（对齐 RanAxro albumsInfoMap） =====
  screenshot: t('albumTypes.screenshot'),
  nikkiphotos_highquality: t('albumTypes.nikkiphotos_highquality'),
  nikkiphotos_lowquality: t('albumTypes.nikkiphotos_lowquality'),
  videos: t('albumTypes.videos'),
  magazinephotos: t('albumTypes.magazinephotos'),
  clockinphoto: t('albumTypes.clockinphoto'),
  cloudphotos: t('albumTypes.cloudphotos'),
  cloudphotos_lowquality: t('albumTypes.cloudphotos_lowquality'),
  // 拼图相册（RanAxro 实际路径是 Collage\CollagePhoto，父目录 Collage 作为签名）
  collage: t('albumTypes.collage'),
  highquality: t('albumTypes.highquality'),
  lowquality: t('albumTypes.lowquality'),
  collagephoto: t('albumTypes.collagephoto'),
  // 其他游戏内相册（对齐 RanAxro）
  customavatar: t('albumTypes.customavatar'),
  customcard: t('albumTypes.customcard'),
  customhomeboardphoto: t('albumTypes.customhomeboardphoto'),
  hometemplate: t('albumTypes.hometemplate'),
  plantdyeing: t('albumTypes.plantdyeing'),
  diy: t('albumTypes.diy'),
  xsdkqrcode: t('albumTypes.xsdkqrcode'),
  mallpic: t('albumTypes.mallpic'),
  // 外部视频与游戏资源
  video: t('albumTypes.video'),
  movies: t('albumTypes.movies'),
  // ===== 拍照模式扩展类型（覆盖游戏可能的其他相册目录） =====
  profilephoto: t('albumTypes.profilephoto'),
  posephoto: t('albumTypes.posephoto'),
  groupphoto: t('albumTypes.groupphoto'),
  storyphoto: t('albumTypes.storyphoto'),
  landscapephoto: t('albumTypes.landscapephoto'),
  selfiephoto: t('albumTypes.selfiephoto'),
  autophoto: t('albumTypes.autophoto'),
  photostudio: t('albumTypes.photostudio'),
  photoframe: t('albumTypes.photoframe'),
  adventurephoto: t('albumTypes.adventurephoto'),
  diaryphoto: t('albumTypes.diaryphoto'),
  activityphoto: t('albumTypes.activityphoto'),
  eventphoto: t('albumTypes.eventphoto'),
  festivalphoto: t('albumTypes.festivalphoto'),
  missionphoto: t('albumTypes.missionphoto'),
  videoclip: t('albumTypes.videoclip'),
  custom: t('albumTypes.custom')
}

/** 未匹配 ALBUM_TYPE_MAP 时的兜底标签 */
export const ALBUM_TYPE_UNKNOWN = t('albumTypes.unknown')

/**
 * 根据文件父文件夹名解析相册类型标签。
 *
 * @param parentDirName 文件所在目录名（不区分大小写匹配映射键）
 * @param keepRawName 未命中映射时是否保留**原目录名**作为分类标签。
 *   需求四.2：官方相册（GamePlayPhotos）下存在打卡相册、旅行手帐等未被 ALBUM_TYPE_MAP
 *   收录的子目录，按目录原名分类（如 `TravelJournal` → 'TravelJournal'），
 *   避免全部归为"其他"导致无法区分。仅在确认属于官方相册子树时由调用方开启。
 * @returns 命中映射返回中文标签；未命中且开启保留原名返回原目录名；否则返回 '其他'
 */
export function resolveAlbumType(parentDirName: string, keepRawName = false): string {
  const name = typeof parentDirName === 'string' ? parentDirName : ''
  const key = name.toLowerCase()
  // 目录名来自文件系统（任意字符串），必须用 hasOwnProperty 判定：
  // 直接下标访问会命中 Object.prototype 成员（如名为 constructor / toString 的目录），
  // 返回非字符串值污染 album_type 列。
  const mapped = Object.prototype.hasOwnProperty.call(ALBUM_TYPE_MAP, key)
    ? ALBUM_TYPE_MAP[key]
    : undefined
  if (mapped) return mapped
  // 空白目录名（含空串）不返回空标签，统一兜底
  if (keepRawName && name.trim() !== '') return name
  return ALBUM_TYPE_UNKNOWN
}

/**
 * 根据文件父文件夹名获取相册类型标签
 * @param parentDirName 文件所在目录名（不区分大小写）
 * @returns 中文相册类型标签，未匹配返回 '其他'
 */
export function getAlbumTypeFromDirName(parentDirName: string): string {
  return resolveAlbumType(parentDirName, false)
}
