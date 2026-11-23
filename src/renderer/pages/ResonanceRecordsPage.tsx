import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '../components/common/EmptyState'
import { SkeletonGrid } from '../components/common/Skeleton'
import { PageHeader } from '../components/common/PageHeader'
import { SegmentedControl } from '../components/common/SegmentedControl'
import { ResonanceGateDialog } from '../components/resonance/ResonanceGateDialog'
import { RecordsView } from '../components/resonance/RecordsView'
import { WardrobeView } from '../components/resonance/WardrobeView'
import { ImportExportView } from '../components/resonance/ImportExportView'
import { StatsView } from '../components/resonance/StatsView'
import { IconImport, IconMessage, IconOutfit, IconStar } from '../icons'
import {
  ensureResonanceLoaded,
  useResonanceStore,
  type ResonanceTab
} from '../stores/resonanceStore'
import { useUIStore } from '../stores/uiStore'

/**
 * 共鸣录页面容器：首次挂载懒加载本地数据（store 去重），顶部分段切换器切换四个子页。
 * 加载态走 SkeletonGrid 骨架，错误态走 EmptyState（提供重试 CTA），不白屏不静默。
 * 身份门为页面内局部遮罩（absolute 覆盖本容器），不拦截侧边栏/标题栏；
 * 未确认时切走会随激活态卸载，切回再弹出；确认后本会话不再弹出。
 */

const TAB_OPTIONS: Array<{ id: ResonanceTab; labelKey: string; icon: React.ReactNode }> = [
  { id: 'records', labelKey: 'resonance.tab.records', icon: <IconMessage size={14} /> },
  { id: 'wardrobe', labelKey: 'resonance.tab.wardrobe', icon: <IconOutfit size={14} /> },
  { id: 'import', labelKey: 'resonance.tab.import', icon: <IconImport size={14} /> },
  { id: 'stats', labelKey: 'resonance.tab.stats', icon: <IconStar size={14} /> }
]

export const ResonanceRecordsPage: React.FC = () => {
  const { t } = useTranslation()
  // 身份门：本会话内点过「仍要继续」即视为已确认；未确认时离开页面卸载遮罩，回到本页重新弹出
  const [gateAcknowledged, setGateAcknowledged] = useState(false)
  const isResonanceActive = useUIStore((s) => s.currentView === 'resonance-records')
  const activeTab = useResonanceStore((s) => s.activeTab)
  const setActiveTab = useResonanceStore((s) => s.setActiveTab)
  const loaded = useResonanceStore((s) => s.loaded)
  const loading = useResonanceStore((s) => s.loading)
  const loadError = useResonanceStore((s) => s.loadError)

  useEffect(() => {
    void ensureResonanceLoaded()
  }, [])

  const renderView = () => {
    if (loadError) {
      return (
        <EmptyState
          status="error"
          subtitle={loadError}
          onCta={() => void ensureResonanceLoaded(true)}
        />
      )
    }
    if (!loaded || loading) return <SkeletonGrid count={8} />
    switch (activeTab) {
      case 'records':
        return <RecordsView />
      case 'wardrobe':
        return <WardrobeView />
      case 'import':
        return <ImportExportView />
      case 'stats':
        return <StatsView />
    }
  }

  return (
    <div className="relative z-0 h-full flex flex-col gap-4 overflow-hidden">
      <ResonanceGateDialog
        open={!gateAcknowledged && isResonanceActive}
        onContinue={() => setGateAcknowledged(true)}
      />
      {/* 视觉体系 v3：统一页头（原小字标题行） */}
      <PageHeader
        icon={<IconMessage size={20} />}
        title={t('resonance.title')}
        subtitle={t('resonance.brand')}
      />
      <div className="px-6 flex-shrink-0">
        {/* 视觉体系 v3：统一 SegmentedControl（原手写 tablist） */}
        <SegmentedControl
          options={TAB_OPTIONS.map(({ id, labelKey, icon }) => ({
            value: id,
            label: t(labelKey),
            icon
          }))}
          value={activeTab}
          onChange={setActiveTab}
          ariaLabel={t('resonance.title')}
        />
      </div>
      <div className="flex-1 min-h-0 px-6 pb-4 overflow-hidden">{renderView()}</div>
    </div>
  )
}
