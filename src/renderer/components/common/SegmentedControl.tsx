import React, { useId, useRef } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { springSoft } from '../../utils/motionPresets'
import { cn } from '../../utils/cn'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: React.ReactNode
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
  /** 无障碍组标签（必填，读屏感知用途） */
  ariaLabel: string
  /** sm：紧凑档（工具栏内嵌）；md：默认 */
  size?: 'sm' | 'md'
  className?: string
}

/**
 * 视觉体系 v3：分段切换器（药丸 tab）——当前接入 ResonanceRecordsPage 页签，
 * GalleryPage / DuplicatesPage / SettingsPage 的手写变体待后续统一接入。
 *
 * 交互：active 指示药丸以 motion layoutId 在选项间平滑滑动（springSoft 弹性），
 * reduce-motion 下退化为瞬时切换；hover 有背景反馈，focus-visible 有 accent 描边。
 *
 * 无障碍：radiogroup / radio + aria-checked，方向键与点击均可切换；
 * roving tabindex——仅 active 项可 Tab 停靠，方向键在组内移动并循环、跳过 disabled 项。
 */
const ARROW_DIRS: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
  className
}: SegmentedControlProps<T>) {
  const uid = useId()
  const reduceMotion = useReducedMotion()
  const groupRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const dir = ARROW_DIRS[e.key]
    if (!dir) return
    e.preventDefault()
    const count = options.length
    if (count === 0) return
    const start = options.findIndex((o) => o.value === value)
    for (let step = 1; step <= count; step++) {
      const idx = (((start + dir * step) % count) + count) % count
      const next = options[idx]
      if (!next || next.disabled) continue
      onChange(next.value)
      // roving tabindex 的唯一停靠点随 active 迁移，编程式聚焦新选中项
      const radios = groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
      radios?.[idx]?.focus()
      return
    }
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={cn(
        'inline-flex items-center gap-1 rounded-pill p-1',
        size === 'sm' ? 'text-xs' : 'text-sm',
        className
      )}
      style={{
        background: 'var(--bg-tertiary)',
        border: '1px solid var(--divider)'
      }}
    >
      {options.map((option) => {
        const isActive = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            disabled={option.disabled}
            tabIndex={isActive ? 0 : -1}
            onClick={() => !option.disabled && onChange(option.value)}
            className={cn(
              'relative rounded-pill transition-colors',
              size === 'sm' ? 'px-3 py-1' : 'px-4 py-1.5',
              option.disabled && 'opacity-50 cursor-not-allowed'
            )}
            style={{
              color: isActive
                ? 'var(--text-on-accent)'
                : option.disabled
                  ? 'var(--text-tertiary)'
                  : 'var(--text-secondary)'
            }}
          >
            {isActive && (
              <motion.span
                layoutId={`segmented-pill-${uid}`}
                className="absolute inset-0 rounded-pill"
                style={{ background: 'var(--accent)' }}
                transition={reduceMotion ? { duration: 0 } : springSoft}
                aria-hidden="true"
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-1.5 whitespace-nowrap">
              {option.icon && (
                <span className="inline-flex flex-shrink-0" aria-hidden="true">
                  {option.icon}
                </span>
              )}
              {option.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
