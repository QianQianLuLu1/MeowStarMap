/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FloatingActionBar } from './FloatingActionBar'

describe('FloatingActionBar', () => {
  it('以 toolbar 语义渲染（aria-label 必填）且子内容可见', () => {
    render(
      <FloatingActionBar ariaLabel="回收站操作">
        <button type="button">恢复</button>
        <button type="button">删除</button>
      </FloatingActionBar>
    )
    expect(screen.getByRole('toolbar', { name: '回收站操作' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '恢复' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument()
  })

  it('层级 z-40，低于全局 Toast 与任务进度浮层（z-50）', () => {
    render(
      <FloatingActionBar ariaLabel="操作">
        <span>内容</span>
      </FloatingActionBar>
    )
    const toolbar = screen.getByRole('toolbar')
    expect(toolbar.className).toContain('z-40')
    expect(toolbar.className).not.toContain('z-[60]')
  })

  it('className 作用于内层内容行（flex 容器）', () => {
    render(
      <FloatingActionBar ariaLabel="操作" className="gap-3">
        <span>内容</span>
      </FloatingActionBar>
    )
    const toolbar = screen.getByRole('toolbar')
    const row = toolbar.firstElementChild as HTMLElement
    expect(row.className).toContain('gap-3')
  })

  it('scrollable 模式应用细滚动条容器类', () => {
    render(
      <FloatingActionBar ariaLabel="操作" scrollable>
        <span>内容</span>
      </FloatingActionBar>
    )
    expect(screen.getByRole('toolbar').className).toContain('batch-actions-root')
  })

  it('bottomOffset 以内联样式生效', () => {
    render(
      <FloatingActionBar ariaLabel="操作" bottomOffset={60}>
        <span>内容</span>
      </FloatingActionBar>
    )
    expect(screen.getByRole('toolbar')).toHaveStyle({ bottom: '60px' })
  })
})
