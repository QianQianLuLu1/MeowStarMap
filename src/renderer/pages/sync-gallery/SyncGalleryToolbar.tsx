import React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/common/Button'
import { IconSync, IconRotateCw, IconInfo } from '../../icons'
import type { NikkiSyncRuntimeStateInfo } from '../../../shared/types/electron-api'

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
 * 只做两件事——重新取数（刷新）与触发扫描（`nikkisync.startScan`）。扫描是惰性的：
 * `runtime-manager.scan()` 内部按需建会话，因此不必先判断「是否已启动」。
 *
 * 同步服务（LAN 侧）的启停刻意**不放**在这里：那是设置页 `sync-sections` 的职责，
 * 两处各摆一个开关会让用户分不清「到底在哪里打开」。
 */
export const SyncGalleryToolbar: React.FC<SyncGalleryToolbarProps> = ({
  runtimeState,
  onRefresh,
  onScan,
  scanning,
  onOpenDetail,
  detailDisabled
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
    </div>
  )
}
