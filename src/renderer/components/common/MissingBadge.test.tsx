/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MissingBadge } from './MissingBadge'

describe('MissingBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('size=md（默认）渲染"已丢失"文案', () => {
    render(<MissingBadge />)
    expect(screen.getByText('已丢失')).toBeTruthy()
  })

  it('size=sm 渲染"丢失"文案', () => {
    render(<MissingBadge size="sm" />)
    expect(screen.getByText('丢失')).toBeTruthy()
  })

  it('size=md 时传入 label 覆盖默认文案', () => {
    render(<MissingBadge label="缺失" />)
    expect(screen.getByText('缺失')).toBeTruthy()
  })

  it('size=sm 时传入 label 覆盖默认文案', () => {
    render(<MissingBadge size="sm" label="缺失" />)
    expect(screen.getByText('缺失')).toBeTruthy()
  })

  it('size=md 渲染 absolute top-2 left-2 定位类', () => {
    const { container } = render(<MissingBadge />)
    const el = container.firstChild as HTMLElement
    expect(el.className).toContain('absolute')
    expect(el.className).toContain('top-2')
    expect(el.className).toContain('left-2')
  })

  it('size=sm 渲染 absolute top-0 left-0 定位类', () => {
    const { container } = render(<MissingBadge size="sm" />)
    const el = container.firstChild as HTMLElement
    expect(el.className).toContain('absolute')
    expect(el.className).toContain('top-0')
    expect(el.className).toContain('left-0')
  })

  it('size=md 渲染 z-10 层级', () => {
    const { container } = render(<MissingBadge />)
    expect((container.firstChild as HTMLElement).className).toContain('z-10')
  })

  it('size=sm 渲染 z-10 层级', () => {
    const { container } = render(<MissingBadge size="sm" />)
    expect((container.firstChild as HTMLElement).className).toContain('z-10')
  })

  it('size=md 时文本字号为 text-[0.714rem]', () => {
    const { container } = render(<MissingBadge />)
    expect((container.firstChild as HTMLElement).className).toContain('text-[0.714rem]')
  })

  it('size=sm 时文本字号为 text-[0.643rem]', () => {
    const { container } = render(<MissingBadge size="sm" />)
    expect((container.firstChild as HTMLElement).className).toContain('text-[0.643rem]')
  })

  it('size=md 时圆角 rounded', () => {
    const { container } = render(<MissingBadge />)
    expect((container.firstChild as HTMLElement).className).toContain('rounded')
  })

  it('size=sm 时圆角 rounded-br', () => {
    const { container } = render(<MissingBadge size="sm" />)
    expect((container.firstChild as HTMLElement).className).toContain('rounded-br')
  })

  it('文本颜色为白色', () => {
    const { container } = render(<MissingBadge />)
    expect((container.firstChild as HTMLElement).className).toContain('text-white')
  })
})
