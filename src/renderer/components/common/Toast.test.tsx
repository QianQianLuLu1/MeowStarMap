/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ToastMessage } from '../../hooks/useToast'

// motion/react 已在 tests/setup.ts 全局 mock（剥离 whileHover/whileTap/layout 等 props）

vi.mock('../../utils/motionPresets', () => ({
  slideUpVariants: {},
  springSoft: {}
}))

vi.mock('../../icons', () => ({
  IconClose: (props: { size?: number }) => <svg data-testid="icon-close" width={props.size ?? 16} />
}))

import { Toast } from './Toast'

const makeMsg = (over: Partial<ToastMessage> = {}): ToastMessage => ({
  id: 'msg-1',
  text: '提示文本',
  type: 'success',
  ...over
})

describe('Toast', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('messages 为空数组时不渲染任何消息项', () => {
    const { container } = render(<Toast messages={[]} />)
    expect(container.querySelectorAll('div[role]')).toHaveLength(0)
  })

  it('messages 单条 success 时以 status 角色渲染', () => {
    render(<Toast messages={[makeMsg({ type: 'success' })]} />)
    const el = screen.getByText('提示文本')
    expect(el.closest('[role]')?.getAttribute('role')).toBe('status')
  })

  it('messages 单条 error 时以 alert 角色渲染', () => {
    render(<Toast messages={[makeMsg({ type: 'error', text: '错误' })]} />)
    const el = screen.getByText('错误')
    expect(el.closest('[role]')?.getAttribute('role')).toBe('alert')
  })

  it('error 消息 aria-live 为 assertive', () => {
    render(<Toast messages={[makeMsg({ type: 'error', text: '错误' })]} />)
    expect(screen.getByText('错误').closest('[role]')?.getAttribute('aria-live')).toBe('assertive')
  })

  it('success 消息 aria-live 为 polite', () => {
    render(<Toast messages={[makeMsg({ type: 'success' })]} />)
    expect(screen.getByText('提示文本').closest('[role]')?.getAttribute('aria-live')).toBe('polite')
  })

  it('info 消息也以 status 角色渲染', () => {
    render(<Toast messages={[makeMsg({ type: 'info', text: '信息' })]} />)
    expect(screen.getByText('信息').closest('[role]')?.getAttribute('role')).toBe('status')
  })

  it('多条消息全部渲染', () => {
    render(
      <Toast
        messages={[
          makeMsg({ id: 'a', text: '消息A' }),
          makeMsg({ id: 'b', text: '消息B' }),
          makeMsg({ id: 'c', text: '消息C' })
        ]}
      />
    )
    expect(screen.getByText('消息A')).toBeTruthy()
    expect(screen.getByText('消息B')).toBeTruthy()
    expect(screen.getByText('消息C')).toBeTruthy()
  })

  it('传入 onDismiss 时渲染关闭按钮', () => {
    render(<Toast messages={[makeMsg()]} onDismiss={vi.fn()} />)
    expect(screen.getByLabelText('关闭')).toBeTruthy()
  })

  it('未传 onDismiss 时不渲染关闭按钮', () => {
    render(<Toast messages={[makeMsg()]} />)
    expect(screen.queryByLabelText('关闭')).toBeNull()
  })

  it('点击关闭按钮触发 onDismiss 并携带消息 id', () => {
    const onDismiss = vi.fn()
    render(<Toast messages={[makeMsg({ id: 'msg-x' })]} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByLabelText('关闭'))
    expect(onDismiss).toHaveBeenCalledWith('msg-x')
  })

  it('消息带 action 时渲染动作按钮', () => {
    render(
      <Toast
        messages={[
          makeMsg({
            action: { label: '撤销', onClick: vi.fn() }
          })
        ]}
        onDismiss={vi.fn()}
      />
    )
    expect(screen.getByText('撤销')).toBeTruthy()
  })

  it('消息无 action 时不渲染动作按钮', () => {
    render(<Toast messages={[makeMsg()]} onDismiss={vi.fn()} />)
    expect(screen.queryByText('撤销')).toBeNull()
  })

  it('点击 action 按钮触发 onClick 并自动 dismiss', () => {
    const onClick = vi.fn()
    const onDismiss = vi.fn()
    render(
      <Toast
        messages={[
          makeMsg({
            id: 'action-id',
            action: { label: '撤销', onClick }
          })
        ]}
        onDismiss={onDismiss}
      />
    )
    fireEvent.click(screen.getByText('撤销'))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledWith('action-id')
  })

  it('设置 zIndex 时透传到容器 style', () => {
    const { container } = render(<Toast messages={[makeMsg()]} zIndex={999} />)
    const outer = container.firstChild as HTMLElement
    expect(outer.style.zIndex).toBe('999')
  })

  it('设置 className 时附加到容器类名', () => {
    const { container } = render(<Toast messages={[]} className="custom-toast" />)
    expect(container.firstChild).toBeTruthy()
    const outer = container.firstChild as HTMLElement
    expect(outer.className).toContain('custom-toast')
  })
})
