/**
 * 媒体生命周期域共享工具：系统回收站批量操作
 *
 * 供 `media-lifecycle-handler.ts` 的 permanentDelete / emptyRecycleBin 共用
 * 同一套三态判定（成功 / 文件不存在 / 失败）、重试退避、熔断与聚合日志逻辑。
 */
import { shell } from 'electron'
import { pathExists } from '../../utils/file-utils'
import { logger } from '../../utils/logger'
import { t } from '../../i18n'

/**
 * trashItem 三态结果。
 * - ok：成功移至回收站，DB 可安全删除
 * - missing：文件已不存在，DB 可安全删除
 * - failed：移至回收站失败且文件仍存在，DB 必须保留供用户重试
 */
export type TrashItemResult = 'ok' | 'missing' | 'failed'

/** 单个文件移至回收站失败后的重试次数（不含首次尝试） */
const TRASH_RETRY_MAX = 2
/** 重试退避基数，实际延迟为 BASE * 2^n（50ms → 100ms） */
const TRASH_RETRY_BASE_DELAY_MS = 50
/**
 * 连续失败达到该阈值后判定为系统性故障（回收站已满 / 磁盘空间不足 / NukeOnDelete），
 * 后续项不再重试以避免整体耗时失控：实测 2474 项全失败场景下，
 * 逐项重试会把 18.5s 拖成分钟级卡顿。熔断后退化为原「单次尝试」行为。
 */
const TRASH_CIRCUIT_BREAK_THRESHOLD = 10
/** 聚合日志中最多记录的样例路径数 */
const TRASH_LOG_SAMPLE_LIMIT = 3

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 移至系统回收站并区分三态：成功 / 文件不存在 / 失败（文件仍存在）。
 *
 * 抽取此函数是为了让 `emptyRecycleBin` 与 `permanentDelete` 共用同一三态判定逻辑，
 * 避免 B1 类 Bug（trashItem 失败时仍删 DB 记录导致用户数据丢失踪迹）。
 *
 * FIX(A-retry): 增加失败重试。日志实测大批量清空回收站时 2474 项全部失败且错误文本
 * 统一为「Failed to perform delete operation」（Shell API 通用失败，无 errno），
 * 其中 94.5% 文件物理仍存在 —— 属 Windows Shell 大批量连续调用的瞬时失败，对重试敏感。
 * 每次重试前先 pathExists 复检：文件已消失则立即判 missing，不做无谓重试。
 *
 * @param filePath 目标文件绝对路径
 * @param maxRetries 重试次数上限，负值归一化为 0（熔断时传 0 以快速失败）
 * @returns 三态结果与首个错误（错误由调用方聚合记录，避免逐条 warn 刷爆日志）
 */
export async function trashItemWithFallback(
  filePath: string,
  maxRetries: number = TRASH_RETRY_MAX
): Promise<{ result: TrashItemResult; error?: unknown }> {
  const totalAttempts = Math.max(0, maxRetries) + 1
  let firstError: unknown
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    try {
      await shell.trashItem(filePath)
      return { result: 'ok' }
    } catch (err) {
      if (firstError === undefined) firstError = err
      // 区分「文件已不存在」与「权限/锁定等真实失败」：仅文件不存在时可安全删 DB
      if (!(await pathExists(filePath))) {
        return { result: 'missing' }
      }
      if (attempt < totalAttempts - 1) {
        await delay(TRASH_RETRY_BASE_DELAY_MS * 2 ** attempt)
      }
    }
  }
  return { result: 'failed', error: firstError }
}

/** 批量移至回收站的聚合结果 */
export interface TrashBatchOutcome {
  /** 可安全物理删除的 DB 记录 id（trashItem 成功 或 文件已不存在） */
  idsToDelete: number[]
  /** 成功移入系统回收站的数量 */
  movedCount: number
  /** 文件已不存在的数量 */
  missingCount: number
  /** 失败且文件仍存在的路径（DB 记录保留供用户重试） */
  failedPaths: string[]
}

/**
 * 批量移至系统回收站，聚合三态统计并在结束后统一记录一条失败日志。
 *
 * FIX(A-log): 原实现在循环内逐项 logger.warn，实测 2474 项失败写出 2474 行日志，
 * 刷爆日志文件且淹没其他诊断信息。改为循环结束后聚合一条（总数 + 样例路径 + 首个错误）。
 * FIX(A-breaker): 连续失败达阈值即停止重试，防止退避延迟在大批量失败时累积成分钟级卡顿。
 *
 * @param rows 待处理的 DB 记录（id + 文件绝对路径）
 * @returns 三态聚合统计；`failedPaths` 对应的记录不得物理删除
 */
export async function trashBatch(
  rows: readonly { id: number; file_path: string }[]
): Promise<TrashBatchOutcome> {
  const outcome: TrashBatchOutcome = {
    idsToDelete: [],
    movedCount: 0,
    missingCount: 0,
    failedPaths: []
  }
  let firstError: unknown
  let consecutiveFailures = 0

  for (const row of rows) {
    // 熔断：连续失败过多说明是系统性故障，重试已无意义，直接快速失败
    const retries = consecutiveFailures >= TRASH_CIRCUIT_BREAK_THRESHOLD ? 0 : TRASH_RETRY_MAX
    const { result, error } = await trashItemWithFallback(row.file_path, retries)

    if (result === 'failed') {
      outcome.failedPaths.push(row.file_path)
      if (firstError === undefined) firstError = error
      consecutiveFailures++
      continue
    }

    consecutiveFailures = 0
    outcome.idsToDelete.push(row.id)
    if (result === 'ok') outcome.movedCount++
    else outcome.missingCount++
  }

  if (outcome.failedPaths.length > 0) {
    const shown = outcome.failedPaths.slice(0, TRASH_LOG_SAMPLE_LIMIT)
    const samples = shown.join(' | ')
    const omitted = outcome.failedPaths.length - shown.length
    logger.warn(
      t('main.media.log.recycleBinMoveFailed', {
        failed: outcome.failedPaths.length,
        total: rows.length,
        sample: samples,
        omitted: omitted > 0 ? t('main.media.log.recycleBinMoveOmitted', { count: omitted }) : ''
      }),
      firstError
    )
  }

  return outcome
}
