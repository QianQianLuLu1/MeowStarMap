import { ipcMain, dialog, shell } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler, wrapHandlerNoArgs, schemas } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { MediaRepository } from '../../database/media-repository'
import { pathExists } from '../../utils/file-utils'
import { logger } from '../../utils/logger'
import { t } from '../../i18n'

/**
 * trashItem 三态结果。
 * - ok：成功移至回收站，DB 可安全删除
 * - missing：文件已不存在，DB 可安全删除
 * - failed：移至回收站失败且文件仍存在，DB 必须保留供用户重试
 */
type TrashItemResult = 'ok' | 'missing' | 'failed'

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
async function trashItemWithFallback(
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
interface TrashBatchOutcome {
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
async function trashBatch(
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
      // TODO: i18n: internal log
      `[RecycleBin] 移至系统回收站失败 ${outcome.failedPaths.length}/${rows.length} 项，` +
        `DB 记录已保留供重试。样例: ${samples}${omitted > 0 ? ` …(另 ${omitted} 项)` : ''}`,
      firstError
    )
  }

  return outcome
}

/**
 * 媒体生命周期域 IPC handler
 *
 * 覆盖：物理删除 / 软删除 / 恢复 / 彻底删除 / 清空回收站 / 丢失与损坏记录清理。
 * 彻底删除与清空回收站含 dialog 二次确认；彻底删除采用三阶段事务保证 DB 与文件系统一致。
 */
export function registerMediaLifecycleHandlers(ctx: HandlerContext): void {
  // 每次调用动态获取 Repository（db 可能在初始化/重连时变化）
  // 数据库写操作进程拆分：传入 workerBridge 与 dbPath，写方法走独立 utilityProcess
  const getRepo = (): MediaRepository => {
    const db = ctx.dbManager.getDatabase()
    if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
    return new MediaRepository(db, ctx.dbManager.getWorkerBridge(), ctx.dbManager.getDbPath())
  }

  ipcMain.handle(
    'media:delete',
    wrapHandler(ctx, z.tuple([schemas.mediaId]), async ([mediaId]) => {
      await getRepo().hardDelete(mediaId)
      ctx.notifyMediaUpdated()
      return { deleted: true }
    })
  )

  // F-S6 回收站：软删除
  ipcMain.handle(
    'media:softDelete',
    wrapHandler(ctx, z.tuple([schemas.mediaIdArrayBulk]), async ([mediaIds]) => {
      await getRepo().softDeleteBatch(mediaIds)
      ctx.notifyMediaUpdated()
      return {
        success: true,
        message: t('main.media.message.softDeleted', { count: mediaIds.length })
      }
    })
  )

  // F-S6 回收站：恢复
  ipcMain.handle(
    'media:restore',
    wrapHandler(ctx, z.tuple([schemas.mediaIdArrayBulk]), async ([mediaIds]) => {
      await getRepo().restoreBatch(mediaIds)
      ctx.notifyMediaUpdated()
      return { message: t('main.media.message.restored', { count: mediaIds.length }) }
    })
  )

  // F-S6 回收站：彻底删除（高危操作二次确认 + 三阶段事务）
  ipcMain.handle(
    'media:permanentDelete',
    wrapHandler(ctx, z.tuple([schemas.mediaIdArrayBulk]), async ([mediaIds]) => {
      // A-S3：高危操作二次确认（彻底删除不可恢复）
      const confirmResult = await dialog.showMessageBox({
        type: 'warning',
        buttons: [t('main.media.dialog.cancel'), t('main.media.dialog.confirmDelete')],
        defaultId: 0,
        cancelId: 0,
        title: t('main.media.dialog.permanentDeleteTitle'),
        message: t('main.media.dialog.permanentDeleteMessage', { count: mediaIds.length }),
        detail: t('main.media.dialog.permanentDeleteDetail')
      })
      if (confirmResult.response !== 1) {
        throw AppError.canceled(t('main.media.error.userCanceled'))
      }

      const repo = getRepo()
      // 查询文件路径
      const rows = repo.getMediaPathsByIds(mediaIds)

      // F-S1 三阶段：①事务软删除标记 ②异步 trashItem ③事务物理删除已处理记录
      // 保证 DB 与文件系统一致：中断后 DB 仍有 is_deleted=1 记录，用户可重试

      // 阶段1：幂等软删除标记
      await repo.softDeleteForPermanentDelete(rows.map((r) => r.id))

      // 阶段2：逐个移至系统回收站，区分「成功」「文件已不存在」「失败」
      const { idsToDelete, failedPaths } = await trashBatch(rows)

      // 阶段3：事务中物理删除已成功处理的记录
      await repo.hardDeleteBatch(idsToDelete)

      ctx.notifyMediaUpdated()
      const msg =
        failedPaths.length > 0
          ? t('main.media.message.permanentDeletePartial', {
              deleted: idsToDelete.length,
              failed: failedPaths.length
            })
          : t('main.media.message.permanentDeleted', { count: idsToDelete.length })
      return { message: msg, deletedCount: idsToDelete.length, failedCount: failedPaths.length }
    })
  )

  // F-S6 回收站：清空回收站
  ipcMain.handle(
    'media:emptyRecycleBin',
    wrapHandlerNoArgs(ctx, async () => {
      const repo = getRepo()
      const rows = repo.getSoftDeletedMediaPaths()

      if (rows.length === 0) {
        return { message: t('main.media.message.recycleBinEmpty'), movedCount: 0 }
      }

      // A-S3：高危操作二次确认（清空回收站不可恢复）
      const confirmResult = await dialog.showMessageBox({
        type: 'warning',
        buttons: [t('main.media.dialog.cancel'), t('main.media.dialog.confirmEmpty')],
        defaultId: 0,
        cancelId: 0,
        title: t('main.media.dialog.emptyRecycleBinTitle'),
        message: t('main.media.dialog.emptyRecycleBinMessage', { count: rows.length }),
        detail: t('main.media.dialog.permanentDeleteDetail')
      })
      if (confirmResult.response !== 1) {
        throw AppError.canceled(t('main.media.error.userCanceled'))
      }

      // B1 修复：trashItem 失败且文件仍存在时，不删除 DB 记录，保留供用户重试。
      // 仅当 trashItem 成功 或 文件已不存在（DB 踪迹已无对应实体）时才删除 DB。
      const { idsToDelete, movedCount, missingCount, failedPaths } = await trashBatch(rows)
      await repo.hardDeleteBatch(idsToDelete)
      ctx.notifyMediaUpdated()
      const msg =
        failedPaths.length > 0
          ? t('main.media.message.permanentDeletePartial', {
              deleted: idsToDelete.length,
              failed: failedPaths.length
            })
          : t('main.media.message.recycleBinEmptied', { count: movedCount + missingCount })
      return {
        message: msg,
        movedCount,
        missingCount,
        failedCount: failedPaths.length
      }
    })
  )

  // T02：清理丢失记录
  ipcMain.handle(
    'media:cleanupMissing',
    wrapHandlerNoArgs(ctx, async () => {
      const cleared = await getRepo().cleanupMissingRecords()
      ctx.notifyMediaUpdated()
      return { message: t('main.media.message.cleanedMissing', { count: cleared }), cleared }
    })
  )

  // T02：从库中移除单条 missing 记录
  ipcMain.handle(
    'media:removeMissing',
    wrapHandler(ctx, z.tuple([schemas.mediaId]), async ([mediaId]) => {
      const deleted = await getRepo().removeMissingRecord(mediaId)
      if (!deleted) {
        throw AppError.notFound(t('main.media.error.missingNotFound'))
      }
      ctx.notifyMediaUpdated()
      return { message: t('main.media.message.missingRemoved') }
    })
  )

  // 损坏文件容错：清理所有 is_corrupted=1 的记录（用户确认后批量删除）
  // 与 cleanupMissing 对称：missing 是文件被外部删除，corrupted 是文件存在但内容损坏
  ipcMain.handle(
    'media:cleanupCorrupted',
    wrapHandlerNoArgs(ctx, async () => {
      const cleared = await getRepo().cleanupCorruptedRecords()
      ctx.notifyMediaUpdated()
      return { message: t('main.media.message.cleanedCorrupted', { count: cleared }), cleared }
    })
  )

  // 损坏文件容错：从库中移除单条 corrupted 记录
  ipcMain.handle(
    'media:removeCorrupted',
    wrapHandler(ctx, z.tuple([schemas.mediaId]), async ([mediaId]) => {
      const deleted = await getRepo().removeCorruptedRecord(mediaId)
      if (!deleted) {
        throw AppError.notFound(t('main.media.error.corruptedNotFound'))
      }
      ctx.notifyMediaUpdated()
      return { message: t('main.media.message.corruptedRemoved') }
    })
  )
}
