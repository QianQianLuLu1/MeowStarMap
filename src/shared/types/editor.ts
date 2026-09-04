/**
 * 编辑器相关共享类型定义
 *
 * 字段与数据库表 edit_history / filter_presets / operation_history 一一对应。
 * 包含图像滤镜参数、曲线调整、编辑历史、操作历史等类型。
 */

// ============================================================================
// HSL 调色类型
// ============================================================================

/**
 * HSL 颜色通道键
 *
 * 12 个颜色通道，对应图像中可独立调整色相/饱和度/亮度的颜色范围。
 */
export type HSLColorKey =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'yellowGreen'
  | 'green'
  | 'cyan'
  | 'blue'
  | 'purple'
  | 'magenta'
  | 'skin'
  | 'bluePurple'
  | 'warm'

/**
 * HSL 调整参数
 */
export interface HSLAdjustment {
  /** 色相偏移（-180 到 180） */
  hue: number
  /** 饱和度调整（-100 到 100） */
  saturation: number
  /** 亮度调整（-100 到 100） */
  lightness: number
}

// ============================================================================
// 曲线与色彩分离
// ============================================================================

/**
 * 曲线控制点
 */
export interface CurvePoint {
  /** X 坐标（0-1） */
  x: number
  /** Y 坐标（0-1） */
  y: number
}

/**
 * 曲线集合
 */
export interface CurvesSet {
  /** RGB 主曲线 */
  rgb: CurvePoint[]
  /** 红色通道曲线 */
  r: CurvePoint[]
  /** 绿色通道曲线 */
  g: CurvePoint[]
  /** 蓝色通道曲线 */
  b: CurvePoint[]
}

/**
 * 色调分离参数
 */
export interface SplitToning {
  /** 高光色相（0-360） */
  highlightHue: number
  /** 高光饱和度（0-100） */
  highlightSaturation: number
  /** 阴影色相（0-360） */
  shadowHue: number
  /** 阴影饱和度（0-100） */
  shadowSaturation: number
  /** 平衡（-100 到 100） */
  balance: number
}

// ============================================================================
// 滤镜参数
// ============================================================================

/**
 * 完整滤镜参数集
 *
 * 对应 filter_presets.params 列存储的 JSON 内容。
 */
export interface FilterParams {
  /** 亮度（-100 到 100） */
  brightness: number
  /** 对比度（-100 到 100） */
  contrast: number
  /** 饱和度（-100 到 100） */
  saturation: number
  /** 自然饱和度（-100 到 100） */
  vibrance: number
  /** 色温（-100 到 100） */
  temperature: number
  /** 色调（-100 到 100） */
  tint: number
  /** 高光（-100 到 100） */
  highlights: number
  /** 阴影（-100 到 100） */
  shadows: number
  /** 白色（-100 到 100） */
  whites: number
  /** 黑色（-100 到 100） */
  blacks: number
  /** 清晰度（-100 到 100） */
  clarity: number
  /** 去雾（0-100） */
  dehaze: number
  /** 锐化（0-100） */
  sharpen: number
  /** 降噪（0-100） */
  denoise: number
  /** HSL 12 通道调整 */
  hsl: Record<HSLColorKey, HSLAdjustment>
  /** 曲线（RGB + R/G/B 通道） */
  curves: CurvesSet
  /** 高光色相（用于色调分离） */
  highlightHue: number
  /** 高光饱和度 */
  highlightSaturation: number
  /** 阴影色相 */
  shadowHue: number
  /** 阴影饱和度 */
  shadowSaturation: number
  /** 色调分离平衡 */
  splitBalance: number
  /** 颗粒（0-100） */
  grain: number
  /** 暗角（-100 到 100） */
  vignette: number
  /** 褪色（0-100） */
  fade: number
  /** LUT 文件名（应用 3D LUT），null 表示不应用 */
  lut: string | null
}

/**
 * 滤镜预设的部分参数（用于预设合并）
 *
 * 与 FilterParams 区别：
 * - 所有字段可选
 * - hsl 为 Partial 类型（仅包含需要调整的颜色通道）
 */
export type PartialFilterParams = Partial<Omit<FilterParams, 'hsl'>> & {
  /** HSL 部分调整（仅包含需要调整的通道） */
  hsl?: Partial<Record<HSLColorKey, HSLAdjustment>>
}

// ============================================================================
// 滤镜预设类型（对应 filter_presets 表）
// ============================================================================

/**
 * 滤镜预设数据库行（与 filter_presets 表字段一一对应）
 */
export interface FilterPresetRow {
  /** 主键 ID（AUTOINCREMENT） */
  id: number
  /** 预设名 */
  name: string
  /** 预设分类（如 'portrait'、'landscape'） */
  category: string
  /** 滤镜参数 JSON 字符串 */
  params: string
  /** 是否内置预设（0/1） */
  is_builtin: number
  /** 创建时间（ISO 字符串） */
  created_at: string
}

/**
 * 渲染进程使用的滤镜预设模型
 */
export interface FilterPreset {
  /** 预设 ID */
  id: string
  /** 预设名 */
  name: string
  /** 预设分类 */
  category: string
  /** 滤镜参数（已解析） */
  params: PartialFilterParams
}

/**
 * 滤镜预设创建参数
 */
export interface FilterPresetCreateInput {
  /** 预设名 */
  name: string
  /** 预设分类 */
  category: string
  /** 滤镜参数 */
  params: PartialFilterParams
}

// ============================================================================
// 编辑历史类型（对应 edit_history 表）
// ============================================================================

/**
 * 编辑历史数据库行（与 edit_history 表字段一一对应）
 */
export interface EditHistoryRow {
  /** 主键 ID（AUTOINCREMENT） */
  id: number
  /** 关联的媒体文件 ID */
  media_id: number
  /** 编辑参数 JSON 字符串 */
  params: string
  /** 编辑结果缩略图路径 */
  thumbnail: string | null
  /** 创建时间（ISO 字符串） */
  created_at: string
}

/**
 * 编辑历史记录（渲染进程模型）
 */
export interface EditHistoryRecord {
  /** 记录 ID */
  id: number
  /** 媒体文件 ID */
  mediaId: number
  /** 编辑参数（已解析） */
  params: FilterParams
  /** 编辑结果缩略图路径 */
  thumbnail: string | null
  /** 创建时间 */
  createdAt: string
}

/**
 * 编辑器保存选项
 */
export interface EditorSaveOptions {
  /** 是否覆盖原文件 */
  overwrite?: boolean
  /** 输出目录（不覆盖时必填） */
  outputDir?: string
  /** 输出文件名（不含扩展名） */
  outputFileName?: string
  /** 输出格式（如 'jpg'、'png'），默认沿用原格式 */
  outputFormat?: string
  /** 输出质量（0-100，仅 jpeg/webp 有效） */
  quality?: number
  /** 是否保留 EXIF 信息 */
  keepExif?: boolean
  /** 是否写入编辑历史 */
  writeHistory?: boolean
}

/**
 * 编辑器保存结果
 */
export interface EditorSaveResult {
  /** 是否成功 */
  success: boolean
  /** 输出文件路径 */
  outputPath: string | null
  /** 输出文件大小（字节） */
  outputSize: number | null
  /** 编辑历史记录 ID（写入历史时） */
  historyId: number | null
  /** 错误信息（失败时） */
  error: string | null
}

// ============================================================================
// 操作历史类型（对应 operation_history 表）
// ============================================================================

/**
 * 操作历史类型枚举
 *
 * 对应 operation_history.operation_type 列。
 */
export type OperationType =
  | 'edit'
  | 'delete'
  | 'restore'
  | 'favorite'
  | 'unfavorite'
  | 'rate'
  | 'tag'
  | 'untag'
  | 'category'
  | 'move'
  | 'rename'
  | 'export'
  | 'watermark'
  | 'share'

/**
 * 操作历史数据库行（与 operation_history 表字段一一对应）
 */
export interface OperationHistoryRow {
  /** 主键 ID（AUTOINCREMENT） */
  id: number
  /** 操作类型 */
  operation_type: OperationType
  /** 关联的媒体文件 ID，无关联为 null */
  media_id: number | null
  /** 操作载荷 JSON 字符串（包含操作的具体参数） */
  payload: string
  /** 操作描述（默认空串） */
  description: string
  /** 创建时间（ISO 字符串） */
  created_at: string
}

/**
 * 操作历史记录（渲染进程模型）
 */
export interface OperationHistoryRecord {
  /** 记录 ID */
  id: number
  /** 操作类型 */
  operationType: OperationType
  /** 关联的媒体文件 ID */
  mediaId: number | null
  /** 操作载荷（已解析） */
  payload: Record<string, string | number | boolean | null>
  /** 操作描述 */
  description: string
  /** 创建时间 */
  createdAt: string
}

/**
 * 操作历史查询选项
 */
export interface OperationHistoryQueryOptions {
  /** 操作类型筛选，null 表示全部 */
  operationType?: OperationType | null
  /** 媒体 ID 筛选，null 表示全部 */
  mediaId?: number | null
  /** 起始时间（ISO 字符串） */
  startTime?: string | null
  /** 结束时间（ISO 字符串） */
  endTime?: string | null
  /** 分页偏移量 */
  offset?: number
  /** 每页数量 */
  limit?: number
}
