/**
 * 扫描变更日志辅助（sync-integration 阶段5，自 scanner-handler 抽取）。
 *
 * 主进程拿不到 scanner worker 内的逐行写入明细，采用两个水位线近似：
 * - preScanMaxId（扫描发起前 MAX(id)）：id 越线 = 本次扫描新发现的资产行（INSERT），精确
 * - scanStartedAt 时间窗：捕获扫描进行期间的行变化（created_at/updated_at 为 ISO 字符串，
 *   与 ISO 水位线可直接字典序比较）
 * 已知限制：上次扫描结束到本次发起之间被外部修改/失踪标记的行不会进入本批 journal
 * （其时间戳早于 scanStartedAt 且 id 未越线）；崩溃恢复扫描以应用启动时间为窗、
 * 水位线 0（全量补账，保证客户端收敛，代价是恢复后一次全量 journal）
 *
 * 抽取动机：IPC 发起扫描（scanner-handler）与启动自动扫描（startup-tasks）必须共用
 * 同一份落账实现——启动扫描此前完全不接 syncEvents，新增照片不进 journal、revision
 * 不递增、WS 客户端收不到事件。落账失败仅告警，绝不阻塞扫描主流程。
 */
import type Database from 'better-sqlite3'
import { SyncMetadataRepository } from '../database/sync-metadata-repository'
import type { SyncEventSink } from '../sync/server/types'
import { logger } from '../utils/logger'

export interface ScanSyncContext {
  /** 扫描发起时刻（ISO）；崩溃恢复扫描用应用启动时间兜底 */
  scanStartedAt: string
  /** 扫描发起前的 media_files MAX(id) 水位线；崩溃恢复扫描传 0（全量补账） */
  preScanMaxId: number
}

// 与 scanner-handler 阶段4 的查询完全一致：id 越线或时间窗命中即变更行（ISO 字典序比较）
const SCAN_CHANGED_ROWS_SQL =
  'SELECT id, created_at FROM media_files WHERE is_duplicate = 0 AND (id > ? OR created_at > ? OR updated_at > ?)'

/** workerBridge/dbPath 类型跟随 SyncMetadataRepository 构造器签名，仓储改动时自动对齐 */
export type ScanJournalWorkerBridge = ConstructorParameters<typeof SyncMetadataRepository>[1]

export interface ScanJournalDeps {
  db: Database.Database | null
  workerBridge: ScanJournalWorkerBridge
  dbPath: string
  /** 缺省时视为未组装（生产由 initSyncServer 注入；journal 永远写的保证在装配层） */
  syncEvents?: SyncEventSink
}

/**
 * 扫描发起前捕获 media_files MAX(id) 水位线。
 * db 缺失或查询失败时返回 0（等价于"全部视为新发现"，由时间窗兜底不误报）。
 */
export function captureScanWatermark(db: Database.Database | null | undefined): number {
  if (!db) return 0
  try {
    const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM media_files').get() as
      { max_id: number } | undefined
    return row?.max_id ?? 0
  } catch {
    return 0
  }
}

/**
 * 扫描结束后按水位线 + 时间窗批量落账（journal + 合并广播由 SyncEventSink 实现）。
 * 返回本次写入的变更行数；任何异常吞掉仅告警并返回 0，不阻塞扫描主流程。
 */
export async function recordScanChanges(
  deps: ScanJournalDeps,
  syncContext: ScanSyncContext
): Promise<number> {
  const { db, syncEvents } = deps
  if (!db || !syncEvents) return 0
  try {
    // 动态照片同名配对先重建：motion 链接变化对客户端可见（资源列表/hasMotion）
    const syncMetadata = new SyncMetadataRepository(db, deps.workerBridge, deps.dbPath)
    await syncMetadata.rebuildMotionLinks()
    const rows = db
      .prepare(SCAN_CHANGED_ROWS_SQL)
      .all(
        syncContext.preScanMaxId,
        syncContext.scanStartedAt,
        syncContext.scanStartedAt
      ) as Array<{
      id: number
      created_at: string
    }>
    if (rows.length === 0) return 0
    await syncEvents.recordAssetChanges(
      rows.map((row) => ({
        eventType:
          row.id > syncContext.preScanMaxId
            ? ('asset.created' as const)
            : ('asset.updated' as const),
        assetId: String(row.id)
      }))
    )
    return rows.length
  } catch (err) {
    logger.warn('[Sync] failed to journal scan changes', err)
    return 0
  }
}
