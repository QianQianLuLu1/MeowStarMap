/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'

// i18n stub：返回 key 作为文案，便于断言
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: any) => {
      if (typeof key === 'string' && options && options.label) {
        return `${key}:${options.label}`
      }
      return key
    }
  })
}))

const makeItems = (): ContextMenuItem[] => [
  { id: 'open', label: '打开', onClick: vi.fn() },
  { id: 'copy', label: '复制', onClick: vi.fn() },
  { id: 'delete', label: '删除', danger: true, onClick: vi.fn() },
  { id: 'd1', label: '', divider: true },
  { id: 'disabled', label: '禁用项', disabled: true, onClick: vi.fn() }
]

describe('ContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('渲染所有非 divider 项的按钮', () => {
    render(<ContextMenu x={100} y={100} items={makeItems()} onClose={vi.fn()} />)
    expect(screen.getByText('打开')).toBeTruthy()
    expect(screen.getByText('复制')).toBeTruthy()
    expect(screen.getByText('删除')).toBeTruthy()
    expect(screen.getByText('禁用项')).toBeTruthy()
  })

  it('divider 项渲染为 separator 角色', () => {
    render(<ContextMenu x={100} y={100} items={makeItems()} onClose={vi.fn()} />)
    expect(screen.getByRole('separator')).toBeTruthy()
  })

  it('菜单容器 role 为 menu', () => {
    render(<ContextMenu x={100} y={100} items={makeItems()} onClose={vi.fn()} />)
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('菜单项 role 为 menuitem', () => {
    render(<ContextMenu x={100} y={100} items={makeItems()} onClose={vi.fn()} />)
    expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0)
  })

  it('点击普通菜单项触发 onClick 并关闭菜单', () => {
    const items = makeItems()
    const onClose = vi.fn()
    render(<ContextMenu x={100} y={100} items={items} onClose={onClose} />)
    fireEvent.click(screen.getByText('复制'))
    expect(items[1].onClick).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('点击禁用菜单项不触发 onClick 也不关闭菜单', () => {
    const items = makeItems()
    const onClose = vi.fn()
    render(<ContextMenu x={100} y={100} items={items} onClose={onClose} />)
    const disabledItem = screen.getByText('禁用项').closest('button')!
    fireEvent.click(disabledItem)
    expect(items[4].onClick).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('禁用项的 disabled 属性透传到 button', () => {
    render(<ContextMenu x={100} y={100} items={makeItems()} onClose={vi.fn()} />)
    const disabledBtn = screen.getByText('禁用项').closest('button')!
    expect(disabledBtn.disabled).toBe(true)
  })

  it('danger 项不渲染为 button[disabled]', () => {
    render(<ContextMenu x={100} y={100} items={makeItems()} onClose={vi.fn()} />)
    const dangerBtn = screen.getByText('删除').closest('button')!
    expect(dangerBtn.disabled).toBe(false)
  })

  it('按下 Escape 触发 onClose', () => {
    const onClose = vi.fn()
    render(<ContextMenu x={100} y={100} items={makeItems()} onClose={onClose} />)
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    document.dispatchEvent(event)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('点击菜单外部触发 onClose', () => {
    const onClose = vi.fn()
    render(<ContextMenu x={100} y={100} items={makeItems()} onClose={onClose} />)
    const event = new MouseEvent('mousedown', { bubbles: true })
    document.body.dispatchEvent(event)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('右键按下不触发 onClose（避免与 contextmenu 事件冲突）', () => {
    const onClose = vi.fn()
    render(<ContextMenu x={100} y={100} items={makeItems()} onClose={onClose} />)
    const event = new MouseEvent('mousedown', { button: 2, bubbles: true })
    document.body.dispatchEvent(event)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('按下 ArrowDown 后 ArrowUp 不报错', () => {
    render(<ContextMenu x={100} y={100} items={makeItems()} onClose={vi.fn()} />)
    expect(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    }).not.toThrow()
  })

  it('按下 Enter 触发当前项 onClick', () => {
    const items = makeItems()
    const onClose = vi.fn()
    render(<ContextMenu x={100} y={100} items={items} onClose={onClose} />)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(items[0].onClick).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('按下 Space 触发当前项 onClick', () => {
    const items = makeItems()
    const onClose = vi.fn()
    render(<ContextMenu x={100} y={100} items={items} onClose={onClose} />)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(items[0].onClick).toHaveBeenCalledTimes(1)
  })

  it('包含 submenu 的项渲染 ▶ 标记', () => {
    const items: ContextMenuItem[] = [
      {
        id: 'share',
        label: '分享',
        submenu: [{ id: 'wechat', label: '微信', onClick: vi.fn() }]
      }
    ]
    render(<ContextMenu x={100} y={100} items={items} onClose={vi.fn()} />)
    expect(screen.getByText('▶')).toBeTruthy()
  })

  it('点击父菜单项不触发 onClose，仅切换子菜单', () => {
    const items: ContextMenuItem[] = [
      {
        id: 'share',
        label: '分享',
        submenu: [{ id: 'wechat', label: '微信', onClick: vi.fn() }]
      }
    ]
    const onClose = vi.fn()
    render(<ContextMenu x={100} y={100} items={items} onClose={onClose} />)
    fireEvent.click(screen.getByText('分享'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('点击子菜单项触发其 onClick 并关闭父菜单', () => {
    const subOnClick = vi.fn()
    const items: ContextMenuItem[] = [
      {
        id: 'share',
        label: '分享',
        submenu: [{ id: 'wechat', label: '微信', onClick: subOnClick }]
      }
    ]
    const onClose = vi.fn()
    render(<ContextMenu x={100} y={100} items={items} onClose={onClose} />)
    fireEvent.mouseEnter(screen.getByText('分享'))
    fireEvent.click(screen.getByText('微信'))
    expect(subOnClick).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('items 为空数组时仍渲染菜单容器', () => {
    const { container } = render(<ContextMenu x={0} y={0} items={[]} onClose={vi.fn()} />)
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(container).toBeTruthy()
  })

  it('设置 icon 时渲染在菜单项中', () => {
    const items: ContextMenuItem[] = [
      {
        id: 'open',
        label: '打开',
        icon: <span data-testid="custom-icon">📷</span>,
        onClick: vi.fn()
      }
    ]
    render(<ContextMenu x={100} y={100} items={items} onClose={vi.fn()} />)
    expect(screen.getByTestId('custom-icon')).toBeTruthy()
  })
})
