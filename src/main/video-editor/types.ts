/**
 * 视频编辑任务类型定义
 *
 * 单视频编辑与批量编辑共用 VideoEditTask 结构；
 * 调色参数复用图片编辑器 FilterParams，水印参数复用 WatermarkConfig。
 *
 * 详见 docs/VIDEO_EDIT_PLAN.md §6.2。
 */
import type { FilterParams } from '../../shared/types/editor'
import type { WatermarkConfig } from '../../shared/types/watermark'

/**
 * 单条视频编辑任务
 * - 调色（params）必填；水印/裁剪/调速/格式可选
 * - 各可选字段为空时，跳过对应滤镜，保留原视频对应属性
 */
export interface VideoEditTask {
  /** 输入视频绝对路径 */
  inputPath: string
  /** 输出视频绝对路径（由调用方确保目录存在） */
  outputPath: string
  /** 基础调色参数（全 0 时跳过滤镜） */
  params: FilterParams
  /** 可选水印配置（不提供则不应用水印） */
  watermark?: WatermarkConfig | null
  /** 可选裁剪区间（秒），未提供时整段保留 */
  trim?: { start: number; end: number } | null
  /** 可选调速倍率（0.25-4.0），未提供时保持原速 */
  speed?: number | null
  /** 输出格式（如 mp4/mov/webm/gif），未提供时沿用 outputPath 后缀 */
  format?: string | null
}

/** 单视频编辑请求（IPC: video:edit） */
export interface VideoEditRequest {
  task: VideoEditTask
}

/** 单视频编辑响应 */
export interface VideoEditResponse {
  success: boolean
  taskId: string
  message?: string
  outputPath?: string
}

/** 批量编辑请求（IPC: video:editBatch） */
export interface VideoEditBatchRequest {
  tasks: VideoEditTask[]
  /** 并发数（默认 2，上限受 MAX_VIDEO_EDIT_CONCURRENCY 限制） */
  concurrency?: number
}

/** 批量编辑响应 */
export interface VideoEditBatchResponse {
  success: boolean
  taskId: string
  failedIndexes: number[]
  message?: string
}
