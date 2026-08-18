/**
 * 编辑器元数据共享类型定义
 *
 * 用于将编辑参数（调色/滤镜/LUT/水印）写入图片 XMP 元数据，
 * 导出副本时携带，读取后可一键恢复编辑状态。
 *
 * 设计原则：
 * - 完整自描述：单字段 JSON 即可恢复全部编辑状态
 * - 向前兼容：通过 schemaVersion 字段标识结构版本，便于后续升级
 * - 不存原图：仅记录参数，原图数据由图片文件本身承载
 */
import type { FilterParams, PartialFilterParams } from './editor'
import type { WatermarkConfig } from './watermark'

/**
 * XMP 元数据 schema 版本
 *
 * 后续字段结构调整时递增，读取侧按版本号兼容旧数据。
 */
export const EDITOR_METADATA_SCHEMA_VERSION = 1

/**
 * 滤镜预设的轻量序列化结构
 *
 * 与 FilterPreset 区别：
 * - 不含 id（导出场景无意义）
 * - params 已序列化为 JSON 字符串（避免嵌套对象在 XMP 属性中重复转义）
 */
export interface EditorMetadataFilter {
  /** 滤镜名（用于 UI 展示） */
  name: string
  /** 滤镜分类 */
  category: string
  /** 滤镜参数（已合并 intensity 后的最终参数 JSON 字符串） */
  params: string
}

/**
 * 编辑器元数据完整结构
 *
 * 写入图片 XMP 的 `wxnn:EditorData` 字段（base64 编码的 JSON）。
 * 同时在 XMP 中保留人类可读字段（FilterName / LutName / ExportTimestamp / AppVersion），
 * 供其他工具直接读取，无需解析 JSON。
 */
export interface EditorMetadata {
  /** 元数据 schema 版本 */
  schemaVersion: number
  /** 应用版本（写入时记录，便于后续兼容性判断） */
  appVersion: string
  /** 导出时间（ISO 字符串） */
  exportTimestamp: string
  /** 完整调色参数（包含 brightness/contrast/hsl/curves 等） */
  params: FilterParams
  /** 滤镜信息（无滤镜时为 null） */
  filter: EditorMetadataFilter | null
  /** 滤镜强度（0-100） */
  filterIntensity: number
  /** 水印配置（无水印时为 null） */
  watermark: WatermarkConfig | null
}

/**
 * 部分滤镜参数（用于反序列化时的兼容类型）
 */
export type { PartialFilterParams }
