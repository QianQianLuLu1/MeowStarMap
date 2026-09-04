import { useEffect, useRef } from 'react'

interface FocusTrapOptions {
  /** 是否激活焦点陷阱 */
  active: boolean
  /** Esc 键回调（通常为关闭） */
  onEscape?: () => void
  /** 初始聚焦的元素选择器或 ref（默认聚焦第一个可聚焦元素） */
  // React 19 的 useRef<T>(null) 返回 RefObject<T | null>，故需接受 null 联合类型
  initialFocusRef?: React.RefObject<HTMLElement | null>
}

/**
 * 模态框焦点陷阱 hook（修复 U-S8）
 * - 激活时将焦点限制在容器内（Tab/Shift+Tab 循环）
 * - Esc 关闭
 * - 关闭后恢复原焦点
 * - 容器需添加 ref={containerRef}
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(options: FocusTrapOptions) {
  const containerRef = useRef<T>(null)
  const previousActiveRef = useRef<Element | null>(null)
  const { active, initialFocusRef } = options

  // P2-F5：原 effect 依赖 onEscape，调用方每次渲染传新函数引用会触发 effect 重注册
  // 改用 ref 保存最新值，effect 依赖改为 [active, initialFocusRef]，onEscape 变更不重注册
  const onEscapeRef = useRef(options.onEscape)
  useEffect(() => {
    onEscapeRef.current = options.onEscape
  })

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    // 保存原焦点，关闭后恢复
    previousActiveRef.current = document.activeElement

    // 初始聚焦
    const focusTarget =
      initialFocusRef?.current ||
      container.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    focusTarget?.focus()

    const getFocusable = () =>
      container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onEscapeRef.current?.()
        return
      }
      if (e.key !== 'Tab') return
      const focusable = getFocusable()
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      // 恢复原焦点
      if (previousActiveRef.current instanceof HTMLElement) {
        previousActiveRef.current.focus()
      }
    }
  }, [active, initialFocusRef])

  return containerRef
}
