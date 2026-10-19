import React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/common/Button'
import { IconSync, IconRotateCw, IconInfo, IconSettings, IconGithub } from '../../icons'
import type { NikkiSyncRuntimeStateInfo } from '../../../shared/types/electron-api'

/**
 * NikkiSync **上游引擎**仓库，与本应用仓库（`settings/about-sections` 的 `GITHUB_URL`）是两个
 * repo，别「统一」成一个。打开方式沿用既有外链入口：主进程 `shell:openExternal` 通道
 * （`window.open` / `<a target="_blank">` 被 `setWindowOpenHandler` 一律 deny，不可用）。
 */
const NIKKISYNC_REPO_URL = 'https://github.com/ToStardust/NikkiSync'

/** 桥缺失（非授信 origin 下 preload 不暴露任何全局）时静默降级，与其余外链入口同口径。 */
function openNikkiSyncRepo(): void {
  window.electronAPI?.shell?.openExternal?.(NIKKISYNC_REPO_URL)
}

/** 运行态折算给 UI 的三档分组（8 个状态机取值对客户无意义，折叠成可懂的三档）。 */
export type SyncRuntimeGroup = 'ready' | 'degraded' | 'off'

/** 纯函数：状态机 → 展示分组。单测直接覆盖全部 8 个取值。 */
export function toRuntimeGroup(state: NikkiSyncRuntimeStateInfo | null): SyncRuntimeGroup {
  if (state === 'running' || state === 'scanning' || state === 'starting') return 'ready'
  if (state === 'degraded' || state === 'error') return 'degraded'
  return 'off'
}

interface SyncGalleryToolbarProps {
  runtimeState: NikkiSyncRuntimeStateInfo | null
  onRefresh: () => void
  onScan: () => void
  scanning: boolean
  /** 打开当前选中资产的详情抽屉；未选中时按钮禁用 */
  onOpenDetail?: () => void
  detailDisabled?: boolean
  /**
   * 进入板块内的「同步服务」二级子页。可选：调用方不传则不渲染入口，
   * 让加载态分支（本页提前 return，本就没有工具栏）与既有测试保持原样。
   */
  onOpenService?: () => void
}

/** 三档各配一个语义色 token（沿用主题已有变量，不自建 class、不写色值字面量）。 */
const GROUP_TONE: Record<SyncRuntimeGroup, string> = {
  ready: 'text-[var(--success)]',
  degraded: 'text-[var(--warning)]',
  off: 'text-tertiary'
}

/**
 * 阶段 5 · A3：同步图库工具栏。
 *
 * 做三件事——重新取数（刷新）、触发扫描（`nikkisync.startScan`）、以及跳转板块内的
 * 「同步服务」二级子页。扫描是惰性的：`runtime-manager.scan()` 内部按需建会话，
 * 因此不必先判断「是否已启动」。
 *
 * 同步服务（LAN 侧）的启停**不放在这里**，但入口放这里：服务节已从设置页剥离，现由
 * `SyncServicePage`（`navigateTo('sync-service')`）承载。本按钮**只做导航、不放任何开关**，
 * 全应用仍然只有一处能启停同步服务——两处各摆一个开关才会让用户分不清「到底在哪里打开」。
 * 运行时未启动时按钮照常可点：那正是用户最需要进去把它打开的时刻。
 */
export const SyncGalleryToolbar: React.FC<SyncGalleryToolbarProps> = ({
  runtimeState,
  onRefresh,
  onScan,
  scanning,
  onOpenDetail,
  detailDisabled,
  onOpenService
}) => {
  const { t } = useTranslation()
  const group = toRuntimeGroup(runtimeState)

  return (
    <div className="flex items-center gap-3 px-4 py-2">
      <span
        className={`inline-flex items-center gap-1 text-sm font-medium ${GROUP_TONE[group]}`}
        data-runtime-state={runtimeState ?? 'unknown'}
        title={t('syncGallery.toolbar.statusTip')}
      >
        <IconSync size={14} />
        {t(`syncGallery.toolbar.status.${group}`)}
      </span>
      <div className="flex-1" />
      {onOpenDetail ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={onOpenDetail}
          disabled={detailDisabled}
          icon={<IconInfo size={14} />}
          title={t('syncGallery.toolbar.detail')}
        >
          {t('syncGallery.toolbar.detail')}
        </Button>
      ) : null}
      <Button
        variant="secondary"
        size="sm"
        onClick={onRefresh}
        icon={<IconRotateCw size={14} />}
        title={t('syncGallery.toolbar.refresh')}
      >
        {t('syncGallery.toolbar.refresh')}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={onScan}
        loading={scanning}
        title={t('syncGallery.toolbar.scan')}
      >
        {t('syncGallery.toolbar.scan')}
      </Button>
      {onOpenService ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={onOpenService}
          icon={<IconSettings size={14} />}
          title={t('syncGallery.toolbar.service')}
        >
          {t('syncGallery.toolbar.service')}
        </Button>
      ) : null}
      {/* 压尾且无条件渲染：「详情」是条件渲染的，按钮组左端会随选中态漂移；
          而空态（桥没接上、运行时没起来）恰恰是最需要去看上游文档的时刻 */}
      <Button
        variant="secondary"
        size="sm"
        onClick={openNikkiSyncRepo}
        icon={<IconGithub size={14} />}
        title={t('syncGallery.toolbar.about')}
      >
        {t('syncGallery.toolbar.about')}
      </Button>
    </div>
  )
}
