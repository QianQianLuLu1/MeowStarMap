import React from 'react'
import { useTranslation } from 'react-i18next'

type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg'

const SIZE_CLASS: Record<SpinnerSize, string> = {
  xs: 'w-3 h-3 border',
  sm: 'w-4 h-4 border-2',
  md: 'w-8 h-8 border-2',
  lg: 'w-10 h-10 border-2'
}

interface SpinnerProps {
  /** 尺寸变体，默认 md
   *   - xs: 12px（行内小提示）
   *   - sm: 16px（按钮内/小图标旁）
   *   - md: 32px（页面加载）
   *   - lg: 40px（全屏加载）
   */
  size?: SpinnerSize
  /** 自定义类名（追加到默认类之后） */
  className?: string
  /** 颜色，默认 var(--text-tertiary) */
  color?: string
  /** aria-label，默认 '加载中' */
  'aria-label'?: string
}

/**
 * 公共加载圈组件
 *
 * 设计目标：消除 10+ 处重复的 `border-2 border-current border-t-transparent rounded-full animate-spin` 模式，
 * 该模式散落在 EditorPage / DuplicatesPage / RecycleBinPage / ExifPanel / InfoRowPanel / WifiShareDialog /
 * ScanProgress / ScanButton / FilterPanel / VideoEditor 中，仅尺寸不同。
 *
 * 使用方式：
 *   import { Spinner } from '@/components/common/Spinner'
 *   <Spinner />                    // 默认 md（32px）
 *   <Spinner size="sm" />          // 小尺寸（16px）
 *   <Spinner size="lg" color="var(--accent)" />
 */
export const Spinner: React.FC<SpinnerProps> = ({
  size = 'md',
  className = '',
  color,
  'aria-label': ariaLabel
}) => {
  const { t } = useTranslation()
  const resolvedAriaLabel = ariaLabel ?? t('common.loading')
  return (
    <div
      role="status"
      aria-label={resolvedAriaLabel}
      className={`rounded-full border-current border-t-transparent animate-spin ${SIZE_CLASS[size]} ${className}`}
      style={color ? { color } : undefined}
    />
  )
}
