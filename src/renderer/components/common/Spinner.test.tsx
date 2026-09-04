/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Spinner } from './Spinner'

describe('Spinner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('默认 size=md 渲染 32px 圆圈', () => {
    const { container } = render(<Spinner />)
    const el = container.firstChild as HTMLElement
    expect(el.className).toContain('w-8')
    expect(el.className).toContain('h-8')
  })

  it('size=xs 渲染 12px 圆圈', () => {
    const { container } = render(<Spinner size="xs" />)
    const el = container.firstChild as HTMLElement
    expect(el.className).toContain('w-3')
    expect(el.className).toContain('h-3')
  })

  it('size=sm 渲染 16px 圆圈', () => {
    const { container } = render(<Spinner size="sm" />)
    const el = container.firstChild as HTMLElement
    expect(el.className).toContain('w-4')
    expect(el.className).toContain('h-4')
  })

  it('size=lg 渲染 40px 圆圈', () => {
    const { container } = render(<Spinner size="lg" />)
    const el = container.firstChild as HTMLElement
    expect(el.className).toContain('w-10')
    expect(el.className).toContain('h-10')
  })

  it('role 属性为 status', () => {
    render(<Spinner />)
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('默认 aria-label 为"加载中..."', () => {
    render(<Spinner />)
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('加载中...')
  })

  it('传入 aria-label 覆盖默认', () => {
    render(<Spinner aria-label="正在处理" />)
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('正在处理')
  })

  it('包含 animate-spin 类', () => {
    const { container } = render(<Spinner />)
    expect((container.firstChild as HTMLElement).className).toContain('animate-spin')
  })

  it('未传 color 时 style 为 undefined', () => {
    const { container } = render(<Spinner />)
    expect((container.firstChild as HTMLElement).style.color).toBe('')
  })

  it('传入 color 时设置 style.color', () => {
    const { container } = render(<Spinner color="red" />)
    expect((container.firstChild as HTMLElement).style.color).toBe('red')
  })

  it('传入 className 时附加到默认类名后', () => {
    const { container } = render(<Spinner className="custom-class" />)
    expect((container.firstChild as HTMLElement).className).toContain('custom-class')
  })
})
