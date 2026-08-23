/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'

vi.mock('./ErrorFallback', () => ({
  ErrorFallback: ({
    error,
    onRetry,
    componentStack
  }: {
    error: Error
    onRetry?: () => void
    componentStack?: string
  }) => (
    <div data-testid="error-fallback">
      <span data-testid="error-message">{error.message}</span>
      <span data-testid="error-stack">{componentStack || ''}</span>
      <button data-testid="retry-btn" onClick={onRetry}>
        重试
      </button>
    </div>
  )
}))

/** electronAPI 测试子集：仅挂 log.reportRendererError */
const setReportAPI = (reportRendererError: () => void): void => {
  ;(
    window as unknown as { electronAPI: { log: { reportRendererError: () => void } } }
  ).electronAPI = { log: { reportRendererError } }
}

const ThrowOnRender: React.FC<{ message?: string }> = ({ message = 'boom' }) => {
  throw new Error(message)
}

const SafeChild: React.FC<{ content: string }> = ({ content }) => (
  <div data-testid="safe-child">{content}</div>
)

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('子组件正常渲染时透传 children', () => {
    render(
      <ErrorBoundary>
        <SafeChild content="hello" />
      </ErrorBoundary>
    )
    expect(screen.getByTestId('safe-child')).toBeTruthy()
    expect(screen.getByText('hello')).toBeTruthy()
  })

  it('子组件抛错时渲染 ErrorFallback', () => {
    // 抑制控制台错误日志（React 在测试中默认会打印错误）
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <ThrowOnRender message="render-crash" />
      </ErrorBoundary>
    )
    expect(screen.getByTestId('error-fallback')).toBeTruthy()
    expect(screen.getByTestId('error-message').textContent).toBe('render-crash')
    spy.mockRestore()
  })

  it('抛错时调用 window.electronAPI.log.reportRendererError', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reportRendererError = vi.fn()
    setReportAPI(reportRendererError)

    render(
      <ErrorBoundary>
        <ThrowOnRender message="will-report" />
      </ErrorBoundary>
    )
    expect(reportRendererError).toHaveBeenCalledTimes(1)
    expect(reportRendererError.mock.calls[0][0].message).toBe('will-report')
    expect(reportRendererError.mock.calls[0][0].source).toBe('ErrorBoundary')
    spy.mockRestore()
  })

  it('点击重试按钮调用 onRetry 重置状态', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reloadMock = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { reload: reloadMock },
      writable: true
    })

    render(
      <ErrorBoundary>
        <ThrowOnRender />
      </ErrorBoundary>
    )
    fireEvent.click(screen.getByTestId('retry-btn'))
    expect(reloadMock).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('electronAPI 不可用时不抛错（容错）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // electronAPI 全局类型本身可选，直接置 undefined 即可
    window.electronAPI = undefined

    expect(() =>
      render(
        <ErrorBoundary>
          <ThrowOnRender />
        </ErrorBoundary>
      )
    ).not.toThrow()
    spy.mockRestore()
  })

  it('reportRendererError 抛错时不影响 fallback 渲染', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    setReportAPI(() => {
      throw new Error('ipc-down')
    })

    expect(() =>
      render(
        <ErrorBoundary>
          <ThrowOnRender message="still-fallback" />
        </ErrorBoundary>
      )
    ).not.toThrow()
    expect(screen.getByTestId('error-message').textContent).toBe('still-fallback')
    spy.mockRestore()
  })
})
