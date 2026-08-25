/**
 * 缩略图 / pHash / 重复检测 worker 进程通信协议
 *
 * 主进程 ↔ media worker 之间的消息类型定义。
 * - 主进程 → worker：MediaWorkerCommand（*_START / *_STOP / MEDIA_WORKER_DISPOSE）
 * - worker → 主进程：MediaWorkerEvent（*_PROGRESS / *_COMPLETE / MEDIA_WORKER_LOG / WORKER_READY / WORKER_ERROR / MEDIA_WORKER_DISPOSED）
 *
 * 设计原则：
 * 1. 三类任务（缩略图批量、pHash 批量、重复标记）共用一个 worker 进程，避免多进程开销
 * 2. 三类任务各自独立 STOP，互不影响（shouldStopThumbnail / shouldStopPhash / shouldStopDuplicate）
 * 3. pHash 完成后自动链式触发 markDuplicates（保持原有行为）
 */
export type ThumbnailQuality = 'low' | 'standard' | 'high'

/**
 * 相似检测回传的分组用元数据（不含像素/缩略图/phash 本体，控制回传体积）。
 * 字段与 similar-handler 分组输出所需字段对齐。
 */
export interface SimilarRowMeta {
  id: number
  file_path: string
  file_name: string
  file_type: string
  file_size: number
  modified_at: string
  width: number | null
  height: number | null
  is_favorite: number
  rating: number
}

// ============ 主进程 → worker ============
export type MediaWorkerCommand =
  // 缩略图批量生成：为缺缩略图/尺寸/phash 的图片记录生成缩略图并补算 phash
  | {
      type: 'THUMBNAIL_BATCH_START'
      payload: {
        dbPath: string
        cacheDir: string // 缩略图缓存目录，由主进程 ThumbnailGenerator.getCacheDir() 提供
        thumbnailQuality: ThumbnailQuality
      }
    }
  // pHash 批量补算：为缺 phash 的图片补算，完成后自动链式 markDuplicates
  | { type: 'PHASH_BATCH_START'; payload: { dbPath: string } }
  // 重复标记：O(n²) Union-Find 聚类，标记 is_duplicate / original_id
  | { type: 'DUPLICATE_MARK_START'; payload: { dbPath: string } }
  // 相似检测：worker 内建 BK-tree 做半径检索，回传候选边 + 元数据
  | { type: 'SIMILAR_FIND_START'; payload: { dbPath: string; threshold: number } }
  // 取消指令（各自独立，互不影响）
  | { type: 'THUMBNAIL_STOP' }
  | { type: 'PHASH_STOP' }
  | { type: 'DUPLICATE_STOP' }
  | { type: 'SIMILAR_STOP' }
  // 主进程退出前调用，worker 主动清理并退出
  | { type: 'MEDIA_WORKER_DISPOSE' }

// ============ worker → 主进程 ============
export type MediaWorkerEvent =
  // worker 启动完成，可接收任务
  | { type: 'WORKER_READY' }
  // 缩略图进度
  | {
      type: 'THUMBNAIL_PROGRESS'
      payload: { processed: number; total: number; currentFile: string }
    }
  // 缩略图完成
  | {
      type: 'THUMBNAIL_COMPLETE'
      payload: { success: boolean; message: string; processed: number; total: number }
    }
  // pHash 进度
  | {
      type: 'PHASH_PROGRESS'
      payload: { processed: number; total: number; currentFile: string }
    }
  // pHash 完成（含链式 markDuplicates 的结果）
  | {
      type: 'PHASH_COMPLETE'
      payload: {
        success: boolean
        message: string
        processed: number
        total: number
        duplicatesResult?: { markedDuplicates: number; totalGroups: number }
      }
    }
  // 重复标记进度（O(n²) 比较）
  | {
      type: 'DUPLICATE_PROGRESS'
      payload: { compared: number; totalPairs: number }
    }
  // 重复标记完成
  | {
      type: 'DUPLICATE_COMPLETE'
      payload: { success: boolean; message: string; markedDuplicates: number; totalGroups: number }
    }
  // 相似检测进度
  | {
      type: 'SIMILAR_PROGRESS'
      payload: { scanned: number; total: number; candidates: number }
    }
  // 相似检测候选边批次（a<b，dist<=threshold；a/b 为 media id）
  | {
      type: 'SIMILAR_CANDIDATES'
      payload: { batch: Array<{ a: number; b: number; dist: number }> }
    }
  // 相似检测完成（rows 为分组用元数据数组，不含 phash 本体）
  | {
      type: 'SIMILAR_COMPLETE'
      payload: {
        success: boolean
        message: string
        rows: SimilarRowMeta[]
        totalCandidates: number
        totalRows: number
        cancelled?: boolean
      }
    }
  // 相似检测异常（worker 内捕获后发送，主进程据此合成失败终态）
  | { type: 'SIMILAR_ERROR'; payload: { message: string; stack?: string } }
  // 日志转发（info 级别在 worker 内丢弃，warn/error 转发到主进程 logger）
  | {
      type: 'MEDIA_WORKER_LOG'
      payload: { level: 'info' | 'warn' | 'error'; message: string; args?: unknown[] }
    }
  // worker 未捕获异常
  | { type: 'WORKER_ERROR'; payload: { message: string; stack?: string } }
  // 新增：worker 处理完 MEDIA_WORKER_DISPOSE 并关闭 DB 句柄后回发，主进程据此确认可安全 rename 还原
  | { type: 'MEDIA_WORKER_DISPOSED' }
