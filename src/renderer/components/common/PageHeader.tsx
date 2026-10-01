import React from 'react'
import { cn } from '../../utils/cn'

export interface PageHeaderProps {
  /** 标题左侧图标（IconXxx 组件，装饰性） */
  icon?: React.ReactNode
  /** 页面主标题 */
  title: string
  /** 副标题（一句话说明，可选） */
  subtitle?: string
  /** 右侧操作区（按钮组等） */
  actions?: React.ReactNode
  className?: string
}

/**
 * 视觉体系 v3：统一页面页头——图标 + 标题 + 副标题 + 右侧操作区。
 *
 * 收敛此前三种手写流派（Duplicates/RecycleBin/Outfit 的图标页头栏、
 * Gallery 的工具栏直开、Categories/Settings 的裸 h2），为所有二级页面
 * 提供一致的页头节奏与分隔线。标题语义固定为 h2（页面级，h1 由应用名承担）。
 */
export const PageHeader: React.FC<PageHeaderProps> = ({
  icon,
  title,
  subtitle,
  actions,
  className
}) => (
  <header
    className={cn('flex items-center justify-between gap-4 px-6 py-4', className)}
    style={{ borderBottom: '1px solid var(--divider)' }}
  >
    <div className="flex items-center gap-3 min-w-0">
      {icon && (
        <span
          className="inline-flex flex-shrink-0 items-center justify-center rounded-md p-2"
          aria-hidden="true"
          style={{
            background: 'var(--accent-soft)',
            color: 'var(--accent)'
          }}
        >
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <h2 className="text-lg font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
          {title}
        </h2>
        {subtitle && (
          <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-tertiary)' }}>
            {subtitle}
          </p>
        )}
      </div>
    </div>
    {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
  </header>
)
