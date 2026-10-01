import React, { forwardRef } from 'react'
import { IconChevronDown } from '../../icons'
import { cn } from '../../utils/cn'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends Omit<
  React.SelectHTMLAttributes<HTMLSelectElement>,
  'className'
> {
  /** 选项数组；也可用 children 自行渲染 <option>（复少数特殊场景） */
  options?: ReadonlyArray<SelectOption>
  className?: string
}

/**
 * 视觉体系 v3：统一下拉选择——`.select` 基类（globals.css）的组件化封装。
 *
 * 保持原生 <select> 行为与可访问性（键盘/读屏/IME 全兼容），仅统一外观：
 * 外观收窄（appearance:none）+ 右侧主题化 chevron 图标 + focus 光环。
 * 替代设置页散落的内联样式 select 与无基类的 .select 类引用。
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ options, className, children, ...rest }, ref) => (
    <span className={cn('relative inline-flex', className)}>
      <select ref={ref} className="select w-full pr-8" {...rest}>
        {options
          ? options.map((opt) => (
              <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </option>
            ))
          : children}
      </select>
      <span
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 inline-flex"
        aria-hidden="true"
        style={{ color: 'var(--text-tertiary)' }}
      >
        <IconChevronDown size={14} />
      </span>
    </span>
  )
)

Select.displayName = 'Select'
