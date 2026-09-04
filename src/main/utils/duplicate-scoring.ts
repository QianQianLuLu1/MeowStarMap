/**
 * P1-01：智能去重评分模块
 *
 * 评分维度（满分 100）：
 * - 分辨率（40 分）：宽×高归一化，分辨率越高画质越好
 * - 文件大小（30 分）：同分辨率下文件越大压缩损失越少
 * - 拍摄时间（20 分）：越新越好（用户更可能保留近期作品）
 * - 收藏加权（10 分）：is_favorite 或 rating > 0 加分
 *
 * 评分仅用于推荐保留版本，不改变文件本身。
 *
 * R19：width/height 为 NULL 的项（旧库未回填或元数据缺失）评分强制为 0，
 * 且不会被 pickBestId 选为推荐保留项——避免基于缺失元数据推荐删除其他文件。
 */
import { logger } from './logger'

export interface ScoreInput {
  id: number
  file_size: number
  width: number | null
  height: number | null
  modified_at: string
  is_favorite: boolean
  rating: number
}

export interface ScoredItem<T extends ScoreInput = ScoreInput> {
  item: T
  score: number
  // 各维度归一化值（0-1），便于调试与展示
  dimensions: {
    resolution: number
    fileSize: number
    recency: number
    favorite: number
  }
}

/** R19：判断项是否因 width/height 为 NULL 而无法可靠评分 */
function hasNullDimensions(item: ScoreInput): boolean {
  return item.width === null || item.height === null
}

/**
 * 对一组重复文件评分，返回每项的评分结果（按分数降序）
 *
 * R19：width/height 为 NULL 的项 score 强制为 0，但仍参与归一化分母计算
 * （不影响其他项的评分基线），并记录 warn 日志提示元数据缺失。
 */
export function scoreGroup<T extends ScoreInput>(group: T[]): ScoredItem<T>[] {
  if (group.length === 0) return []

  // R19：检测 group 内是否有 NULL width/height 项，记录一次 warn 日志（避免日志洪水）
  const nullDimItems = group.filter(hasNullDimensions)
  if (nullDimItems.length > 0) {
    logger.warn(
      `[duplicate-scoring] 检测到 ${nullDimItems.length} 项 width/height 为 NULL，评分置 0 且不参与推荐删除`,
      { ids: nullDimItems.map((it) => it.id) }
    )
  }

  // 收集该组内各维度的最大值，用于归一化
  let maxResolution = 0
  let maxFileSize = 0
  let maxTimestamp = 0
  let minTimestamp = Number.POSITIVE_INFINITY
  for (const it of group) {
    const pixels = (it.width ?? 0) * (it.height ?? 0)
    if (pixels > maxResolution) maxResolution = pixels
    if (it.file_size > maxFileSize) maxFileSize = it.file_size
    const ts = new Date(it.modified_at).getTime()
    if (Number.isFinite(ts)) {
      if (ts > maxTimestamp) maxTimestamp = ts
      if (ts < minTimestamp) minTimestamp = ts
    }
  }
  const timestampRange = Math.max(1, maxTimestamp - minTimestamp)

  return group
    .map((item) => {
      const pixels = (item.width ?? 0) * (item.height ?? 0)
      const resolutionNorm = maxResolution > 0 ? pixels / maxResolution : 0
      const fileSizeNorm = maxFileSize > 0 ? item.file_size / maxFileSize : 0
      const ts = new Date(item.modified_at).getTime()
      const recencyNorm =
        Number.isFinite(ts) && timestampRange > 0 ? (ts - minTimestamp) / timestampRange : 1
      const favoriteNorm = item.is_favorite || item.rating > 0 ? 1 : 0

      // R19：NULL width/height 的项 score 强制为 0，不参与推荐删除
      // dimensions 仍保留实际归一化值供调试/展示，但 score 为 0 确保不会胜出
      const score = hasNullDimensions(item)
        ? 0
        : resolutionNorm * 40 + fileSizeNorm * 30 + recencyNorm * 20 + favoriteNorm * 10

      return {
        item,
        score: Math.round(score * 10) / 10,
        dimensions: {
          resolution: resolutionNorm,
          fileSize: fileSizeNorm,
          recency: recencyNorm,
          favorite: favoriteNorm
        }
      }
    })
    .sort((a, b) => b.score - a.score)
}

/**
 * 返回一组重复文件中评分最高的项 id（推荐保留）
 *
 * R19：若最高分项的 width/height 为 NULL（即所有项均 NULL 或仅有 NULL 项胜出），
 * 返回 null——不推荐删除任何项，让用户手动判断。
 */
export function pickBestId<T extends ScoreInput>(group: T[]): number | null {
  if (group.length === 0) return null
  const scored = scoreGroup(group)
  const best = scored[0]
  if (!best) return null
  // R19：最高分项元数据缺失时不推荐删除（返回 null）
  if (hasNullDimensions(best.item)) return null
  return best.item.id
}
