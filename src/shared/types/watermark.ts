/**
 * 水印相关共享类型定义
 *
 * 字段与数据库表 watermark_templates 一一对应。
 * 水印配置同时供编辑器、批量导出、分享功能使用。
 */

// ============================================================================
// 水印基础类型
// ============================================================================

/**
 * 水印位置枚举
 *
 * 9 个预设位置 + 1 个自定义位置。
 */
export type WatermarkPosition =
  | 'topLeft'
  | 'topCenter'
  | 'topRight'
  | 'centerLeft'
  | 'center'
  | 'centerRight'
  | 'bottomLeft'
  | 'bottomCenter'
  | 'bottomRight'
  | 'custom'

/**
 * 水印样式枚举
 *
 * 不同样式影响水印的渲染效果与布局。
 */
export type WatermarkStyle = 'normal' | 'polaroid' | 'date-label' | 'signature' | 'copyright'

/**
 * 混合模式枚举
 *
 * 用于图像水印的图层混合。
 */
export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'

// ============================================================================
// 水印内容配置
// ============================================================================

/**
 * 文字水印配置
 */
export interface WatermarkText {
  /** 文字内容 */
  content: string
  /** 字体（如 'Microsoft YaHei'、'Arial'） */
  font: string
  /** 字号（像素） */
  size: number
  /** 颜色（如 '#FFFFFF'） */
  color: string
  /** 不透明度（0-1） */
  opacity: number
  /** 是否加粗 */
  bold: boolean
  /** 是否斜体 */
  italic: boolean
  /** 是否下划线 */
  underline: boolean
}

/**
 * 图像水印配置
 */
export interface WatermarkImage {
  /** 图像路径（绝对路径或 file:// URL） */
  path: string
  /** 宽度（像素） */
  width: number
  /** 高度（像素） */
  height: number
  /** 不透明度（0-1） */
  opacity: number
  /** 混合模式 */
  blendMode: BlendMode
}

// ============================================================================
// 水印完整配置
// ============================================================================

/**
 * 水印完整配置
 *
 * 对应 watermark_templates.config 列存储的 JSON 内容。
 * 文字水印与图像水印可同时存在（叠加渲染）。
 */
export interface WatermarkConfig {
  /** 文字水印配置，不启用为 undefined */
  text?: WatermarkText
  /** 图像水印配置，不启用为 undefined */
  image?: WatermarkImage
  /** 水印位置 */
  position: WatermarkPosition
  /** 自定义位置 X 坐标（position='custom' 时生效） */
  customX: number
  /** 自定义位置 Y 坐标（position='custom' 时生效） */
  customY: number
  /** 旋转角度（-180 到 180） */
  rotation: number
  /** 边距（像素） */
  margin: number
  /** 是否平铺（覆盖整张图片） */
  tile: boolean
  /** 平铺水平间距（像素） */
  tileSpacingX: number
  /** 平铺垂直间距（像素） */
  tileSpacingY: number
  /** 水印样式 */
  style?: WatermarkStyle
}

// ============================================================================
// 水印模板类型（对应 watermark_templates 表）
// ============================================================================

/**
 * 水印模板数据库行（与 watermark_templates 表字段一一对应）
 */
export interface WatermarkTemplateRow {
  /** 主键 ID（AUTOINCREMENT） */
  id: number
  /** 模板名 */
  name: string
  /** 水印配置 JSON 字符串 */
  config: string
  /** 是否内置模板（0/1） */
  is_builtin: number
  /** 创建时间（ISO 字符串） */
  created_at: string
}

/**
 * 渲染进程使用的水印模板模型
 */
export interface WatermarkTemplate {
  /** 模板 ID */
  id: number
  /** 模板名 */
  name: string
  /** 水印配置（已解析） */
  config: WatermarkConfig
  /** 是否内置模板 */
  isBuiltin: boolean
  /** 创建时间 */
  createdAt: string
}

/**
 * 水印模板创建参数
 */
export interface WatermarkTemplateCreateInput {
  /** 模板名 */
  name: string
  /** 水印配置 */
  config: WatermarkConfig
}

/**
 * 水印模板更新参数
 */
export interface WatermarkTemplateUpdateInput {
  /** 模板名 */
  name?: string
  /** 水印配置 */
  config?: WatermarkConfig
}

// ============================================================================
// 水印应用选项
// ============================================================================

/**
 * 水印应用进度
 */
export interface WatermarkApplyProgress {
  /** 当前已处理文件数 */
  current: number
  /** 总文件数 */
  total: number
  /** 当前文件路径 */
  currentPath: string
  /** 进度百分比（0-100） */
  percent: number
}

/**
 * 水印应用结果
 */
export interface WatermarkApplyResult {
  /** 是否成功 */
  success: boolean
  /** 成功处理的文件数 */
  successCount: number
  /** 失败的文件数 */
  failedCount: number
  /** 输出文件路径列表 */
  outputPaths: string[]
  /** 失败的文件与错误信息 */
  failures: Array<{ path: string; error: string }>
  /** 总耗时（毫秒） */
  duration: number
}
