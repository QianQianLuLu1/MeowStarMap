import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '../stores/uiStore'
import type { MediaFile } from '../stores/mediaStore'

export interface UseMultiSelectionOptions {
  /**
   * 当前板块经筛选后的文件列表（即 GalleryPage 的 filteredFiles）。
   * 非数组（null / undefined / 其它类型）一律按空列表处理，保证数据层异常时不抛错。
   */
  files: MediaFile[]
}

export interface UseMultiSelectionResult {
  /** 是否处于多选模式 */
  multiSelectMode: boolean
  /** 当前选中的 id 列表 */
  selectedIds: string[]
  /** 选中数量 */
  selectedCount: number
  /** 当前列表总数（非法入参为 0） */
  totalCount: number
  /** 当前列表是否已全部选中（空列表恒为 false） */
  isAllSelected: boolean
  /** 判断单项是否选中 */
  isSelected: (id: string) => boolean
  /** 进入多选模式 */
  enter: () => void
  /** 退出多选模式（同时清空选中） */
  exit: () => void
  /** 在多选模式之间切换（工具栏「选择 / 退出选择」按钮用） */
  toggleMultiSelectMode: () => void
  /** 单项勾选（幂等 toggle） */
  toggle: (id: string) => void
  /** 全选 / 取消全选切换 */
  toggleSelectAll: () => void
  /** 在当前列表内反选 */
  invert: () => void
}

/**
 * 多选模式逻辑封装（图库 / 截图 / 收藏 三大板块共用）
 *
 * 设计约束：
 * - 不新增 store 写入路径，仅转发 uiStore 已有的 4 个 action；
 * - 全选 / 反选一律基于当前 files（已过滤），避免选中不属于当前板块或当前筛选条件的 id；
 * - files 非法时全部降级为空列表，绝不抛错。
 */
export function useMultiSelection(options: UseMultiSelectionOptions): UseMultiSelectionResult {
  const { files } = options

  const {
    multiSelectMode,
    selectedIds,
    setSelectedMediaIds,
    toggleMediaSelection,
    clearSelection
  } = useUIStore(
    useShallow((s) => ({
      multiSelectMode: s.multiSelectMode,
      selectedIds: s.selectedMediaIds,
      setSelectedMediaIds: s.setSelectedMediaIds,
      toggleMediaSelection: s.toggleMediaSelection,
      clearSelection: s.clearSelection
    }))
  )
  const setMultiSelectMode = useUIStore((s) => s.setMultiSelectMode)

  // 入参守卫：非数组按空列表处理（项目先例 GalleryPage.tsx:97-100）
  // 守卫内联进 useMemo，避免每次渲染产生新数组导致下游依赖抖动
  const ids = useMemo(() => (Array.isArray(files) ? files : []).map((f) => f.id), [files])
  const idSet = useMemo(() => new Set(ids), [ids])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  const totalCount = ids.length
  // 以「当前列表」为口径判断是否全选：0/0 不视为全选
  const isAllSelected = totalCount > 0 && ids.every((id) => selectedSet.has(id))

  const isSelected = useCallback((id: string) => selectedSet.has(id), [selectedSet])

  const enter = useCallback(() => setMultiSelectMode(true), [setMultiSelectMode])
  const exit = useCallback(() => setMultiSelectMode(false), [setMultiSelectMode])
  const toggleMultiSelectMode = useCallback(
    () => setMultiSelectMode(!multiSelectMode),
    [setMultiSelectMode, multiSelectMode]
  )

  // 只允许勾选当前列表内的 id：既防止数据刷新后的幽灵 id 进入选中态，
  // 也让 files 非法（空列表）时 toggle 自动降级为 no-op 而非抛错
  const toggle = useCallback(
    (id: string) => {
      if (!idSet.has(id)) return
      toggleMediaSelection(id)
    },
    [idSet, toggleMediaSelection]
  )

  const toggleSelectAll = useCallback(() => {
    if (isAllSelected) {
      clearSelection()
    } else {
      // 去重：列表理论上无重复，防御性去重避免重复 id 进入选中态
      setSelectedMediaIds([...new Set(ids)])
    }
  }, [isAllSelected, ids, clearSelection, setSelectedMediaIds])

  const invert = useCallback(() => {
    setSelectedMediaIds(ids.filter((id) => !selectedSet.has(id)))
  }, [ids, selectedSet, setSelectedMediaIds])

  return {
    multiSelectMode,
    selectedIds,
    selectedCount: selectedIds.length,
    totalCount,
    isAllSelected,
    isSelected,
    enter,
    exit,
    toggleMultiSelectMode,
    toggle,
    toggleSelectAll,
    invert
  }
}
