import React from 'react'

interface IconButtonProps {
  /** 图标节点（如 <IconClose size={18} />） */
  children: React.ReactNode
  /** 点击回调 */
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
  /** aria-label，必须传（无障碍） */
  'aria-label': string
  /** 标题（tooltip） */
  title?: string
  /** 是否禁用 */
  disabled?: boolean
  /** 自定义类名（追加到 icon-btn 之后） */
  className?: string
  /** 按钮类型，默认 'button' */
  type?: 'button' | 'submit' | 'reset'
}

/**
 * 公共图标按钮组件
 *
 * 设计目标：消除 5+ 处重复的
 *   `<button className="icon-btn" aria-label="关闭" onClick={onClose}><IconClose /></button>` 模式，
 *   该模式散落在 ShortcutsModal / ImportWizard / SmartGroupPanel / WatermarkDialog / WifiShareDialog 等组件中。
 *
 * 复用 globals.css 已定义的 `.icon-btn` 类（36x36、hover 缩放、ripple 动画）。
 *
 * 使用方式：
 *   import { IconButton } from '@/components/common/IconButton'
 *   import { IconClose } from '@/icons'
 *   <IconButton aria-label="关闭" onClick={onClose}>
 *     <IconClose size={18} />
 *   </IconButton>
 */
export const IconButton: React.FC<IconButtonProps> = ({
  children,
  onClick,
  'aria-label': ariaLabel,
  title,
  disabled,
  className = '',
  type = 'button'
}) => {
  return (
    <button
      type={type}
      className={`icon-btn ${className}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
    >
      {children}
    </button>
  )
}
