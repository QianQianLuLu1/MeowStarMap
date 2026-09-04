import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso } from 'react-virtuoso'
import { useUIStore } from '../stores/uiStore'
import { useGlobalToast } from './settings/sections'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { useContainerSize } from '../hooks/useContainerSize'
import { getAutoFillColumns } from '../utils/responsive'
import { formatDateTime } from '../utils/date'
import { formatFileSize, formatEta } from '../utils/format'
import { toFileUrl } from '../utils/file'
import { fetchMediaFromDatabase } from '../stores/mediaStore'
import type { TaskProgress } from '../../shared/types/progress'
import type { DuplicateItem, ScanResult } from '../../shared/types/duplicate'
import { useStagedTask } from '../hooks/useStagedTask'
import { TaskProgressOverlay } from '../components/common/TaskProgressOverlay'
import {
  IconDuplicate,
  IconRefresh,
  IconStar,
  IconTrash,
  IconClose,
  IconCompare,
  IconChevronDown,
  IconCheck
} from '../icons'
import { ContextMenu } from '../components/common/ContextMenu'
import { MediaThumbnail } from '../components/common/MediaThumbnail'
import { getContextMenuItems, type GalleryContextMenuActions } from '../utils/gallery'
import { useFileOperations } from '../hooks/useFileOperations'
import { PropertiesDialog } from '../components/common/PropertiesDialog'
import { RenameDialog } from '../components/gallery/RenameDialog'
import { ShareGuideDialog, type ShareChannelId } from '../components/common/ShareGuideDialog'
import { runClipboardShare, type ClipboardShareCopyResult } from '../utils/share'
import type { MediaFile } from '../stores/mediaStore'
import { toContextMenuMediaFile } from '../utils/duplicateContextMenu'

// 缺缩略图视频按需生成的尝试缓存：同一路径生命周期内最多请求一次（含 null 结果不重试）
const thumbGenerateCache = new Map<string, string | null>()

// 性能重构 v3 改造项三：重复检测同步任务接入 TaskRegistry + ProgressThrottle + EtaCalculator
// TaskProgress 类型复用 src/shared/types/progress.ts（消除重复定义）
// ScanResult / DuplicateItem 复用 src/shared/types/duplicate.ts（前后端契约一致）

type ScanMode = 'exact' | 'similar'
type CleanStrategy = 'newest' | 'largest' | 'smallest' | 'favorited' | 'best_quality'

// P1-U15：STRATEGY_LABEL 改为 i18n key 引用，渲染时通过 t() 翻译
const STRATEGY_LABEL_KEY: Record<CleanStrategy, string> = {
  newest: 'duplicates.strategy.newest',
  largest: 'duplicates.strategy.largest',
  smallest: 'duplicates.strategy.smallest',
  favorited: 'duplicates.strategy.favorited',
  best_quality: 'duplicates.strategy.bestQuality'
}

// T05：相似检测阈值档位（汉明距离越小越严格）
// P1-U15：label/hint 改为 i18n key 引用
const SIMILAR_THRESHOLD_PRESETS = [
  {
    value: 2,
    labelKey: 'duplicates.threshold.veryStrict',
    hintKey: 'duplicates.threshold.veryStrictHint'
  },
  {
    value: 5,
    labelKey: 'duplicates.threshold.default',
    hintKey: 'duplicates.threshold.defaultHint'
  },
  { value: 10, labelKey: 'duplicates.threshold.loose', hintKey: 'duplicates.threshold.looseHint' },
  {
    value: 15,
    labelKey: 'duplicates.threshold.veryLoose',
    hintKey: 'duplicates.threshold.veryLooseHint'
  }
]

// 虚拟列表布局常量：与改造前的 `repeat(auto-fill, minmax(220px, 1fr))` + `gap-3` + `p-4`/`p-6` 一致
const MIN_ITEM_WIDTH = 220
const GRID_GAP = 12
const PAGE_PADDING_X = 24
const CARD_PADDING_X = 16
const CARD_RADIUS = 16
const CARD_BORDER = '1px solid var(--divider)'

// P1-I：formatDate 已统一到 utils/date.ts，调用 formatDateTime 处理 null/空值
// 提到模块作用域，避免每次渲染生成新函数导致 memo 化的列表项全量重渲染
const formatDate = (dateStr?: string | null) => (dateStr ? formatDateTime(dateStr) : '—')

/**
 * 虚拟列表行模型
 *
 * 重复分组被摊平成「组头 + 若干成员行」，用一个滚动容器同时虚拟化外层分组和组内缩略图。
 * 相比「外层 Virtuoso 里再嵌一个 VirtuosoGrid」，摊平后没有嵌套滚动区，
 * 单个分组里塞进几千张图也只挂载可视区的那几行。
 */
type DuplicateRow =
  | { kind: 'header'; key: string; gIdx: number; group: DuplicateItem[]; collapsed: boolean }
  | {
      kind: 'items'
      key: string
      gIdx: number
      files: DuplicateItem[]
      isFirst: boolean
      isLast: boolean
    }

function buildDuplicateRows(
  groups: DuplicateItem[][],
  collapsedGroups: Set<number>,
  columns: number
): DuplicateRow[] {
  const rows: DuplicateRow[] = []
  groups.forEach((group, gIdx) => {
    const collapsed = collapsedGroups.has(gIdx)
    rows.push({ kind: 'header', key: `g${gIdx}-h`, gIdx, group, collapsed })
    if (collapsed) return
    for (let i = 0; i < group.length; i += columns) {
      rows.push({
        kind: 'items',
        key: `g${gIdx}-r${i}`,
        gIdx,
        files: group.slice(i, i + columns),
        isFirst: i === 0,
        isLast: i + columns >= group.length
      })
    }
  })
  return rows
}

// 摊平后卡片由「组头 + 成员行」多个虚拟项拼成，靠这里的分段边框还原成一张连续的卡片
function bandStyle(isTop: boolean, isBottom: boolean): React.CSSProperties {
  return {
    background: 'var(--bg-secondary)',
    borderLeft: CARD_BORDER,
    borderRight: CARD_BORDER,
    ...(isTop
      ? {
          borderTop: CARD_BORDER,
          borderTopLeftRadius: CARD_RADIUS,
          borderTopRightRadius: CARD_RADIUS
        }
      : {}),
    ...(isBottom
      ? {
          borderBottom: CARD_BORDER,
          borderBottomLeftRadius: CARD_RADIUS,
          borderBottomRightRadius: CARD_RADIUS,
          marginBottom: 16
        }
      : {})
  }
}

export const DuplicatesPage: React.FC = () => {
  const { t } = useTranslation()
  const navigateTo = useUIStore((s) => s.navigateTo)
  const showMessage = useGlobalToast()
  const [mode, setMode] = useState<ScanMode>('exact')
  const [threshold, setThreshold] = useState<number>(5)
  const [scanning, setScanning] = useState(false)
  const [generatingPhash, setGeneratingPhash] = useState(false)
  // P1-01：手动触发重复标记（基于 pHash 极严格阈值 + 评分推荐保留）
  const [markingDuplicates, setMarkingDuplicates] = useState(false)
  const [result, setResult] = useState<ScanResult | null>(null)
  // 每组内勾选要删除的文件 id 集合
  const [selectedToDelete, setSelectedToDelete] = useState<Set<number>>(new Set())
  // 折叠的分组索引集合
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number>>(new Set())
  const [confirm, setConfirm] = useState<{
    open: boolean
    ids: number[]
    strategy: CleanStrategy | 'manual' | null
  }>({
    open: false,
    ids: [],
    strategy: null
  })
  const [operating, setOperating] = useState(false)
  // 性能重构 v3 改造项三：跟踪当前重复检测/pHash 补算/重复标记的实时进度
  // 只跟踪 taskType='duplicate' 的任务（扫描/水印等其他任务由各自的 UI 处理）
  const [taskProgress, setTaskProgress] = useState<TaskProgress | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { width } = useContainerSize(contentRef)
  // 可用宽度需扣掉页面左右内边距与卡片左右内边距，才对得上原来的 auto-fill 结果
  const columns = getAutoFillColumns(
    width - PAGE_PADDING_X * 2 - CARD_PADDING_X * 2,
    MIN_ITEM_WIDTH,
    GRID_GAP
  )

  // 自动触发首次扫描
  useEffect(() => {
    void runScan('exact')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 订阅 task:progress 事件，过滤 taskType='duplicate'
  // 终态（done/cancelled/error）保留 1.5s 后清除，让用户看到最终状态
  useEffect(() => {
    const api = window.electronAPI?.task
    if (!api?.onProgress) return
    let clearTimer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = api.onProgress((progress: TaskProgress) => {
      if (progress.taskType !== 'duplicate') return
      setTaskProgress(progress)
      const isTerminal =
        progress.phase === 'done' || progress.phase === 'cancelled' || progress.phase === 'error'
      if (isTerminal) {
        if (clearTimer) clearTimeout(clearTimer)
        clearTimer = setTimeout(() => setTaskProgress(null), 1500)
      } else if (clearTimer) {
        // 进入处理中状态时取消待清除的定时器
        clearTimeout(clearTimer)
        clearTimer = null
      }
    })
    return () => {
      unsubscribe()
      if (clearTimer) clearTimeout(clearTimer)
    }
  }, [])

  // 取消当前任务
  const handleCancelTask = useCallback(async () => {
    if (!taskProgress?.taskId) return
    if (!window.electronAPI?.task?.cancel) {
      showMessage(t('duplicates.task.cancelUnsupported'), 'error')
      return
    }
    try {
      await window.electronAPI.task.cancel(taskProgress.taskId)
      showMessage(t('duplicates.task.cancelRequested'), 'info')
    } catch (err) {
      showMessage(err instanceof Error ? err.message : t('duplicates.task.cancelFailed'), 'error')
    }
  }, [taskProgress, showMessage, t])

  const runScan = useCallback(
    async (scanMode: ScanMode, thresh?: number) => {
      const api = window.electronAPI?.media
      if (!api) {
        showMessage(t('duplicates.unsupported'), 'error')
        return
      }
      if (scanMode === 'exact' && !api.findDuplicates) {
        showMessage(t('duplicates.unsupportedExact'), 'error')
        return
      }
      if (scanMode === 'similar' && !api.findSimilar) {
        showMessage(t('duplicates.unsupportedSimilar'), 'error')
        return
      }
      setScanning(true)
      setSelectedToDelete(new Set())
      setCollapsedGroups(new Set())
      try {
        const res =
          scanMode === 'exact'
            ? ((await api.findDuplicates()) as ScanResult)
            : ((await api.findSimilar({ threshold: thresh ?? threshold })) as ScanResult)
        // 性能重构 v3：用户取消时显示「已取消」提示，不当作失败
        if (res.cancelled) {
          showMessage(
            scanMode === 'exact'
              ? t('duplicates.task.exactCancelled')
              : t('duplicates.task.similarCancelled'),
            'info'
          )
          // 取消后保留之前的 result（若有），这里清空避免显示部分结果
          setResult(null)
          return
        }
        setResult(res)
        if (res.success) {
          if (res.totalGroups === 0) {
            showMessage(
              scanMode === 'exact' ? t('duplicates.noDuplicates') : t('duplicates.noSimilar'),
              'success'
            )
          } else {
            const typeLabel =
              scanMode === 'exact' ? t('duplicates.typeExact') : t('duplicates.typeSimilar')
            showMessage(
              t('duplicates.foundGroups', {
                groups: res.totalGroups,
                type: typeLabel,
                files: res.totalFiles
              }),
              'info'
            )
          }
        } else {
          showMessage(res.message || t('duplicates.scanFailed'), 'error')
        }
      } catch (err) {
        showMessage(err instanceof Error ? err.message : t('duplicates.scanFailed'), 'error')
      } finally {
        setScanning(false)
      }
    },
    [showMessage, t, threshold]
  )

  // ===== 重复文件右键菜单（复用图库 ContextMenu + getContextMenuItems + useFileOperations）=====
  const [contextMenu, setContextMenu] = useState<{ file: MediaFile; x: number; y: number } | null>(
    null
  )
  const [renameDialog, setRenameDialog] = useState<{ file: MediaFile | null; newName: string }>({
    file: null,
    newName: ''
  })
  const [propertiesDialog, setPropertiesDialog] = useState<{
    open: boolean
    file: MediaFile | null
  }>({ open: false, file: null })
  const [shareGuide, setShareGuide] = useState<{
    open: boolean
    channelId: ShareChannelId | null
    installed: boolean
    running: boolean
    copyResult: ClipboardShareCopyResult | null
  }>({ open: false, channelId: null, installed: false, running: false, copyResult: null })
  const [deleteTarget, setDeleteTarget] = useState<{ file: MediaFile; permanent: boolean } | null>(
    null
  )

  const allFiles = useMemo(
    () =>
      (result?.duplicates ?? [])
        .flat()
        .map(toContextMenuMediaFile)
        .filter((f): f is MediaFile => f !== null),
    [result]
  )
  const fileOperations = useFileOperations({
    filteredFiles: allFiles,
    onShowMessage: showMessage,
    onRefreshMedia: () => runScan(mode)
  })

  const groupIdById = useMemo(() => {
    const m = new Map<number, number>()
    ;(result?.duplicates ?? []).forEach((group, gIdx) => {
      group.forEach((f) => m.set(f.id, gIdx))
    })
    return m
  }, [result])

  const handleCardContextMenu = useCallback((item: DuplicateItem, e: React.MouseEvent) => {
    const m = toContextMenuMediaFile(item)
    if (!m) return
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ file: m, x: e.clientX, y: e.clientY })
  }, [])

  const handleOpenLocation = useCallback(
    (file: MediaFile) => {
      const api = window.electronAPI?.shell
      if (!api?.showItemInFolder) {
        showMessage(t('toast.openLocationFailed'), 'error')
        return
      }
      void api.showItemInFolder(file.file_path)
    },
    [showMessage, t]
  )

  const handleShareToClipboard = useCallback(
    async (filePaths: string[], channelId: ShareChannelId) => {
      const api = window.electronAPI?.share
      if (!api) {
        showMessage(t('toast.shareFailed'), 'error')
        return
      }
      try {
        const r = await runClipboardShare(api, filePaths, channelId)
        setShareGuide({
          open: true,
          channelId,
          installed: r.installed,
          running: r.running,
          copyResult: r.copyResult
        })
      } catch (err) {
        showMessage(err instanceof Error ? err.message : t('toast.shareFailed'), 'error')
      }
    },
    [showMessage, t]
  )

  const handleShareSingle = useCallback(
    (file: MediaFile, channelId: ShareChannelId) => {
      void handleShareToClipboard([file.file_path], channelId)
    },
    [handleShareToClipboard]
  )

  const handleRenameOpen = useCallback((file: MediaFile) => {
    setRenameDialog({ file, newName: file.file_name })
  }, [])

  const handleRenameConfirm = useCallback(async () => {
    const { file, newName } = renameDialog
    if (!file) {
      setRenameDialog({ file: null, newName: '' })
      return
    }
    await fileOperations.handleRename(file, newName)
    setRenameDialog({ file: null, newName: '' })
  }, [renameDialog, fileOperations])

  const handleShowProperties = useCallback((file: MediaFile) => {
    setPropertiesDialog({ open: true, file })
  }, [])

  const handleExportSingle = useCallback(
    async (file: MediaFile) => {
      const dialogApi = window.electronAPI?.dialog
      if (!dialogApi?.selectDirectory) {
        showMessage(t('toast.exportFailed'), 'error')
        return
      }
      const targetDir = await dialogApi.selectDirectory()
      if (!targetDir) return
      const fileApi = window.electronAPI?.file
      if (!fileApi?.export) {
        showMessage(t('toast.exportFailed'), 'error')
        return
      }
      try {
        const res = await fileApi.export([file.file_path], targetDir, {})
        showMessage(res.message, res.success ? 'success' : 'error')
      } catch (err) {
        showMessage(err instanceof Error ? err.message : t('toast.exportFailed'), 'error')
      }
    },
    [showMessage, t]
  )

  // 图库「全选同类」在重复文件语义下映射为「选中同重复组的全部文件」
  const handleSelectAllInCategory = useCallback(() => {
    const file = contextMenu?.file
    if (!file) return
    const gIdx = groupIdById.get(Number(file.id))
    if (gIdx == null) return
    const groupIds = result?.duplicates[gIdx].map((f) => f.id) ?? []
    setSelectedToDelete((prev) => {
      const next = new Set(prev)
      groupIds.forEach((id) => next.add(id))
      return next
    })
  }, [contextMenu, groupIdById, result, setSelectedToDelete])

  const contextMenuActions = useMemo<GalleryContextMenuActions>(
    () => ({
      onOpen: fileOperations.handleOpen,
      onEdit: fileOperations.handleEdit,
      onSaveAs: fileOperations.handleSaveAs,
      onExport: handleExportSingle,
      onCopy: fileOperations.handleCopy,
      onMove: fileOperations.handleMove,
      onRename: handleRenameOpen,
      onToggleFavorite: fileOperations.handleToggleFavorite,
      onDelete: (file) => setDeleteTarget({ file, permanent: false }),
      onDeletePermanent: (file) => setDeleteTarget({ file, permanent: true }),
      onShowProperties: handleShowProperties,
      onSelectAllInCategory: handleSelectAllInCategory,
      onOpenLocation: handleOpenLocation,
      onShare: handleShareSingle
    }),
    [
      fileOperations,
      handleExportSingle,
      handleRenameOpen,
      handleShowProperties,
      handleSelectAllInCategory,
      handleOpenLocation,
      handleShareSingle
    ]
  )

  const contextMenuItems = useMemo(
    () => (contextMenu ? getContextMenuItems(contextMenu.file, contextMenuActions, t) : []),
    [contextMenu, contextMenuActions, t]
  )

  const handleContextDeleteConfirm = useCallback(async () => {
    const target = deleteTarget
    setDeleteTarget(null)
    if (!target) return
    const ids = [Number(target.file.id)]
    if (target.permanent) {
      const api = window.electronAPI?.mediaAction
      if (!api?.permanentDelete) {
        showMessage(t('toast.deleteFailed'), 'error')
        return
      }
      const res = await api.permanentDelete(ids)
      if (res.success) {
        showMessage(res.message, 'success')
        await runScan(mode)
      } else {
        showMessage(res.message, 'error')
      }
    } else {
      const api = window.electronAPI?.mediaAction
      if (!api?.softDelete) {
        showMessage(t('toast.deleteFailed'), 'error')
        return
      }
      const res = await api.softDelete(ids)
      if (res.success) {
        showMessage(res.message, 'success')
        await runScan(mode)
      } else {
        showMessage(res.message, 'error')
      }
    }
  }, [deleteTarget, showMessage, t, mode, runScan])

  // T05：切换模式时重新扫描
  const handleModeChange = useCallback(
    (nextMode: ScanMode) => {
      if (nextMode === mode || scanning) return
      setMode(nextMode)
      setResult(null)
      void runScan(nextMode)
    },
    [mode, scanning, runScan]
  )

  // T05：切换阈值档位时重新扫描（仅相似模式）
  const handleThresholdChange = useCallback(
    (next: number) => {
      if (scanning) return
      setThreshold(next)
      void runScan('similar', next)
    },
    [scanning, runScan]
  )

  // T05：手动触发 pHash 补算
  const handleGeneratePhash = useCallback(async () => {
    if (!window.electronAPI?.media?.generatePhash) {
      showMessage(t('duplicates.unsupportedPhash'), 'error')
      return
    }
    setGeneratingPhash(true)
    try {
      const res = await window.electronAPI.media.generatePhash()
      if (res.success) {
        const msg =
          res.total && res.total > 0
            ? t('duplicates.phashCompleted', { processed: res.processed, total: res.total })
            : t('duplicates.phashAllDone')
        showMessage(msg, 'success')
        // 补算完成后重新扫描
        await runScan('similar')
      } else {
        showMessage(res.message || t('duplicates.phashFailed'), 'error')
      }
    } catch (err) {
      showMessage(err instanceof Error ? err.message : t('duplicates.phashFailed'), 'error')
    } finally {
      setGeneratingPhash(false)
    }
  }, [showMessage, t, runScan])

  // P1-01：手动触发重复标记（基于 pHash 极严格阈值 + 评分推荐保留）
  // 标记后图库默认隐藏 is_duplicate=1 的文件，用户可在图库"显示重复"开关中查看
  const handleMarkDuplicates = useCallback(async () => {
    if (!window.electronAPI?.media?.markDuplicates) {
      showMessage(t('duplicates.unsupportedMark'), 'error')
      return
    }
    setMarkingDuplicates(true)
    try {
      const res = await window.electronAPI.media.markDuplicates()
      if (res.success) {
        const msg =
          res.totalGroups > 0
            ? t('duplicates.markCompleted', {
                groups: res.totalGroups,
                marked: res.markedDuplicates
              })
            : t('duplicates.markNoGroups')
        showMessage(msg, res.totalGroups > 0 ? 'success' : 'info')
        // 标记完成后刷新图库数据
        await fetchMediaFromDatabase()
      } else {
        showMessage(res.message || t('duplicates.markFailed'), 'error')
      }
    } catch (err) {
      showMessage(err instanceof Error ? err.message : t('duplicates.markFailed'), 'error')
    } finally {
      setMarkingDuplicates(false)
    }
  }, [showMessage, t])

  // 切换单个文件选中
  const toggleFileSelect = useCallback((id: number) => {
    setSelectedToDelete((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // 切换分组折叠
  const toggleGroupCollapse = useCallback((groupIdx: number) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupIdx)) next.delete(groupIdx)
      else next.add(groupIdx)
      return next
    })
  }, [])

  // 基于策略选择要删除的文件（返回 id 数组）
  // P1-01：新增 best_quality 策略，使用主进程基于评分推荐的 bestItemId
  const pickByStrategy = useCallback(
    (group: DuplicateItem[], strategy: CleanStrategy, groupIdx?: number): number[] => {
      if (group.length < 2) return []
      // group 已按 modified_at 降序（最新在前）
      const sorted = [...group]
      let keepIdx = 0
      switch (strategy) {
        case 'newest':
          keepIdx = 0 // 最新的保留
          break
        case 'largest':
          keepIdx = sorted.reduce(
            (maxI, f, i, arr) => (f.file_size > arr[maxI].file_size ? i : maxI),
            0
          )
          break
        case 'smallest':
          keepIdx = sorted.reduce(
            (minI, f, i, arr) => (f.file_size < arr[minI].file_size ? i : minI),
            0
          )
          break
        case 'favorited': {
          // 优先保留收藏的；若多个收藏，保留其中最新；若无收藏，保留最新
          const favs = sorted.filter((f) => f.is_favorite || f.rating > 0)
          if (favs.length > 0) {
            keepIdx = sorted.indexOf(favs[0])
          } else {
            keepIdx = 0
          }
          break
        }
        case 'best_quality': {
          // P1-01：优先使用主进程基于评分推荐的 bestItemId
          // 兜底：若无 bestItemId，回退到 largest 策略
          if (groupIdx !== undefined && result?.bestItemIds) {
            const bestId = result.bestItemIds[groupIdx]
            if (bestId !== null && bestId !== undefined) {
              const foundIdx = sorted.findIndex((f) => f.id === bestId)
              if (foundIdx >= 0) {
                keepIdx = foundIdx
                break
              }
            }
          }
          // 兜底：保留最大（文件大小近似画质）
          keepIdx = sorted.reduce(
            (maxI, f, i, arr) => (f.file_size > arr[maxI].file_size ? i : maxI),
            0
          )
          break
        }
      }
      return sorted.filter((_, i) => i !== keepIdx).map((f) => f.id)
    },
    [result?.bestItemIds]
  )

  // 对单个分组应用策略
  // P1-01：best_quality 策略需要 groupIdx 来定位 result.bestItemIds[gIdx]
  const applyStrategyToGroup = useCallback(
    (group: DuplicateItem[], strategy: CleanStrategy, groupIdx?: number) => {
      const idsToDelete = pickByStrategy(group, strategy, groupIdx)
      setSelectedToDelete((prev) => {
        const next = new Set(prev)
        // 先清除该组内已选中的
        for (const f of group) next.delete(f.id)
        // 再加入策略选中的
        for (const id of idsToDelete) next.add(id)
        return next
      })
    },
    [pickByStrategy]
  )

  // 对所有分组应用策略
  const applyStrategyToAll = useCallback(
    (strategy: CleanStrategy) => {
      if (!result) return
      const allIds: number[] = []
      result.duplicates.forEach((group, gIdx) => {
        allIds.push(...pickByStrategy(group, strategy, gIdx))
      })
      setSelectedToDelete(new Set(allIds))
      showMessage(
        t('duplicates.strategyApplied', {
          strategy: t(STRATEGY_LABEL_KEY[strategy]),
          count: allIds.length
        }),
        'info'
      )
    },
    [result, pickByStrategy, showMessage, t]
  )

  const clearSelection = useCallback(() => setSelectedToDelete(new Set()), [])

  const staged = useStagedTask()

  // 执行删除（软删除到回收站），带阶段步骤进度
  const performDelete = useCallback(
    async (ids: number[]) => {
      if (ids.length === 0) {
        showMessage(t('duplicates.noFilesSelected'), 'error')
        return
      }
      if (!window.electronAPI?.mediaAction?.softDelete) {
        showMessage(t('duplicates.unsupportedDelete'), 'error')
        return
      }
      setOperating(true)
      let toastText = t('taskProgress.phase.processing')
      const final = await staged.run({
        taskType: 'batch',
        title: t('taskProgress.phase.processing'),
        stageLabels: [
          t('taskProgress.phase.preparing'),
          t('taskProgress.phase.processing'),
          t('taskProgress.phase.finalizing')
        ],
        canCancel: false,
        total: ids.length,
        execute: async ({ setStage }) => {
          setStage(0)
          setStage(0, 'done')
          setStage(1)
          const res = await window.electronAPI!.mediaAction!.softDelete(ids)
          if (!res.success) throw new Error(res.message)
          toastText = res.message
          setStage(1, 'done')
          setStage(2)
          setSelectedToDelete(new Set())
          await fetchMediaFromDatabase()
          await runScan(mode)
          setStage(2, 'done')
        }
      })
      if (final?.phase === 'error') {
        showMessage(final.message ?? t('duplicates.scanFailed'), 'error')
      } else if (final && final.phase !== 'cancelled') {
        showMessage(toastText, 'success')
      }
      setOperating(false)
    },
    [showMessage, t, runScan, mode, staged]
  )

  const handleDeleteConfirm = useCallback(() => {
    const ids = confirm.ids
    const strategy = confirm.strategy
    setConfirm({ open: false, ids: [], strategy: null })
    if (strategy && ids.length > 0) {
      void performDelete(ids)
    }
  }, [confirm.ids, confirm.strategy, performDelete])

  const handleManualDelete = useCallback(() => {
    const ids = Array.from(selectedToDelete)
    if (ids.length === 0) {
      showMessage(t('duplicates.pleaseSelect'), 'error')
      return
    }
    setConfirm({ open: true, ids, strategy: 'manual' })
  }, [selectedToDelete, showMessage, t])

  // 有分组结果时走虚拟列表，其余状态（扫描中/空结果/失败）走普通滚动容器
  const showGroupList = !scanning && !!result?.success && result.totalGroups > 0

  const rows = useMemo(
    () =>
      showGroupList && result
        ? buildDuplicateRows(result.duplicates, collapsedGroups, columns)
        : [],
    [showGroupList, result, collapsedGroups, columns]
  )

  // 统计
  const stats = useMemo(() => {
    if (!result) return { groups: 0, files: 0, wasted: 0, scanned: 0 }
    return {
      groups: result.totalGroups,
      files: result.totalFiles,
      wasted: result.wastedBytes,
      scanned: result.scannedFiles
    }
  }, [result])

  // T05：相似模式特有的额外信息
  const similarMeta = useMemo(() => {
    if (mode !== 'similar' || !result) return null
    return {
      threshold: result.threshold ?? threshold,
      hashedFiles: result.hashedFiles ?? 0
    }
  }, [mode, result, threshold])

  const subtitle = useMemo(() => {
    if (scanning) {
      return mode === 'exact'
        ? t('duplicates.subtitleScanningExact')
        : t('duplicates.subtitleScanningSimilar')
    }
    if (!result) {
      return mode === 'exact' ? t('duplicates.subtitleExact') : t('duplicates.subtitleSimilar')
    }
    if (!result.success) return t('duplicates.subtitleFailed')
    const typeLabel = mode === 'exact' ? t('duplicates.typeExact') : t('duplicates.typeSimilar')
    const parts = [
      t('duplicates.subtitleMeta', {
        scanned: stats.scanned,
        groups: stats.groups,
        type: typeLabel,
        size: formatFileSize(stats.wasted)
      })
    ]
    if (mode === 'similar' && similarMeta) {
      parts.push(
        t('duplicates.subtitleSimilarMeta', {
          threshold: similarMeta.threshold,
          hashed: similarMeta.hashedFiles
        })
      )
    }
    return parts.join(' · ')
  }, [scanning, result, mode, stats, similarMeta, t])

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 顶部标题栏 */}
      <div
        className="flex items-center justify-between px-6 py-4"
        style={{ borderBottom: '1px solid var(--divider)' }}
      >
        <div className="flex items-center gap-3">
          {mode === 'exact' ? <IconDuplicate size={22} /> : <IconCompare size={22} />}
          <div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              {mode === 'exact' ? t('duplicates.titleExact') : t('duplicates.titleSimilar')}
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
              {subtitle}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {result && result.success && result.totalGroups > 0 && !scanning && (
            <>
              <button
                className="btn-secondary text-sm"
                onClick={() => applyStrategyToAll('best_quality')}
                title={t('duplicates.strategyTooltipBest')}
              >
                {t('duplicates.strategyAll', { label: t('duplicates.strategy.bestQuality') })}
              </button>
              <button
                className="btn-secondary text-sm"
                onClick={() => applyStrategyToAll('newest')}
                title={t('duplicates.strategyTooltipNewest')}
              >
                {t('duplicates.strategyAll', { label: t('duplicates.strategy.newest') })}
              </button>
              <button
                className="btn-secondary text-sm"
                onClick={() => applyStrategyToAll('largest')}
                title={t('duplicates.strategyTooltipLargest')}
              >
                {t('duplicates.strategyAll', { label: t('duplicates.strategy.largest') })}
              </button>
              <button
                className="btn-secondary text-sm"
                onClick={() => applyStrategyToAll('favorited')}
                title={t('duplicates.strategyTooltipFavorited')}
              >
                {t('duplicates.strategyAll', { label: t('duplicates.strategy.favorited') })}
              </button>
              <div className="w-px h-5 mx-1" style={{ background: 'var(--divider)' }} />
            </>
          )}
          {mode === 'similar' && (
            <button
              className="btn-secondary text-sm"
              onClick={() => void handleGeneratePhash()}
              disabled={generatingPhash || scanning}
              title={t('duplicates.phashButton')}
            >
              {generatingPhash ? t('duplicates.phashCalculating') : t('duplicates.phashButton')}
            </button>
          )}
          {/* P1-01：手动触发重复标记（标记后图库默认隐藏 is_duplicate=1） */}
          <button
            className="btn-secondary text-sm"
            onClick={() => void handleMarkDuplicates()}
            disabled={markingDuplicates || scanning || generatingPhash}
            title={t('duplicates.markButton')}
          >
            {markingDuplicates ? t('duplicates.markingButton') : t('duplicates.markButton')}
          </button>
          <button
            className="btn-secondary text-sm"
            onClick={() => void runScan(mode)}
            disabled={scanning}
            title={t('duplicates.rescan')}
          >
            <IconRefresh size={14} className="mr-1" /> {t('duplicates.rescan')}
          </button>
        </div>
      </div>

      {/* T05：模式切换 + 阈值档位条 */}
      <div
        className="flex items-center gap-3 px-6 py-3"
        style={{ borderBottom: '1px solid var(--divider)', background: 'var(--bg-secondary)' }}
      >
        <div
          className="flex items-center rounded-full p-0.5"
          style={{ background: 'var(--bg-tertiary)' }}
          role="tablist"
          aria-label={t('duplicates.modeLabel')}
        >
          <button
            role="tab"
            aria-selected={mode === 'exact'}
            onClick={() => handleModeChange('exact')}
            disabled={scanning || generatingPhash}
            className="px-3 py-1 text-xs rounded-full transition-all flex items-center gap-1.5"
            style={{
              background: mode === 'exact' ? 'var(--accent)' : 'transparent',
              color: mode === 'exact' ? '#fff' : 'var(--text-secondary)',
              cursor: scanning || generatingPhash ? 'not-allowed' : 'pointer'
            }}
          >
            <IconDuplicate size={12} /> {t('duplicates.modeExact')}
          </button>
          <button
            role="tab"
            aria-selected={mode === 'similar'}
            onClick={() => handleModeChange('similar')}
            disabled={scanning || generatingPhash}
            className="px-3 py-1 text-xs rounded-full transition-all flex items-center gap-1.5"
            style={{
              background: mode === 'similar' ? 'var(--accent)' : 'transparent',
              color: mode === 'similar' ? '#fff' : 'var(--text-secondary)',
              cursor: scanning || generatingPhash ? 'not-allowed' : 'pointer'
            }}
          >
            <IconCompare size={12} /> {t('duplicates.modeSimilar')}
          </button>
        </div>

        {mode === 'similar' && (
          <div
            className="flex items-center gap-2"
            role="radiogroup"
            aria-label={t('duplicates.thresholdGroupLabel')}
          >
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('duplicates.thresholdLabel')}：
            </span>
            {SIMILAR_THRESHOLD_PRESETS.map((p) => {
              const active = threshold === p.value
              return (
                <button
                  key={p.value}
                  role="radio"
                  aria-checked={active}
                  onClick={() => handleThresholdChange(p.value)}
                  disabled={scanning || generatingPhash}
                  title={t(p.hintKey)}
                  className="px-2.5 py-1 text-xs rounded-full transition-all"
                  style={{
                    background: active ? 'var(--accent-soft)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text-secondary)',
                    border: active ? '1px solid var(--accent)' : '1px solid var(--divider)',
                    cursor: scanning || generatingPhash ? 'not-allowed' : 'pointer'
                  }}
                >
                  {t(p.labelKey)}
                  <span style={{ opacity: 0.6, marginLeft: 4 }}>(≤{p.value})</span>
                </button>
              )
            })}
          </div>
        )}

        <div className="flex-1" />
        <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {mode === 'exact' ? t('duplicates.exactDesc') : t('duplicates.similarDesc')}
        </span>
      </div>

      {/* 内容区 */}
      <div ref={contentRef} className="flex-1 min-h-0 overflow-hidden">
        {!showGroupList && (
          <div className="h-full overflow-auto p-6">
            {/* 加载中 + 进度条 */}
            {scanning && (
              <div
                className="flex flex-col items-center justify-center h-full"
                style={{ color: 'var(--text-tertiary)' }}
              >
                <div
                  className="w-10 h-10 border-2 border-current border-t-transparent rounded-full animate-spin mb-4"
                  style={{ color: 'var(--accent)' }}
                />
                <p className="text-sm">
                  {mode === 'exact' ? t('duplicates.loadingExact') : t('duplicates.loadingSimilar')}
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                  {mode === 'exact'
                    ? t('duplicates.loadingHintExact')
                    : t('duplicates.loadingHintSimilar')}
                </p>
                {/* 性能重构 v3：实时进度条（仅当收到 task:progress 时显示） */}
                {taskProgress && taskProgress.phase !== 'done' && (
                  <div className="mt-6 w-80 max-w-full">
                    <div className="flex items-center justify-between text-xs mb-1.5">
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {taskProgress.message ||
                          (mode === 'exact'
                            ? t('duplicates.loadingExact')
                            : t('duplicates.loadingSimilar'))}
                      </span>
                      <span style={{ color: 'var(--text-tertiary)' }}>
                        {taskProgress.phase === 'cancelled'
                          ? t('duplicates.task.cancelled')
                          : `${taskProgress.percent}%`}
                      </span>
                    </div>
                    <div className="progress-bar">
                      <div
                        className="progress-bar-fill"
                        style={{
                          width: `${taskProgress.percent}%`,
                          transition: 'width 0.2s ease-out'
                        }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs mt-1.5">
                      <span style={{ color: 'var(--text-tertiary)' }}>
                        {taskProgress.current} / {taskProgress.total}
                        {taskProgress.processedPerSec
                          ? ` · ${taskProgress.processedPerSec.toFixed(1)}/s`
                          : ''}
                      </span>
                      <span style={{ color: 'var(--text-tertiary)' }}>
                        {taskProgress.etaMs && taskProgress.etaMs > 0
                          ? t('duplicates.task.remainingTime', {
                              time: formatEta(taskProgress.etaMs)
                            })
                          : t('duplicates.task.calculateEta')}
                      </span>
                    </div>
                    {taskProgress.canCancel && (
                      <div className="flex justify-center mt-3">
                        <button
                          className="btn-secondary text-xs"
                          onClick={() => void handleCancelTask()}
                          disabled={taskProgress.phase === 'cancelled'}
                        >
                          {taskProgress.phase === 'cancelled'
                            ? t('duplicates.task.cancelling')
                            : t('common.cancel')}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 未扫描 / 空结果 */}
            {!scanning && result && result.success && result.totalGroups === 0 && (
              <div
                className="flex flex-col items-center justify-center h-full"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {mode === 'exact' ? <IconDuplicate size={64} /> : <IconCompare size={64} />}
                <p className="mt-4 text-base">
                  {mode === 'exact' ? t('duplicates.noDuplicates') : t('duplicates.noSimilar')}
                </p>
                <p className="text-xs mt-1">
                  {mode === 'exact'
                    ? t('duplicates.emptyExact', { count: stats.scanned })
                    : similarMeta && similarMeta.hashedFiles === 0
                      ? t('duplicates.emptySimilarNoPhash')
                      : t('duplicates.emptySimilarCompared', { count: stats.scanned })}
                </p>
                {mode === 'similar' && similarMeta && similarMeta.hashedFiles === 0 && (
                  <button
                    className="btn-primary mt-4"
                    onClick={() => void handleGeneratePhash()}
                    disabled={generatingPhash}
                  >
                    {generatingPhash
                      ? t('duplicates.phashCalculating')
                      : t('duplicates.phashRecalcNow')}
                  </button>
                )}
                {!(mode === 'similar' && similarMeta && similarMeta.hashedFiles === 0) && (
                  <button className="btn-primary mt-4" onClick={() => navigateTo('gallery')}>
                    {t('duplicates.backToGallery')}
                  </button>
                )}
              </div>
            )}

            {/* 扫描失败 */}
            {!scanning && result && !result.success && (
              <div
                className="flex flex-col items-center justify-center h-full"
                style={{ color: 'var(--text-tertiary)' }}
              >
                <IconClose size={48} />
                <p className="mt-4 text-base" style={{ color: 'var(--danger)' }}>
                  {t('duplicates.subtitleFailed')}
                </p>
                <p className="text-xs mt-1">{result.message}</p>
                <button className="btn-primary mt-4" onClick={() => void runScan(mode)}>
                  {t('common.retry')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* 重复分组列表：摊平成「组头 + 成员行」后交给 Virtuoso，
            外层分组与组内缩略图在同一个滚动容器里一起虚拟化 */}
        {showGroupList && (
          <Virtuoso
            data={rows}
            computeItemKey={(_, row) => row.key}
            style={{
              paddingLeft: PAGE_PADDING_X,
              paddingRight: PAGE_PADDING_X,
              paddingTop: PAGE_PADDING_X
            }}
            increaseViewportBy={{ top: 300, bottom: 600 }}
            itemContent={(_, row) =>
              row.kind === 'header' ? (
                <DuplicateGroupHeader
                  gIdx={row.gIdx}
                  group={row.group}
                  collapsed={row.collapsed}
                  mode={mode}
                  selectedIds={selectedToDelete}
                  onToggleCollapse={toggleGroupCollapse}
                  onApplyStrategy={applyStrategyToGroup}
                />
              ) : (
                <DuplicateMemberRow
                  files={row.files}
                  columns={columns}
                  isFirst={row.isFirst}
                  isLast={row.isLast}
                  bestItemId={result?.bestItemIds?.[row.gIdx] ?? null}
                  selectedIds={selectedToDelete}
                  onToggle={toggleFileSelect}
                  onContextMenu={handleCardContextMenu}
                />
              )
            }
          />
        )}
      </div>
      {/* 底部操作栏（有选中项时显示） */}
      {selectedToDelete.size > 0 && (
        <div
          className="fixed left-1/2 -translate-x-1/2 glass-card px-4 py-2 flex items-center gap-2 z-40"
          style={{ bottom: '44px', animation: 'slideInBottom 200ms ease-out' }}
          role="toolbar"
          aria-label={t('duplicates.toolbarLabel')}
        >
          <span className="text-sm font-medium px-2" style={{ color: 'var(--text-primary)' }}>
            {t('duplicates.selectedToDelete', { count: selectedToDelete.size })}
          </span>
          <div className="w-px h-5 mx-1" style={{ background: 'var(--divider)' }} />
          <button
            className="icon-btn text-sm px-3 w-auto gap-1"
            onClick={handleManualDelete}
            disabled={operating}
            style={{ color: 'var(--danger)' }}
            aria-label={t('duplicates.moveToTrash')}
          >
            <IconTrash size={14} />
            {t('duplicates.moveToTrash')}
          </button>
          <div className="w-px h-5 mx-1" style={{ background: 'var(--divider)' }} />
          <button
            className="icon-btn"
            onClick={clearSelection}
            aria-label={t('common.clear')}
            title={t('common.clear')}
          >
            <IconClose size={14} />
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirm.open}
        title={t('duplicates.confirmTitle')}
        message={t('duplicates.confirmMessage', {
          count: confirm.ids.length,
          type: mode === 'exact' ? t('duplicates.typeExact') : t('duplicates.typeSimilar')
        })}
        confirmText={t('duplicates.moveToTrash')}
        confirmVariant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setConfirm({ open: false, ids: [], strategy: null })}
      />

      {/* 性能重构 v3 改造项三：pHash 补算 / 重复标记进度浮窗
          扫描进度走内容区内的内联进度条，这里仅覆盖 scanning=false 时的后台任务 */}
      {!scanning && taskProgress && taskProgress.phase !== 'done' && (
        <div
          className="fixed bottom-6 right-6 z-50 glass-card p-4"
          style={{
            width: 320,
            borderRadius: 16,
            boxShadow: '0 8px 32px rgba(0,0,0,0.16)',
            animation: 'slideInBottom 200ms ease-out'
          }}
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-3 mb-2">
            <div
              className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin flex-shrink-0"
              style={{ color: 'var(--accent)' }}
            />
            <span
              className="flex-1 text-sm font-medium truncate"
              style={{ color: 'var(--text-primary)' }}
              title={taskProgress.message}
            >
              {taskProgress.message}
            </span>
            {taskProgress.canCancel && (
              <button
                className="icon-btn flex-shrink-0"
                onClick={() => void handleCancelTask()}
                disabled={taskProgress.phase === 'cancelled'}
                aria-label={t('duplicates.task.cancelAria')}
                title={
                  taskProgress.phase === 'cancelled'
                    ? t('duplicates.task.cancelling')
                    : t('common.cancel')
                }
              >
                <IconClose size={14} />
              </button>
            )}
          </div>
          <div className="progress-bar">
            <div
              className="progress-bar-fill"
              style={{
                width: `${taskProgress.percent}%`,
                transition: 'width 0.2s ease-out',
                background:
                  taskProgress.phase === 'cancelled' ? 'var(--text-tertiary)' : 'var(--accent)'
              }}
            />
          </div>
          <div className="flex items-center justify-between text-xs mt-1.5">
            <span style={{ color: 'var(--text-tertiary)' }}>
              {taskProgress.current} / {taskProgress.total}
              {taskProgress.processedPerSec
                ? ` · ${taskProgress.processedPerSec.toFixed(1)}/s`
                : ''}
            </span>
            <span style={{ color: 'var(--text-tertiary)' }}>
              {taskProgress.phase === 'cancelled'
                ? t('duplicates.task.cancelling')
                : taskProgress.etaMs && taskProgress.etaMs > 0
                  ? t('duplicates.task.remainingTime', { time: formatEta(taskProgress.etaMs) })
                  : t('duplicates.task.calculateEta')}
            </span>
          </div>
        </div>
      )}

      {/* 删除 / 批量删除的阶段步骤进度浮窗 */}
      <TaskProgressOverlay progress={staged.progress} onCancel={staged.cancel} />

      {/* 重复文件右键菜单（复用图库 ContextMenu 组件与 getContextMenuItems 工厂） */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
      <PropertiesDialog
        open={propertiesDialog.open}
        file={propertiesDialog.file}
        onClose={() => setPropertiesDialog({ open: false, file: null })}
      />
      <RenameDialog
        file={renameDialog.file}
        newName={renameDialog.newName}
        onNewNameChange={(v) => setRenameDialog((p) => ({ ...p, newName: v }))}
        onConfirm={handleRenameConfirm}
        onCancel={() => setRenameDialog({ file: null, newName: '' })}
      />
      <ShareGuideDialog
        open={shareGuide.open}
        channelId={shareGuide.channelId}
        installed={shareGuide.installed}
        running={shareGuide.running}
        copyResult={shareGuide.copyResult}
        onClose={() =>
          setShareGuide({
            open: false,
            channelId: null,
            installed: false,
            running: false,
            copyResult: null
          })
        }
      />
      <ConfirmDialog
        open={!!deleteTarget}
        title={deleteTarget?.permanent ? t('contextMenu.deletePermanent') : t('contextMenu.delete')}
        message={
          deleteTarget
            ? t('contextMenu.deleteConfirmMessage', { name: deleteTarget.file.file_name })
            : ''
        }
        confirmText={
          deleteTarget?.permanent ? t('contextMenu.deletePermanent') : t('contextMenu.delete')
        }
        confirmVariant="danger"
        onConfirm={handleContextDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}

interface DuplicateGroupHeaderProps {
  gIdx: number
  group: DuplicateItem[]
  collapsed: boolean
  mode: ScanMode
  selectedIds: Set<number>
  onToggleCollapse: (gIdx: number) => void
  onApplyStrategy: (group: DuplicateItem[], strategy: CleanStrategy, gIdx?: number) => void
}

// 分组头：折叠开关 + 组内清理策略。作为虚拟列表的一个行项渲染
const DuplicateGroupHeader: React.FC<DuplicateGroupHeaderProps> = ({
  gIdx,
  group,
  collapsed,
  mode,
  selectedIds,
  onToggleCollapse,
  onApplyStrategy
}) => {
  const { t } = useTranslation()
  const wastedInGroup = group[0].file_size * (group.length - 1)
  const selectedInGroup = group.reduce((n, f) => (selectedIds.has(f.id) ? n + 1 : n), 0)

  return (
    <div style={{ ...bandStyle(true, collapsed), overflow: 'hidden' }}>
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer transition-colors hover:bg-[var(--hover-bg)]"
        style={{ borderBottom: collapsed ? 'none' : CARD_BORDER }}
        onClick={() => onToggleCollapse(gIdx)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggleCollapse(gIdx)
          }
        }}
      >
        <div className="flex items-center gap-3">
          <span
            className="inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          >
            {gIdx + 1}
          </span>
          <div>
            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              {mode === 'exact'
                ? t('duplicates.groupExact', { count: group.length })
                : t('duplicates.groupSimilar', { count: group.length })}
            </p>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {t('duplicates.groupSingleSize', { size: formatFileSize(group[0].file_size) })}
              {group[0].width && group[0].height ? ` · ${group[0].width}×${group[0].height}` : ''}
              {group[0].file_type === 'video'
                ? ` · ${t('duplicates.groupVideoTag')}`
                : ` · ${t('duplicates.groupImageTag')}`}
              {` · ${t('duplicates.groupReleasable')} `}
              <span style={{ color: 'var(--accent)' }}>{formatFileSize(wastedInGroup)}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {selectedInGroup > 0 && (
            <span
              className="text-xs px-2 py-0.5 rounded-full"
              style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}
            >
              {t('duplicates.groupSelected', { count: selectedInGroup })}
            </span>
          )}
          <button
            className="btn-secondary text-xs"
            onClick={() => onApplyStrategy(group, 'best_quality', gIdx)}
            title={t('duplicates.strategyTooltipGroupBest')}
          >
            {t('duplicates.strategy.bestQuality')}
          </button>
          <button
            className="btn-secondary text-xs"
            onClick={() => onApplyStrategy(group, 'newest')}
            title={t('duplicates.strategyTooltipGroupNewest')}
          >
            {t('duplicates.strategy.newest')}
          </button>
          <button
            className="btn-secondary text-xs"
            onClick={() => onApplyStrategy(group, 'largest')}
            title={t('duplicates.strategyTooltipGroupLargest')}
          >
            {t('duplicates.strategy.largest')}
          </button>
          <button
            className="btn-secondary text-xs"
            onClick={() => onApplyStrategy(group, 'favorited')}
            title={t('duplicates.strategyTooltipGroupFavorited')}
          >
            {t('duplicates.strategy.favorited')}
          </button>
          <button
            className="icon-btn"
            onClick={() => onToggleCollapse(gIdx)}
            aria-label={collapsed ? t('duplicates.ariaExpand') : t('duplicates.ariaCollapse')}
            title={collapsed ? t('duplicates.ariaExpandBtn') : t('duplicates.ariaCollapseBtn')}
          >
            <IconChevronDown
              size={14}
              style={{
                transform: collapsed ? 'rotate(-90deg)' : 'rotate(0)',
                transition: 'transform 200ms'
              }}
            />
          </button>
        </div>
      </div>
    </div>
  )
}

interface DuplicateMemberRowProps {
  files: DuplicateItem[]
  columns: number
  isFirst: boolean
  isLast: boolean
  bestItemId: number | null
  selectedIds: Set<number>
  onToggle: (id: number) => void
  onContextMenu?: (file: DuplicateItem, e: React.MouseEvent) => void
}

// 组内成员的一行缩略图（最多 columns 个）
const DuplicateMemberRow: React.FC<DuplicateMemberRowProps> = ({
  files,
  columns,
  isFirst,
  isLast,
  bestItemId,
  selectedIds,
  onToggle,
  onContextMenu
}) => {
  return (
    <div
      style={{
        ...bandStyle(false, isLast),
        paddingLeft: CARD_PADDING_X,
        paddingRight: CARD_PADDING_X,
        paddingTop: isFirst ? CARD_PADDING_X : 0,
        paddingBottom: isLast ? CARD_PADDING_X : GRID_GAP
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: `${GRID_GAP}px`
        }}
      >
        {files.map((file) => (
          <DuplicateFileCard
            key={file.id}
            file={file}
            selected={selectedIds.has(file.id)}
            recommended={file.id === bestItemId}
            onToggle={onToggle}
            onContextMenu={(e) => onContextMenu?.(file, e)}
          />
        ))}
      </div>
    </div>
  )
}

interface DuplicateFileCardProps {
  file: DuplicateItem
  selected: boolean
  recommended: boolean
  onToggle: (id: number) => void
  onContextMenu?: (e: React.MouseEvent) => void
}

// 单个重复文件卡片。缩略图仍走 media:// 协议（toFileUrl），不引入 blob
const DuplicateFileCard: React.FC<DuplicateFileCardProps> = ({
  file,
  selected,
  recommended,
  onToggle,
  onContextMenu
}) => {
  const { t } = useTranslation()
  // 视频专用取源规则（对齐 VirtualImageGrid.tsx 已验证不变量）：
  // 视频绝不回退到原文件（原文件无法被 <img> 解码），只用 thumbnail；
  // 图片允许 thumbnail 缺失时回退到原文件路径。
  const baseSrc = toFileUrl(
    file.file_type === 'video' ? file.thumbnail : file.thumbnail || file.file_path
  )

  // 缺缩略图的视频：按需触发一次生成（不写库，仅本次显示；模块级缓存做单次守卫）
  const [generatedSrc, setGeneratedSrc] = useState<string | null>(null)
  useEffect(() => {
    if (file.file_type !== 'video' || file.thumbnail || generatedSrc) return
    if (typeof file.file_path !== 'string' || file.file_path.length === 0) return
    const cacheKey = file.file_path
    const cached = thumbGenerateCache.get(cacheKey)
    if (cached !== undefined) {
      if (cached) setGeneratedSrc(toFileUrl(cached))
      return
    }
    const generate = window.electronAPI?.thumbnail?.generate
    if (!generate) return
    let cancelled = false
    void (async () => {
      try {
        const result = await generate(file.file_path)
        thumbGenerateCache.set(cacheKey, result ?? null)
        if (!cancelled && result) setGeneratedSrc(toFileUrl(result))
      } catch {
        thumbGenerateCache.set(cacheKey, null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [file.file_type, file.thumbnail, file.file_path, generatedSrc])

  const thumbSrc = generatedSrc ?? baseSrc

  return (
    <div
      className="glass-card overflow-hidden cursor-pointer transition-all"
      style={{
        borderRadius: '12px',
        boxShadow: selected
          ? '0 0 0 2px var(--danger)'
          : recommended
            ? '0 0 0 2px var(--accent)'
            : '0 2px 8px rgba(0,0,0,0.06)',
        opacity: selected ? 0.7 : 1
      }}
      onClick={() => onToggle(file.id)}
      role="checkbox"
      aria-checked={selected}
      aria-label={t('duplicates.ariaGroupToggle', { name: file.file_name })}
      tabIndex={0}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          onToggle(file.id)
        }
      }}
    >
      <div
        className="relative aspect-square flex items-center justify-center"
        style={{ background: 'var(--bg-tertiary)' }}
      >
        <MediaThumbnail
          src={thumbSrc}
          alt={file.file_name}
          fileType={file.file_type === 'video' ? 'video' : 'image'}
        />
        {/* 选中标记 */}
        <div
          className="absolute top-2 left-2 w-6 h-6 rounded-full flex items-center justify-center transition-all"
          style={{
            background: selected ? 'var(--danger)' : 'rgba(255,255,255,0.85)',
            border: selected ? 'none' : '2px solid var(--divider)'
          }}
        >
          {selected && <IconCheck size={14} strokeWidth={3} stroke="white" />}
        </div>
        {/* 收藏 / 评分角标 */}
        {(file.is_favorite || file.rating > 0) && (
          <div
            className="absolute top-2 right-2 px-1.5 py-0.5 rounded-full flex items-center gap-1 text-xs"
            style={{ background: 'rgba(255,184,0,0.92)', color: '#fff' }}
            title={
              file.is_favorite
                ? t('duplicates.favoriteTooltip')
                : t('duplicates.ratingTooltip', { rating: file.rating })
            }
          >
            <IconStar size={10} filled />
            {file.rating > 0 && <span>{file.rating}</span>}
          </div>
        )}
        {/* 视频角标 */}
        {file.file_type === 'video' && (
          <div
            className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded text-xs"
            style={{ background: 'rgba(0,0,0,0.6)', color: '#fff' }}
          >
            {t('duplicates.videoBadge')}
          </div>
        )}
        {/* P1-01：评分推荐保留角标（左下，蓝色，区别于红色选中/黄色收藏） */}
        {recommended && (
          <div
            className="absolute bottom-2 left-2 px-1.5 py-0.5 rounded text-xs font-medium"
            style={{
              background: 'var(--accent)',
              color: '#fff',
              boxShadow: '0 1px 4px rgba(0,0,0,0.2)'
            }}
            title={t('duplicates.recommendTooltip')}
          >
            {t('duplicates.recommendKeep')}
          </div>
        )}
      </div>
      <div className="p-2.5">
        <p
          className="text-xs font-medium truncate"
          style={{ color: 'var(--text-primary)' }}
          title={file.file_name}
        >
          {file.file_name}
        </p>
        <div
          className="flex items-center justify-between mt-1 text-xs"
          style={{ color: 'var(--text-tertiary)' }}
        >
          <span>{formatFileSize(file.file_size)}</span>
          <span>{formatDate(file.modified_at)}</span>
        </div>
      </div>
    </div>
  )
}
