/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'

// 隔离 BaseDialog（依赖 useFocusTrap、motion 等）
vi.mock('./BaseDialog', () => ({
  BaseDialog: ({
    open,
    onClose,
    children,
    ariaLabelledby
  }: {
    open: boolean
    onClose: () => void
    children?: ReactNode
    ariaLabelledby?: string
  }) =>
    open ? (
      <div role="dialog" aria-labelledby={ariaLabelledby} data-testid="base-dialog">
        <button data-testid="close-trigger" onClick={onClose}>
          close
        </button>
        {children}
      </div>
    ) : null
}))

import { ConfirmDialog } from './ConfirmDialog'

describe('ConfirmDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('open=false 时不渲染', () => {
    const { container } = render(
      <ConfirmDialog
        open={false}
        title="标题"
        message="消息"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('open=true 时渲染标题与消息文案', () => {
    render(
      <ConfirmDialog
        open={true}
        title="删除确认"
        message="确定要删除吗？"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText('删除确认')).toBeTruthy()
    expect(screen.getByText('确定要删除吗？')).toBeTruthy()
  })

  it('未传 confirmText 时按钮显示默认"确认"', () => {
    render(
      <ConfirmDialog
        open={true}
        title="标题"
        message="消息"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText('确认')).toBeTruthy()
  })

  it('传入 confirmText 时按钮显示自定义文案', () => {
    render(
      <ConfirmDialog
        open={true}
        title="标题"
        message="消息"
        confirmText="确定删除"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText('确定删除')).toBeTruthy()
  })

  it('未传 cancelText 时按钮显示默认"取消"', () => {
    render(
      <ConfirmDialog
        open={true}
        title="标题"
        message="消息"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText('取消')).toBeTruthy()
  })

  it('传入 cancelText 时按钮显示自定义文案', () => {
    render(
      <ConfirmDialog
        open={true}
        title="标题"
        message="消息"
        cancelText="返回"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText('返回')).toBeTruthy()
  })

  it('confirmVariant=primary 时确认按钮使用 btn-primary 类', () => {
    render(
      <ConfirmDialog
        open={true}
        title="标题"
        message="消息"
        confirmVariant="primary"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    const confirmBtn = screen.getByText('确认')
    expect(confirmBtn.className).toContain('btn-primary')
  })

  it('confirmVariant=danger 时确认按钮使用 btn-danger 类', () => {
    render(
      <ConfirmDialog
        open={true}
        title="标题"
        message="消息"
        confirmVariant="danger"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    const confirmBtn = screen.getByText('确认')
    expect(confirmBtn.className).toContain('btn-danger')
  })

  it('点击确认按钮触发 onConfirm', () => {
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog
        open={true}
        title="标题"
        message="消息"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('确认'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('点击取消按钮触发 onCancel', () => {
    const onCancel = vi.fn()
    render(
      <ConfirmDialog
        open={true}
        title="标题"
        message="消息"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />
    )
    fireEvent.click(screen.getByText('取消'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('消息支持换行（whitespace-pre-line）', () => {
    render(
      <ConfirmDialog
        open={true}
        title="标题"
        message={'第一行\n第二行'}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    const messageEl = screen.getByText(/第一行/)
    expect(messageEl.className).toContain('whitespace-pre-line')
  })

  it('ariaLabelledby 指向标题元素 id', () => {
    render(
      <ConfirmDialog
        open={true}
        title="标题"
        message="消息"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-labelledby')).toBe('confirm-title')
    expect(screen.getByText('标题').id).toBe('confirm-title')
  })
})
