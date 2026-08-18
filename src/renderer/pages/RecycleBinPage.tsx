import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { VirtuosoGrid, type GridListProps } from 'react-virtuoso'
import {
  useMediaStore,
  loadRecycleBin,
  loadNextRecycleBinPage,
  fetchMediaFromDatabase,
  toFileUrl,
  type MediaFile
} from '../stores/mediaStore'
import { useUIStore } from '../stores/uiStore'
import { useGlobalToast } from './settings/sections'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { EmptyState } from '../components/common/EmptyState'
import { useContainerSize } from '../hooks/useContainerSize'
import { getAutoFillColumns } from '../utils/responsive'
import { formatFileSize } from '../utils/format'
import { formatDateTime } from '../utils/date'
import {
  IconTrash,
  IconRestore,
  IconClose,
  IconImage,
  IconVideo,
  IconSelectAll,
  IconInvertSelection,
  IconCheck
} from '../icons'

// 虚拟网格布局常量：与改造前的 `repeat(auto-fill, minmax(200px, 1fr))` + `gap-3` 保持一致
const MIN_ITEM_WIDTH = 200
const GRID_GAP = 12
const PAGE_PADDING_X = 24

// P1-I：formatDate 已统一到 utils/date.ts，调用 formatDateTime 处理 null/空值
// 提到模块作用域，避免每次渲染生成新函数导致 memo 化的列表项全量重渲染
const formatDate = (dateStr?: string | null) => (dateStr ? formatDateTime(dateStr) : '—')

export const RecycleBinPage: React.FC = () => {
  const { t } = useTranslation()
  const recycleBinFiles = useMediaStore((s) => s.recycleBinFiles)
  const recycleBinLoading = useMediaStore((s) => s.recycleBinLoading)
  const recycleBinTotal = useMediaStore((s) => s.recycleBinTotal)
  const recycleBinHasMore = useMediaStore((s) => s.recycleBinHasMore)
  const recycleBinLoadingMore = useMediaStore((s) => s.recycleBinLoadingMore)
  const navigateTo = useUIStore((s) => s.navigateTo)
  const showMessage = useGlobalToast()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [operating, setOperating] = useState(false)
  const [confirm, setConfirm] = useState<{ open: boolean; type: 'permanent' | 'empty' | null }>({
    open: false,
    type: null
  })
  // F-B1：记录失败的操作类型，用于显示重试按钮
  const [failedAction, setFailedAction] = useState<'restore' | 'permanent' | 'empty' | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { width } = useContainerSize(contentRef)
  const columns = getAutoFillColumns(width - PAGE_PADDING_X * 2, MIN_ITEM_WIDTH, GRID_GAP)

  useEffect(() => {
    loadRecycleBin()
  }, [])

  // 切换选中
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(recycleBinFiles.map((f) => f.id)))
  }, [recycleBinFiles])

  const invertSelection = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set<string>()
      for (const f of recycleBinFiles) {
        if (!prev.has(f.id)) next.add(f.id)
      }
      return next
    })
  }, [recycleBinFiles])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    setFailedAction(null)
  }, [])

  // 恢复选中项
  const handleRestore = useCallback(async () => {
    if (selectedIds.size === 0 || !window.electronAPI?.mediaAction?.restore) {
      showMessage(t('recycleBin.selectToRestore'), 'error')
      return
    }
    setOperating(true)
    setFailedAction(null)
    try {
      const ids = Array.from(selectedIds).map((id) => Number(id))
      const result = await window.electronAPI.mediaAction.restore(ids)
      showMessage(result.message, result.success ? 'success' : 'error')
      if (result.success) {
        setSelectedIds(new Set())
        await loadRecycleBin()
        // 恢复后刷新图库（图库的 mediaFiles 需重新加载以包含恢复的记录）
        await fetchMediaFromDatabase()
      } else {
        // F-B1：失败时记录操作类型，供用户重试
        setFailedAction('restore')
      }
    } catch (error) {
      showMessage(error instanceof Error ? error.message : t('recycleBin.restoreFailed'), 'error')
      setFailedAction('restore')
    } finally {
      setOperating(false)
    }
  }, [selectedIds, showMessage, t])

  // 彻底删除选中项（移至系统回收站 + 删除数据库记录）
  const handlePermanentDelete = useCallback(async () => {
    if (selectedIds.size === 0 || !window.electronAPI?.mediaAction?.permanentDelete) {
      showMessage(t('recycleBin.selectToDelete'), 'error')
      return
    }
    setOperating(true)
    setFailedAction(null)
    try {
      const ids = Array.from(selectedIds).map((id) => Number(id))
      const result = await window.electronAPI.mediaAction.permanentDelete(ids)
      showMessage(result.message, result.success ? 'success' : 'error')
      if (result.success) {
        setSelectedIds(new Set())
        await loadRecycleBin()
      } else {
        // F-B1：失败时记录操作类型，供用户重试
        setFailedAction('permanent')
      }
    } catch (error) {
      showMessage(error instanceof Error ? error.message : t('recycleBin.deleteFailed'), 'error')
      setFailedAction('permanent')
    } finally {
      setOperating(false)
    }
  }, [selectedIds, showMessage, t])

  // 清空回收站
  const handleEmptyRecycleBin = useCallback(async () => {
    if (!window.electronAPI?.mediaAction?.emptyRecycleBin) return
    setOperating(true)
    setFailedAction(null)
    try {
      const result = await window.electronAPI.mediaAction.emptyRecycleBin()
      showMessage(result.message, result.success ? 'success' : 'error')
      if (result.success) {
        setSelectedIds(new Set())
        await loadRecycleBin()
      } else {
        // F-B1：失败时记录操作类型，供用户重试
        setFailedAction('empty')
      }
    } catch (error) {
      showMessage(error instanceof Error ? error.message : t('recycleBin.emptyFailed'), 'error')
      setFailedAction('empty')
    } finally {
      setOperating(false)
    }
  }, [showMessage, t])

  // F-B1：重试上次失败的操作
  const handleRetry = useCallback(() => {
    if (failedAction === 'restore') void handleRestore()
    else if (failedAction === 'permanent') void handlePermanentDelete()
    else if (failedAction === 'empty') void handleEmptyRecycleBin()
  }, [failedAction, handleRestore, handlePermanentDelete, handleEmptyRecycleBin])

  const handleConfirm = useCallback(() => {
    const type = confirm.type
    setConfirm({ open: false, type: null })
    if (type === 'permanent') handlePermanentDelete()
    else if (type === 'empty') handleEmptyRecycleBin()
  }, [confirm.type, handlePermanentDelete, handleEmptyRecycleBin])

  // 已加载部分的占用空间。服务端未提供总字节数，未翻完页时这里会偏小，
  // 因此只用于概览展示；需要真实条目数的地方（清空确认）一律用 totalCount。
  const totalSize = useMemo(
    () => recycleBinFiles.reduce((sum, f) => sum + f.file_size, 0),
    [recycleBinFiles]
  )
  const totalCount = recycleBinTotal || recycleBinFiles.length

  // 虚拟网格：List 负责列布局，Footer 负责触底状态提示与底部留白
  const gridComponents = useMemo(
    () => ({
      List: ({ children, className, style, ref, ...rest }: GridListProps) => (
        <div
          ref={ref}
          className={className}
          style={{
            ...style,
            display: 'grid',
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gap: `${GRID_GAP}px`
          }}
          {...rest}
        >
          {children}
        </div>
      ),
      Footer: () => (
        <div
          className="py-4 text-center text-xs"
          style={{ color: 'var(--text-secondary)' }}
          role="status"
          aria-live="polite"
        >
          {recycleBinLoadingMore
            ? t('gallery.virtualGrid.loadingMore')
            : recycleBinHasMore
              ? null
              : t('gallery.virtualGrid.noMore')}
        </div>
      )
    }),
    [columns, recycleBinLoadingMore, recycleBinHasMore, t]
  )

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 顶部标题栏 */}
      <div
        className="flex items-center justify-between px-6 py-4"
        style={{ borderBottom: '1px solid var(--divider)' }}
      >
        <div className="flex items-center gap-3">
          <IconTrash size={22} />
          <div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              {t('recycleBin.title')}
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
              {totalCount > 0
                ? t('recycleBin.summaryWithHint', {
                    count: totalCount,
                    size: formatFileSize(totalSize)
                  })
                : t('recycleBin.summary', {
                    count: totalCount,
                    size: formatFileSize(totalSize)
                  })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn-secondary text-sm"
            onClick={selectAll}
            disabled={recycleBinFiles.length === 0}
          >
            <IconSelectAll size={14} className="mr-1" /> {t('common.selectAll')}
          </button>
          <button
            className="btn-secondary text-sm"
            onClick={invertSelection}
            disabled={recycleBinFiles.length === 0}
          >
            <IconInvertSelection size={14} className="mr-1" /> {t('common.invertSelection')}
          </button>
          <button
            className="btn-secondary text-sm"
            onClick={() => setConfirm({ open: true, type: 'empty' })}
            disabled={recycleBinFiles.length === 0 || operating}
            style={{ color: 'var(--danger)' }}
          >
            {t('recycleBin.empty')}
          </button>
        </div>
      </div>

      {/* 内容区：列表虚拟化 + 触底分页，回收站堆积上万条时仍只挂载可视区 DOM */}
      <div ref={contentRef} className="flex-1 min-h-0 overflow-hidden">
        {recycleBinLoading && (
          <div className="flex items-center justify-center h-32">
            <div
              className="w-8 h-8 border-2 border-current border-t-transparent rounded-full animate-spin"
              style={{ color: 'var(--accent)' }}
            />
          </div>
        )}

        {!recycleBinLoading && recycleBinFiles.length === 0 && (
          <div className="p-6">
            <EmptyState
              icon={<IconTrash size={64} />}
              title={t('recycleBin.emptyTitle')}
              ctaLabel={t('recycleBin.backToGallery')}
              onCta={() => navigateTo('gallery')}
            />
          </div>
        )}

        {!recycleBinLoading && recycleBinFiles.length > 0 && (
          <VirtuosoGrid
            data={recycleBinFiles}
            computeItemKey={(_, file) => file.id}
            components={gridComponents}
            style={{ paddingLeft: PAGE_PADDING_X, paddingRight: PAGE_PADDING_X, paddingTop: 24 }}
            increaseViewportBy={{ top: 200, bottom: 200 }}
            endReached={() => void loadNextRecycleBinPage()}
            itemContent={(_, file) => (
              <RecycleBinItem
                file={file}
                selected={selectedIds.has(file.id)}
                onToggle={toggleSelect}
              />
            )}
          />
        )}
      </div>

      {/* 底部操作栏（有选中项时显示） */}
      {selectedIds.size > 0 && (
        <div
          className="fixed left-1/2 -translate-x-1/2 glass-card px-4 py-2 flex items-center gap-2 z-40"
          style={{ bottom: '44px', animation: 'slideInBottom 200ms ease-out' }}
          role="toolbar"
          aria-label={t('recycleBin.toolbarLabel')}
        >
          <span className="text-sm font-medium px-2" style={{ color: 'var(--text-primary)' }}>
            {t('recycleBin.selectedCount', { count: selectedIds.size })}
          </span>
          <div className="w-px h-5 mx-1" style={{ background: 'var(--divider)' }} />
          <button
            className="icon-btn text-sm px-3 w-auto gap-1"
            onClick={handleRestore}
            disabled={operating}
            aria-label={t('recycleBin.restoreSelected')}
          >
            <IconRestore size={14} />
            {t('recycleBin.restore')}
          </button>
          <button
            className="icon-btn text-sm px-3 w-auto gap-1"
            onClick={() => setConfirm({ open: true, type: 'permanent' })}
            disabled={operating}
            style={{ color: 'var(--danger)' }}
            aria-label={t('recycleBin.permanentDeleteSelected')}
          >
            <IconClose size={14} />
            {t('recycleBin.permanentDelete')}
          </button>
          {/* F-B1：操作失败时显示重试按钮（高亮，引导用户重试） */}
          {failedAction && (
            <>
              <div className="w-px h-5 mx-1" style={{ background: 'var(--divider)' }} />
              <button
                className="btn-primary text-sm"
                onClick={handleRetry}
                disabled={operating}
                style={{ background: 'var(--warning, #f59e0b)' }}
              >
                {failedAction === 'restore' && t('recycleBin.retryRestore')}
                {failedAction === 'permanent' && t('recycleBin.retryDelete')}
                {failedAction === 'empty' && t('recycleBin.retryEmpty')}
              </button>
            </>
          )}
          <div className="w-px h-5 mx-1" style={{ background: 'var(--divider)' }} />
          <button
            className="icon-btn"
            onClick={clearSelection}
            aria-label={t('recycleBin.clearSelection')}
          >
            <IconClose size={14} />
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirm.open}
        title={
          confirm.type === 'empty'
            ? t('recycleBin.emptyConfirmTitle')
            : t('recycleBin.permanentConfirmTitle')
        }
        message={
          confirm.type === 'empty'
            ? // 清空作用于服务端全部软删除记录，必须用总数而非已加载页的条数
              t('recycleBin.emptyConfirm', { count: totalCount })
            : t('recycleBin.permanentConfirm', { count: selectedIds.size })
        }
        confirmText={
          confirm.type === 'empty' ? t('recycleBin.confirmEmpty') : t('recycleBin.permanentDelete')
        }
        confirmVariant="danger"
        onConfirm={handleConfirm}
        onCancel={() => setConfirm({ open: false, type: null })}
      />
    </div>
  )
}

interface RecycleBinItemProps {
  file: MediaFile
  selected: boolean
  onToggle: (id: string) => void
}

const RecycleBinItemComponent: React.FC<RecycleBinItemProps> = ({ file, selected, onToggle }) => {
  const { t } = useTranslation()
  const thumbUrl = useMemo(() => {
    if (file.thumbnail) {
      try {
        const url = new URL(file.thumbnail, 'media://')
        return file.thumbnail.startsWith('media://') ? file.thumbnail : url.href
      } catch {
        return file.thumbnail
      }
    }
    return toFileUrl(file.file_path)
  }, [file.thumbnail, file.file_path])

  return (
    <div
      className={`glass-card overflow-hidden cursor-pointer transition-all ${selected ? 'ring-2' : ''}`}
      style={{
        borderRadius: '12px',
        boxShadow: selected ? '0 0 0 2px var(--accent)' : '0 4px 20px rgba(0,0,0,0.08)'
      }}
      onClick={() => onToggle(file.id)}
      role="checkbox"
      aria-checked={selected}
      aria-label={t('recycleBin.itemLabel', { name: file.file_name })}
      tabIndex={0}
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
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt={file.file_name}
            className="w-full h-full object-cover"
            loading="lazy"
            draggable={false}
          />
        ) : (
          <div style={{ color: 'var(--text-tertiary)' }}>
            {file.file_type === 'video' ? <IconVideo size={32} /> : <IconImage size={32} />}
          </div>
        )}
        {/* 选中标记 */}
        <div
          className="absolute top-2 left-2 w-6 h-6 rounded-full flex items-center justify-center transition-all"
          style={{
            background: selected ? 'var(--accent)' : 'rgba(255,255,255,0.8)',
            border: selected ? 'none' : '2px solid var(--divider)'
          }}
        >
          {selected && <IconCheck size={14} strokeWidth={3} stroke="white" />}
        </div>
        {/* 文件类型角标 */}
        {file.file_type === 'video' && (
          <div
            className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded text-xs"
            style={{ background: 'rgba(0,0,0,0.6)', color: '#fff' }}
          >
            {t('recycleBin.videoBadge')}
          </div>
        )}
      </div>
      <div className="p-3">
        <p
          className="text-sm font-medium truncate"
          style={{ color: 'var(--text-primary)' }}
          title={file.file_name}
        >
          {file.file_name}
        </p>
        <div
          className="flex items-center justify-between mt-1.5 text-xs"
          style={{ color: 'var(--text-tertiary)' }}
        >
          <span>{formatFileSize(file.file_size)}</span>
          <span>{formatDate(file.deleted_at)}</span>
        </div>
      </div>
    </div>
  )
}

RecycleBinItemComponent.displayName = 'RecycleBinItem'

// 虚拟列表滚动时父组件会频繁重渲染，memo 化避免可视区外的项跟着重算
const RecycleBinItem = React.memo(RecycleBinItemComponent)
