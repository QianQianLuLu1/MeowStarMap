import React from 'react'
import { useTranslation } from 'react-i18next'
import { Spinner } from './Spinner'

type EmptyStateStatus = 'empty' | 'loading' | 'error'

interface EmptyStateProps {
  /** 图标（ReactNode，传入 <IconXXX /> 组件）
   *  注意：status='loading' 时忽略此 prop，自动显示 Spinner */
  icon?: React.ReactNode
  /** 主标题
   *  status='loading' 且未传时默认"加载中..."
   *  status='error' 且未传时默认"加载失败" */
  title?: string
  /** 副标题/描述 */
  subtitle?: string
  /** CTA 按钮文案 */
  ctaLabel?: string
  /** CTA 按钮回调 */
  onCta?: () => void
  /** 状态：
   *   - 'empty'（默认）：空态，显示 icon + title + subtitle + cta
   *   - 'loading'：加载中，自动显示 Spinner 替代 icon，标题默认"加载中..."
   *   - 'error'：错误态，CTA 默认显示"重试"按钮（仍可被 ctaLabel 覆盖）
   */
  status?: EmptyStateStatus
  /** 自定义 Spinner 尺寸，默认 'lg' */
  spinnerSize?: 'sm' | 'md' | 'lg'
}

/**
 * U-S6：统一空态组件
 * 用于 4 处空态结构（DetailPage / EditorPage / DuplicatesPage / RecycleBinPage）
 * P0-2：CTA 按钮改用 CSS transition 实现 hover/active 微交互（原 motion.button 触发 React 19 警告）
 *
 * 扩展：支持 loading / error 三态，消除 DuplicatesPage 等 5+ 处手写的
 * "loading/empty/error 三态切换"重复模式。
 *
 * 使用方式：
 *   // 空态（默认）
 *   <EmptyState title="暂无文件" subtitle="点击导入按钮添加" ctaLabel="导入" onCta={onImport} />
 *
 *   // 加载中
 *   <EmptyState title="加载中..." status="loading" />
 *
 *   // 错误态
 *   <EmptyState title="加载失败" subtitle={errMsg} status="error" ctaLabel="重试" onCta={reload} />
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  subtitle,
  ctaLabel,
  onCta,
  status = 'empty',
  spinnerSize = 'lg'
}) => {
  const { t } = useTranslation()
  // loading 态：标题默认"加载中..."（除非显式传入 title），强制显示 Spinner 替代 icon
  const isLoading = status === 'loading'
  const isError = status === 'error'
  const displayTitle =
    title || (isLoading ? t('common.loading') : isError ? t('common.loadFailed') : '')
  const displayCtaLabel = isError && !ctaLabel ? t('common.retry') : ctaLabel

  return (
    <div
      className="flex flex-col items-center justify-center h-full gap-2"
      style={{ color: 'var(--text-tertiary)' }}
    >
      {isLoading ? (
        <div className="mb-2">
          <Spinner size={spinnerSize} />
        </div>
      ) : (
        icon && <div className="mb-2 opacity-60">{icon}</div>
      )}
      <p className="text-base">{displayTitle}</p>
      {subtitle && <p className="text-sm opacity-80">{subtitle}</p>}
      {displayCtaLabel && onCta && (
        <button className="btn-primary mt-4 motion-hover-scale-cta" onClick={onCta}>
          {displayCtaLabel}
        </button>
      )}
    </div>
  )
}
