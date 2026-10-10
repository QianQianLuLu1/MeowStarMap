/**
 * 卡池心愿单规范化（逻辑复用自 gongeo.us-nikki-tracker 的
 * shared/utils/bannerWishlist.ts，MIT, dastrokes）。
 *
 * 与源实现差异：结构非法改抛宿主 ValidationError（源实现抛裸 Error）；卡池存在性
 * 依据本地静态快照 BANNER_DATA 判定，保持共鸣录的离线特性（不访问源站）。
 */
import { ValidationError } from '../../../shared/errors/app-error'
import type {
  ResonanceBannerWish,
  ResonanceBannerWishlistData
} from '../../../shared/types/resonance'
import { BANNER_DATA } from './staticData'

export function createEmptyBannerWishlist(): ResonanceBannerWishlistData {
  return { version: 1, entries: [] }
}

/**
 * 校验并归一化心愿单。
 *
 * 结构非法（非对象 / version ≠ 1 / entries 非数组）→ 抛 ValidationError；
 * 条目级非法（非整数 id、快照中不存在的卡池）逐条静默丢弃，以容忍跨版本文件导入。
 * 同一 bannerId 只保留首次出现，顺序与输入一致。
 */
export function normalizeBannerWishlist(value: unknown): ResonanceBannerWishlistData {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('entries' in value) ||
    !Array.isArray(value.entries)
  ) {
    throw new ValidationError('Invalid banner wish list')
  }

  const entries = new Map<number, ResonanceBannerWish>()
  for (const entry of value.entries as unknown[]) {
    if (!entry || typeof entry !== 'object') continue
    const { bannerId } = entry as { bannerId?: unknown }
    if (typeof bannerId !== 'number' || !Number.isInteger(bannerId)) continue
    if (!BANNER_DATA[String(bannerId)]) continue
    if (entries.has(bannerId)) continue
    entries.set(bannerId, { bannerId })
  }

  return { version: 1, entries: [...entries.values()] }
}
