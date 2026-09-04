/**
 * 缩略图单文件生成 worker 通信协议
 *
 * 主进程 ↔ thumbnail worker 之间的消息类型定义。
 * - 主进程 → worker：ThumbnailWorkerCommand（THUMBNAIL_PROCESS_START / THUMBNAIL_WORKER_DISPOSE）
 * - worker → 主进程：ThumbnailWorkerEvent（THUMBNAIL_PROCESS_COMPLETE / THUMBNAIL_WORKER_LOG / WORKER_READY / WORKER_ERROR）
 *
 * 设计要点：
 * 1. 单文件原子操作，无需 PROGRESS（sharp 单张 50~200ms，进度无意义）
 * 2. 多请求并发：每个 START 携带唯一 requestId，COMPLETE 回传 requestId 关联 pending Promise
 * 3. fileHash 由主进程计算（contentHashCache 在主进程），worker 直接用于输出文件名，避免重复读文件
 * 4. quality 枚举与 ThumbnailGenerator.generate 的 quality 参数一致
 *
 * 与 media-worker/worker-protocol.ts 的 ThumbnailQuality 字面量保持一致（'low' | 'standard' | 'high'）。
 * 选择复制定义而非 re-export：3 个字符串字面量零维护成本，避免单文件 worker 与批量 worker 跨模块耦合。
 */

export type ThumbnailQuality = 'low' | 'standard' | 'high'

/** worker 处理单个缩略图请求所需的输入参数 */
export interface ThumbnailProcessInput {
  /** 请求 ID（主进程生成，用于关联 pending Promise） */
  requestId: string
  /** 源文件绝对路径 */
  filePath: string
  /** 文件内容 hash（主进程已计算，前 1MB sha256 前 16 字符） */
  fileHash: string
  /** 缩略图档位 */
  quality: ThumbnailQuality
  /** 缩略图缓存目录（主进程 cacheDir） */
  cacheDir: string
}

/** worker 处理结果 */
export interface ThumbnailProcessOutput {
  /** 对应的 requestId */
  requestId: string
  /** 是否成功 */
  success: boolean
  /** 生成的缩略图绝对路径（失败时为 null） */
  outputPath: string | null
  /** 失败原因（成功时为空字符串） */
  errorMessage: string
  /** 生成的新文件大小（字节，用于主进程累加 totalCacheSize） */
  outputSize: number
}

// ============ 主进程 → worker ============
export type ThumbnailWorkerCommand =
  | { type: 'THUMBNAIL_PROCESS_START'; payload: ThumbnailProcessInput }
  | { type: 'THUMBNAIL_WORKER_DISPOSE' }

// ============ worker → 主进程 ============
export type ThumbnailWorkerEvent =
  | { type: 'WORKER_READY' }
  | { type: 'THUMBNAIL_PROCESS_COMPLETE'; payload: ThumbnailProcessOutput }
  | {
      type: 'THUMBNAIL_WORKER_LOG'
      payload: { level: 'info' | 'warn' | 'error'; message: string; args?: unknown[] }
    }
  | { type: 'WORKER_ERROR'; payload: { message: string; stack?: string } }
