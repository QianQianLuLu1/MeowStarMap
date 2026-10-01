/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Checkbox } from './Checkbox'

describe('Checkbox', () => {
  it('role=checkbox 且 aria-checked 反映受控态', () => {
    render(<Checkbox checked onChange={vi.fn()} aria-label="选择" />)
    expect(screen.getByRole('checkbox', { name: '选择' })).toHaveAttribute('aria-checked', 'true')
  })

  it('点击回调接收取反后的目标值', () => {
    const onChange = vi.fn()
    render(<Checkbox checked={false} onChange={onChange} aria-label="选择" />)
    fireEvent.click(screen.getByRole('checkbox', { name: '选择' }))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('提供 label 时以 label 文本关联且可点击切换', () => {
    const onChange = vi.fn()
    render(<Checkbox checked={false} onChange={onChange} label="同步设置" />)
    expect(screen.getByRole('checkbox', { name: '同步设置' })).toBeInTheDocument()
    fireEvent.click(screen.getByText('同步设置'))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('选中态渲染勾选图标', () => {
    render(<Checkbox checked onChange={vi.fn()} aria-label="选择" />)
    expect(screen.getByRole('checkbox', { name: '选择' }).querySelector('svg')).not.toBeNull()
  })
})
