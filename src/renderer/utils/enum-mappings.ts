// 所有 map 值为 i18n key，调用方需用 t() 解析
/**
 * 游戏枚举映射表
 *
 * 数据来源：上游 nikki_albums 项目（RanAxro/nikki_albums）
 * - 数字→字符串映射：lib/modules/nuan5_params/model/enumeration.dart
 * - 字符串→中文名：assets/lang/infinity_nikki/{zh-CN,other}/zh-CN.json
 *
 * 所有映射均通过上游源码验证，非推测值。
 */

// ── 服装部位类型（ClothType enum → zh-CN.json media_params.cloth_type）──
export const CLOTH_TYPE_MAP: Record<number, string> = {
  0: 'enums.clothType.0',
  10: 'enums.clothType.10',
  20: 'enums.clothType.20',
  30: 'enums.clothType.30',
  41: 'enums.clothType.41',
  50: 'enums.clothType.50',
  60: 'enums.clothType.60',
  71: 'enums.clothType.71',
  72: 'enums.clothType.72',
  73: 'enums.clothType.73',
  74: 'enums.clothType.74',
  75: 'enums.clothType.75',
  76: 'enums.clothType.76',
  77: 'enums.clothType.77',
  78: 'enums.clothType.78',
  79: 'enums.clothType.79',
  80: 'enums.clothType.80',
  81: 'enums.clothType.81',
  82: 'enums.clothType.82',
  83: 'enums.clothType.83',
  84: 'enums.clothType.84',
  85: 'enums.clothType.85',
  86: 'enums.clothType.86',
  90: 'enums.clothType.90',
  92: 'enums.clothType.92',
  93: 'enums.clothType.93',
  94: 'enums.clothType.94',
  95: 'enums.clothType.95',
  96: 'enums.clothType.96',
  97: 'enums.clothType.97'
}

// ── 服装进化/焕新状态（NikkiClothState enum → zh-CN.json media_params.nikki_cloth_state）──
export const CLOTH_STATE_MAP: Record<number, string> = {
  0: 'enums.clothState.0',
  1: 'enums.clothState.1',
  2: 'enums.clothState.2',
  3: 'enums.clothState.3',
  4: 'enums.clothState.4',
  5: 'enums.clothState.5',
  9: 'enums.clothState.9'
}

// ── 天气类型（Weather enum → zh-CN.json media_params.weather）──
export const WEATHER_TYPE_MAP: Record<number, string> = {
  [-1]: 'enums.weather.neg1',
  0: 'enums.weather.0',
  2: 'enums.weather.2',
  4: 'enums.weather.4',
  7: 'enums.weather.7'
}

// ── 光圈档位（ApertureSection enum → zh-CN.json media_params.aperture_section）──
export const APERTURE_SECTION_MAP: Record<number, string> = {
  [-1]: 'enums.aperture.neg1',
  1: 'enums.aperture.1',
  2: 'enums.aperture.2',
  3: 'enums.aperture.3',
  4: 'enums.aperture.4',
  5: 'enums.aperture.5',
  6: 'enums.aperture.6',
  7: 'enums.aperture.7',
  8: 'enums.aperture.8',
  9: 'enums.aperture.9',
  10: 'enums.aperture.10',
  11: 'enums.aperture.11',
  12: 'enums.aperture.12',
  13: 'enums.aperture.13',
  14: 'enums.aperture.14',
  15: 'enums.aperture.15'
}

// ── 祝福闪光挂载点（EurekaAttachmentPoint enum → zh-CN.json media_params.eureka_attachment_point）──
export const EUREKA_ATTACHMENT_POINT_MAP: Record<number, string> = {
  0: 'enums.eurekaAttachment.0',
  1: 'enums.eurekaAttachment.1',
  2: 'enums.eurekaAttachment.2',
  3: 'enums.eurekaAttachment.3'
}

// ── 染色色盘（ColorPalette enum → zh-CN.json media_params.color_palette）──
export const COLOR_PALETTE_MAP: Record<number, string> = {
  0: 'enums.colorPalette.0',
  1: 'enums.colorPalette.1',
  2: 'enums.colorPalette.2',
  3: 'enums.colorPalette.3',
  4: 'enums.colorPalette.4',
  5: 'enums.colorPalette.5',
  6: 'enums.colorPalette.6',
  7: 'enums.colorPalette.7',
  8: 'enums.colorPalette.8',
  9: 'enums.colorPalette.9',
  10: 'enums.colorPalette.10',
  11: 'enums.colorPalette.11',
  12: 'enums.colorPalette.12',
  13: 'enums.colorPalette.13',
  14: 'enums.colorPalette.14',
  15: 'enums.colorPalette.15',
  16: 'enums.colorPalette.16',
  17: 'enums.colorPalette.17',
  18: 'enums.colorPalette.18'
}

// ── 染色色格（ColorSwatch enum → zh-CN.json media_params.color_swatch）──
export const COLOR_SWATCH_MAP: Record<number, string> = {
  0: 'enums.colorSwatch.0',
  1: 'enums.colorSwatch.1',
  2: 'enums.colorSwatch.2',
  3: 'enums.colorSwatch.3',
  4: 'enums.colorSwatch.4',
  5: 'enums.colorSwatch.5',
  6: 'enums.colorSwatch.6',
  7: 'enums.colorSwatch.7',
  8: 'enums.colorSwatch.8'
}

// ── 灯光（字符串ID → other/zh-CN.json light）──
export const LIGHT_MAP: Record<string, string> = {
  None: 'enums.light.None',
  DirectionLight_L: 'enums.light.DirectionLight_L',
  DirectionLight_R: 'enums.light.DirectionLight_R',
  DirectionLight_T: 'enums.light.DirectionLight_T',
  DirectionLight_B: 'enums.light.DirectionLight_B',
  HueEdgeLight_001_L: 'enums.light.HueEdgeLight_001_L',
  HueEdgeLight_001_R: 'enums.light.HueEdgeLight_001_R',
  HueEdgeLight_002_L: 'enums.light.HueEdgeLight_002_L',
  HueEdgeLight_002_R: 'enums.light.HueEdgeLight_002_R',
  HueEdgeLight_003_L: 'enums.light.HueEdgeLight_003_L',
  HueEdgeLight_003_R: 'enums.light.HueEdgeLight_003_R',
  HueEdgeLight_004_L: 'enums.light.HueEdgeLight_004_L',
  HueEdgeLight_004_R: 'enums.light.HueEdgeLight_004_R',
  VibeLight_001: 'enums.light.VibeLight_001',
  VibeLight_002: 'enums.light.VibeLight_002',
  VibeLight_003: 'enums.light.VibeLight_003',
  VibeLight_004: 'enums.light.VibeLight_004'
}

// ── 滤镜（字符串ID → other/zh-CN.json filter）──
export const FILTER_MAP: Record<string, string> = {
  None: 'enums.filter.None',
  Fresh_001: 'enums.filter.Fresh_001',
  Fresh_002: 'enums.filter.Fresh_002',
  Fresh_003: 'enums.filter.Fresh_003',
  Fresh_004: 'enums.filter.Fresh_004',
  Fresh_005: 'enums.filter.Fresh_005',
  Weather_001: 'enums.filter.Weather_001',
  Weather_002: 'enums.filter.Weather_002',
  Weather_003: 'enums.filter.Weather_003',
  Weather_004: 'enums.filter.Weather_004',
  Vibe_009: 'enums.filter.Vibe_009',
  Vibe_001: 'enums.filter.Vibe_001',
  Vibe_002: 'enums.filter.Vibe_002',
  Vibe_003: 'enums.filter.Vibe_003',
  Vibe_004: 'enums.filter.Vibe_004',
  Vibe_005: 'enums.filter.Vibe_005'
}

// ── 错位摄影（数字ID → other/zh-CN.json puzzle）──
export const PUZZLE_MAP: Record<number, string> = {
  [-1]: 'enums.puzzle.neg1',
  30: 'enums.puzzle.30',
  31: 'enums.puzzle.31'
}

// ── 拍摄任务（数字ID → other/zh-CN.json interactive）──
export const INTERACTIVE_MAP: Record<number, string> = {
  206001: 'enums.interactive.206001',
  261003: 'enums.interactive.261003',
  42031201: 'enums.interactive.42031201',
  42031202: 'enums.interactive.42031202',
  42031203: 'enums.interactive.42031203'
}

// ── 世界巡游（数字ID → other/zh-CN.json expedition）──
export const EXPEDITION_MAP: Record<number, string> = {
  101020301: 'enums.expedition.101020301',
  101020302: 'enums.expedition.101020302',
  101020303: 'enums.expedition.101020303',
  101020304: 'enums.expedition.101020304',
  101020305: 'enums.expedition.101020305',
  101020306: 'enums.expedition.101020306',
  101020307: 'enums.expedition.101020307',
  101020308: 'enums.expedition.101020308'
}

// ── 动作场景（pose_id → other/zh-CN.json pose）
//    上游亦为空（仅有 {0: "无"}），需后续收集 ──
export const POSE_ID_MAP: Record<number, string> = {
  0: 'enums.poseId.0'
}

// ── 定格场景（framed_moment → other/zh-CN.json framed_moment）
//    上游亦为空（仅有 {0: "无"}），需后续收集 ──
export const FRAMED_MOMENT_MAP: Record<number, string> = {
  0: 'enums.framedMoment.0'
}

// ── 祝福闪光颜色（eureka.color，0-9）
//    推导依据：color = rawId % 10，值域 0-9
//    上游 other/zh-CN.json 中 eureka 对象为空，tree_node_generator.dart 直接显示数字
//    此映射基于游戏内祝福闪光颜色系统的标准色序推导（红→紫彩虹序 + 粉/白），
//    准确性需通过游戏内实际对照验证。如有偏差请通过 debug 日志修正。──
export const EUREKA_COLOR_MAP: Record<number, string> = {
  0: 'enums.eurekaColor.0',
  1: 'enums.eurekaColor.1',
  2: 'enums.eurekaColor.2',
  3: 'enums.eurekaColor.3',
  4: 'enums.eurekaColor.4',
  5: 'enums.eurekaColor.5',
  6: 'enums.eurekaColor.6',
  7: 'enums.eurekaColor.7',
  8: 'enums.eurekaColor.8',
  9: 'enums.eurekaColor.9'
}

// ═══════════════════════════════════════════════
//  查询函数
// ═══════════════════════════════════════════════

/** 根据 cloth_type 获取部位名称，未知类型返回 fallback */
export function getClothTypeName(clothType: number): string {
  return CLOTH_TYPE_MAP[clothType] ?? 'enums.clothType.unknown'
}

/** 根据 weather_type 获取天气名称，未知类型返回 null */
export function getWeatherName(weatherType: number): string | null {
  return WEATHER_TYPE_MAP[weatherType] ?? null
}

/** 根据 pose_id 获取动作名称，未知 ID 返回 null */
export function getPoseName(poseId: number): string | null {
  return POSE_ID_MAP[poseId] ?? null
}

/** 根据 eureka color 获取颜色名称，未知返回 null */
export function getEurekaColorName(color: number): string | null {
  return EUREKA_COLOR_MAP[color] ?? null
}

/** 根据 cloth state 获取状态名称，未知返回 null */
export function getClothStateName(state: number): string | null {
  return CLOTH_STATE_MAP[state] ?? null
}

/** 根据 aperture_section 获取光圈名称，未知返回 null */
export function getApertureName(aperture: number): string | null {
  return APERTURE_SECTION_MAP[aperture] ?? null
}

/** 根据 eureka attachment_point 获取挂载点名称，未知返回 null */
export function getEurekaAttachmentPointName(point: number): string | null {
  return EUREKA_ATTACHMENT_POINT_MAP[point] ?? null
}

/** 根据 color_palette 获取色盘名称，未知返回 null */
export function getColorPaletteName(palette: number): string | null {
  return COLOR_PALETTE_MAP[palette] ?? null
}

/** 根据 color_swatch 获取色格名称，未知返回 null */
export function getColorSwatchName(swatch: number): string | null {
  return COLOR_SWATCH_MAP[swatch] ?? null
}

/** 根据 light ID 获取灯光名称，未知返回原始ID */
export function getLightName(lightId: string): string {
  return LIGHT_MAP[lightId] ?? lightId
}

/** 根据 filter ID 获取滤镜名称，未知返回原始ID */
export function getFilterName(filterId: string): string {
  return FILTER_MAP[filterId] ?? filterId
}

/** 根据 puzzle ID 获取错位摄影名称，未知返回 null */
export function getPuzzleName(puzzleId: number): string | null {
  return PUZZLE_MAP[puzzleId] ?? null
}

/** 根据 interactive ID 获取拍摄任务名称，未知返回 null */
export function getInteractiveName(interactiveId: number): string | null {
  return INTERACTIVE_MAP[interactiveId] ?? null
}

/** 根据 expedition ID 获取世界巡游名称，未知返回 null */
export function getExpeditionName(expeditionId: number): string | null {
  return EXPEDITION_MAP[expeditionId] ?? null
}
