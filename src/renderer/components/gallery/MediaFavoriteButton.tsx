import React from 'react'
import { useTranslation } from 'react-i18next'
import { IconFavorite } from '../../icons'

export interface MediaFavoriteButtonProps {
  /** 受控收藏态（SQLite 布尔 0/1 由调用方 !! 归一化后传入，或依赖 !! 兜底） */
  isFavorite: boolean
  /** 点击切换回调（切换语义由上层 useFavoriteToggle 决定） */
  onToggle: () => void
  /** 无障碍标签（建议传文件名）；缺省时 aria-label 仅用 i18n 动作文案 */
  label?: string
  /** 由父级提供的定位类名（如 `absolute top-2 right-2 z-10`） */
  className?: string
  /** 图标尺寸，默认 16（与网格静态收藏徽标一致） */
  size?: number
}

/**
 * 卡片收藏切换按钮（网格 / 列表 / 瀑布流 / 时间轴 / 事件时间轴 共用）
 *
 * 用途：批量选择模式下每条记录常驻显示收藏状态（实心=已收藏 / 空心=未收藏）
 * 并支持点击即时切换；正常模式下承接原静态收藏徽标（升级为可点击）。
 *
 * 关键约束：所有鼠标事件必须 `stopPropagation`（与 MediaCheckbox 同款）。
 * 按钮浮在卡片之上，若事件冒泡到卡片会连带触发批量勾选或打开全屏。
 */
export const MediaFavoriteButton: React.FC<MediaFavoriteButtonProps> = ({
  isFavorite,
  onToggle,
  label,
  className = '',
  size = 16
}) => {
  const { t } = useTranslation()
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  // SQLite 布尔可能以 0/1 传入：统一归一化，保证 aria-pressed/filled 语义稳定
  const favorite = !!isFavorite
  const actionText = favorite
    ? t('gallery.virtualGrid.unfavoriteTitle')
    : t('gallery.virtualGrid.favoriteTitle')

  return (
    <button
      type="button"
      aria-pressed={favorite}
      aria-label={label ? `${actionText}：${label}` : actionText}
      data-testid="media-favorite"
      className={className}
      onClick={(e) => {
        stop(e)
        onToggle()
      }}
      onMouseDown={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      title={actionText}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 2,
        cursor: 'pointer',
        // 空心态 stroke 走 currentColor：钉住按钮前景色为收藏令牌，
        // 保证空心/实心两态在缩略图上都用同一主题色渲染
        color: 'var(--favorite)'
      }}
    >
      <IconFavorite size={size} filled={favorite} />
    </button>
  )
}
