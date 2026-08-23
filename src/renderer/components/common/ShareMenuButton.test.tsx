/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ComponentProps } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string }) => {
      if (opts && opts.name) return `${key}:${opts.name}`
      return key
    }
  })
}))

vi.mock('../../icons', () => ({
  IconShare: (p: ComponentProps<'svg'>) => <svg data-testid="icon-share" {...p} />,
  IconWeChat: (p: ComponentProps<'svg'>) => <svg data-testid="icon-wechat" {...p} />,
  IconQQ: (p: ComponentProps<'svg'>) => <svg data-testid="icon-qq" {...p} />,
  IconVivo: (p: ComponentProps<'svg'>) => <svg data-testid="icon-vivo" {...p} />
}))

import { ShareMenuButton } from './ShareMenuButton'

describe('ShareMenuButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('渲染默认按钮文案', () => {
    render(<ShareMenuButton onSelect={vi.fn()} />)
    expect(screen.getByText('share.menu.label')).toBeTruthy()
  })

  it('传入 label 覆盖默认文案', () => {
    render(<ShareMenuButton onSelect={vi.fn()} label="共享" />)
    expect(screen.getByText('共享')).toBeTruthy()
  })

  it('点击按钮切换菜单展开状态', () => {
    render(<ShareMenuButton onSelect={vi.fn()} />)
    const btn = screen.getByRole('button')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
  })

  it('菜单展开后渲染三个渠道（wechat/qq/vivo）', () => {
    render(<ShareMenuButton onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('share.menu.toWechat')).toBeTruthy()
    expect(screen.getByText('share.menu.toQQ')).toBeTruthy()
    expect(screen.getByText('share.menu.toVivo')).toBeTruthy()
  })

  it('点击渠道项触发 onSelect 并关闭菜单', () => {
    const onSelect = vi.fn()
    render(<ShareMenuButton onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('share.menu.toWechat'))
    expect(onSelect).toHaveBeenCalledWith('wechat')
    expect(screen.queryByText('share.menu.toWechat')).toBeNull()
  })

  it('点击 QQ 渠道调用 onSelect("qq")', () => {
    const onSelect = vi.fn()
    render(<ShareMenuButton onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('share.menu.toQQ'))
    expect(onSelect).toHaveBeenCalledWith('qq')
  })

  it('点击 vivo 渠道调用 onSelect("vivo")', () => {
    const onSelect = vi.fn()
    render(<ShareMenuButton onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText('share.menu.toVivo'))
    expect(onSelect).toHaveBeenCalledWith('vivo')
  })

  it('disabled=true 时按钮 disabled', () => {
    render(<ShareMenuButton onSelect={vi.fn()} disabled={true} />)
    const btn = screen.getByRole('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('disabled=true 时点击不展开菜单', () => {
    render(<ShareMenuButton onSelect={vi.fn()} disabled={true} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByText('share.menu.toWechat')).toBeNull()
  })

  it('按下 Escape 关闭展开的菜单', () => {
    render(<ShareMenuButton onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('share.menu.toWechat')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('share.menu.toWechat')).toBeNull()
  })

  it('点击外部关闭展开的菜单', () => {
    render(<ShareMenuButton onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('share.menu.toWechat')).toBeTruthy()
    // 模拟点击菜单外部
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText('share.menu.toWechat')).toBeNull()
  })

  it('size=sm 时按钮应用 px-3 类', () => {
    render(<ShareMenuButton onSelect={vi.fn()} size="sm" />)
    const btn = screen.getByRole('button')
    expect(btn.className).toContain('px-3')
  })

  it('size=md 时按钮应用 px-4 py-2 类', () => {
    render(<ShareMenuButton onSelect={vi.fn()} size="md" />)
    const btn = screen.getByRole('button')
    expect(btn.className).toContain('px-4')
    expect(btn.className).toContain('py-2')
  })

  it('未传 title 时 title 默认为 label', () => {
    render(<ShareMenuButton onSelect={vi.fn()} label="共享" />)
    expect(screen.getByRole('button').getAttribute('title')).toBe('共享')
  })

  it('传入 title 时覆盖默认 title', () => {
    render(<ShareMenuButton onSelect={vi.fn()} title="点击分享" />)
    expect(screen.getByRole('button').getAttribute('title')).toBe('点击分享')
  })

  it('菜单容器 role 为 menu', () => {
    render(<ShareMenuButton onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('菜单项 role 为 menuitem', () => {
    render(<ShareMenuButton onSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getAllByRole('menuitem').length).toBe(3)
  })
})
