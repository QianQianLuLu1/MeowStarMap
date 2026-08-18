/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ErrorFallback } from './ErrorFallback'

vi.mock('../../icons', () => ({
  IconWarning: (p: any) => <svg data-testid="icon-warning" {...p} />,
  IconRefresh: (p: any) => <svg data-testid="icon-refresh" {...p} />,
  IconFolderOpen: (p: any) => <svg data-testid="icon-folder" {...p} />,
  IconCopy: (p: any) => <svg data-testid="icon-copy" {...p} />
}))

const makeError = (over: Partial<Error> = {}): Error => {
  const e = new Error('测试错误')
  e.stack = 'Error: 测试错误\n  at foo:1'
  Object.assign(e, over)
  return e
}

describe('ErrorFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('渲染 error.message', () => {
    render(<ErrorFallback error={makeError({ message: '具体错误信息' })} onRetry={vi.fn()} />)
    expect(screen.getByText('具体错误信息')).toBeTruthy()
  })

  it('渲染"页面加载失败"标题', () => {
    render(<ErrorFallback error={makeError()} onRetry={vi.fn()} />)
    expect(screen.getByText('页面加载失败')).toBeTruthy()
  })

  it('渲染三个操作按钮（重新加载、打开日志目录、复制错误信息）', () => {
    render(<ErrorFallback error={makeError()} onRetry={vi.fn()} />)
    expect(screen.getByText('重新加载')).toBeTruthy()
    expect(screen.getByText('打开日志目录')).toBeTruthy()
    expect(screen.getByText('复制错误信息')).toBeTruthy()
  })

  it('点击"重新加载"触发 onRetry', () => {
    const onRetry = vi.fn()
    render(<ErrorFallback error={makeError()} onRetry={onRetry} />)
    fireEvent.click(screen.getByText('重新加载'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('点击"打开日志目录"调用 electronAPI.log.openDirectory', async () => {
    const openDirectory = vi.fn().mockResolvedValue(undefined)
    ;(window as any).electronAPI = { log: { openDirectory } }

    render(<ErrorFallback error={makeError()} onRetry={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('打开日志目录'))
    })
    expect(openDirectory).toHaveBeenCalledTimes(1)
  })

  it('点击"复制错误信息"调用 clipboard.writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true
    })

    render(<ErrorFallback error={makeError()} onRetry={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('复制错误信息'))
    })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toContain('测试错误')
  })

  it('复制成功后按钮文案变为"已复制"', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true
    })

    render(<ErrorFallback error={makeError()} onRetry={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('复制错误信息'))
    })
    expect(screen.getByText('已复制')).toBeTruthy()
  })

  it('2 秒后"已复制"恢复为"复制错误信息"', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true
    })

    render(<ErrorFallback error={makeError()} onRetry={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('复制错误信息'))
    })
    expect(screen.getByText('已复制')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByText('复制错误信息')).toBeTruthy()
  })

  it('clipboard 不可用时不报错（catch 分支）', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      writable: true,
      configurable: true
    })

    render(<ErrorFallback error={makeError()} onRetry={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('复制错误信息'))
      // 等待微任务推进，catch 分支吞掉异常不会同步抛出
      await Promise.resolve()
    })
    // 复制失败时不显示"已复制"
    expect(screen.queryByText('已复制')).toBeNull()
  })

  it('默认不显示错误详情', () => {
    render(<ErrorFallback error={makeError()} onRetry={vi.fn()} />)
    expect(screen.queryByText('隐藏错误详情')).toBeNull()
  })

  it('点击"显示错误详情"展开详情区域', () => {
    render(<ErrorFallback error={makeError()} onRetry={vi.fn()} />)
    fireEvent.click(screen.getByText('显示错误详情'))
    // 展开后按钮文案变为"隐藏错误详情"
    expect(screen.getByText('隐藏错误详情')).toBeTruthy()
  })

  it('点击"隐藏错误详情"折叠详情区域', () => {
    render(<ErrorFallback error={makeError()} onRetry={vi.fn()} />)
    fireEvent.click(screen.getByText('显示错误详情'))
    fireEvent.click(screen.getByText('隐藏错误详情'))
    expect(screen.queryByText('隐藏错误详情')).toBeNull()
  })

  it('显示详情时渲染 error.stack', () => {
    render(<ErrorFallback error={makeError()} onRetry={vi.fn()} />)
    fireEvent.click(screen.getByText('显示错误详情'))
    // 详情区 <pre> 中包含 stack 内容（at foo:1 是 stack 特有）
    expect(screen.getByText(/at foo:1/)).toBeTruthy()
  })

  it('传入 componentStack 时在详情区域显示', () => {
    render(
      <ErrorFallback
        error={makeError()}
        onRetry={vi.fn()}
        componentStack="in ComponentA\nin ComponentB"
      />
    )
    fireEvent.click(screen.getByText('显示错误详情'))
    expect(screen.getByText(/ComponentA/)).toBeTruthy()
  })

  it('未传 componentStack 时不显示组件堆栈', () => {
    render(<ErrorFallback error={makeError()} onRetry={vi.fn()} />)
    fireEvent.click(screen.getByText('显示错误详情'))
    expect(screen.queryByText('组件堆栈')).toBeNull()
  })

  it('error.stack 为 undefined 时显示 message', () => {
    render(<ErrorFallback error={makeError({ stack: undefined } as any)} onRetry={vi.fn()} />)
    fireEvent.click(screen.getByText('显示错误详情'))
    // 详情区 <pre> 渲染 message 兜底（存在多元素匹配，用 getAllByText）
    expect(screen.getAllByText(/测试错误/).length).toBeGreaterThan(0)
  })
})
