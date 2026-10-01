import React from 'react'
import { cn } from '../../utils/cn'

export interface ProgressProps {
  /** 进度值 0-100；传入即为确定态 */
  value?: number
  /** 不定态：任务总量未知时使用（value 被忽略） */
  indeterminate?: boolean
  /** 无障碍标签（如「正在扫描」），建议由宿主容器配合 aria-busy 使用 */
  'aria-label'?: string
  className?: string
}

/**
 * 视觉体系 v3：进度条——`.progress-bar/.progress-bar-fill` 的组件化封装，
 * 新增不定态（progress-bar-fill-indeterminate，纯 transform 动画）。
 *
 * 确定态：value 0-100 映射 fill 宽度，容器 aria-valuemin/max/now；
 * 不定态：容器 aria-busy，读屏以 aria-label 表达「进行中」。
 */
export const Progress: React.FC<ProgressProps> = ({
  value,
  indeterminate = false,
  'aria-label': ariaLabel,
  className
}) => {
  const clamped = Math.max(0, Math.min(100, value ?? 0))

  return (
    <div
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : clamped}
      aria-busy={indeterminate || undefined}
      className={cn('progress-bar', className)}
    >
      {indeterminate ? (
        <div className="progress-bar-fill-indeterminate" />
      ) : (
        <div className="progress-bar-fill" style={{ width: `${clamped}%` }} />
      )}
    </div>
  )
}
