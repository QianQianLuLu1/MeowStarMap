/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Switch } from './Switch'

describe('Switch', () => {
  it('role=switch 且 aria-checked 反映受控态', () => {
    render(<Switch checked onChange={vi.fn()} aria-label="开关" />)
    expect(screen.getByRole('switch', { name: '开关' })).toHaveAttribute('aria-checked', 'true')
  })

  it('点击回调接收取反后的目标值', () => {
    const onChange = vi.fn()
    render(<Switch checked={false} onChange={onChange} aria-label="开关" />)
    fireEvent.click(screen.getByRole('switch', { name: '开关' }))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('disabled 时不触发回调', () => {
    const onChange = vi.fn()
    render(<Switch checked onChange={onChange} disabled aria-label="开关" />)
    fireEvent.click(screen.getByRole('switch', { name: '开关' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
