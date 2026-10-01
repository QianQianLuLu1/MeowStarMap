import React, { useId } from 'react'
import { cn } from '../../utils/cn'

export interface FormFieldAria {
  /** 绑定到控件的 aria-invalid（有错误时 true） */
  'aria-invalid': boolean
  /** 绑定到控件的 aria-describedby（helper/error 的 id 组合，无则 undefined） */
  'aria-describedby': string | undefined
}

export interface FormFieldProps {
  /** 字段标签（上置，必填） */
  label: string
  /** 控件 id（与控件元素的 id 一致，用于 label 关联） */
  htmlFor?: string
  /** 必填标记 */
  required?: boolean
  /** 辅助说明（无错误时显示） */
  helper?: string
  /** 错误信息（显示时替代 helper，红色 + 警示语义） */
  error?: string
  className?: string
  /**
   * 控件渲染函数：接收应绑定到控件的 aria 属性（aria-invalid / aria-describedby）。
   * 传入普通 ReactNode 时无法自动关联错误语义，仅建议只读展示场景使用。
   */
  children: (aria: FormFieldAria) => React.ReactNode
}

/**
 * 视觉体系 v3：统一表单字段容器——label 上置 + 控件 + helper/error 下置的标准结构。
 *
 * 补齐项目缺失的字段级校验态：此前校验只有提交时 toast 兜底，无字段级错误呈现。
 * 错误文案以 role="alert" 渲染（读屏即时播报），并经 aria-invalid / aria-describedby
 * 关联到控件。标签点击聚焦控件（htmlFor）。
 *
 * 使用方式：
 *   <FormField label={t('...')} htmlFor="outfit-name" error={errors.name}>
 *     {(aria) => <input id="outfit-name" {...aria} ... />}
 *   </FormField>
 */
export const FormField: React.FC<FormFieldProps> = ({
  label,
  htmlFor,
  required,
  helper,
  error,
  className,
  children
}) => {
  const uid = useId()
  const helperId = helper ? `${uid}-helper` : undefined
  const errorId = error ? `${uid}-error` : undefined
  // error 存在时 helper 元素被替代渲染，describedby 不得指向未渲染的 helper（悬空引用）
  const describedBy = error ? errorId : helperId

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label
        htmlFor={htmlFor}
        className="text-sm font-medium"
        style={{ color: 'var(--text-primary)' }}
      >
        {label}
        {required && (
          <span aria-hidden="true" style={{ color: 'var(--danger)' }}>
            {' *'}
          </span>
        )}
      </label>
      {children({ 'aria-invalid': Boolean(error), 'aria-describedby': describedBy })}
      {error ? (
        <p id={errorId} role="alert" className="text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      ) : helper ? (
        <p id={helperId} className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {helper}
        </p>
      ) : null}
    </div>
  )
}
