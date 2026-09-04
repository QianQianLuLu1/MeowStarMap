import React from 'react'
import { useTranslation } from 'react-i18next'

/**
 * P1-H：丢失文件角标组件
 * 4 个视图（VirtualImageGrid、MasonryView、ListView、TimelineView/EventTimelineView）
 * 均独立实现丢失角标逻辑，统一抽取为可复用组件
 *
 * 使用示例：
 *   {isMissing && <MissingBadge />}
 *   // 或自定义尺寸
 *   {isMissing && <MissingBadge size="sm" />}
 */

interface MissingBadgeProps {
  /** 尺寸变体：'md' 用于网格/瀑布流，'sm' 用于列表/时间线 */
  size?: 'md' | 'sm'
  /** 角标文本，默认 '已丢失'（md）或 '丢失'（sm） */
  label?: string
}

export const MissingBadge: React.FC<MissingBadgeProps> = ({ size = 'md', label }) => {
  const { t } = useTranslation()
  if (size === 'sm') {
    return (
      <div
        className="absolute top-0 left-0 z-10 px-1 py-0.5 rounded-br text-[0.643rem] font-medium text-white"
        style={{ background: 'color-mix(in srgb, var(--danger) 90%, transparent)' }}
      >
        {label || t('common.missingBadge.labelSm')}
      </div>
    )
  }

  return (
    <div
      className="absolute top-2 left-2 z-10 px-1.5 py-0.5 rounded text-[0.714rem] font-medium text-white"
      style={{ background: 'color-mix(in srgb, var(--danger) 85%, transparent)' }}
    >
      {label || t('common.missingBadge.label')}
    </div>
  )
}
