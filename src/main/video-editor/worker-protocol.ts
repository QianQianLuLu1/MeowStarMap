/**
 * 视频编辑 worker 进程通信协议
 *
 * 主进程 ↔ worker 之间的消息类型定义。
 * - 主进程 → worker：VideoEditorCommand（EDIT_START / EDIT_STOP / EDITOR_DISPOSE）
 * - worker → 主进程：VideoEditorEvent（WORKER_READY / EDIT_PROGRESS / EDIT_COMPLETE / WORKER_ERROR / EDITOR_LOG）
 *
 * 设计要点：
 * - 单任务派发：worker 仅处理一条 EDIT_START，批量调度由 bridge 用 runWithConcurrency 控制并发，
 *   符合「小函数、单一职责」原则。
 * - 复用现有 FilterParams / WatermarkConfig / VideoEditTask 类型，不重复定义。
 *
 * 详见 docs/VIDEO_EDIT_PLAN.md §8。
 */
import type { VideoEditTask } from './types'

/** 单条视频编辑任务载荷（主进程 → worker：EDIT_START） */
export interface VideoEditTaskPayload {
  /** 任务参数 */
  task: VideoEditTask
  /** 任务 ID（用于取消） */
  taskId: string
  /** 当前任务在批量中的序号（0-based） */
  index: number
  /** 批量总数（单视频编辑时为 1） */
  total: number
}

// ============ 主进程 → worker ============
export type VideoEditorCommand =
  | { type: 'EDIT_START'; payload: VideoEditTaskPayload }
  | { type: 'EDIT_STOP' }
  | { type: 'EDITOR_DISPOSE' } // 主进程退出前调用，worker 主动清理并退出

// ============ worker → 主进程 ============

/** 编辑进度上报载荷 */
export interface EditProgressPayload {
  /** 当前已处理数（批量时为 index，单视频时为 0-1 的进度） */
  current: number
  /** 总数 */
  total: number
  /** 完成百分比 0-100 */
  percent: number
  /** 操作描述 */
  message: string
}

/** 单任务完成上报载荷 */
export interface EditCompletePayload {
  /** 是否成功 */
  success: boolean
  /** 结果消息（成功为输出路径摘要，失败为错误信息） */
  message: string
  /** 任务序号（与 EDIT_START.payload.index 对应） */
  index: number
  /** 成功时输出文件路径 */
  outputPath?: string
}

export type VideoEditorEvent =
  | { type: 'WORKER_READY' }
  | { type: 'EDIT_PROGRESS'; payload: EditProgressPayload }
  | { type: 'EDIT_COMPLETE'; payload: EditCompletePayload }
  | {
      type: 'WORKER_ERROR'
      payload: { message: string; stack?: string }
    }
  | {
      type: 'EDITOR_LOG'
      payload: { level: 'warn' | 'error'; message: string }
    }
