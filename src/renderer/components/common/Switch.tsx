import React from 'react'
import { cn } from '../../utils/cn'

export interface SwitchProps {
  /** 受控选中态 */
  checked: boolean
  /** 切换回调，接收取反后的目标值 */
  onChange: (checked: boolean) => void
  /** 无障碍标签（无可见文案的独立使用场景必填） */
  'aria-label'?: string
  disabled?: boolean
  className?: string
}

/**
 * 视觉体系 v3：独立弹性开关——`.settings-elastic-switch` 的裸控件封装。
 *
 * 与 SettingsToggle（设置行布局：标签 + 描述 + 开关）分工：
 * 本组件只渲染开关本体，用于 FormField 或自定义布局。
 * 按下拉伸、松开过冲回弹的手感由 CSS 类承载（compositor 合成，不触发 React 重渲染）。
 *
 * 无障碍：<button role="switch">，Space/Enter 原生可切换，aria-checked 反映状态。
 */
export const Switch: React.FC<SwitchProps> = ({
  checked,
  onChange,
  'aria-label': ariaLabel,
  disabled,
  className
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={Boolean(checked)}
    aria-label={ariaLabel}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={cn('settings-elastic-switch', className)}
  >
    <span className="settings-elastic-switch-knob" />
  </button>
)
