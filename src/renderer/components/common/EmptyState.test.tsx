/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// motion/react 已在 tests/setup.ts 全局 mock（剥离 whileHover/whileTap/layout 等 props）

vi.mock('../../utils/motionPresets', () => ({
  springSoft: {}
}))

vi.mock('./Spinner', () => ({
  Spinner: ({ size }: { size?: 'xs' | 'sm' | 'md' | 'lg' }) => (
    <div data-testid="spinner" data-size={size} />
  )
}))

import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('status=empty（默认）且未传 title 时不渲染标题', () => {
    const { container } = render(<EmptyState />)
    expect(container.querySelector('p')).toBeTruthy()
    // 默认 displayTitle 为空字符串，仍渲染 p 标签但无文本
  })

  it('status=empty 渲染自定义 title 与 subtitle', () => {
    render(<EmptyState title="暂无文件" subtitle="点击导入按钮添加" />)
    expect(screen.getByText('暂无文件')).toBeTruthy()
    expect(screen.getByText('点击导入按钮添加')).toBeTruthy()
  })

  it('status=empty 渲染自定义 icon', () => {
    render(<EmptyState icon={<span data-testid="custom-icon">📷</span>} title="空" />)
    expect(screen.getByTestId('custom-icon')).toBeTruthy()
  })

  it('status=empty 且 ctaLabel+onCta 时渲染 CTA 按钮', () => {
    render(<EmptyState title="空" ctaLabel="导入" onCta={vi.fn()} />)
    expect(screen.getByText('导入')).toBeTruthy()
  })

  it('status=empty 且仅有 ctaLabel 无 onCta 时不渲染 CTA 按钮', () => {
    render(<EmptyState title="空" ctaLabel="导入" />)
    expect(screen.queryByText('导入')).toBeNull()
  })

  it('status=empty 且仅有 onCta 无 ctaLabel 时不渲染 CTA 按钮', () => {
    render(<EmptyState title="空" onCta={vi.fn()} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('点击 CTA 按钮触发 onCta', () => {
    const onCta = vi.fn()
    render(<EmptyState title="空" ctaLabel="导入" onCta={onCta} />)
    fireEvent.click(screen.getByText('导入'))
    expect(onCta).toHaveBeenCalledTimes(1)
  })

  it('status=loading 默认显示"加载中..."标题', () => {
    render(<EmptyState status="loading" />)
    expect(screen.getByText('加载中...')).toBeTruthy()
  })

  it('status=loading 且传 title 时显示自定义 title', () => {
    render(<EmptyState status="loading" title="正在载入数据" />)
    expect(screen.getByText('正在载入数据')).toBeTruthy()
  })

  it('status=loading 显示 Spinner 替代 icon', () => {
    render(<EmptyState status="loading" icon={<span data-testid="should-not-render">📷</span>} />)
    expect(screen.getByTestId('spinner')).toBeTruthy()
    expect(screen.queryByTestId('should-not-render')).toBeNull()
  })

  it('status=loading spinnerSize 透传给 Spinner', () => {
    render(<EmptyState status="loading" spinnerSize="sm" />)
    expect(screen.getByTestId('spinner').getAttribute('data-size')).toBe('sm')
  })

  it('status=error 默认显示"加载失败"标题', () => {
    render(<EmptyState status="error" />)
    expect(screen.getByText('加载失败')).toBeTruthy()
  })

  it('status=error 且未传 ctaLabel 时默认显示"重试"按钮', () => {
    render(<EmptyState status="error" onCta={vi.fn()} />)
    expect(screen.getByText('重试')).toBeTruthy()
  })

  it('status=error 且传 ctaLabel 时覆盖默认"重试"', () => {
    render(<EmptyState status="error" ctaLabel="重新加载" onCta={vi.fn()} />)
    expect(screen.getByText('重新加载')).toBeTruthy()
  })

  it('status=error 时仍渲染 icon', () => {
    render(<EmptyState status="error" icon={<span data-testid="err-icon">⚠️</span>} />)
    expect(screen.getByTestId('err-icon')).toBeTruthy()
  })

  it('icon 容器挂 empty-state-icon 类（柔粉主题柔光动画挂载点）', () => {
    const { container } = render(<EmptyState icon={<span>📷</span>} />)
    expect(container.querySelector('.empty-state-icon')).toBeTruthy()
  })
})
