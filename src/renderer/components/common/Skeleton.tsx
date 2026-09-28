import React from 'react'
import { useTranslation } from 'react-i18next'

type SkeletonVariant = 'rect' | 'text' | 'circle'

const VARIANT_CLASS: Record<SkeletonVariant, string> = {
  rect: '',
  text: 'h-4 rounded-full',
  circle: 'rounded-full'
}

interface SkeletonProps {
  /** 形状变体，默认 rect（走 .skeleton 的 --radius-sm 圆角）
   *   - rect: 矩形块（卡片/媒体占位）
   *   - text: 单行文本条（h-4 全圆角）
   *   - circle: 圆形（头像/图标占位）
   */
  variant?: SkeletonVariant
  /** 自定义类名（追加到默认类之后，用于覆盖尺寸/圆角/宽高） */
  className?: string
  /** 内联样式（如固定宽高） */
  style?: React.CSSProperties
}

/**
 * 骨架屏基元：复用 globals.css 的 .skeleton 渐变动画类（颜色走 --skeleton-from/to，双主题自适应）。
 * 纯展示组件，无状态无 IPC；reduce-motion 下动画自动静止（globals.css 已有降级规则）。
 *
 * 使用方式：
 *   <Skeleton className="w-24 h-24" />
 *   <Skeleton variant="text" className="w-40" />
 */
export const Skeleton: React.FC<SkeletonProps> = ({ variant = 'rect', className = '', style }) => {
  return <div className={`skeleton ${VARIANT_CLASS[variant]} ${className}`} style={style} />
}

const GRID_CLASS =
  'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4'

interface SkeletonGridProps {
  /** 占位数量，默认 12，越界钳制到 1–50 */
  count?: number
  /** 占位宽高比：square 对齐图库网格，video 对齐回收站/视频卡片，默认 square */
  aspect?: 'square' | 'video'
  /** 网格容器自定义类名 */
  className?: string
}

/**
 * 媒体网格骨架：列数响应式断点与 VirtualImageGrid 一致（2→6 列）。
 * 替代 GalleryPage 等页面内联的 Array.from + skeleton div 重复模式。
 */
export const SkeletonGrid: React.FC<SkeletonGridProps> = ({
  count = 12,
  aspect = 'square',
  className = ''
}) => {
  const { t } = useTranslation()
  const safeCount = Math.min(50, Math.max(1, Math.floor(count) || 1))
  return (
    <div className={`${GRID_CLASS} ${className}`} role="status" aria-label={t('common.loading')}>
      {Array.from({ length: safeCount }).map((_, i) => (
        <Skeleton
          key={i}
          className={`rounded-[var(--radius-md)] ${aspect === 'square' ? 'aspect-square' : 'aspect-video'}`}
        />
      ))}
    </div>
  )
}

interface SkeletonListProps {
  /** 行数，默认 3，越界钳制到 1–10 */
  rows?: number
  /** 容器自定义类名 */
  className?: string
}

/**
 * 卡片列表骨架：组头条 + 两行内容条，供 Duplicates 扫描态等分组列表场景。
 */
export const SkeletonList: React.FC<SkeletonListProps> = ({ rows = 3, className = '' }) => {
  const safeRows = Math.min(10, Math.max(1, Math.floor(rows) || 1))
  return (
    <div className={`space-y-4 ${className}`} aria-hidden="true">
      {Array.from({ length: safeRows }).map((_, i) => (
        <div key={i} className="glass-panel p-4 space-y-3">
          <Skeleton variant="text" className="w-1/3" />
          <Skeleton className="h-16" />
          <Skeleton variant="text" className="w-2/3" />
        </div>
      ))}
    </div>
  )
}

/**
 * 详情页骨架：左媒体区 + 右信息面板（标题条 + 文本行 + 信息卡），对齐 DetailPage 布局。
 */
export const SkeletonDetail: React.FC<{ className?: string }> = ({ className = '' }) => {
  return (
    <div className={`flex gap-5 h-full ${className}`} aria-hidden="true">
      <Skeleton className="flex-[2] h-full rounded-[var(--radius-lg)]" />
      <div className="flex-1 space-y-4 overflow-hidden">
        <Skeleton variant="text" className="w-3/4 h-6" />
        <Skeleton variant="text" className="w-1/2" />
        <div className="glass-panel p-4 space-y-3">
          <Skeleton variant="text" className="w-1/3" />
          <Skeleton variant="text" className="w-full" />
          <Skeleton variant="text" className="w-5/6" />
        </div>
        <div className="glass-panel p-4 space-y-3">
          <Skeleton variant="text" className="w-1/4" />
          <Skeleton className="h-20" />
        </div>
      </div>
    </div>
  )
}
