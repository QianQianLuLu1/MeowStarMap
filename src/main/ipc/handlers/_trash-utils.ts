/**
 * 媒体生命周期域共享工具：文件物理删除批量操作 + 缩略图缓存清理
 *
 * 供 `media-lifecycle-handler.ts` 的 permanentDelete / emptyRecycleBin 共用
 * 同一套三态判定（成功 / 文件不存在 / 失败）、重试退避、熔断与聚合日志逻辑。
 *
 * #fix-recyclebin-permanent-delete：原实现用 `shell.trashItem` 处理「彻底删除」，
 * 语义是移入 Windows 系统回收站而非物理删除——文件被转移到 $Recycle.Bin 仍占磁盘，
 * 且 Shell API 大批量调用存在实测瞬时失败（2474 项 94.5% 失败）。现改为 `fsp.unlink`
 * 直接物理删除（与 fileService.deletePermanent / cleanupThumbnailsForRows 同一删除原语），
 * 重试 / 熔断 / 聚合日志机制原样保留（对 EBUSY/EPERM 等占用类瞬时错误同样有效）。
 */
import fsp from 'fs/promises'
import path from 'path'
import { pathExists } from '../../utils/file-utils'
import { logger } from '../../utils/logger'
import { t } from '../../i18n'

/**
 * 物理删除三态结果。
 * - ok：删除成功，DB 可安全删除
 * - missing：文件已不存在，DB 可安全删除
 * - failed：删除失败且文件仍存在，DB 必须保留供用户重试
 */
export type UnlinkResult = 'ok' | 'missing' | 'failed'

/** 单个文件删除失败后的重试次数（不含首次尝试） */
const UNLINK_RETRY_MAX = 2
/** 重试退避基数，实际延迟为 BASE * 2^n（50ms → 100ms） */
const UNLINK_RETRY_BASE_DELAY_MS = 50
/**
 * 连续失败达到该阈值后判定为系统性故障（磁盘故障 / 目录被整体锁定等），
 * 后续项不再重试以避免整体耗时失控：实测 2474 项全失败场景下，
 * 逐项重试会把 18.5s 拖成分钟级卡顿。熔断后退化为原「单次尝试」行为。
 */
const UNLINK_CIRCUIT_BREAK_THRESHOLD = 10
/** 聚合日志中最多记录的样例路径数 */
const UNLINK_LOG_SAMPLE_LIMIT = 3

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 物理删除单个文件并区分三态：成功 / 文件不存在 / 失败（文件仍存在）。
 *
 * 抽取此函数是为了让 `emptyRecycleBin` 与 `permanentDelete` 共用同一三态判定逻辑，
 * 避免 B1 类 Bug（删除失败时仍删 DB 记录导致用户数据丢失踪迹）。
 *
 * FIX(A-retry): 保留失败重试。文件被占用（EBUSY/EPERM 等）属瞬时失败，对重试敏感；
 * 历史上 shell.trashItem 大批量场景实测 2474 项 94.5% 瞬时失败，重试机制显著降低失败率。
 * 每次重试前先 pathExists 复检：文件已消失则立即判 missing，不做无谓重试。
 *
 * @param filePath 目标文件绝对路径
 * @param maxRetries 重试次数上限，负值归一化为 0（熔断时传 0 以快速失败）
 * @returns 三态结果与首个错误（错误由调用方聚合记录，避免逐条 warn 刷爆日志）
 */
export async function unlinkWithFallback(
  filePath: string,
  maxRetries: number = UNLINK_RETRY_MAX
): Promise<{ result: UnlinkResult; error?: unknown }> {
  const totalAttempts = Math.max(0, maxRetries) + 1
  let firstError: unknown
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    try {
      await fsp.unlink(filePath)
      return { result: 'ok' }
    } catch (err) {
      if (firstError === undefined) firstError = err
      // 区分「文件已不存在」与「权限/锁定等真实失败」：仅文件不存在时可安全删 DB
      if (!(await pathExists(filePath))) {
        return { result: 'missing' }
      }
      if (attempt < totalAttempts - 1) {
        await delay(UNLINK_RETRY_BASE_DELAY_MS * 2 ** attempt)
      }
    }
  }
  return { result: 'failed', error: firstError }
}

/** 批量物理删除的聚合结果 */
export interface UnlinkBatchOutcome {
  /** 可安全物理删除的 DB 记录 id（文件删除成功 或 文件已不存在） */
  idsToDelete: number[]
  /** 成功物理删除的文件数量 */
  movedCount: number
  /** 文件已不存在的数量 */
  missingCount: number
  /** 删除失败且文件仍存在的路径（DB 记录保留供用户重试） */
  failedPaths: string[]
}

/**
 * 批量物理删除文件，聚合三态统计并在结束后统一记录一条失败日志。
 *
 * FIX(A-log): 原实现在循环内逐项 logger.warn，实测 2474 项失败写出 2474 行日志，
 * 刷爆日志文件且淹没其他诊断信息。改为循环结束后聚合一条（总数 + 样例路径 + 首个错误）。
 * FIX(A-breaker): 连续失败达阈值即停止重试，防止退避延迟在大批量失败时累积成分钟级卡顿。
 *
 * 日志 key 沿用历史 `main.media.log.recycleBinMoveFailed`（12 语言包共享 key 结构，
 * 仅更新 zh-CN 文案为「物理删除失败」语义，避免波及全部语言包的 key 重命名）。
 *
 * @param rows 待处理的 DB 记录（id + 文件绝对路径）
 * @returns 三态聚合统计；`failedPaths` 对应的记录不得物理删除 DB
 */
export async function unlinkBatch(
  rows: readonly { id: number; file_path: string }[]
): Promise<UnlinkBatchOutcome> {
  const outcome: UnlinkBatchOutcome = {
    idsToDelete: [],
    movedCount: 0,
    missingCount: 0,
    failedPaths: []
  }
  let firstError: unknown
  let consecutiveFailures = 0

  for (const row of rows) {
    // 熔断：连续失败过多说明是系统性故障，重试已无意义，直接快速失败
    const retries = consecutiveFailures >= UNLINK_CIRCUIT_BREAK_THRESHOLD ? 0 : UNLINK_RETRY_MAX
    const { result, error } = await unlinkWithFallback(row.file_path, retries)

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
    const shown = outcome.failedPaths.slice(0, UNLINK_LOG_SAMPLE_LIMIT)
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

/**
 * 清理 DB 记录关联的缩略图缓存（best-effort，#fix-permanent-delete-error-toast）。
 *
 * 背景：物理删除 DB 记录（media:delete / media:permanentDelete / media:emptyRecycleBin）后，
 * media_files.thumbnail 指向的缩略图文件残留为孤儿，只能靠 LRU 淘汰或手动清空。
 *
 * 安全边界：
 * - 仅删除 cacheDir 前缀内的文件——thumbnail 可能指向游戏自管的原生低清缩略图
 *   （NikkiPhotos_LowQuality，见 scanner/path-classifier.ts resolveNativeThumbnailPath）
 *   或其他外部路径，这些文件不属于应用缓存，绝不触碰；
 * - best-effort：pathExists 预检 + 逐文件 try/catch，失败仅聚合日志，
 *   不阻断删除主流程，不影响 IPC 返回值。
 *
 * @param rows 待清理的 DB 行（含可选 thumbnail 路径）
 * @param cacheDir 应用缩略图缓存目录（ctx.thumbnailGen.getCacheDir()）
 * @returns 实际删除的文件数
 */
export async function cleanupThumbnailsForRows(
  rows: readonly { thumbnail?: string | null }[],
  cacheDir: string
): Promise<number> {
  if (!cacheDir) return 0
  let resolvedCacheDir: string
  try {
    resolvedCacheDir = path.resolve(cacheDir).toLowerCase()
  } catch {
    return 0
  }
  const targets: string[] = []
  for (const row of rows) {
    const thumb = row.thumbnail
    if (!thumb) continue
    try {
      // 前缀判定（大小写不敏感，兼容 Windows 盘符）：位于缓存目录内才允许删除
      const resolved = path.resolve(thumb).toLowerCase()
      if (resolved === resolvedCacheDir || resolved.startsWith(resolvedCacheDir + path.sep)) {
        targets.push(thumb)
      }
    } catch {
      // 非法路径跳过
    }
  }
  if (targets.length === 0) return 0

  let deleted = 0
  let firstError: unknown
  for (const target of targets) {
    try {
      if (!(await pathExists(target))) continue
      await fsp.unlink(target)
      deleted++
    } catch (err) {
      if (firstError === undefined) firstError = err
    }
  }
  if (firstError !== undefined) {
    logger.warn(
      `[media-cleanup] 缩略图清理部分失败（目标 ${targets.length} 个，已删 ${deleted} 个）`,
      firstError
    )
  }
  return deleted
}
