// @core-change: 完全删除图片时补齐 X6Game\ScreenShot 同名副本的同步清理，消除三目录残留与重扫复活
/**
 * 媒体生命周期域共享工具：文件物理删除批量操作 + 缩略图清理（缓存 + 游戏原生同图衍生文件）
 *
 * 供 `media-lifecycle-handler.ts` 的 permanentDelete / emptyRecycleBin / delete 共用
 * 同一套三态判定（成功 / 文件不存在 / 失败）、重试退避、熔断与聚合日志逻辑。
 *
 * #fix-recyclebin-permanent-delete：原实现用 `shell.trashItem` 处理「彻底删除」,
 * 语义是移入 Windows 系统回收站而非物理删除——文件被转移到 $Recycle.Bin 仍占磁盘,
 * 且 Shell API 大批量调用存在实测瞬时失败（2474 项 94.5% 失败）。现改为 `fsp.unlink`
 * 直接物理删除（与 fileService.deletePermanent / cleanupThumbnailsForRows 同一删除原语）,
 * 重试 / 熔断 / 聚合日志机制原样保留（对 EBUSY/EPERM 等占用类瞬时错误同样有效）。
 *
 * #fix-gallery-delete-thumbnail-cleanup：缩略图清理范围从「仅缓存目录内 thumbnail 列指向
 * 的单一文件」扩展为两类：
 * 1. 缓存缩略图：thumbnail 位于 cacheDir 内 → 引用文件 + ${hash}.jpg/_low/_high 三档位；
 * 2. 游戏原生 LQ：由 file_path 经 resolveNativeThumbnailPath 严格推导（非信任 thumbnail 列），
 *    并联动硬删该 LQ 的 DB 记录（LQ 文件本身也是入库媒体记录，scene_category='thumbnail'）。
 *
 * #fix-permanent-delete-game-photo-variants：第 2 类由「LQ 单一目标」扩展为**同图衍生文件
 * 全集**——游戏会把同一张照片以完全相同的文件名写入多个目录：NikkiPhotos_HighQuality（原图）、
 * NikkiPhotos_LowQuality（原生低清）、X6Game\ScreenShot（截图副本，扁平无 UID 子目录），
 * 另有兼容变体 X6Game\Saved\ScreenShot。此前只推导 HQ→LQ 一条，X6Game\ScreenShot 完全未
 * 覆盖 ⇒ 完全删除后该副本及其 local_screenshot 数据库记录必然残留、重扫即复活。
 * 现统一经 resolveGamePhotoVariantPaths（scanner/path-classifier.ts 纯函数）推导，
 * 三个副本与其 DB 记录、缓存缩略图一并清理。
 */
import fsp from 'fs/promises'
import path from 'path'
import { pathExists } from '../../utils/file-utils'
import { logger } from '../../utils/logger'
import { t } from '../../i18n'
import { resolveGamePhotoVariantPaths } from '../../scanner/path-classifier'

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
 * 清理 DB 记录关联的缩略图（best-effort，#fix-permanent-delete-error-toast /
 * #fix-gallery-delete-thumbnail-cleanup）。
 *
 * 背景：物理删除 DB 记录（media:delete / media:permanentDelete / media:emptyRecycleBin）后，
 * 其关联缩略图残留为孤儿：缓存文件仅能靠 LRU 淘汰（_low/_high 档位从不被引用），
 * 游戏原生 LQ 无任何回收机制（无界增长）。
 *
 * 清理范围（两类）：
 * 1. 缓存缩略图：DB thumbnail 列位于 cacheDir 前缀内 → 删除引用文件，
 *    并按生成器命名规范（generator.ts）推导清理 `${hash}.jpg` / `${hash}_low.jpg` /
 *    `${hash}_high.jpg` 三档位（hash 为 sha256 十六进制切片，不含下划线，后缀剥离无歧义）；
 * 2. 游戏原生同图衍生文件（#fix-permanent-delete-game-photo-variants）：由源文件路径 file_path
 *    经 `resolveGamePhotoVariantPaths` 严格推导（scanner/path-classifier.ts 纯函数，须命中
 *    \X6Game\Saved\GamePlayPhotos\ + \NikkiPhotos_HighQuality\ + 单层纯数字 UID 段）——
 *    thumbnail 列不作依据，绝不据此触碰缓存外文件。推导结果只可能是「与被删照片同名、位于
 *    兄弟 NikkiPhotos_LowQuality 目录 / X6Game\ScreenShot / X6Game\Saved\ScreenShot」的
 *    那几个文件（都只是候选，三目录并不总是齐备，缺项按 missing 跳过）。
 *
 * 安全边界：
 * - 缓存目标：cacheDir 前缀（大小写不敏感 + path.sep 边界）不变；
 * - 原生目标：与同批次任一 row 的 file_path 相同则跳过（该路径由其自身记录的删除流程处理）；
 *   落在 cacheDir 内的推导结果属异常数据，同样跳过（双保险）；
 * - best-effort：pathExists 预检 + 逐文件 try/catch，失败仅聚合日志，
 *   不阻断删除主流程，不影响 IPC 返回值。
 *
 * @param rows 待清理的 DB 行（含可选 file_path / thumbnail 路径）
 * @param cacheDir 应用缩略图缓存目录（ctx.thumbnailGen.getCacheDir()）
 * @param hooks 可选钩子：同图衍生文件被删除或本已不存在时回调
 *   （`makeNativeThumbRecordCleaner` 用于同步硬删其 DB 记录，避免悬空记录）
 * @returns 实际删除的文件数
 */
export async function cleanupThumbnailsForRows(
  rows: readonly { file_path?: string; thumbnail?: string | null }[],
  cacheDir: string,
  hooks?: ThumbnailCleanupHooks
): Promise<number> {
  const targets = collectThumbnailCleanupTargets(rows, cacheDir)
  if (targets.length === 0) return 0

  let deleted = 0
  let firstError: unknown
  const nativeRemoved: string[] = []
  // 失败路径聚合（#fix-permanent-delete-game-photo-variants）：沿用 unlinkBatch 的
  // 「循环后聚合一条」约定，绝不逐项 warn（历史教训：2474 项失败刷爆日志）
  const failedPaths: string[] = []
  for (const target of targets) {
    try {
      if (!(await pathExists(target.path))) {
        // 文件本已不存在；同图衍生文件缺失意味着其 DB 记录（若有）此刻已悬空
        if (target.kind === 'native') nativeRemoved.push(target.path)
        continue
      }
      await fsp.unlink(target.path)
      deleted++
      if (target.kind === 'native') nativeRemoved.push(target.path)
    } catch (err) {
      // unlink 失败但文件实际已消失（并发竞态）：视为 missing 而非失败
      let gone = false
      try {
        gone = !(await pathExists(target.path))
      } catch {
        gone = false
      }
      if (gone) {
        if (target.kind === 'native') nativeRemoved.push(target.path)
        continue
      }
      failedPaths.push(target.path)
      if (firstError === undefined) firstError = err
    }
  }

  if (hooks?.onNativeThumbnailRemoved && nativeRemoved.length > 0) {
    for (const variantPath of nativeRemoved) {
      try {
        await hooks.onNativeThumbnailRemoved(variantPath)
      } catch (err) {
        if (firstError === undefined) firstError = err
      }
    }
  }

  if (firstError !== undefined) {
    const shown = failedPaths.slice(0, UNLINK_LOG_SAMPLE_LIMIT)
    const omitted = failedPaths.length - shown.length
    logger.warn(
      `[media-cleanup] 缩略图清理部分失败（目标 ${targets.length} 个，已删 ${deleted} 个，原生记录联动 ${nativeRemoved.length} 个，失败 ${failedPaths.length} 个${failedPaths.length > 0 ? `：${shown.join(' | ')}${omitted > 0 ? ` …等 ${failedPaths.length} 个` : ''}` : ''}）`,
      firstError
    )
  }
  return deleted
}

/** 单个缩略图清理目标 */
export interface ThumbnailCleanupTarget {
  path: string
  /**
   * cache：应用缩略图缓存目录内文件；
   * native：由源文件路径严格推导的游戏原生同图衍生文件（NikkiPhotos_LowQuality 同名副本 /
   * X6Game\ScreenShot 同名副本 / X6Game\Saved\ScreenShot 同名副本）
   */
  kind: 'cache' | 'native'
}

/** cleanupThumbnailsForRows 的可选钩子 */
export interface ThumbnailCleanupHooks {
  /**
   * 同图衍生文件已物理删除或本已不存在（missing）时回调，用于同步硬删其 DB 记录；
   * 删除失败时不调用（记录保留供用户重试）。
   *
   * @param variantPath 已删除或本已不存在的衍生文件路径
   */
  onNativeThumbnailRemoved?: (variantPath: string) => Promise<void>
}

/** 缓存缩略图文件名模式：${hash}.jpg 及其 _low/_high 档位（hash 为 sha256 十六进制切片，不含下划线） */
const CACHE_THUMB_NAME_RE = /^(.+?)(?:_low|_high)?\.jpg$/i

/**
 * 由 DB thumbnail 列推导应清理的缓存文件路径集合（三档位）。
 *
 * 安全边界不变：thumbnail 必须落在 cacheDir 前缀内（大小写不敏感 + path.sep 边界），
 * 否则返回空数组——绝不据此触碰缓存目录外的文件。
 * 命名非 ${hash}.jpg 时仅返回引用文件本身（维持既有行为）。
 *
 * @param thumbnail DB thumbnail 列值（可为缓存内任意档位路径）
 * @param cacheDir 应用缩略图缓存目录
 * @returns 应清理的缓存文件路径数组；入参非法 / 目录外 / cacheDir 为空时返回空数组
 */
export function collectCacheTierPaths(thumbnail: string, cacheDir: string): string[] {
  if (!thumbnail || !cacheDir) return []
  try {
    const resolved = path.resolve(thumbnail)
    const resolvedCacheDir = path.resolve(cacheDir).toLowerCase()
    const lower = resolved.toLowerCase()
    const isInside = lower === resolvedCacheDir || lower.startsWith(resolvedCacheDir + path.sep)
    if (!isInside) return []
    const dir = path.dirname(resolved)
    const m = path.basename(resolved).match(CACHE_THUMB_NAME_RE)
    const names = m
      ? [`${m[1]}.jpg`, `${m[1]}_low.jpg`, `${m[1]}_high.jpg`]
      : [path.basename(resolved)]
    return names.map((name) => path.join(dir, name))
  } catch {
    // 非法路径跳过
    return []
  }
}

/**
 * 收集删除 DB 记录时应清理的缩略图目标（纯收集，不执行删除，供单元测试与清理执行共用）。
 *
 * - 缓存目标：thumbnail 位于 cacheDir 前缀内 → 引用文件 + 三档位（规范化去重）；
 *   非 ${hash}.jpg 命名仅删除引用文件本身（维持既有行为）；
 * - 原生目标：resolveGamePhotoVariantPaths(row.file_path) 严格推导（同图衍生文件全集），
 *   与批内任一 file_path 相同者排除（由其自身行的删除流程处理）、落在 cacheDir 内者
 *   排除（双保险）、去重。
 */
export function collectThumbnailCleanupTargets(
  rows: readonly { file_path?: string; thumbnail?: string | null }[],
  cacheDir: string
): ThumbnailCleanupTarget[] {
  if (!cacheDir) return []
  let resolvedCacheDir: string
  try {
    resolvedCacheDir = path.resolve(cacheDir).toLowerCase()
  } catch {
    return []
  }
  const isInsideCacheDir = (resolvedLower: string): boolean =>
    resolvedLower === resolvedCacheDir || resolvedLower.startsWith(resolvedCacheDir + path.sep)

  // 批内全部源文件路径（小写化）：原生目标若与之一致则排除，避免与该记录自身删除流程重复处理
  const batchPaths = new Set<string>()
  for (const row of rows) {
    if (!row.file_path) continue
    try {
      batchPaths.add(path.resolve(row.file_path).toLowerCase())
    } catch {
      // 非法路径跳过
    }
  }

  const targets: ThumbnailCleanupTarget[] = []
  const seen = new Set<string>()
  const pushTarget = (target: ThumbnailCleanupTarget): void => {
    try {
      const key = path.resolve(target.path).toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      targets.push(target)
    } catch {
      // 非法路径跳过
    }
  }

  for (const row of rows) {
    // ① 缓存目标：thumbnail 列仅在 cacheDir 前缀内才可作为删除依据（安全边界不变）
    if (row.thumbnail) {
      for (const cachePath of collectCacheTierPaths(row.thumbnail, cacheDir)) {
        pushTarget({ path: cachePath, kind: 'cache' })
      }
    }

    // ② 原生目标：同图衍生文件全集，由源文件路径严格推导（与扫描入库 / 存量修复 v6 /
    //    缩略图豁免同一口径），不信任 thumbnail 列——非官方相册 HQ 路径返回空数组，
    //    不做任何清理。推导结果只是候选，由执行阶段 pathExists 预检后决定是否删除。
    for (const variant of resolveGamePhotoVariantPaths(row.file_path ?? '')) {
      try {
        const resolvedVariant = path.resolve(variant).toLowerCase()
        if (batchPaths.has(resolvedVariant)) continue
        // 双保险：推导结果落在缓存目录内属异常数据，不删
        if (isInsideCacheDir(resolvedVariant)) continue
        pushTarget({ path: variant, kind: 'native' })
      } catch {
        // 非法路径跳过
      }
    }
  }
  return targets
}

/** makeNativeThumbRecordCleaner 依赖的 repo 最小子集（结构化，便于测试注入） */
export interface ThumbnailRecordCleanerRepo {
  getMediaIdByPath(filePath: string): number | undefined
  /**
   * 可选：查询该路径记录的 thumbnail 列，用于连带清理其缓存缩略图。
   * 声明为可选是为了兼容既有精简测试桩（缺失时只硬删记录，不清缓存）。
   */
  getThumbnailByPath?(filePath: string): string | null
  hardDelete(mediaId: number): Promise<void>
}

/**
 * 生成「按路径硬删同图衍生文件 DB 记录」的清理钩子（供三个删除通道接线）。
 *
 * 背景：游戏原生 LQ 文件（NikkiPhotos_LowQuality）本身也会被扫描器作为独立媒体记录
 * 入库（scene_category='thumbnail'，见 shared/scene-category.ts；扫描器对 GPP 子树
 * 全量遍历且豁免小图过滤）；X6Game\ScreenShot 同名副本同样独立入库
 * （media_source='local_screenshot'）。删除 HQ 记录时若只删衍生文件而不删其记录，
 * 会残留指向已删除文件的悬空记录。
 *
 * #fix-permanent-delete-game-photo-variants：衍生文件的缓存缩略图（副本自身记录生成，
 * 落在 cacheDir 内）一并按三档位清理，避免留下孤儿缓存。
 *
 * @param repo 结构化子集（便于测试注入），实际传 MediaRepository 实例
 * @param cacheDir 应用缩略图缓存目录（ctx.thumbnailGen.getCacheDir()），用于连带清理
 *   衍生文件自身记录的缓存缩略图；不传则只硬删记录
 * @returns 钩子：入参为已删除或本已不存在的衍生文件路径
 */
export function makeNativeThumbRecordCleaner(
  repo: ThumbnailRecordCleanerRepo,
  cacheDir?: string
): (variantPath: string) => Promise<void> {
  return async (variantPath: string) => {
    const id = repo.getMediaIdByPath(variantPath)
    if (id === undefined) return
    // 该衍生文件自身也是入库记录，其缓存缩略图需一并清理（best-effort）
    if (cacheDir) {
      const thumbnail = repo.getThumbnailByPath?.(variantPath)
      if (thumbnail) {
        for (const cachePath of collectCacheTierPaths(thumbnail, cacheDir)) {
          try {
            if (await pathExists(cachePath)) await fsp.unlink(cachePath)
          } catch {
            // best-effort：缓存清理失败不影响记录硬删，也不阻断删除主流程
          }
        }
      }
    }
    await repo.hardDelete(id)
  }
}
