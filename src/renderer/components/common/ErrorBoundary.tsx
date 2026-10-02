import React from 'react'
import { ErrorFallback } from './ErrorFallback'

export interface ErrorBoundaryFallbackProps {
  error: Error
  /** 重置错误态并强制子树重新挂载（不刷新 window） */
  reset: () => void
  /** 组件栈信息（ErrorBoundary componentDidCatch 提供） */
  componentStack?: string
  /** 已重试次数（reset 每次调用 +1），供 fallback 判断是否超过上限 */
  retryCount: number
  /** 最大重试次数，达到后 fallback 应给出降级提示而非无限重试 */
  maxRetries: number
}

interface ErrorBoundaryProps {
  children: React.ReactNode
  /**
   * 当这些值变化时重置错误态（路由级用于切换页面时自动恢复）
   * 行为类似 react-error-boundary 的 resetKeys
   */
  resetKeys?: unknown[]
  /**
   * 自定义 fallback 组件。不传则用默认全屏 ErrorFallback（根边界兜底用）
   * fallback 组件内部可使用 hooks（如 useTranslation）
   */
  fallback?: React.FC<ErrorBoundaryFallbackProps>
  /**
   * 最大重试次数。达到上限后 fallback 收到 retryCount>=maxRetries，
   * 应渲染降级提示而非无限「重试」按钮。仅对传了 fallback 的区域/路由级边界有意义。
   */
  maxRetries?: number
}

interface ErrorBoundaryState {
  hasError: boolean
  error?: Error
  componentStack?: string
  // 递增 key：重试时让 BoundaryChildren 重新挂载，从而清空子树内部状态
  retryCount: number
}

/**
 * P0-2 / P0-4：ErrorBoundary
 * 捕获子组件渲染过程中的同步异常，避免白屏
 *
 * 三种用法：
 * 1. 根边界（main.tsx）：不传 resetKeys/fallback，用默认全屏 ErrorFallback + reload 兜底
 * 2. 路由级：传 resetKeys=[currentView] + fallback，切换页面时自动重置
 * 3. 区域级：传 fallback，仅替换出错区域
 *
 * 注意：ErrorBoundary 无法捕获事件处理器、异步代码、setInterval 中的错误，
 * 这些由 window.onerror 和 window.addEventListener('unhandledrejection') 兜底
 */

// children 的包装组件：本身不产生 DOM，仅利用 key 变化触发子树整体重新挂载
const BoundaryChildren: React.FC<{ children: React.ReactNode }> = ({ children }) => <>{children}</>

// resetKeys 浅比较：逐项 Object.is
const areResetKeysEqual = (a?: unknown[], b?: unknown[]): boolean => {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false
  }
  return true
}

// eslint-disable-next-line no-restricted-syntax -- React Error Boundary 必须使用 class 组件（依赖 componentDidCatch / getDerivedStateFromError 生命周期），函数式组件目前无法替代
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, retryCount: 0 }
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const componentStack = info.componentStack || undefined
    this.setState({ componentStack })

    // 上报到主进程 faults 日志
    try {
      window.electronAPI?.log?.reportRendererError({
        message: error.message,
        stack: error.stack,
        componentStack,
        source: 'ErrorBoundary'
      })
    } catch {
      // IPC 不可用时无法上报，忽略
    }
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    // 错误态下若 resetKeys 变化（如路由切换），自动重置以便重新渲染子树
    if (this.state.hasError && !areResetKeysEqual(this.props.resetKeys, prevProps.resetKeys)) {
      this.resetBoundary()
    }
  }

  // 重置错误态并递增 retryCount，强制子树重新挂载（不刷新 window）
  resetBoundary = (): void => {
    this.setState((s) => ({
      hasError: false,
      error: undefined,
      componentStack: undefined,
      retryCount: s.retryCount + 1
    }))
  }

  // 根边界兜底重试：重置 + 刷新页面（仅 main.tsx 根节点使用，保留原有 reload 行为）
  handleRetry = (): void => {
    this.resetBoundary()
    if (typeof window !== 'undefined') {
      window.location.reload()
    }
  }

  render(): React.ReactNode {
    const { hasError, error, componentStack, retryCount } = this.state
    if (hasError && error) {
      if (this.props.fallback) {
        const Fallback = this.props.fallback
        return (
          <Fallback
            error={error}
            reset={this.resetBoundary}
            componentStack={componentStack}
            retryCount={retryCount}
            maxRetries={this.props.maxRetries ?? 3}
          />
        )
      }
      return (
        <ErrorFallback error={error} onRetry={this.handleRetry} componentStack={componentStack} />
      )
    }
    return <BoundaryChildren key={retryCount}>{this.props.children}</BoundaryChildren>
  }
}
