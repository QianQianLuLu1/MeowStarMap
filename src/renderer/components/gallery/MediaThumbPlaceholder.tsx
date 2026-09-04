import React from 'react'
import { IconImage, IconVideo, IconWarning } from '../../icons'

interface MediaThumbPlaceholderProps {
  /** 文件类型，决定未出错时显示的图标 */
  fileType: 'image' | 'video'
  /** 是否加载失败（失败时显示 IconWarning） */
  hasError: boolean
  /** 图标尺寸，默认 32 */
  size?: number
  /** overlay = absolute inset-0 居中（网格视图），inline = 无定位（列表视图） */
  variant?: 'overlay' | 'inline'
  /** 控制显隐：true 显示，false 隐藏（有缩略图且未出错时隐藏） */
  visible?: boolean
  /** icon stroke width，默认 '1.5' */
  strokeWidth?: string
}

/**
 * P1-U10：媒体缩略图占位/失败图标
 *
 * 5 个 Gallery 视图原各自实现"根据 hasError / file_type 选择 IconWarning / IconVideo / IconImage"
 * 的逻辑，但分支覆盖不一致（TimelineView/EventTimelineView 漏了 video 分支），统一后自动修复。
 */
export const MediaThumbPlaceholder: React.FC<MediaThumbPlaceholderProps> = ({
  fileType,
  hasError,
  size = 32,
  variant = 'overlay',
  visible = true,
  strokeWidth = '1.5'
}) => {
  if (!visible) return null

  const icon = hasError ? (
    <IconWarning size={size} strokeWidth={strokeWidth} />
  ) : fileType === 'video' ? (
    <IconVideo size={size} strokeWidth={strokeWidth} />
  ) : (
    <IconImage size={size} strokeWidth={strokeWidth} />
  )

  const className =
    variant === 'overlay'
      ? 'absolute inset-0 flex items-center justify-center'
      : 'flex items-center justify-center w-full h-full'

  return (
    <div className={className} style={{ color: 'var(--text-tertiary)' }}>
      {icon}
    </div>
  )
}
