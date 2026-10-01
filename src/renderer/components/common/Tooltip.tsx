import React, { useCallback, useRef, useState, useLayoutEffect, useId, cloneElement } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../utils/cn'

type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right'

const GAP = 8
const ARROW_OFFSET = 8

export interface TooltipProps {
  /** 提示文本（纯文本场景；富内容提示请用组件原生 title 或自定义浮层） */
  content: string
  /** 出现方位，默认 top */
  placement?: TooltipPlacement
  /** 显示延迟毫秒数，默认 300 */
  delay?: number
  /** 触发元素（单个可聚焦元素：按钮/图标按钮等） */
  children: React.ReactElement<React.HTMLAttributes<HTMLElement>>
  className?: string
}

/**
 * 视觉体系 v3：统一工具提示——替代散落的原生 `title` 属性（EditorToolbar 等），
 * 提供受控延迟、玻璃面板质感与视口钳制定位（复用 ContextMenu 的钳制模式）。
 *
 * 触发：hover 与 keyboard focus 双通道（纯 hover 提示对键盘用户不可达）；
 * 定位：portal 到 body + useLayoutEffect 边界钳制，z-[95]（介于菜单 90 与弹窗 100 之间）。
 * 降级：无 content 时不渲染任何东西，children 原样透出。
 */
export const Tooltip: React.FC<TooltipProps> = ({
  content,
  placement = 'top',
  delay = 300,
  children,
  className
}) => {
  const [visible, setVisible] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 气泡 id：与触发元素 aria-describedby 建立程序化关联（读屏在 focus 触发时朗读）
  const bubbleId = useId()
  // 触发元素包装层 ref：portal 气泡不在触发元素的 DOM 邻位，
  // 必须经 ref 反查触发元素的几何信息（inline-flex 包装对布局无侵入）
  const triggerWrapRef = useRef<HTMLSpanElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)

  const show = useCallback(() => {
    if (!content) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setVisible(true), delay)
  }, [content, delay])

  const hide = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setVisible(false)
  }, [])

  useLayoutEffect(() => {
    if (!visible) {
      setPosition(null)
      return
    }
    const trigger = triggerWrapRef.current?.firstElementChild as HTMLElement | null
    const bubble = bubbleRef.current
    if (!trigger || !bubble) return
    const tRect = trigger.getBoundingClientRect()
    const bRect = bubble.getBoundingClientRect()
    let left: number
    let top: number
    switch (placement) {
      case 'bottom':
        left = tRect.left + tRect.width / 2 - bRect.width / 2
        top = tRect.bottom + GAP
        break
      case 'left':
        left = tRect.left - bRect.width - GAP
        top = tRect.top + tRect.height / 2 - bRect.height / 2
        break
      case 'right':
        left = tRect.right + GAP
        top = tRect.top + tRect.height / 2 - bRect.height / 2
        break
      case 'top':
      default:
        left = tRect.left + tRect.width / 2 - bRect.width / 2
        top = tRect.top - bRect.height - GAP
    }
    // 视口钳制：上下左右越界均收回 8px 边距内
    left = Math.max(ARROW_OFFSET, Math.min(left, window.innerWidth - bRect.width - ARROW_OFFSET))
    top = Math.max(ARROW_OFFSET, Math.min(top, window.innerHeight - bRect.height - ARROW_OFFSET))
    setPosition({ left, top })
    // content 变化会改变气泡尺寸，可见期间需重新钳制定位
  }, [visible, placement, content])

  // 卸载时清理延迟计时器，避免隐藏后仍弹出
  React.useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    []
  )

  if (!content) return children

  const trigger = cloneElement(children, {
    onMouseEnter: (e: React.MouseEvent) => {
      children.props.onMouseEnter?.(e as React.MouseEvent<HTMLElement>)
      show()
    },
    onMouseLeave: (e: React.MouseEvent) => {
      children.props.onMouseLeave?.(e as React.MouseEvent<HTMLElement>)
      hide()
    },
    onFocus: (e: React.FocusEvent) => {
      children.props.onFocus?.(e as React.FocusEvent<HTMLElement>)
      show()
    },
    onBlur: (e: React.FocusEvent) => {
      children.props.onBlur?.(e as React.FocusEvent<HTMLElement>)
      hide()
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      children.props.onKeyDown?.(e as React.KeyboardEvent<HTMLElement>)
      if (e.key === 'Escape') hide()
    },
    'aria-describedby': children.props['aria-describedby']
      ? `${children.props['aria-describedby']} ${bubbleId}`
      : bubbleId
  })

  return (
    <>
      <span ref={triggerWrapRef} className="inline-flex">
        {trigger}
      </span>
      {visible &&
        createPortal(
          <div
            ref={bubbleRef}
            id={bubbleId}
            role="tooltip"
            className={cn(
              'fixed z-[95] glass-panel px-2.5 py-1.5 text-xs max-w-[280px]',
              className
            )}
            style={{
              left: position?.left ?? -9999,
              top: position?.top ?? -9999,
              color: 'var(--text-primary)',
              pointerEvents: 'none',
              animation: 'fadeIn 150ms ease-out',
              // 首帧渲染在屏外完成测量，position 就绪后落位，避免从 (0,0) 闪烁
              visibility: position ? 'visible' : 'hidden'
            }}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  )
}
