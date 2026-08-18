import React from 'react'
import { useTranslation } from 'react-i18next'

/**
 * 损坏文件容错：损坏文件角标组件
 *
 * 与 MissingBadge 对称：
 * - MissingBadge 标记 is_missing=true（文件被外部删除）
 * - CorruptedBadge 标记 is_corrupted=true（文件存在但内容无法读取/解码）
 *
 * 视觉策略：橙色而非红色（区分"丢失"与"损坏"），用户可一眼识别文件状态
 *
 * 使用示例：
 *   {isCorrupted && <CorruptedBadge />}
 *   // 或自定义尺寸
 *   {isCorrupted && <CorruptedBadge size="sm" />}
 *   // 显示失败原因 tooltip
 *   {isCorrupted && <CorruptedBadge reason={file.corrupted_reason} />}
 */

interface CorruptedBadgeProps {
  /** 尺寸变体：'md' 用于网格/瀑布流，'sm' 用于列表/时间线 */
  size?: 'md' | 'sm'
  /** 角标文本，默认 '已损坏'（md）或 '损坏'（sm） */
  label?: string
  /** 失败原因摘要（≤200 字符），鼠标 hover 时显示 tooltip */
  reason?: string | null
}

export const CorruptedBadge: React.FC<CorruptedBadgeProps> = ({ size = 'md', label, reason }) => {
  const { t } = useTranslation()
  // title 属性提供原生 tooltip，便于用户查看失败原因而不需要额外 UI 组件
  const title = reason
    ? t('common.corruptedBadge.titleWithReason', { reason })
    : t('common.corruptedBadge.title')

  if (size === 'sm') {
    return (
      <div
        className="absolute top-0 left-0 z-10 px-1 py-0.5 rounded-br text-[0.643rem] font-medium text-white"
        style={{ background: 'color-mix(in srgb, var(--warning, #f59e0b) 90%, transparent)' }}
        title={title}
      >
        {label || t('common.corruptedBadge.labelSm')}
      </div>
    )
  }

  return (
    <div
      className="absolute top-2 left-2 z-10 px-1.5 py-0.5 rounded text-[0.714rem] font-medium text-white"
      style={{ background: 'color-mix(in srgb, var(--warning, #f59e0b) 85%, transparent)' }}
      title={title}
    >
      {label || t('common.corruptedBadge.label')}
    </div>
  )
}
