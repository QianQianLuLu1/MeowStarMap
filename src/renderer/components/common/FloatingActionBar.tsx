import React from 'react'
import { cn } from '../../utils/cn'

export interface FloatingActionBarProps {
  /** 底部偏移像素（应用状态栏高度 + 间距），默认 44 */
  bottomOffset?: number
  /** 允许横向滚动（批量操作按钮过多时的细滚动条模式） */
  scrollable?: boolean
  /** toolbar 无障碍标签（必填，读屏感知用途） */
  ariaLabel: string
  /** 附加类名，作用于内层内容行（flex 容器）而非定位层 */
  className?: string
  children: React.ReactNode
}

/**
 * 视觉体系 v3：底部浮动操作栏——统一 DuplicatesPage / RecycleBinPage 底部操作栏
 * 共用的容器（GalleryPage BatchActions 因承载横滚与状态计数暂保持独立实现，待后续接入）。
 *
 * 视觉：居中悬浮玻璃卡（slideInBottom 入场）+ 阴影-xl；容器仅负责定位与质感，
 * 操作按钮与状态计数由调用方组合。常驻承载，有操作可执行时由调用方条件渲染。
 * 层级：z-40——必须低于全局 Toast 与任务进度浮层（z-50），保证操作反馈不被底栏遮挡。
 */
export const FloatingActionBar: React.FC<FloatingActionBarProps> = ({
  bottomOffset = 44,
  scrollable = false,
  ariaLabel,
  className,
  children
}) => (
  <div
    className={cn(
      'fixed left-1/2 -translate-x-1/2 z-40 glass-card shadow-xl',
      scrollable && 'batch-actions-root overflow-x-auto scrollbar-hide'
    )}
    style={{
      bottom: `${bottomOffset}px`,
      animation: 'slideInBottom 250ms var(--ease-decelerate) forwards'
    }}
    role="toolbar"
    aria-label={ariaLabel}
  >
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-2',
        scrollable && 'w-max min-w-full',
        className
      )}
    >
      {children}
    </div>
  </div>
)
