import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState } from '../../components/common/EmptyState'
import { VirtualImageGrid } from '../../components/gallery/VirtualImageGrid'
import { IconSync } from '../../icons'
import { useUIStore } from '../../stores/uiStore'
import { useSyncGalleryStore } from '../../stores/syncGalleryStore'
import { SyncGalleryToolbar } from './SyncGalleryToolbar'
import { SyncAssetDrawer } from './SyncAssetDrawer'
import { ShareCardDialog } from '../../components/sync/ShareCardDialog'
import { extractUserMessage } from '../../../shared/errors/app-error'
import type { NikkiSyncRuntimeStateInfo } from '../../../shared/types/electron-api'
import type { AssetMediaFile } from '../../utils/assetViewModel'

/**
 * 阶段 5 · A3：同步图库一级入口页。
 *
 * 与图库页的关系：两者读同一条取数链（`mediaStore.fetchAssetPage`），但**各持一份列表**
 * （图库 = `mediaStore.mediaFiles`，本页 = `syncGalleryStore.files`）。这不是重复，而是
 * 必须的隔离——图库 keep-alive 常驻且其取数由 `currentView` 驱动，共用一份列表会让两个
 * 数据源互相覆盖。详见 `stores/syncGalleryStore.ts` 头部。
 *
 * 网格的缩略图由 `VirtualImageGrid` 内部的 `useOnDemandThumbnails` 按 `file_path` 生成：
 * 上游从不产出派生缩略图（04-ui-bridge-plan §0.1），所以视图模型里 `thumbnail` 恒空。
 */
export const SyncGalleryPage: React.FC = () => {
  const { t } = useTranslation()
  const { files, loading, loadingMore, hasMore, error, loadFirst, loadMore } = useSyncGalleryStore(
    useShallow((s) => ({
      files: s.files,
      loading: s.loading,
      loadingMore: s.loadingMore,
      hasMore: s.hasMore,
      error: s.error,
      loadFirst: s.loadFirst,
      loadMore: s.loadMore
    }))
  )
  const currentView = useUIStore((s) => s.currentView)
  const openFullscreen = useUIStore((s) => s.openFullscreen)
  const navigateTo = useUIStore((s) => s.navigateTo)

  const [runtimeState, setRuntimeState] = useState<NikkiSyncRuntimeStateInfo | null>(null)
  const [scanning, setScanning] = useState(false)
  /** 最近一次点击的资产：全屏与详情抽屉共用这一个「当前对象」 */
  const [active, setActive] = useState<AssetMediaFile | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)

  const refreshStatus = useCallback(async (): Promise<void> => {
    const api = window.electronAPI?.nikkisync
    if (!api?.getRuntimeStatus) {
      setRuntimeState(null)
      return
    }
    try {
      const status = await api.getRuntimeStatus()
      setRuntimeState(status?.state ?? null)
    } catch {
      // 状态取不到只影响徽标，不打断浏览：保持上一次已知值
      setRuntimeState(null)
    }
  }, [])

  // 每次导航进本页都重新取数 + 取状态（与图库页「视图变化即刷新」同口径）
  useEffect(() => {
    if (currentView !== 'sync-gallery') return
    void loadFirst()
    void refreshStatus()
  }, [currentView, loadFirst, refreshStatus])

  // 扫描完成 / 库变更 ⇒ 重新取第一页；沿用图库页已验证的订阅面
  useEffect(() => {
    const subscribe = window.electronAPI?.nikkisync?.onLibraryChanged
    if (!subscribe) return
    return subscribe(() => {
      void loadFirst()
      void refreshStatus()
    })
  }, [loadFirst, refreshStatus])

  const handleRefresh = useCallback(() => {
    void loadFirst()
    void refreshStatus()
  }, [loadFirst, refreshStatus])

  const handleScan = useCallback(async () => {
    const api = window.electronAPI?.nikkisync
    if (!api?.startScan || scanning) return
    setScanning(true)
    try {
      await api.startScan()
    } catch (e) {
      // 扫描失败只提示，不清空已加载列表
      console.error('[sync-gallery] startScan failed', extractUserMessage(e))
    } finally {
      setScanning(false)
      void refreshStatus()
    }
  }, [scanning, refreshStatus])

  const handleSelect = useCallback(
    (_id: string, index: number) => {
      setActive(files[index] ?? null)
      // 显式带上当前的资产列表：全屏组件默认读 mediaStore（图库那份），本页必须自带
      openFullscreen(index, files)
    },
    [openFullscreen, files]
  )

  // 重新取数/扫描后原选中资产可能已不在表里：清掉，避免详情抽屉显示幽灵资产
  useEffect(() => {
    if (active && !files.some((file) => file.id === active.id)) {
      setActive(null)
      setDetailOpen(false)
    }
  }, [files, active])

  const noop = useCallback(() => undefined, [])

  if (loading && files.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title={t('syncGallery.title')}
          subtitle={t('syncGallery.subtitle')}
          icon={<IconSync size={20} />}
        />
        <EmptyState status="loading" title={t('syncGallery.loading')} />
      </div>
    )
  }

  if (files.length === 0) {
    // 空态必须给**可执行**的下一步，而不是「暂无数据」——见 04-ui-bridge-plan §12
    const bridgeMissing =
      error === 'syncGallery.error.bridgeMissing' || runtimeState === 'unavailable'
    const notRunning =
      runtimeState === null ||
      runtimeState === 'idle' ||
      runtimeState === 'stopping' ||
      bridgeMissing
    const subtitleKey = bridgeMissing
      ? 'syncGallery.empty.linkHint'
      : notRunning
        ? 'syncGallery.empty.runtimeOff'
        : runtimeState === 'degraded'
          ? 'syncGallery.empty.gameRootMissing'
          : 'syncGallery.empty.noAssets'
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title={t('syncGallery.title')}
          subtitle={t('syncGallery.subtitle')}
          icon={<IconSync size={20} />}
        />
        <SyncGalleryToolbar
          runtimeState={runtimeState}
          onRefresh={handleRefresh}
          onScan={handleScan}
          scanning={scanning}
          onOpenService={() => navigateTo('sync-service')}
        />
        <EmptyState
          status={error === 'syncGallery.error.loadFailed' ? 'error' : 'empty'}
          icon={<IconSync size={40} />}
          title={error ? t(error) : t('syncGallery.empty.title')}
          subtitle={t(subtitleKey)}
          ctaLabel={t('syncGallery.empty.retry')}
          onCta={handleRefresh}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('syncGallery.title')}
        subtitle={t('syncGallery.subtitle')}
        icon={<IconSync size={20} />}
      />
      <SyncGalleryToolbar
        runtimeState={runtimeState}
        onRefresh={handleRefresh}
        onScan={handleScan}
        scanning={scanning}
        onOpenDetail={() => setDetailOpen(true)}
        detailDisabled={active === null}
        onOpenService={() => navigateTo('sync-service')}
      />
      {/* 续页失败但已有列表：不能清屏，也不能静默吞掉，给一条行内提示 */}
      {error ? (
        <div className="px-4 py-1 text-sm text-[var(--warning)]" role="status">
          {t(error)}
        </div>
      ) : null}
      <VirtualImageGrid
        items={files}
        selectedIds={[]}
        onSelect={handleSelect}
        onHover={noop}
        onContextMenu={noop}
        onEndReached={loadMore}
        loadingMore={loadingMore}
        hasMore={hasMore}
      />
      <SyncAssetDrawer
        open={detailOpen}
        file={active}
        onClose={() => setDetailOpen(false)}
        onShare={() => setShareOpen(true)}
      />
      <ShareCardDialog open={shareOpen} file={active} onClose={() => setShareOpen(false)} />
    </div>
  )
}
