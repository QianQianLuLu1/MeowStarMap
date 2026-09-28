import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '../components/common/EmptyState'
import { SkeletonGrid } from '../components/common/Skeleton'
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
 * 共鸣录页面容器：首次挂载懒加载本地数据（store 去重），顶部按钮组切换四个子页。
 * 加载态走 SkeletonGrid 骨架，错误态走 EmptyState（提供重试 CTA），不白屏不静默。
 */

const TAB_ITEMS: Array<{ id: ResonanceTab; labelKey: string; icon: React.ReactNode }> = [
  { id: 'records', labelKey: 'resonance.tab.records', icon: <IconMessage size={16} /> },
  { id: 'wardrobe', labelKey: 'resonance.tab.wardrobe', icon: <IconOutfit size={16} /> },
  { id: 'import', labelKey: 'resonance.tab.import', icon: <IconImport size={16} /> },
  { id: 'stats', labelKey: 'resonance.tab.stats', icon: <IconStar size={16} /> }
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
    <div className="h-full flex flex-col px-6 py-4 gap-3">
      <div className="flex items-baseline gap-2 flex-shrink-0">
        <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
          {t('resonance.brand')}
        </p>
        <h1 className="text-base font-medium" style={{ color: 'var(--text-primary)' }}>
          {t('resonance.title')}
        </h1>
      </div>
      <div
        className="flex items-center gap-1 flex-shrink-0"
        role="tablist"
        aria-label={t('resonance.title')}
      >
        {TAB_ITEMS.map((item) => {
          const isActive = item.id === activeTab
          return (
            <button
              key={item.id}
              role="tab"
              aria-selected={isActive}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-all"
              style={{
                background: isActive ? 'var(--bg-tertiary)' : 'transparent',
                color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                fontWeight: isActive ? 500 : 400
              }}
              onClick={() => setActiveTab(item.id)}
            >
              {item.icon}
              {t(item.labelKey)}
            </button>
          )
        })}
      </div>
      <div className="flex-1 min-h-0">{renderView()}</div>
    </div>
  )
}
