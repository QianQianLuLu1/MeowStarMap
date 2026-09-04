/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ComponentProps } from 'react'

// motion/react 已在 tests/setup.ts 全局 mock（剥离 whileHover/whileTap/layout 等 props）

// 隔离 useFocusTrap hook（依赖 DOM focus API）
vi.mock('../../hooks/useFocusTrap', () => ({
  useFocusTrap: () => ({ current: null })
}))

// 隔离动画预设
vi.mock('../../utils/motionPresets', () => ({
  fadeVariants: {},
  scaleFadeVariants: {},
  fastFade: {},
  springSoft: {},
  slideUpVariants: {},
  slideDownVariants: {}
}))

// 隔离图标
vi.mock('../../icons', () => ({
  IconClose: (props: { size?: number }) => <svg data-testid="icon-close" width={props.size ?? 16} />
}))

// 隔离 IconButton
vi.mock('./IconButton', () => ({
  IconButton: ({ children, onClick, ...props }: ComponentProps<'button'>) => (
    <button data-testid="icon-button" onClick={onClick} {...props}>
      {children}
    </button>
  )
}))

import { BaseDialog } from './BaseDialog'

describe('BaseDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('open=false 时不渲染任何内容', () => {
    const { container } = render(
      <BaseDialog open={false} onClose={vi.fn()}>
        <p data-testid="content">内容</p>
      </BaseDialog>
    )
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('content')).toBeNull()
  })

  it('open=true 且仅传 children 时渲染自定义内容', () => {
    render(
      <BaseDialog open={true} onClose={vi.fn()}>
        <p data-testid="content">自定义内容</p>
      </BaseDialog>
    )
    expect(screen.getByTestId('content')).toBeTruthy()
  })

  it('传入 title 时自动渲染标题与关闭按钮', () => {
    render(
      <BaseDialog open={true} onClose={vi.fn()} title="对话框标题">
        <p>内容</p>
      </BaseDialog>
    )
    expect(screen.getByText('对话框标题')).toBeTruthy()
    expect(screen.getByTestId('icon-button')).toBeTruthy()
  })

  it('传入 footer 时渲染底部区域', () => {
    render(
      <BaseDialog open={true} onClose={vi.fn()} footer={<button data-testid="ok">确定</button>}>
        <p>内容</p>
      </BaseDialog>
    )
    expect(screen.getByTestId('ok')).toBeTruthy()
  })

  it('点击关闭按钮触发 onClose', () => {
    const onClose = vi.fn()
    render(
      <BaseDialog open={true} onClose={onClose} title="标题">
        <p>内容</p>
      </BaseDialog>
    )
    fireEvent.click(screen.getByTestId('icon-button'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closeOnOverlayClick=true 时点击遮罩触发 onClose', () => {
    const onClose = vi.fn()
    render(
      <BaseDialog open={true} onClose={onClose} closeOnOverlayClick={true}>
        <p>内容</p>
      </BaseDialog>
    )
    // dialog 容器即遮罩，点击 dialog 自身触发
    const overlay = screen.getByRole('dialog')
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closeOnOverlayClick=false 时点击遮罩不触发 onClose', () => {
    const onClose = vi.fn()
    render(
      <BaseDialog open={true} onClose={onClose} closeOnOverlayClick={false}>
        <p>内容</p>
      </BaseDialog>
    )
    const overlay = screen.getByRole('dialog')
    fireEvent.click(overlay)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('点击内容区不冒泡到遮罩 onClose', () => {
    const onClose = vi.fn()
    render(
      <BaseDialog open={true} onClose={onClose}>
        <p data-testid="inner">内容</p>
      </BaseDialog>
    )
    fireEvent.click(screen.getByTestId('inner'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('设置 ariaLabelledby 时透传到 dialog 元素', () => {
    render(
      <BaseDialog open={true} onClose={vi.fn()} ariaLabelledby="my-title">
        <p>内容</p>
      </BaseDialog>
    )
    expect(screen.getByRole('dialog').getAttribute('aria-labelledby')).toBe('my-title')
  })

  it('设置 aria-modal 为 true', () => {
    render(
      <BaseDialog open={true} onClose={vi.fn()}>
        <p>内容</p>
      </BaseDialog>
    )
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
  })

  it('传入 headerExtra 时在标题右侧渲染额外内容', () => {
    render(
      <BaseDialog
        open={true}
        onClose={vi.fn()}
        title="标题"
        headerExtra={<span data-testid="extra">额外</span>}
      >
        <p>内容</p>
      </BaseDialog>
    )
    expect(screen.getByTestId('extra')).toBeTruthy()
  })

  it('trapFocus=false 时不挂载焦点陷阱 ref', () => {
    render(
      <BaseDialog open={true} onClose={vi.fn()} trapFocus={false}>
        <p>内容</p>
      </BaseDialog>
    )
    // trapFocus=false 时 overlayRef 不传入，组件仍可渲染
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
