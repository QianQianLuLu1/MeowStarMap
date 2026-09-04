import { useCallback, useEffect, useState } from 'react'

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
 * @param dep 触发清空的依赖项（通常是 files / items 数组引用）
 * @returns `{ failedImages, markFailed }`
 */
export function useFailedImages<T>(dep: T): {
  failedImages: Set<string>
  markFailed: (id: string) => void
} {
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set())

  // C-O7：dep 变化时清空失败记录，避免 failedImages 无限增长
  useEffect(() => {
    setFailedImages(new Set())
  }, [dep])

  const markFailed = useCallback((id: string) => {
    setFailedImages((prev) => new Set(prev).add(id))
  }, [])

  return { failedImages, markFailed }
}
