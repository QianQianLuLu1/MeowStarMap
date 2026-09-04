/**
 * 活动任务快照存储（扫描 / 索引共用）
 *
 * 为什么需要：启动自动扫描在渲染进程订阅 task:progress 之前就已发起，
 * 早到的进度事件因 IPC 无重放而丢失，导致弹窗不显示。
 * 这里缓存"最近一次非终态活动任务进度"，供 task:getActive 在挂载时一次性拉取，
 * 等效实现进度重放，让弹窗在挂载瞬间即出现。
 *
 * 同时覆盖 scan 与 indexing 两类任务：扫描完成后缩略图 / pHash / 场景分析
 * 以 indexing 任务继续推送进度，挂载即拉快照也能补偿这段丢失事件。
 */
import type { TaskProgress } from '../../shared/types/progress'

const snapshotByType = new Map<string, TaskProgress>()

function isTerminal(p: TaskProgress): boolean {
  return p.phase === 'done' || p.phase === 'cancelled' || p.phase === 'error'
}

/** 写入当前扫描任务快照（null 表示扫描已结束或尚未开始） */
export function setActiveScanTask(p: TaskProgress | null): void {
  if (p) snapshotByType.set('scan', p)
  else snapshotByType.delete('scan')
}

/** 写入当前索引任务快照（null 表示索引已结束或尚未开始） */
export function setActiveIndexingTask(p: TaskProgress | null): void {
  if (p) snapshotByType.set('indexing', p)
  else snapshotByType.delete('indexing')
}

/**
 * 返回当前活动任务（非终态优先返回 scan，其次 indexing）。
 * 渲染进程挂载时调用一次，用于重放订阅前丢失的进度事件。
 */
export function getActiveTask(): TaskProgress | null {
  const scan = snapshotByType.get('scan')
  if (scan && !isTerminal(scan)) return scan
  const indexing = snapshotByType.get('indexing')
  if (indexing && !isTerminal(indexing)) return indexing
  return null
}

/** 仅返回活动扫描任务（非终态），供 ScannerWorkerBridge.getActiveScanTask 复用 */
export function getActiveScanTask(): TaskProgress | null {
  const scan = snapshotByType.get('scan')
  return scan && !isTerminal(scan) ? scan : null
}
