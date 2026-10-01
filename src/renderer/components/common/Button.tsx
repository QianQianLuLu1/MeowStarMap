import React from 'react'
import { Spinner } from './Spinner'
import { cn } from '../../utils/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
export type ButtonSize = 'sm' | 'md' | 'lg'

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  danger: 'btn-danger',
  ghost: 'btn-ghost'
}

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'btn-sm',
  md: '',
  lg: 'btn-lg'
}

export interface ButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'className'
> {
  /** 视觉变体：primary 主操作 / secondary 次操作 / danger 危险操作 / ghost 弱化文本按钮 */
  variant?: ButtonVariant
  /** 尺寸档位，默认 md */
  size?: ButtonSize
  /** 加载态：显示 Spinner 并禁用点击（仍保留 aria 状态） */
  loading?: boolean
  /** 左侧图标（IconXxx 组件或任意 ReactNode） */
  icon?: React.ReactNode
  /** 占满整行宽度 */
  fullWidth?: boolean
  className?: string
}

/**
 * 视觉体系 v3：统一按钮组件——`.btn-*` 语义类的组件化封装。
 *
 * 状态反馈由 CSS 类承载（默认/悬停/按下涟漪/聚焦描边/禁用降级均已在
 * globals.css 实现），本组件只负责变体/尺寸/加载态的组合与类型收敛。
 * 新代码一律使用本组件，不再手写 `<button className="btn-primary">`。
 *
 * 无障碍：loading 态设置 aria-busy；图标为纯装饰时请置于 icon prop（自动 aria-hidden）
 * 而非 children。
 */
export const Button: React.FC<ButtonProps> = ({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  fullWidth = false,
  className,
  disabled,
  children,
  type = 'button',
  ...rest
}) => {
  const isDisabled = disabled || loading

  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(VARIANT_CLASS[variant], SIZE_CLASS[size], fullWidth && 'w-full', className)}
      {...rest}
    >
      {loading ? (
        <span className="inline-flex flex-shrink-0" aria-hidden="true">
          <Spinner size="xs" color="currentColor" />
        </span>
      ) : (
        icon && (
          <span className="inline-flex flex-shrink-0" aria-hidden="true">
            {icon}
          </span>
        )
      )}
      {children}
    </button>
  )
}
