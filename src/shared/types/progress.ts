/**
 * 通用任务进度状态协议（性能重构 v3 改造项三）
 * 文档：docs/PERFORMANCE_REFACTOR_PLAN.md §4.2
 *
 * 适用任务：扫描 / 重复检测 / 批量编辑 / 水印 / 文件导入 / 视频编辑
 * 复用现有 IpcResponse 契约 + 进度通过 task:progress 通道推送
 */

/** 任务类型，决定 UI 显示文案与图标 */
export type TaskType =
  | 'scan' // 扫描
  | 'duplicate' // 重复检测
  | 'batch' // 批量编辑
  | 'watermark' // 水印
  | 'import' // 文件导入
  | 'video-edit' // 视频编辑
  | 'indexing' // 扫描后长任务（缩略图 / pHash / 场景分析）

/** 任务执行阶段，决定 UI 状态展示 */
export type TaskPhase =
  | 'preparing' // 准备中（如初始化文件列表）
  | 'processing' // 处理中（主循环）
  | 'finalizing' // 收尾（如更新数据库索引）
  | 'done' // 完成
  | 'cancelled' // 已取消
  | 'error' // 异常

/**
 * 统一进度状态
 * - 主进程通过 task:progress 通道推送
 * - 渲染进程通过 electronAPI.task.onProgress 订阅
 * - 取消通过 electronAPI.task.cancel(taskId) 触发
 */
export interface TaskProgress {
  /** 任务唯一 ID（用于取消） */
  taskId: string
  /** 任务类型 */
  taskType: TaskType
  /** 当前阶段 */
  phase: TaskPhase
  /** 已处理条目数 */
  current: number
  /** 总条目数（preparing 阶段可为 0） */
  total: number
  /** 完成百分比 0~100 */
  percent: number
  /** 吞吐量（条目/秒），用于 ETA 计算 */
  processedPerSec?: number
  /** 剩余时间（毫秒），done/cancelled 时为 0 */
  etaMs?: number
  /** 当前操作描述（如「扫描 D:\Steam\...」） */
  message?: string
  /** 任务开始时间戳（Date.now()） */
  startedAt: number
  /** 是否可取消 */
  canCancel: boolean
  /** 扫描当前路径（scan 任务特有，用于弹窗子行展示；其他任务可省略） */
  currentPath?: string
  /** 已发现文件数（scan 任务特有） */
  found?: number
}

/**
 * 扫描器状态快照（scanner:status 的统一契约，三端共享）
 *
 * 主进程 ScannerManager.getStatus() 返回此类型；preload 通过
 * call<ScannerStatus>('scanner:status') 暴露给渲染进程；渲染进程
 * window.electronAPI.scanner.status() 消费此类型。
 *
 * 与 worker-protocol.ts 的 ScanProgress 关系：ScanProgress 是扫描进度事件
 * 用的富类型（额外带 total / perSec / etaMs / taskId），ScannerStatus 是
 * 状态查询用的精简契约，字段为其子集。getStatus() 实际返回的运行时对象
 * 满足本类型。
 */
export interface ScannerStatus {
  /** 当前扫描阶段 */
  status: 'idle' | 'running' | 'completed' | 'failed'
  /** 已扫描文件数 */
  scanned: number
  /** 已发现文件数 */
  found: number
  /** 当前正在扫描的路径 */
  currentPath: string
}

/**
 * 取消任务的请求参数
 * - 渲染进程 → 主进程：通过 task:cancel 通道
 * - 主进程确认后推送 task:cancelled
 */
export interface TaskCancelRequest {
  taskId: string
}

/** 任务取消确认 */
export interface TaskCancelledEvent {
  taskId: string
  /** 取消时已处理的条目数（用于 UI 提示已保留部分结果） */
  processedBeforeCancel: number
  /** 取消原因（用户主动取消 / 系统异常等） */
  reason: 'user' | 'system' | 'error'
}
