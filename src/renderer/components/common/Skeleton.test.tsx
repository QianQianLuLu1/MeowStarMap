/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Skeleton, SkeletonGrid, SkeletonList, SkeletonDetail } from './Skeleton'

describe('Skeleton', () => {
  it('默认 rect 变体渲染 .skeleton 基类', () => {
    const { container } = render(<Skeleton className="w-10 h-10" />)
    const el = container.firstChild as HTMLElement
    expect(el.className).toContain('skeleton')
    expect(el.className).toContain('w-10')
  })

  it('text 变体为 h-4 全圆角文本条', () => {
    const { container } = render(<Skeleton variant="text" />)
    expect((container.firstChild as HTMLElement).className).toContain('h-4')
    expect((container.firstChild as HTMLElement).className).toContain('rounded-full')
  })

  it('circle 变体为圆形', () => {
    const { container } = render(<Skeleton variant="circle" />)
    expect((container.firstChild as HTMLElement).className).toContain('rounded-full')
  })
})

describe('SkeletonGrid', () => {
  it('默认渲染 12 个 square 占位，role=status 标注加载语义', () => {
    render(<SkeletonGrid />)
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('加载中...')
    expect(screen.getByRole('status').children.length).toBe(12)
  })

  it('count 越界钳制到 1–50', () => {
    const { container: under } = render(<SkeletonGrid count={0} />)
    expect(under.querySelectorAll('.skeleton').length).toBe(1)
    const { container: over } = render(<SkeletonGrid count={999} />)
    expect(over.querySelectorAll('.skeleton').length).toBe(50)
  })

  it('aspect=video 渲染 16:9 占位', () => {
    render(<SkeletonGrid count={2} aspect="video" />)
    expect(document.querySelector('.aspect-video')).toBeTruthy()
  })
})

describe('SkeletonList', () => {
  it('默认渲染 3 行组卡，rows 越界钳制到 1–10', () => {
    render(<SkeletonList />)
    expect(document.querySelectorAll('.glass-panel').length).toBe(3)
    const { container } = render(<SkeletonList rows={99} />)
    expect(container.querySelectorAll('.glass-panel').length).toBe(10)
  })

  it('装饰性内容对辅助技术隐藏', () => {
    const { container } = render(<SkeletonList rows={1} />)
    expect((container.firstChild as HTMLElement).getAttribute('aria-hidden')).toBe('true')
  })
})

describe('SkeletonDetail', () => {
  it('渲染左媒体区 + 右信息面板结构', () => {
    const { container } = render(<SkeletonDetail />)
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(3)
    expect(container.querySelectorAll('.glass-panel').length).toBe(2)
  })
})
