/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Tooltip } from './Tooltip'

describe('Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hover 超过延迟后显示提示气泡', () => {
    render(
      <Tooltip content="提示文本">
        <button type="button">触发按钮</button>
      </Tooltip>
    )
    fireEvent.mouseEnter(screen.getByRole('button', { name: '触发按钮' }))
    expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(350)
    })
    expect(screen.getByRole('tooltip')).toHaveTextContent('提示文本')
  })

  it('mouseLeave 后隐藏', () => {
    render(
      <Tooltip content="提示文本" delay={0}>
        <button type="button">触发按钮</button>
      </Tooltip>
    )
    const btn = screen.getByRole('button', { name: '触发按钮' })
    fireEvent.mouseEnter(btn)
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.mouseLeave(btn)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('focus 通道同样触发（键盘可达性）', () => {
    render(
      <Tooltip content="焦点提示" delay={0}>
        <button type="button">触发按钮</button>
      </Tooltip>
    )
    fireEvent.focus(screen.getByRole('button', { name: '触发按钮' }))
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(screen.getByRole('tooltip')).toHaveTextContent('焦点提示')
  })

  it('显示后触发元素通过 aria-describedby 关联气泡 id', () => {
    render(
      <Tooltip content="提示文本" delay={0}>
        <button type="button">触发按钮</button>
      </Tooltip>
    )
    const btn = screen.getByRole('button', { name: '触发按钮' })
    fireEvent.mouseEnter(btn)
    act(() => {
      vi.advanceTimersByTime(10)
    })
    const bubble = screen.getByRole('tooltip')
    expect(bubble.id).toBeTruthy()
    expect(btn).toHaveAttribute('aria-describedby', bubble.id)
  })

  it('Escape 按下立即隐藏气泡（键盘退出通道）', () => {
    render(
      <Tooltip content="提示文本" delay={0}>
        <button type="button">触发按钮</button>
      </Tooltip>
    )
    const btn = screen.getByRole('button', { name: '触发按钮' })
    fireEvent.mouseEnter(btn)
    act(() => {
      vi.advanceTimersByTime(10)
    })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    fireEvent.keyDown(btn, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('content 为空时不渲染任何提示', () => {
    render(
      <Tooltip content="">
        <button type="button">触发按钮</button>
      </Tooltip>
    )
    fireEvent.mouseEnter(screen.getByRole('button', { name: '触发按钮' }))
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
