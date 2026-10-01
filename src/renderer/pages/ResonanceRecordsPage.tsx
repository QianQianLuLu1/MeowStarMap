import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '../components/common/EmptyState'
import { SkeletonGrid } from '../components/common/Skeleton'
import { PageHeader } from '../components/common/PageHeader'
import { SegmentedControl } from '../components/common/SegmentedControl'
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

/**
 * 共鸣录页面容器：首次挂载懒加载本地数据（store 去重），顶部分段切换器切换四个子页。
 * 加载态走 SkeletonGrid 骨架，错误态走 EmptyState（提供重试 CTA），不白屏不静默。
 */

const TAB_OPTIONS: Array<{ id: ResonanceTab; labelKey: string; icon: React.ReactNode }> = [
  { id: 'records', labelKey: 'resonance.tab.records', icon: <IconMessage size={14} /> },
  { id: 'wardrobe', labelKey: 'resonance.tab.wardrobe', icon: <IconOutfit size={14} /> },
  { id: 'import', labelKey: 'resonance.tab.import', icon: <IconImport size={14} /> },
  { id: 'stats', labelKey: 'resonance.tab.stats', icon: <IconStar size={14} /> }
]

export const ResonanceRecordsPage: React.FC = () => {
  const { t } = useTranslation()
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
    <div className="h-full flex flex-col gap-4 overflow-hidden">
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
