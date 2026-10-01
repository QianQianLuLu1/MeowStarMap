import React from 'react'
import { IconCheck } from '../../icons'
import { cn } from '../../utils/cn'

export interface CheckboxProps {
  /** 受控选中态 */
  checked: boolean
  /** 切换回调，接收取反后的目标值 */
  onChange: (checked: boolean) => void
  /** 无障碍标签（无可见文案时必填） */
  'aria-label'?: string
  /** 右侧可见标签文本（提供时整体变为可点击的 label 区域） */
  label?: string
  disabled?: boolean
  className?: string
}

/**
 * 视觉体系 v3：通用圆形勾选框——由 MediaCheckbox（媒体卡片专用，含事件阻断）
 * 泛化而来的表单级控件，不含卡片场景的 stopPropagation 行为。
 *
 * 视觉：圆形 + accent 填充选中态 + scaleIn 落点动画，颜色全部走令牌。
 * 无障碍：role="checkbox" + aria-checked；有可见 label 时以 <label> 包裹整块可点击。
 */
export const Checkbox: React.FC<CheckboxProps> = ({
  checked,
  onChange,
  'aria-label': ariaLabel,
  label,
  disabled,
  className
}) => {
  const box = (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex flex-shrink-0 items-center justify-center rounded-full transition-all',
        className
      )}
      style={{
        width: 20,
        height: 20,
        border: checked ? '1px solid var(--accent)' : '1px solid var(--divider)',
        background: checked ? 'var(--accent)' : 'var(--bg-primary)',
        color: 'var(--text-on-accent)',
        boxShadow: checked ? 'var(--shadow-xs)' : 'none',
        animation: checked ? 'scaleIn 150ms ease-out' : undefined
      }}
    >
      {checked && <IconCheck size={12} strokeWidth={3} />}
    </span>
  )

  const control = (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      // 有可见 label 时同样显式命名：button 处于 <label> 内时
      // 包裹式 label 的名称计算不稳定（jsdom/读屏表现不一），显式 aria-label 最可靠
      aria-label={label ?? ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
    >
      {box}
      {label && (
        <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
          {label}
        </span>
      )}
    </button>
  )

  // 有可见 label 时用 <label> 关联（点击文字同样切换），无障碍语义更完整
  return label ? <label className="inline-flex">{control}</label> : control
}
