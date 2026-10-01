/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PageHeader } from './PageHeader'

describe('PageHeader', () => {
  it('渲染 h2 标题与副标题', () => {
    render(<PageHeader title="重复文件" subtitle="查找并清理重复照片" />)
    expect(screen.getByRole('heading', { level: 2, name: '重复文件' })).toBeInTheDocument()
    expect(screen.getByText('查找并清理重复照片')).toBeInTheDocument()
  })

  it('图标为装饰性渲染（aria-hidden）', () => {
    render(<PageHeader icon={<span data-testid="icon">◈</span>} title="标题" />)
    expect(screen.getByTestId('icon').closest('span[aria-hidden="true"]')).not.toBeNull()
  })

  it('actions 渲染在操作区', () => {
    render(<PageHeader title="标题" actions={<button type="button">操作</button>} />)
    expect(screen.getByRole('button', { name: '操作' })).toBeInTheDocument()
  })
})
