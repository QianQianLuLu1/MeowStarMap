import React from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '../components/common/EmptyState'
import { IconMessage } from '../icons'

/**
 * 共鸣录占位页：即将上线，暂不含业务内容。
 * 复用既有 EmptyState 与图标体系，居中展示四段固定文案：
 *   品牌（resonance.brand）/ 板块名（resonance.title）/ 功能描述+状态（resonance.subtitle）
 */
export const ResonanceRecordsPage: React.FC = () => {
  const { t } = useTranslation()
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4">
      <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
        {t('resonance.brand')}
      </p>
      <EmptyState
        icon={<IconMessage size={48} />}
        title={t('resonance.title')}
        subtitle={t('resonance.subtitle')}
      />
    </div>
  )
}
