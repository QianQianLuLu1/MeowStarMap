import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '../stores/uiStore'
import {
  useMediaStore,
  type MediaFile,
  fetchMediaFromDatabase,
  loadNextMediaPage
} from '../stores/mediaStore'
import { ConfirmDialog } from '../components/common/ConfirmDialog'
import { PropertiesDialog } from '../components/common/PropertiesDialog'
import { ContextMenu } from '../components/common/ContextMenu'
import { VirtualImageGrid } from '../components/gallery/VirtualImageGrid'
import { ListView } from '../components/gallery/ListView'
import { TimelineView } from '../components/gallery/TimelineView'
import { MasonryView } from '../components/gallery/MasonryView'
import { EventTimelineView } from '../components/gallery/EventTimelineView'
import { GalleryToolbar } from '../components/gallery/GalleryToolbar'
import { BatchActions } from '../components/gallery/BatchActions'
import { EmptyState } from '../components/common/EmptyState'
import { IconImage } from '../icons'
import { ScanProgress } from '../components/scanner/ScanProgress'
import { RenameDialog } from '../components/gallery/RenameDialog'
import { WatermarkDialog } from '../components/gallery/WatermarkDialog'
import { WifiShareDialog } from '../components/common/WifiShareDialog'
import { ShareGuideDialog, type ShareChannelId } from '../components/common/ShareGuideDialog'
import { SlideshowPlayer } from '../components/gallery/SlideshowPlayer'
import { BatchRenameDialog } from '../components/gallery/BatchRenameDialog'
import { ImportWizard } from '../components/gallery/ImportWizard'
import { SmartGroupPanel } from '../components/gallery/SmartGroupPanel'
import { useFileOperations } from '../hooks/useFileOperations'
import { useBatchOperations } from '../hooks/useBatchOperations'
import { useGallerySearch } from '../hooks/useGallerySearch'
import { useGlobalToast } from './settings/sections'
import { useRefreshMedia } from '../hooks/useRefreshMedia'
import { useFilteredMediaFiles } from '../hooks/useFilteredMediaFiles'
import { getContextMenuItems } from '../utils/gallery'

export const GalleryPage: React.FC = () => {
  const { t } = useTranslation()
  // C-O4：用 useShallow 选择器订阅具体字段，避免订阅整个 store 触发过度重渲染
  const {
    viewMode,
    selectedMediaIds,
    selectMedia,
    setSelectedMediaIds,
    toggleMediaSelection,
    openFullscreen,
    openSlideshow,
    clearSelection,
    // P1-01：图库"显示重复"开关（默认 false 隐藏 is_duplicate=1）
    showDuplicates,
    setShowDuplicates,
    // 当前视图（用于切换 gallery/launcher-cache 时重新加载数据）
    currentView,
    // 损坏文件容错：仅看损坏开关（true 时服务端仅返回 is_corrupted=1 的记录，需重新加载）
    showCorruptedOnly
  } = useUIStore(
    useShallow((s) => ({
      viewMode: s.viewMode,
      selectedMediaIds: s.selectedMediaIds,
      selectMedia: s.selectMedia,
      setSelectedMediaIds: s.setSelectedMediaIds,
      toggleMediaSelection: s.toggleMediaSelection,
      openFullscreen: s.openFullscreen,
      openSlideshow: s.openSlideshow,
      clearSelection: s.clearSelection,
      showDuplicates: s.showDuplicates,
      setShowDuplicates: s.setShowDuplicates,
      currentView: s.currentView,
      showCorruptedOnly: s.showCorruptedOnly
    }))
  )

  const setMediaFiles = useMediaStore((s) => s.setMediaFiles)
  const loading = useMediaStore((s) => s.loading)
  const setLoading = useMediaStore((s) => s.setLoading)
  // 无限滚动分页状态：驱动网格页脚的"加载中/没有更多"提示
  const loadingMore = useMediaStore((s) => s.loadingMore)
  const hasMoreMedia = useMediaStore((s) => s.hasMoreMedia)
  // P1-04：跨档案转移——读取已有档案列表供 BatchActions 下拉选择
  const profiles = useMediaStore((s) => s.profiles)
  const showMessage = useGlobalToast()
  const refreshMedia = useRefreshMedia()
  const { inputValue, setInputValue } = useGallerySearch()
  const filteredFiles = useFilteredMediaFiles()

  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean
    title: string
    message: string
    onConfirm: () => void
  }>({ open: false, title: '', message: '', onConfirm: () => {} })
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: MediaFile } | null>(
    null
  )
  const [renameDialog, setRenameDialog] = useState<{
    open: boolean
    file: MediaFile | null
    newName: string
  }>({
    open: false,
    file: null,
    newName: ''
  })
  // T08：WiFi 局域网分享对话框状态
  const [wifiShareDialog, setWifiShareDialog] = useState<{ open: boolean; filePaths: string[] }>({
    open: false,
    filePaths: []
  })
  // T09：剪贴板分享引导弹窗状态
  const [shareGuide, setShareGuide] = useState<{
    open: boolean
    channelId: ShareChannelId | null
    installed: boolean
    running: boolean
    copyResult: { success: boolean; message: string; count: number; skipped: number } | null
  }>({ open: false, channelId: null, installed: false, running: false, copyResult: null })

  // T14：文件导入向导
  const [importWizardOpen, setImportWizardOpen] = useState(false)
  // P0-03：智能分组面板展开状态
  const [groupPanelOpen, setGroupPanelOpen] = useState(false)
  // 图片属性弹窗（含 EXIF 拍摄参数 + 复制按钮）
  const [propertiesDialog, setPropertiesDialog] = useState<{
    open: boolean
    file: MediaFile | null
  }>({
    open: false,
    file: null
  })

  // useEffect 1：仅响应 currentView/showCorruptedOnly 变化触发首次加载
  // 依赖 currentView：切换 gallery/launcher-cache/favorites 视图时需重新加载
  // （launcher-cache 由后端按 media_source 过滤，必须重新查询数据库）
  // 依赖 showCorruptedOnly：损坏文件容错切换"仅看损坏"时需重新加载（服务端过滤 is_corrupted）
  useEffect(() => {
    const refresh = async () => {
      setLoading(true)
      try {
        const result = await fetchMediaFromDatabase()
        if (result) {
          setMediaFiles(result.files)
        }
      } finally {
        setLoading(false)
      }
    }
    refresh()
  }, [setMediaFiles, setLoading, currentView, showCorruptedOnly])

  // useEffect 2：全局订阅 media:updated，仅注册一次（不依赖 currentView/showCorruptedOnly）
  // 拆分目的：避免依赖变化时解绑订阅，导致扫描完成通知丢失
  useEffect(() => {
    const unsubscribe = window.electronAPI?.media?.onUpdated(() => {
      fetchMediaFromDatabase()
        .then((result) => {
          if (result) setMediaFiles(result.files)
        })
        .catch((err) => {
          console.error('[GalleryPage] media:updated refresh failed:', err)
        })
    })
    return () => {
      if (unsubscribe) unsubscribe()
    }
  }, [setMediaFiles])

  const fileOperations = useFileOperations({
    filteredFiles,
    onShowMessage: showMessage,
    onRefreshMedia: refreshMedia
  })

  const batchOperations = useBatchOperations({
    onShowMessage: showMessage
  })

  // 网格/列表项选择处理
  const handleGridItemClick = useCallback(
    (id: string, fileIndex: number, e: React.MouseEvent | React.KeyboardEvent) => {
      const isCtrl = 'ctrlKey' in e && e.ctrlKey
      const isMeta = 'metaKey' in e && e.metaKey
      const isShift = 'shiftKey' in e && e.shiftKey
      if (isCtrl || isMeta) {
        toggleMediaSelection(id)
      } else if (isShift) {
        // Shift 连续选择
        if (selectedMediaIds.length === 0) {
          selectMedia(id)
          return
        }
        const lastIndex = filteredFiles.findIndex(
          (f) => f.id === selectedMediaIds[selectedMediaIds.length - 1]
        )
        if (lastIndex < 0 || lastIndex >= filteredFiles.length) {
          selectMedia(id)
          return
        }
        const start = Math.min(lastIndex, fileIndex)
        const end = Math.max(lastIndex, fileIndex)
        const rangeIds = filteredFiles.slice(start, end + 1).map((f) => f.id)
        setSelectedMediaIds(rangeIds)
      } else {
        // P3-1：给被点击的卡片 img 设置 view-transition-name，供 FullscreenViewer 共享元素过渡
        if (typeof document !== 'undefined' && (document as any).startViewTransition) {
          const sourceImg = (e.currentTarget as HTMLElement).querySelector('img[data-media-id]')
          if (sourceImg) {
            ;(sourceImg as HTMLElement).style.viewTransitionName = 'fullscreen-media'
          }
        }
        selectMedia(id)
        openFullscreen(fileIndex)
      }
    },
    [
      filteredFiles,
      selectedMediaIds,
      selectMedia,
      setSelectedMediaIds,
      toggleMediaSelection,
      openFullscreen
    ]
  )

  const handleSelectAll = useCallback(() => {
    setSelectedMediaIds(filteredFiles.map((f) => f.id))
  }, [filteredFiles, setSelectedMediaIds])

  const handleSelectAllInCategory = useCallback(() => {
    if (!contextMenu) return
    const category = contextMenu.file.scene_category
    const ids = filteredFiles.filter((f) => f.scene_category === category).map((f) => f.id)
    setSelectedMediaIds(ids)
    setContextMenu(null)
  }, [contextMenu, filteredFiles, setSelectedMediaIds])

  const handleInvertSelection = useCallback(() => {
    const selectedSet = new Set(selectedMediaIds)
    const inverted = filteredFiles.filter((f) => !selectedSet.has(f.id)).map((f) => f.id)
    setSelectedMediaIds(inverted)
  }, [filteredFiles, selectedMediaIds, setSelectedMediaIds])

  const handleContextMenu = useCallback((e: React.MouseEvent, file: MediaFile) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, file })
  }, [])

  // P1 修复：稳定化 ContextMenu 的 onClose 回调，避免每次 GalleryPage 重渲染都产生新引用
  // 触发 ContextMenu useEffect 重跑（解绑/重绑 mousedown/keydown 监听器）
  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const handleRenameOpen = useCallback((file: MediaFile) => {
    setRenameDialog({ open: true, file, newName: file.file_name.replace(/\.[^.]+$/, '') })
  }, [])

  const handleRenameConfirm = useCallback(async () => {
    if (!renameDialog.file) return
    await fileOperations.handleRename(renameDialog.file, renameDialog.newName)
    setRenameDialog({ open: false, file: null, newName: '' })
  }, [renameDialog.file, renameDialog.newName, fileOperations])

  const handleDelete = useCallback(
    (file: MediaFile, permanent = false) => {
      const config = fileOperations.getDeleteConfirm(file, permanent)
      setConfirmDialog({
        open: true,
        title: config.title,
        message: config.message,
        onConfirm: config.onConfirm
      })
    },
    [fileOperations]
  )

  // 稳定回调：避免内联函数破坏 VirtualImageGrid 的 React.memo 浅比较
  const handleGridHover = useCallback(() => {}, [])
  // 滚动到底追加下一页；重复触发与游标推进由 loadNextMediaPage 内部保护
  const handleEndReached = useCallback(() => {
    void loadNextMediaPage()
  }, [])
  const handleGridDelete = useCallback(
    (file: MediaFile) => handleDelete(file, false),
    [handleDelete]
  )

  const handleShowProperties = useCallback((file: MediaFile) => {
    setPropertiesDialog({ open: true, file })
  }, [])

  // 在资源管理器中打开文件所在位置并选中该文件
  const handleOpenLocation = useCallback(
    async (file: MediaFile) => {
      try {
        const result = await window.electronAPI?.shell?.showItemInFolder(file.file_path)
        if (result && !result.success) {
          showMessage(result.message || t('galleryPage.openLocationFailed'), 'error')
        }
      } catch (err) {
        showMessage(
          err instanceof Error ? err.message : t('galleryPage.openLocationFailed'),
          'error'
        )
      }
    },
    [showMessage, t]
  )

  const handleExportSingle = useCallback(
    (file: MediaFile) => {
      selectMedia(file.id)
      useUIStore.getState().setSelectedMediaIds([file.id])
      batchOperations.handleBatchExport()
    },
    [selectMedia, batchOperations]
  )

  // T09：剪贴板分享核心流程——复制文件 → 检测应用 → 弹引导窗
  const handleShareToClipboard = useCallback(
    async (filePaths: string[], channelId: ShareChannelId) => {
      if (filePaths.length === 0) {
        showMessage(t('galleryPage.selectShareFirst'), 'error')
        return
      }
      const api = window.electronAPI?.share
      if (!api) {
        showMessage(t('galleryPage.shareUnavailable'), 'error')
        return
      }
      // 第一步：复制到剪贴板
      const copyResult = await api.copyFiles(filePaths)
      if (!copyResult.success) {
        // 复制失败：直接弹错误引导窗（不自动关闭）
        setShareGuide({ open: true, channelId, installed: false, running: false, copyResult })
        return
      }
      // 第二步：检测目标应用状态（installed + running）
      const detect = await api.detectApp(channelId)
      setShareGuide({
        open: true,
        channelId,
        installed: detect.success ? detect.installed : false,
        running: detect.success ? !!detect.running : false,
        copyResult
      })
    },
    [showMessage]
  )

  // T09：单文件分享（来自右键菜单）
  const handleShareSingle = useCallback(
    (file: MediaFile, channelId: ShareChannelId) => {
      void handleShareToClipboard([file.file_path], channelId)
    },
    [handleShareToClipboard]
  )

  const contextMenuItems = useMemo(() => {
    if (!contextMenu) return []
    const file = contextMenu.file
    return getContextMenuItems(
      file,
      {
        onOpen: fileOperations.handleOpen,
        onEdit: fileOperations.handleEdit,
        onSaveAs: fileOperations.handleSaveAs,
        onExport: handleExportSingle,
        onCopy: fileOperations.handleCopy,
        onMove: fileOperations.handleMove,
        onRename: handleRenameOpen,
        onToggleFavorite: fileOperations.handleToggleFavorite,
        onDelete: (f) => handleDelete(f, false),
        onDeletePermanent: (f) => handleDelete(f, true),
        onShowProperties: handleShowProperties,
        onSelectAllInCategory: handleSelectAllInCategory,
        onShare: handleShareSingle,
        onOpenLocation: handleOpenLocation
      },
      t
    )
  }, [
    contextMenu,
    fileOperations,
    handleExportSingle,
    handleRenameOpen,
    handleDelete,
    handleShowProperties,
    handleSelectAllInCategory,
    handleShareSingle,
    handleOpenLocation,
    t
  ])

  const handleBatchDelete = useCallback(() => {
    setConfirmDialog({
      open: true,
      title: t('galleryPage.batchDeleteTitle'),
      message: t('galleryPage.batchDeleteConfirm', { count: selectedMediaIds.length }),
      onConfirm: async () => {
        // deleteFilesBatch 内部已处理错误与 Toast，失败项会保留在列表中
        await fileOperations.deleteFilesBatch(selectedMediaIds)
        clearSelection()
        setConfirmDialog((prev) => ({ ...prev, open: false }))
      }
    })
  }, [selectedMediaIds, fileOperations, clearSelection, t])

  // 损坏文件容错：批量清理所有 is_corrupted=1 的数据库记录
  // 仅删除数据库索引，不删除源文件（源文件仍存在于磁盘但无法解码，由用户决定后续处理）
  // 调用前显示确认对话框，避免误操作
  // 注：preload `call` 在失败时抛出 IpcError，成功时直接返回业务数据（{ message, cleared }）
  const handleCleanupCorrupted = useCallback(() => {
    setConfirmDialog({
      open: true,
      title: t('galleryPage.cleanupCorruptedTitle'),
      message: t('galleryPage.cleanupCorruptedConfirm'),
      onConfirm: async () => {
        try {
          const result = await window.electronAPI!.mediaAction.cleanupCorrupted()
          const res = await fetchMediaFromDatabase()
          if (res) setMediaFiles(res.files)
          showMessage(
            result.message || t('galleryPage.cleanupCorruptedCount', { count: result.cleared }),
            'success'
          )
        } catch (error) {
          showMessage(
            error instanceof Error ? error.message : t('galleryPage.cleanupCorruptedFailed'),
            'error'
          )
        } finally {
          setConfirmDialog((prev) => ({ ...prev, open: false }))
        }
      }
    })
  }, [setMediaFiles, showMessage, t])

  // T08：批量 WiFi 分享
  const handleBatchShareWifi = useCallback(() => {
    if (selectedMediaIds.length === 0) return
    const selectedSet = new Set(selectedMediaIds)
    const paths = filteredFiles.filter((f) => selectedSet.has(f.id)).map((f) => f.file_path)
    if (paths.length === 0) {
      showMessage(t('galleryPage.selectShareFilesFirst'), 'error')
      return
    }
    setWifiShareDialog({ open: true, filePaths: paths })
  }, [selectedMediaIds, filteredFiles, showMessage, t])

  // T09：批量分享（来自工具栏 / 批量操作栏）
  const handleShareBatch = useCallback(
    (channelId: ShareChannelId) => {
      if (selectedMediaIds.length === 0) {
        showMessage(t('galleryPage.selectShareFirst'), 'error')
        return
      }
      const selectedSet = new Set(selectedMediaIds)
      const paths = filteredFiles.filter((f) => selectedSet.has(f.id)).map((f) => f.file_path)
      void handleShareToClipboard(paths, channelId)
    },
    [selectedMediaIds, filteredFiles, showMessage, handleShareToClipboard, t]
  )

  // T11：启动幻灯片播放——若已选择文件则从首个选中开始，否则从列表第一张开始
  const handleStartSlideshow = useCallback(() => {
    if (filteredFiles.length === 0) {
      showMessage(t('galleryPage.noPlayableMedia'), 'info')
      return
    }
    let startIndex = 0
    if (selectedMediaIds.length > 0) {
      const firstSelectedIdx = filteredFiles.findIndex((f) => f.id === selectedMediaIds[0])
      if (firstSelectedIdx >= 0) startIndex = firstSelectedIdx
    }
    openSlideshow(startIndex)
  }, [filteredFiles, selectedMediaIds, openSlideshow, showMessage, t])

  // P2-F：仅在初次加载（无已渲染数据）时显示骨架，避免卸载已渲染的虚拟列表丢失滚动位置
  if (loading && filteredFiles.length === 0) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="aspect-square rounded-xl skeleton" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full space-y-4">
      <GalleryToolbar
        searchInput={inputValue}
        onSearchChange={setInputValue}
        onShareClipboard={selectedMediaIds.length > 0 ? handleShareBatch : undefined}
        onSlideshow={filteredFiles.length > 0 ? handleStartSlideshow : undefined}
        onImport={() => setImportWizardOpen(true)}
        onCleanupCorrupted={handleCleanupCorrupted}
      />

      {/* P0-03：智能分组面板切换按钮 + P1-01：显示重复开关 */}
      <div className="flex items-center gap-2">
        <button
          className="px-3 py-1.5 text-xs rounded-full transition-all hover:scale-105 flex items-center gap-1"
          style={{
            background: groupPanelOpen ? 'var(--accent)' : 'var(--bg-tertiary)',
            color: groupPanelOpen ? 'white' : 'var(--text-secondary)',
            border: 'none',
            cursor: 'pointer',
            fontWeight: groupPanelOpen ? 600 : 400
          }}
          onClick={() => setGroupPanelOpen((v) => !v)}
          title={t('galleryPage.smartGroupToggle')}
        >
          <span>{t('galleryPage.smartGroup')}</span>
          <span style={{ fontSize: '0.714rem' }}>▼</span>
        </button>
        {/* P1-01：图库默认隐藏 is_duplicate=1，可手动开启查看重复项 */}
        <button
          className="px-3 py-1.5 text-xs rounded-full transition-all hover:scale-105 flex items-center gap-1"
          style={{
            background: showDuplicates ? 'var(--accent)' : 'var(--bg-tertiary)',
            color: showDuplicates ? 'white' : 'var(--text-secondary)',
            border: 'none',
            cursor: 'pointer',
            fontWeight: showDuplicates ? 600 : 400
          }}
          onClick={() => {
            const next = !showDuplicates
            setShowDuplicates(next)
            // 切换后需要重新加载媒体数据以应用新的过滤策略
            // 使用 useRefreshMedia：它封装了 fetchMediaFromDatabase 取数 + 写 store，避免返回值被丢弃
            void refreshMedia()
          }}
          title={
            showDuplicates ? t('galleryPage.showDuplicatesOn') : t('galleryPage.showDuplicatesOff')
          }
        >
          {showDuplicates
            ? t('galleryPage.showDuplicatesChecked')
            : t('galleryPage.showDuplicates')}
        </button>
      </div>

      {/* P0-03：智能分组面板（条件渲染） */}
      {groupPanelOpen && <SmartGroupPanel onClose={() => setGroupPanelOpen(false)} />}

      {/* 文件列表 */}
      {filteredFiles.length === 0 ? (
        <EmptyState
          icon={<IconImage size={64} strokeWidth="1" className="empty-state-icon" />}
          title={t('galleryPage.emptyTitle')}
          subtitle={t('galleryPage.emptySubtitle')}
        />
      ) : (
        <>
          {viewMode === 'grid' && (
            <VirtualImageGrid
              items={filteredFiles}
              selectedIds={selectedMediaIds}
              onSelect={handleGridItemClick}
              onHover={handleGridHover}
              onContextMenu={handleContextMenu}
              onEdit={fileOperations.handleEdit}
              onFavorite={fileOperations.handleToggleFavorite}
              onDelete={handleGridDelete}
              onEndReached={handleEndReached}
              loadingMore={loadingMore}
              hasMore={hasMoreMedia}
            />
          )}
          {viewMode === 'list' && (
            <ListView
              files={filteredFiles}
              selectedIds={selectedMediaIds}
              onSelect={handleGridItemClick}
              onToggleSelection={toggleMediaSelection}
              onContextMenu={handleContextMenu}
            />
          )}
          {viewMode === 'timeline' && (
            <TimelineView
              files={filteredFiles}
              onOpen={fileOperations.handleOpen}
              onContextMenu={handleContextMenu}
            />
          )}
          {viewMode === 'masonry' && (
            <MasonryView
              files={filteredFiles}
              selectedIds={selectedMediaIds}
              onSelect={handleGridItemClick}
              onContextMenu={handleContextMenu}
            />
          )}
          {viewMode === 'event-timeline' && (
            <EventTimelineView
              files={filteredFiles}
              onOpen={fileOperations.handleOpen}
              onContextMenu={handleContextMenu}
            />
          )}
        </>
      )}

      {/* 批量操作工具栏 */}
      {selectedMediaIds.length > 0 && (
        <BatchActions
          count={selectedMediaIds.length}
          total={filteredFiles.length}
          onExport={() => batchOperations.handleBatchExport(false)}
          onMove={batchOperations.handleBatchMove}
          onWatermark={() => batchOperations.setWatermarkDialog(true)}
          onDelete={handleBatchDelete}
          onClear={clearSelection}
          onSelectAll={handleSelectAll}
          onInvertSelection={handleInvertSelection}
          onShareWifi={handleBatchShareWifi}
          onShareClipboard={handleShareBatch}
          onBatchRename={() => batchOperations.setBatchRenameDialog(true)}
          // P1-02：导出到默认文件夹（未配置时主进程返回提示信息）
          onExportToDefault={() => batchOperations.handleBatchExport(true)}
          // P1-04：跨档案转移——传递档案列表与回调
          profiles={profiles}
          onTransferToProfile={batchOperations.handleTransferToProfile}
        />
      )}

      {/* 确认对话框 */}
      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmText={t('galleryPage.confirmOK')}
        cancelText={t('galleryPage.confirmCancel')}
        confirmVariant="danger"
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog((prev) => ({ ...prev, open: false }))}
      />

      {/* 文件属性弹窗（含 EXIF 拍摄参数 + 复制按钮） */}
      <PropertiesDialog
        open={propertiesDialog.open}
        file={propertiesDialog.file}
        onClose={() => setPropertiesDialog({ open: false, file: null })}
      />

      {/* 右键菜单 */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={handleCloseContextMenu}
        />
      )}

      {/* 重命名对话框 */}
      <RenameDialog
        file={renameDialog.file}
        newName={renameDialog.newName}
        onNewNameChange={(newName) => setRenameDialog((prev) => ({ ...prev, newName }))}
        onConfirm={handleRenameConfirm}
        onCancel={() => setRenameDialog({ open: false, file: null, newName: '' })}
      />

      {/* 批量水印对话框 */}
      <WatermarkDialog
        open={batchOperations.watermarkDialog}
        config={batchOperations.watermarkConfig}
        onChange={batchOperations.setWatermarkConfig}
        progress={batchOperations.watermarkProgress}
        processing={batchOperations.watermarking}
        onConfirm={batchOperations.handleBatchWatermark}
        onCancel={() => batchOperations.setWatermarkDialog(false)}
        onCancelTask={batchOperations.handleCancelWatermarkTask}
      />

      {/* T08：WiFi 局域网分享对话框 */}
      <WifiShareDialog
        open={wifiShareDialog.open}
        filePaths={wifiShareDialog.filePaths}
        onClose={() => setWifiShareDialog({ open: false, filePaths: [] })}
      />

      {/* T09：剪贴板分享引导弹窗 */}
      <ShareGuideDialog
        open={shareGuide.open}
        channelId={shareGuide.channelId}
        installed={shareGuide.installed}
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

      {/* T11：幻灯片播放器 */}
      <SlideshowPlayer filteredFiles={filteredFiles} />

      {/* T12：批量重命名对话框 */}
      <BatchRenameDialog
        open={batchOperations.batchRenameDialog}
        files={batchOperations.selectedFiles}
        onClose={() => batchOperations.setBatchRenameDialog(false)}
        onConfirm={batchOperations.handleBatchRename}
      />

      {/* T14：文件导入向导 */}
      <ImportWizard open={importWizardOpen} onClose={() => setImportWizardOpen(false)} />

      {/* 扫描进度浮窗（修复 U-S1：原 ScanProgress 从未被挂载） */}
      <ScanProgress />
    </div>
  )
}
