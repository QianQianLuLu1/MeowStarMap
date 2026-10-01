/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Drawer } from './Drawer'

describe('Drawer', () => {
  it('open=false 时不渲染', () => {
    const { container } = render(
      <Drawer open={false} onClose={vi.fn()} title="抽屉">
        <div>内容</div>
      </Drawer>
    )
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('open=true 渲染 dialog 语义与标题', () => {
    render(
      <Drawer open onClose={vi.fn()} title="批量重命名">
        <div>内容</div>
      </Drawer>
    )
    const dialog = screen.getByRole('dialog', { name: '批量重命名' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('点击遮罩触发 onClose', () => {
    const onClose = vi.fn()
    render(
      <Drawer open onClose={onClose} title="抽屉">
        <div>内容</div>
      </Drawer>
    )
    fireEvent.click(screen.getByRole('dialog', { name: '抽屉' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('footer 渲染操作区', () => {
    render(
      <Drawer open onClose={vi.fn()} title="抽屉" footer={<button type="button">确认</button>}>
        <div>内容</div>
      </Drawer>
    )
    expect(screen.getByRole('button', { name: '确认' })).toBeInTheDocument()
  })

  it('两个 Drawer 同时打开时标题 id 互不串号', () => {
    render(
      <>
        <Drawer open onClose={vi.fn()} title="抽屉甲">
          <div>内容</div>
        </Drawer>
        <Drawer open onClose={vi.fn()} title="抽屉乙">
          <div>内容</div>
        </Drawer>
      </>
    )
    // 可访问名称必须各自解析到自己的标题（硬编码共享 id 时第二个会解析到第一个的标题）
    const first = screen.getByRole('dialog', { name: '抽屉甲' })
    const second = screen.getByRole('dialog', { name: '抽屉乙' })
    const label1 = first.getAttribute('aria-labelledby')
    const label2 = second.getAttribute('aria-labelledby')
    expect(label1).toBeTruthy()
    expect(label2).toBeTruthy()
    expect(label1).not.toBe(label2)
    // 各自的 aria-labelledby 精确指向自己面板内的标题元素
    expect(first.querySelector(`[id="${label1}"]`)?.textContent).toBe('抽屉甲')
    expect(second.querySelector(`[id="${label2}"]`)?.textContent).toBe('抽屉乙')
  })
})
