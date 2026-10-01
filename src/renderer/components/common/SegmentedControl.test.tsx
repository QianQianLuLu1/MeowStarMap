/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SegmentedControl } from './SegmentedControl'

const options = [
  { value: 'grid', label: '网格' },
  { value: 'list', label: '列表' },
  { value: 'timeline', label: '时间线' }
] as const

describe('SegmentedControl', () => {
  it('radiogroup 语义 + 选项 aria-checked', () => {
    render(
      <SegmentedControl options={options} value="list" onChange={vi.fn()} ariaLabel="视图模式" />
    )
    const group = screen.getByRole('radiogroup', { name: '视图模式' })
    expect(group).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '列表' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: '网格' })).toHaveAttribute('aria-checked', 'false')
  })

  it('点击未选中项触发 onChange', () => {
    const onChange = vi.fn()
    render(
      <SegmentedControl options={options} value="grid" onChange={onChange} ariaLabel="视图模式" />
    )
    fireEvent.click(screen.getByRole('radio', { name: '时间线' }))
    expect(onChange).toHaveBeenCalledWith('timeline')
  })

  it('disabled 选项不可点击', () => {
    const onChange = vi.fn()
    render(
      <SegmentedControl
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B', disabled: true }
        ]}
        value="a"
        onChange={onChange}
        ariaLabel="模式"
      />
    )
    fireEvent.click(screen.getByRole('radio', { name: 'B' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('方向键切换到相邻项并移动焦点（roving tabindex：仅 active 项可 Tab 停靠）', () => {
    const onChange = vi.fn()
    render(
      <SegmentedControl options={options} value="list" onChange={onChange} ariaLabel="视图模式" />
    )
    const group = screen.getByRole('radiogroup', { name: '视图模式' })
    const grid = screen.getByRole('radio', { name: '网格' })
    const list = screen.getByRole('radio', { name: '列表' })
    const timeline = screen.getByRole('radio', { name: '时间线' })
    expect(list).toHaveAttribute('tabindex', '0')
    expect(grid).toHaveAttribute('tabindex', '-1')
    expect(timeline).toHaveAttribute('tabindex', '-1')

    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('timeline')
    expect(timeline).toHaveFocus()
  })

  it('首项 ArrowLeft 循环到末项', () => {
    const onChange = vi.fn()
    render(
      <SegmentedControl options={options} value="grid" onChange={onChange} ariaLabel="视图模式" />
    )
    fireEvent.keyDown(screen.getByRole('radiogroup', { name: '视图模式' }), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenCalledWith('timeline')
  })

  it('相邻项 disabled 时方向键跳过至下一个可用项', () => {
    const onChange = vi.fn()
    render(
      <SegmentedControl
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B', disabled: true },
          { value: 'c', label: 'C' }
        ]}
        value="a"
        onChange={onChange}
        ariaLabel="模式"
      />
    )
    fireEvent.keyDown(screen.getByRole('radiogroup', { name: '模式' }), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('c')
  })

  it('方向键在 disabled 组上不触发 onChange', () => {
    const onChange = vi.fn()
    render(
      <SegmentedControl
        options={[
          { value: 'a', label: 'A', disabled: true },
          { value: 'b', label: 'B', disabled: true }
        ]}
        value="a"
        onChange={onChange}
        ariaLabel="模式"
      />
    )
    fireEvent.keyDown(screen.getByRole('radiogroup', { name: '模式' }), { key: 'ArrowRight' })
    fireEvent.keyDown(screen.getByRole('radiogroup', { name: '模式' }), { key: 'ArrowUp' })
    expect(onChange).not.toHaveBeenCalled()
  })
})
