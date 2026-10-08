import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { VirtuosoGrid, type GridListProps } from 'react-virtuoso'
import {
  useMediaStore,
  loadRecycleBin,
  loadNextRecycleBinPage,
  type MediaFile
} from '../stores/mediaStore'
import { resolveThumbnailSrc } from '../utils/thumbnail-src'
import { useRefreshMedia } from '../hooks/useRefreshMedia'
import { useUIStore } from '../stores/uiStore'
import { useGlobalToast } from './settings/sections'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { EmptyState } from '../components/common/EmptyState'
import { InternalError } from '../../shared/errors/app-error'
import { SkeletonGrid } from '../components/common/Skeleton'
import { ThumbReveal } from '../components/common/ThumbReveal'
import { TaskProgressOverlay } from '../components/common/TaskProgressOverlay'
import { PageHeader } from '../components/common/PageHeader'
import { FloatingActionBar } from '../components/common/FloatingActionBar'
import { useStagedTask } from '../hooks/useStagedTask'
import { settleWithConcurrency } from '../../shared/utils/concurrency'
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
// 永久删除并发上限
const DELETE_CONCURRENCY = 5

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
  // 阶段步骤进度编排（回收站永久删除 / 清空回收站）
  const staged = useStagedTask()
  // 图库刷新写回：useRefreshMedia 封装「取数 + 写 store + 失败重试」
  const refreshMedia = useRefreshMedia()

  // 回收站语义修复 D4：App 采用 keep-alive（display:none 保活），空依赖 effect 只在
  // 首次挂载拉一次数据——他处删除后切回回收站列表陈旧。改为「首次挂载必拉取 +
  // currentView 变回 recycle-bin 时重新拉取」（真实路由下首挂载必然处于回收站视图，
  // 兼容独立挂载/测试场景的既有时序）
  const currentView = useUIStore((s) => s.currentView)
  const isFirstMountRef = useRef(true)
  useEffect(() => {
    if (isFirstMountRef.current || currentView === 'recycle-bin') {
      isFirstMountRef.current = false
      void loadRecycleBin()
    }
  }, [currentView])

  // 订阅 media:updated 广播：图库/详情页/全屏删除等操作后主进程会广播，
  // 回收站为当前视图时重新拉取（不依赖重新挂载）
  useEffect(() => {
    const unsubscribe = window.electronAPI?.media?.onUpdated?.(() => {
      if (useUIStore.getState().currentView === 'recycle-bin') void loadRecycleBin()
    })
    return () => {
      if (unsubscribe) unsubscribe()
    }
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
      // preload call() 解包 IpcResponse 只回传 data，返回值形态为 { message }（无 success 字段）；
      // 因此不可读取 result.success 判定成败，应直接信任 call() 的解析结果（失败会抛 IpcError），
      // 对齐 handleEmptyRecycleBin 的修复模式（#fix-empty-recycle-bin-contract / #fix-restore-sync）
      const result = await window.electronAPI.mediaAction.restore(ids)
      setSelectedIds(new Set())
      await loadRecycleBin()
      // 恢复后刷新图库并写回 store：fetchMediaFromDatabase 是纯取数函数，
      // 丢弃返回值不会更新 mediaFiles，必须经 useRefreshMedia 写回
      await refreshMedia()
      showMessage(result.message, 'success')
    } catch (error) {
      showMessage(error instanceof Error ? error.message : t('recycleBin.restoreFailed'), 'error')
      setFailedAction('restore')
    } finally {
      setOperating(false)
    }
  }, [selectedIds, showMessage, t, refreshMedia])

  // 彻底删除选中项（移至系统回收站 + 删除数据库记录），带阶段步骤进度 + 可取消
  const handlePermanentDelete = useCallback(async () => {
    if (selectedIds.size === 0 || !window.electronAPI?.mediaAction?.permanentDelete) {
      showMessage(t('recycleBin.selectToDelete'), 'error')
      return
    }
    const ids = Array.from(selectedIds)
    setOperating(true)
    setFailedAction(null)
    const final = await staged.run({
      taskType: 'batch',
      title: t('taskProgress.phase.processing'),
      stageLabels: [
        t('taskProgress.phase.preparing'),
        t('taskProgress.phase.processing'),
        t('taskProgress.phase.finalizing')
      ],
      canCancel: true,
      total: ids.length,
      execute: async ({ setStage, tick, signal }) => {
        setStage(0)
        setStage(0, 'done')
        setStage(1)
        const settled = await settleWithConcurrency(
          ids,
          DELETE_CONCURRENCY,
          async (id) => {
            if (signal.aborted) {
              const e = new Error('aborted')
              e.name = 'AbortError'
              throw e
            }
            // #fix-permanent-delete-error-toast：preload call() 成功只返回 data
            // （media:permanentDelete → { message, deletedCount, failedCount }，无 success 字段），
            // 失败会抛 IpcError；不可读取 r.success 判定（恒 undefined → 每项恒判失败），
            // 部分失败以 failedCount 判定
            const r = await window.electronAPI!.mediaAction!.permanentDelete([Number(id)])
            if (r.failedCount > 0) throw new InternalError(r.message)
          },
          (done) => tick(done, ids.length),
          signal
        )
        if (signal.aborted) {
          const e = new Error('aborted')
          e.name = 'AbortError'
          throw e
        }
        const anyFailed = settled.some((s) => s.status === 'rejected')
        setStage(1, 'done')
        setStage(2)
        if (!anyFailed) {
          setSelectedIds(new Set())
          await loadRecycleBin()
          setStage(2, 'done')
        } else {
          setFailedAction('permanent')
          // #fix-permanent-delete-error-toast：部分失败时向 run() 抛出首个失败原因，
          // 使 final.phase='error' → Toast 透传具体错误文案（原实现吞错后仍显示成功文案）
          const firstReason = settled.find((s) => s.status === 'rejected')?.reason
          throw firstReason instanceof Error
            ? firstReason
            : new Error(String(firstReason ?? t('recycleBin.deleteFailed')))
        }
      }
    })
    if (final?.phase === 'cancelled') {
      showMessage(t('taskProgress.phase.cancelled'), 'error')
    } else if (final?.phase === 'error') {
      showMessage(final.message ?? t('recycleBin.deleteFailed'), 'error')
    } else if (final && final.stages?.some((s) => s.status === 'failed')) {
      showMessage(t('recycleBin.deleteFailed'), 'error')
    } else {
      showMessage(t('recycleBin.permanentDeleteSuccess', { count: ids.length }), 'success')
    }
    setOperating(false)
  }, [selectedIds, showMessage, t, staged])

  // 清空回收站，带阶段步骤进度
  const handleEmptyRecycleBin = useCallback(async () => {
    if (!window.electronAPI?.mediaAction?.emptyRecycleBin) return
    setOperating(true)
    setFailedAction(null)
    // 缓存主进程返回的成功文案；call() 成功即代表操作成功（失败抛 IpcError 由 error 分支透传）
    let successMessage = ''
    const final = await staged.run({
      taskType: 'batch',
      title: t('taskProgress.phase.processing'),
      stageLabels: [
        t('taskProgress.phase.preparing'),
        t('taskProgress.phase.processing'),
        t('taskProgress.phase.finalizing')
      ],
      canCancel: false,
      execute: async ({ setStage }) => {
        setStage(0)
        setStage(0, 'done')
        setStage(1)
        // preload call() 解包 IpcResponse 只回传 data，返回值形态为 { message, movedCount, missingCount, failedCount }（无 success 字段）；
        // 因此不可读取 result.success 判定成败，应直接信任 call() 的解析结果（失败会抛 IpcError）。
        const result = await window.electronAPI!.mediaAction!.emptyRecycleBin()
        successMessage = result.message ?? ''
        setStage(1, 'done')
        setStage(2)
        setSelectedIds(new Set())
        await loadRecycleBin()
        setStage(2, 'done')
      }
    })
    if (final?.phase === 'error') showMessage(final.message ?? t('recycleBin.emptyFailed'), 'error')
    else if (final && final.phase !== 'cancelled')
      showMessage(successMessage || t('recycleBin.emptySuccess'), 'success')
    setOperating(false)
  }, [showMessage, t, staged])

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
      {/* 顶部标题栏（视觉体系 v3：统一 PageHeader） */}
      <PageHeader
        icon={<IconTrash size={20} />}
        title={t('recycleBin.title')}
        subtitle={
          totalCount > 0
            ? t('recycleBin.summaryWithHint', {
                count: totalCount,
                size: formatFileSize(totalSize)
              })
            : t('recycleBin.summary', {
                count: totalCount,
                size: formatFileSize(totalSize)
              })
        }
        actions={
          <>
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
          </>
        }
      />

      {/* 内容区：列表虚拟化 + 触底分页，回收站堆积上万条时仍只挂载可视区 DOM */}
      <div ref={contentRef} className="flex-1 min-h-0 overflow-hidden">
        {recycleBinLoading && (
          <div className="p-6">
            <SkeletonGrid count={8} aspect="video" />
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

      {/* 底部操作栏（有选中项时显示；视觉体系 v3：统一 FloatingActionBar 容器） */}
      {selectedIds.size > 0 && (
        <FloatingActionBar ariaLabel={t('recycleBin.toolbarLabel')}>
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
                style={{ background: 'var(--warning)' }}
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
        </FloatingActionBar>
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

      {/* 删除 / 清空回收站的阶段步骤进度浮窗 */}
      <TaskProgressOverlay progress={staged.progress} onCancel={staged.cancel} />
    </div>
  )
}

interface RecycleBinItemProps {
  file: MediaFile
  selected: boolean
  onToggle: (id: string) => void
}

// 导出仅供测试直测，行为与内部使用完全一致
export const RecycleBinItemComponent: React.FC<RecycleBinItemProps> = ({
  file,
  selected,
  onToggle
}) => {
  const { t } = useTranslation()
  // FIX(B-thumb): 原用 new URL(thumbnail, 'media://') 构造缩略图 URL。thumbnail 为绝对
  // Windows 路径时，new URL 会把盘符「C:」当作 scheme 解析（protocol === 'c:'）且不抛异常，
  // 于是 catch 分支失效、返回畸形 URL，最终被 Chromium 当作 file:/// 拒绝加载
  // （Not allowed to load local resource，日志实测 570 次裂图）。
  // FIX(N1): 再改用 resolveThumbnailSrc（同 VirtualImageGrid 不变量）——旧写法
  // `toFileUrl(file.thumbnail || file.file_path)` 对 thumbnail 为空的视频会回退用视频文件
  // 本身作 <img> 源必裂图，现统一判定：DB thumbnail > （仅图片）原文件 > null（图标占位）；
  // media 协议白名单（media-protocol.ts）已放行缩略图缓存目录，故无需改协议层。
  const thumbUrl = useMemo(() => resolveThumbnailSrc(file), [file])
  // N5 骨架门控：加载失败回退图标占位（原卡片无 onError 处理，不引入跨卡片失败集合）。
  // 审查修复 T5：thumbUrl 变化（同 id 条目数据刷新后缩略图补齐，Virtuoso 复用实例）
  // 时复位失败态，否则旧失败标记粘滞导致新缩略图永不显示。
  const [thumbFailed, setThumbFailed] = useState(false)
  useEffect(() => {
    setThumbFailed(false)
  }, [thumbUrl])

  return (
    <div
      className={`glass-card card-hover overflow-hidden cursor-pointer ${selected ? 'ring-2' : ''}`}
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
        {thumbUrl && !thumbFailed ? (
          <ThumbReveal
            src={thumbUrl}
            alt={file.file_name}
            className="w-full h-full object-cover"
            onError={() => setThumbFailed(true)}
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
        {/* 文件类型角标（缩略图上的遮罩角标：走 overlay 令牌） */}
        {file.file_type === 'video' && (
          <div
            className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded text-xs"
            style={{ background: 'var(--overlay-bg-strong)', color: 'var(--text-on-overlay)' }}
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
