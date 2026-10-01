/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Button } from './Button'

describe('Button', () => {
  it('渲染默认 secondary 变体并响应点击', () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>保存</Button>)
    const btn = screen.getByRole('button', { name: '保存' })
    expect(btn.className).toContain('btn-secondary')
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('primary 变体应用 btn-primary 类', () => {
    render(<Button variant="primary">确定</Button>)
    expect(screen.getByRole('button', { name: '确定' }).className).toContain('btn-primary')
  })

  it('loading 态禁用点击并带 aria-busy', () => {
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        提交
      </Button>
    )
    const btn = screen.getByRole('button', { name: /提交/ })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('sm 尺寸应用 btn-sm 修饰类', () => {
    render(<Button size="sm">小</Button>)
    expect(screen.getByRole('button', { name: '小' }).className).toContain('btn-sm')
  })

  it('icon 以 aria-hidden 装饰性渲染', () => {
    render(<Button icon={<span data-testid="icon">▶</span>}>播放</Button>)
    const icon = screen.getByTestId('icon')
    expect(icon.parentElement).toHaveAttribute('aria-hidden', 'true')
  })
})
