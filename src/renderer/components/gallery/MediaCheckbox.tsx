import React from 'react'
import { IconCheck } from '../../icons'

export interface MediaCheckboxProps {
  /** 受控选中态 */
  checked: boolean
  /** 选中态变更回调（已取反后的目标值） */
  onChange: (checked: boolean) => void
  /** 无障碍标签（建议传文件名或 i18n 文案） */
  label?: string
  /** 由父级提供的定位类名（如 `absolute top-2 left-2`） */
  className?: string
}

/**
 * 卡片多选勾选框（网格 / 列表 / 瀑布流 / 时间轴 / 事件时间轴 共用）
 *
 * 关键约束：所有鼠标事件必须 `stopPropagation`。
 * 勾选框浮在卡片之上，若事件冒泡到卡片会连带触发"打开全屏"，
 * 导致用户只想勾选却跳进查看器。
 */
export const MediaCheckbox: React.FC<MediaCheckboxProps> = ({
  checked,
  onChange,
  label,
  className = ''
}) => {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      data-testid="media-checkbox"
      className={className}
      onClick={(e) => {
        stop(e)
        onChange(!checked)
      }}
      onMouseDown={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      style={{
        width: 20,
        height: 20,
        minWidth: 20,
        minHeight: 20,
        padding: 0,
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        border: checked ? '1px solid var(--accent)' : '1px solid var(--divider)',
        background: checked ? 'var(--accent)' : 'rgba(255, 255, 255, 0.78)',
        color: 'var(--text-on-accent, #fff)',
        boxShadow: '0 2px 6px rgba(0, 0, 0, 0.18)',
        backdropFilter: 'blur(4px)',
        transition: 'transform 150ms ease-out, background 150ms ease-out',
        animation: checked ? 'scaleIn 150ms ease-out' : undefined
      }}
    >
      {checked && <IconCheck size={12} strokeWidth={3} data-testid="media-checkbox-icon" />}
    </button>
  )
}
