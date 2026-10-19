import { useCallback, useEffect, useState } from 'react'

/** 带 id 的列表项——失败状态以 id 记账，因此只要求这一字段 */
interface Identifiable {
  id: string
}

/**
 * P1-U10：媒体缩略图加载失败状态管理
 *
 * 4 个视图（VirtualImageGrid / ListView / TimelineView / EventTimelineView）原各自实现：
 * - `useState<Set<string>>` 管理失败的文件 id
 * - items/files 变化时清空（C-O7 优化，避免 Set 无限增长）
 * - `onError` 回调中 `new Set(prev).add(id)`
 *
 * 抽取后各减约 8-12 行，并顺带修复 TimelineView / EventTimelineView 遗漏的清空逻辑。
 *
 * N4（2026-10-18 网格视图滚动闪烁修复）：「变化即整表清空」改为「只裁剪已消失的 id」。
 * 图库向下滚动触底会走 `endReached → loadNextMediaPage → addMediaFiles`
 * （mediaStore.ts:202-205 用 `[...state.mediaFiles, ...files]` 产生新数组），原实现据此
 * 把整屏失败记录一次性抹掉 ⇒ 已终态的坏图卡退回骨架并重新发起加载/重试，
 * 表现为「向下滑动显示图片时逐格闪」。C-O7 的有界增长意图保留：条目真的从列表消失即清理。
 * 另：无裁剪发生时返回原引用，避免「setState(新 Set) → 再渲染」的多余一轮（调用方若每次渲染
 * 都新建数组，原实现会形成无限渲染环路）。
 *
 * @param items 当前列表（引用稳定即可；只需元素带 id）
 * @returns `{ failedImages, markFailed, clearFailed }`
 */
export function useFailedImages<T extends Identifiable>(
  items: readonly T[]
): {
  failedImages: Set<string>
  markFailed: (id: string) => void
  clearFailed: (id: string) => void
} {
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set())

  useEffect(() => {
    // 脏数据防御：非数组不裁剪也不抹掉现集（抹掉会立刻引发整屏重闪）
    if (!Array.isArray(items)) return
    const alive = new Set<string>()
    for (const item of items) {
      if (item && typeof item.id === 'string') alive.add(item.id)
    }
    setFailedImages((prev) => {
      if (prev.size === 0) return prev
      let dropped = 0
      for (const id of prev) {
        if (!alive.has(id)) dropped++
      }
      if (dropped === 0) return prev
      const next = new Set<string>()
      for (const id of prev) {
        if (alive.has(id)) next.add(id)
      }
      return next
    })
  }, [items])

  const markFailed = useCallback((id: string) => {
    setFailedImages((prev) => new Set(prev).add(id))
  }, [])

  // THUMBNAIL_OPTIMIZATION_PLAN 节点2：按需重建成功后清除单个失败标记，
  // 使同 URL 立即重试（LRU 驱逐 / 批量未生成场景）；id 不在集合中时为 no-op
  const clearFailed = useCallback((id: string) => {
    setFailedImages((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  return { failedImages, markFailed, clearFailed }
}
