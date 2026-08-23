/**
 * 游戏内照片场景分类（C-S2：从 main/utils 抽取到 shared，供主进程与渲染进程共享）
 *
 * 本文件为纯类型与常量模块，不依赖任何 Node API 或 Electron API，
 * 可安全被主进程与渲染进程同时导入。
 *
 * 根据文件所在父文件夹名称自动识别场景类型。
 */

export type SceneCategory =
  'thumbnail' | 'screenshot' | 'travel_journal' | 'world_tour' | 'collage' | 'other'

/**
 * F-O1：基于图像亮度直方图的场景时段分类
 * - day：日景（高亮度）
 * - night：夜景（低亮度）
 * - dawn：晨景（中等亮度，偏暖）
 * - dusk：暮景（中等亮度，偏冷）
 * - unknown：未分析/视频文件
 */
export type SceneTime = 'day' | 'night' | 'dawn' | 'dusk' | 'unknown'

export interface SceneCategoryConfig {
  key: SceneCategory
  /** i18n key，供支持 i18n 的组件用 t() 解析 */
  labelKey: string
  folderPattern: string
}

export interface SceneTimeConfig {
  key: SceneTime
  /** i18n key，供支持 i18n 的组件用 t() 解析 */
  labelKey: string
  /** i18n key，供支持 i18n 的组件用 t() 解析 */
  descKey: string
}

// 按匹配优先级排序：越靠前的分类越精准
export const SCENE_CATEGORIES: SceneCategoryConfig[] = [
  {
    key: 'thumbnail',
    labelKey: 'sceneCategory.thumbnail',
    folderPattern: 'NikkiPhotos_LowQuality'
  },
  { key: 'screenshot', labelKey: 'sceneCategory.screenshot', folderPattern: 'ScreenShot' },
  {
    key: 'travel_journal',
    labelKey: 'sceneCategory.travelJournal',
    folderPattern: 'MagazinePhotos'
  },
  { key: 'world_tour', labelKey: 'sceneCategory.worldTour', folderPattern: 'ClockInPhoto' },
  { key: 'collage', labelKey: 'sceneCategory.collage', folderPattern: 'Collage_CollagePhoto' },
  { key: 'other', labelKey: 'sceneCategory.other', folderPattern: '' }
]

// F-O1：场景时段配置（基于图像亮度直方图）
export const SCENE_TIMES: SceneTimeConfig[] = [
  { key: 'day', labelKey: 'sceneTime.day', descKey: 'sceneTime.dayDesc' },
  { key: 'dawn', labelKey: 'sceneTime.dawn', descKey: 'sceneTime.dawnDesc' },
  { key: 'dusk', labelKey: 'sceneTime.dusk', descKey: 'sceneTime.duskDesc' },
  { key: 'night', labelKey: 'sceneTime.night', descKey: 'sceneTime.nightDesc' },
  { key: 'unknown', labelKey: 'sceneTime.unknown', descKey: 'sceneTime.unknownDesc' }
]

/**
 * F-O1：无限暖暖常见套装预设库
 * 用户可从中选择或自定义输入套装名
 *
 * id：数据库标识符（写入 media.outfit 列，不可变更，等同于用户输入的套装名）
 * nameKey：i18n key，UI 展示时用 t(nameKey) 解析
 */
export interface OutfitPreset {
  id: string
  nameKey: string
}

/* eslint-disable no-restricted-syntax -- 数据值豁免：下列 id 是写入 media.outfit 列的数据库标识符（等同于用户输入的套装名，不可变更），非 UI 文案；UI 展示一律走 nameKey 的 t() 解析 */
export const OUTFIT_PRESETS: OutfitPreset[] = [
  // 经典套装
  { id: '初心之吻', nameKey: 'outfit.presets.firstKiss' },
  { id: '星之海', nameKey: 'outfit.presets.seaOfStars' },
  { id: '雪地精灵', nameKey: 'outfit.presets.snowElf' },
  { id: '夜色诗篇', nameKey: 'outfit.presets.nightPoem' },
  { id: '晨光微露', nameKey: 'outfit.presets.morningLight' },
  { id: '花漾少女', nameKey: 'outfit.presets.floralGirl' },
  { id: '云端漫步', nameKey: 'outfit.presets.cloudWalk' },
  { id: '月光奏鸣曲', nameKey: 'outfit.presets.moonlightSonata' },
  { id: '樱花恋人', nameKey: 'outfit.presets.cherryBlossomLover' },
  { id: '琥珀之韵', nameKey: 'outfit.presets.amberCharm' },
  // 华丽套装
  { id: '璀璨星河', nameKey: 'outfit.presets.brilliantGalaxy' },
  { id: '蝴蝶效应', nameKey: 'outfit.presets.butterflyEffect' },
  { id: '海蓝之谜', nameKey: 'outfit.presets.oceanMystery' },
  { id: '沙漠玫瑰', nameKey: 'outfit.presets.desertRose' },
  { id: '极光幻影', nameKey: 'outfit.presets.auroraPhantom' },
  { id: '琉璃梦境', nameKey: 'outfit.presets.glazeDream' },
  { id: '翡翠之誓', nameKey: 'outfit.presets.emeraldOath' },
  { id: '紫藤花语', nameKey: 'outfit.presets.wisteriaWhisper' },
  { id: '玫瑰园', nameKey: 'outfit.presets.roseGarden' },
  { id: '水晶誓约', nameKey: 'outfit.presets.crystalOath' },
  // 季节限定
  { id: '春之圆舞曲', nameKey: 'outfit.presets.springWaltz' },
  { id: '夏日微风', nameKey: 'outfit.presets.summerBreeze' },
  { id: '秋叶翩跹', nameKey: 'outfit.presets.autumnLeaves' },
  { id: '冬雪皑皑', nameKey: 'outfit.presets.winterSnow' },
  { id: '新年华彩', nameKey: 'outfit.presets.newYearSplendor' },
  // 主题套装
  { id: '校园时光', nameKey: 'outfit.presets.campusDays' },
  { id: '都市丽人', nameKey: 'outfit.presets.urbanBeauty' },
  { id: '古风雅韵', nameKey: 'outfit.presets.ancientElegance' },
  { id: '未来科技', nameKey: 'outfit.presets.futureTech' },
  { id: '童话物语', nameKey: 'outfit.presets.fairyTale' },
  { id: '海岛假日', nameKey: 'outfit.presets.islandHoliday' },
  { id: '雪国列车', nameKey: 'outfit.presets.snowlandTrain' },
  { id: '云端歌者', nameKey: 'outfit.presets.cloudSinger' },
  { id: '星屑魔法', nameKey: 'outfit.presets.stardustMagic' },
  { id: '蔷薇骑士', nameKey: 'outfit.presets.roseKnight' }
]
/* eslint-enable no-restricted-syntax */

/**
 * 根据文件路径检测游戏场景分类
 * - 不区分大小写匹配完整路径中的文件夹名
 * - 返回最精准（优先级最高）的匹配分类
 * - 无匹配或路径异常时返回 'other'
 */
export function detectSceneCategory(filePath: string): SceneCategory {
  if (!filePath || typeof filePath !== 'string') return 'other'

  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase()

  for (const category of SCENE_CATEGORIES) {
    if (!category.folderPattern) continue
    const pattern = category.folderPattern.toLowerCase()
    if (normalizedPath.includes('/' + pattern + '/') || normalizedPath.endsWith('/' + pattern)) {
      return category.key
    }
  }

  return 'other'
}

/**
 * 获取分类的 i18n key（调用方需用 t() 解析）
 */
export function getSceneCategoryLabel(key: SceneCategory): string {
  return SCENE_CATEGORIES.find((c) => c.key === key)?.labelKey ?? 'sceneCategory.other'
}

/**
 * 获取所有场景分类键（按显示顺序）
 */
export function getSceneCategoryKeys(): SceneCategory[] {
  return SCENE_CATEGORIES.map((c) => c.key)
}

/**
 * F-O1：获取场景时段的 i18n key（调用方需用 t() 解析）
 */
export function getSceneTimeLabel(key: SceneTime): string {
  return SCENE_TIMES.find((c) => c.key === key)?.labelKey ?? 'sceneTime.unknown'
}

/**
 * F-O1：获取所有场景时段键（按显示顺序）
 */
export function getSceneTimeKeys(): SceneTime[] {
  return SCENE_TIMES.map((c) => c.key)
}

/**
 * T03：套装图鉴统计——每个套装的聚合信息
 * - count：该套装下未软删除的照片数
 * - latestCreatedAt：该套装最新一张的拍摄时间（ISO 字符串）
 * - coverFilePath：封面图原文件路径（取最新一张）
 * - coverThumbnail：封面缩略图（file:// 或 data: URL）
 */
export interface OutfitStat {
  outfit: string
  count: number
  latestCreatedAt: string
  coverFilePath: string
  coverThumbnail: string | null
}
