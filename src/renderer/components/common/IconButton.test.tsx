/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { IconButton } from './IconButton'

describe('IconButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('渲染子节点', () => {
    render(
      <IconButton aria-label="关闭">
        <span data-testid="icon">✕</span>
      </IconButton>
    )
    expect(screen.getByTestId('icon')).toBeTruthy()
  })

  it('默认 type=button', () => {
    render(
      <IconButton aria-label="操作">
        <span />
      </IconButton>
    )
    expect(screen.getByLabelText('操作').getAttribute('type')).toBe('button')
  })

  it('type=submit 透传到 button', () => {
    render(
      <IconButton aria-label="提交" type="submit">
        <span />
      </IconButton>
    )
    expect(screen.getByLabelText('提交').getAttribute('type')).toBe('submit')
  })

  it('type=reset 透传到 button', () => {
    render(
      <IconButton aria-label="重置" type="reset">
        <span />
      </IconButton>
    )
    expect(screen.getByLabelText('重置').getAttribute('type')).toBe('reset')
  })

  it('aria-label 透传到 button', () => {
    render(
      <IconButton aria-label="删除">
        <span />
      </IconButton>
    )
    expect(screen.getByLabelText('删除')).toBeTruthy()
  })

  it('title 透传到 button', () => {
    render(
      <IconButton aria-label="提示" title="点击查看详情">
        <span />
      </IconButton>
    )
    expect(screen.getByLabelText('提示').getAttribute('title')).toBe('点击查看详情')
  })

  it('未传 disabled 时 button 可点击', () => {
    const onClick = vi.fn()
    render(
      <IconButton aria-label="操作" onClick={onClick}>
        <span />
      </IconButton>
    )
    fireEvent.click(screen.getByLabelText('操作'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('disabled=true 时 button disabled 属性为 true', () => {
    render(
      <IconButton aria-label="操作" disabled>
        <span />
      </IconButton>
    )
    expect((screen.getByLabelText('操作') as HTMLButtonElement).disabled).toBe(true)
  })

  it('disabled=true 时点击不触发 onClick', () => {
    const onClick = vi.fn()
    render(
      <IconButton aria-label="操作" disabled onClick={onClick}>
        <span />
      </IconButton>
    )
    fireEvent.click(screen.getByLabelText('操作'))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('onClick 接收 MouseEvent 参数', () => {
    const onClick = vi.fn()
    render(
      <IconButton aria-label="操作" onClick={onClick}>
        <span />
      </IconButton>
    )
    fireEvent.click(screen.getByLabelText('操作'))
    expect(onClick.mock.calls[0][0]).toBeDefined()
    expect(onClick.mock.calls[0][0].type).toBe('click')
  })

  it('传入 className 时附加到 icon-btn 之后', () => {
    render(
      <IconButton aria-label="操作" className="extra-class">
        <span />
      </IconButton>
    )
    const btn = screen.getByLabelText('操作')
    expect(btn.className).toContain('icon-btn')
    expect(btn.className).toContain('extra-class')
  })

  it('未传 onClick 时点击不报错', () => {
    expect(() => {
      render(
        <IconButton aria-label="操作">
          <span />
        </IconButton>
      )
      fireEvent.click(screen.getByLabelText('操作'))
    }).not.toThrow()
  })
})
