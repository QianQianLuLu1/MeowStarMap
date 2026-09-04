/**
 * React Hook：在 App 根组件调用一次，负责：
 * 1. 启动时初始化索引（searchService.init 内部决定导入或重建）
 * 2. 订阅 mediaStore 变化触发增量更新（diff 后批量 add/update/remove）
 *
 * Diff 算法：
 * - 构建 currentMap: Map<id, MediaFile>
 * - 与 lastSeenRef.current 对比：
 *   - currentMap 有但 lastSeen 没有 → added
 *   - 两边都有但 关键字段 不同 → updated
 *   - lastSeen 有但 currentMap 没有 → removed
 * - 关键字段：modifiedAt / tags / outfit / notes / sceneCategory
 * - 任意一个变化即触发 searchService.update
 *
 * 边缘处理：
 * - 第一次 ready 时仅记录 baseline，不触发 update
 *   （索引已由 searchService.init 从数据库构建，无需重复 add）
 * - FIX(组22-2): baseline 的"首次"用独立标志判断，不能用 lastSeen.size === 0——
 *   首次 ready 时 mediaFiles 恰为空（DB 首启/取数未完成）的话 baseline 记成空集，
 *   之后 mediaFiles 变非空仍命中 size===0 分支只更新 baseline 不触发 update，
 *   新增文档永远不会被增量加入索引（直到下次全量重建）
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { searchService } from './search-service'
import { useMediaStore, type MediaFile } from '../stores/mediaStore'

let initialized = false

/**
 * 在 App 根组件调用一次
 */
export function useSearchIndex(): void {
  const mediaFiles = useMediaStore((s) => s.mediaFiles)
  const lastSeenRef = useRef<Map<string, MediaFile>>(new Map())
  // FIX(组22-2): 区分"尚未记录过 baseline"与"baseline 为空集"两种状态
  const hasBaselineRef = useRef(false)
  // FIX(组22-2): 订阅索引状态，ready 瞬间（而非等下一次 mediaFiles 变化）即记录 baseline，
  // 避免该窗口期内的变化丢失
  const searchState = useSyncExternalStore(
    (cb) => searchService.onStateChange(cb),
    () => searchService.getState(),
    () => 'idle' as const
  )

  // 启动初始化（仅一次）
  useEffect(() => {
    if (initialized) return
    initialized = true
    void searchService.init()
  }, [])

  // 增量更新：mediaFiles 引用变化或索引状态变化时对比差异
  useEffect(() => {
    if (!initialized || searchService.getState() !== 'ready') return

    const lastSeen = lastSeenRef.current
    const currentMap = new Map<string, MediaFile>(mediaFiles.map((f) => [f.id, f]))

    // 第一次 ready 时记录 baseline，不触发 update
    // 避免索引已由 init 构建后又被全量重复 add
    if (!hasBaselineRef.current) {
      lastSeenRef.current = currentMap
      hasBaselineRef.current = true
      return
    }

    const added: MediaFile[] = []
    const updated: MediaFile[] = []
    for (const [id, file] of currentMap) {
      const old = lastSeen.get(id)
      if (!old) {
        added.push(file)
      } else if (
        old.modified_at !== file.modified_at ||
        old.tags !== file.tags ||
        old.outfit !== file.outfit ||
        old.notes !== file.notes ||
        old.scene_category !== file.scene_category
      ) {
        updated.push(file)
      }
    }
    const removed: number[] = []
    for (const id of lastSeen.keys()) {
      if (!currentMap.has(id)) {
        removed.push(Number(id))
      }
    }

    if (added.length || updated.length || removed.length) {
      searchService.update({ added, updated, removed })
    }
    lastSeenRef.current = currentMap
  }, [mediaFiles, searchState])
}
