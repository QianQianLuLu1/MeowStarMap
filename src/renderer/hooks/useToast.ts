import { useCallback, useEffect, useRef, useState } from 'react'

export type ToastType = 'success' | 'error' | 'info'

export interface ToastMessage {
  /** U-G3：唯一 id，用于手动 dismiss 与 React key */
  id: string
  text: string
  type: ToastType
  /** F-S8：可选动作按钮（如"撤销"） */
  action?: {
    label: string
    onClick: () => void | Promise<void>
  }
}

/** U-G3：最多同时显示的 Toast 数量，超出 FIFO 淘汰 */
const MAX_VISIBLE = 3

// U8：移除模块级 toastIdCounter（HMR 后 id 重置导致与已渲染 Toast 的 id 冲突）
// 改用 crypto.randomUUID() 生成全局唯一 id；降级分支用 Date.now()+Math.random() 避免模块状态
function nextToastId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `toast-${crypto.randomUUID()}`
  }
  // 无 crypto.randomUUID 环境的兜底（不依赖模块级变量，HMR 安全）
  return `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function useToast(duration = 3000): {
  messages: ToastMessage[]
  showMessage: (text: string, type?: ToastType, action?: ToastMessage['action']) => void
  /** F-S8：带动作按钮的便捷方法（默认 info 类型，duration 延长至 6s） */
  showMessageWithAction: (
    text: string,
    actionLabel: string,
    onAction: () => void | Promise<void>,
    type?: ToastType
  ) => void
  /** U-G3：手动关闭单条 Toast */
  dismiss: (id: string) => void
  clear: () => void
} {
  const [messages, setMessages] = useState<ToastMessage[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const clearTimer = useCallback((id: string) => {
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id)
      setMessages((prev) => prev.filter((m) => m.id !== id))
    },
    [clearTimer]
  )

  const clear = useCallback(() => {
    timersRef.current.forEach((timer) => clearTimeout(timer))
    timersRef.current.clear()
    setMessages([])
  }, [])

  const showMessage = useCallback(
    (text: string, type: ToastType = 'success', action?: ToastMessage['action']) => {
      const id = nextToastId()
      const msg: ToastMessage = { id, text, type, action }
      setMessages((prev) => {
        // U-G3：堆叠支持，最多显示 MAX_VISIBLE 条，FIFO 淘汰最旧的
        const next = [...prev, msg]
        while (next.length > MAX_VISIBLE) {
          const removed = next.shift()
          if (removed) clearTimer(removed.id)
        }
        return next
      })
      // 带动作按钮的消息显示时间延长至 6s，给用户足够时间点击
      const actualDuration = action ? Math.max(duration, 6000) : duration
      const timer = setTimeout(() => {
        setMessages((prev) => prev.filter((m) => m.id !== id))
        timersRef.current.delete(id)
      }, actualDuration)
      timersRef.current.set(id, timer)
    },
    [duration, clearTimer]
  )

  const showMessageWithAction = useCallback(
    (
      text: string,
      actionLabel: string,
      onAction: () => void | Promise<void>,
      type: ToastType = 'info'
    ) => {
      showMessage(text, type, { label: actionLabel, onClick: onAction })
    },
    [showMessage]
  )

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer))
      timersRef.current.clear()
    }
  }, [])

  return { messages, showMessage, showMessageWithAction, dismiss, clear }
}
