/**
 * @layer L3
 * @module src/renderer/hooks/useFocusTrap
 * @coverage 焦点陷阱 + Tab 循环 + Esc 关闭 + 焦点恢复
 * @dependencies react, document
 * @remarks jsdom 环境，渲染真实 DOM 元素验证焦点行为
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { cleanup } from '@testing-library/react'
import { useFocusTrap } from './useFocusTrap'

function renderContainer(buttons: string[] = ['OK', 'Cancel']) {
  const html = `<div data-testid="trap">${buttons
    .map((label) => `<button>${label}</button>`)
    .join('')}</div>`
  document.body.innerHTML = html
  return document.querySelector<HTMLDivElement>('[data-testid="trap"]')!
}

describe('useFocusTrap', () => {
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  describe('containerRef 返回', () => {
    it('返回可挂载到元素的 ref', () => {
      const { result } = renderHook(() => useFocusTrap<HTMLDivElement>({ active: false }))
      expect(result.current).toBeDefined()
      expect(result.current.current).toBeNull()
    })
  })

  describe('active=false', () => {
    it('不注册 keydown 监听器', () => {
      const { result } = renderHook(() => useFocusTrap<HTMLDivElement>({ active: false }))
      const container = renderContainer()
      result.current.current = container
      // active=false 时不应触发 Esc 关闭
      const onEscape = vi.fn()
      const { rerender } = renderHook(
        (props: { active: boolean }) =>
          useFocusTrap<HTMLDivElement>({ active: props.active, onEscape }),
        { initialProps: { active: false } }
      )
      rerender({ active: false })
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      expect(onEscape).not.toHaveBeenCalled()
    })
  })

  describe('active=true 初始聚焦', () => {
    it('激活时聚焦第一个可聚焦元素', () => {
      const container = renderContainer()
      const { result, rerender } = renderHook(
        (props: { active: boolean }) => useFocusTrap<HTMLDivElement>({ active: props.active }),
        { initialProps: { active: false } }
      )
      result.current.current = container
      rerender({ active: true })
      const firstButton = container.querySelector('button')
      expect(document.activeElement).toBe(firstButton)
    })

    it('initialFocusRef 优先于默认查询', () => {
      const container = renderContainer()
      const initial = document.createElement('button')
      initial.textContent = 'initial'
      container.appendChild(initial)
      const initialFocusRef = { current: initial }
      const { result, rerender } = renderHook(
        (props: { active: boolean }) =>
          useFocusTrap<HTMLDivElement>({
            active: props.active,
            initialFocusRef
          }),
        { initialProps: { active: false } }
      )
      result.current.current = container
      rerender({ active: true })
      expect(document.activeElement).toBe(initial)
    })
  })

  describe('Esc 键关闭', () => {
    it('按 Esc 触发 onEscape 回调', () => {
      const container = renderContainer()
      const onEscape = vi.fn()
      const { result, rerender } = renderHook(
        (props: { active: boolean; onEscape: () => void }) =>
          useFocusTrap<HTMLDivElement>({
            active: props.active,
            onEscape: props.onEscape
          }),
        { initialProps: { active: false, onEscape } }
      )
      result.current.current = container
      rerender({ active: true, onEscape })
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      expect(onEscape).toHaveBeenCalledTimes(1)
    })

    it('onEscape 变化不影响监听器注册（ref 模式）', () => {
      const container = renderContainer()
      const onEscape1 = vi.fn()
      const onEscape2 = vi.fn()
      const { result, rerender } = renderHook(
        (props: { active: boolean; onEscape: () => void }) =>
          useFocusTrap<HTMLDivElement>({
            active: props.active,
            onEscape: props.onEscape
          }),
        { initialProps: { active: false, onEscape: onEscape1 } }
      )
      // 先设置容器再激活，确保 effect 注册 keydown 监听
      result.current.current = container
      rerender({ active: true, onEscape: onEscape1 })
      rerender({ active: true, onEscape: onEscape2 })
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      expect(onEscape2).toHaveBeenCalledTimes(1)
      expect(onEscape1).not.toHaveBeenCalled()
    })
  })

  describe('Tab 循环', () => {
    it('Tab 在最后元素时跳回第一个', () => {
      const container = renderContainer(['A', 'B', 'C'])
      const { result, rerender } = renderHook(
        (props: { active: boolean }) => useFocusTrap<HTMLDivElement>({ active: props.active }),
        { initialProps: { active: false } }
      )
      result.current.current = container
      rerender({ active: true })
      const buttons = container.querySelectorAll('button')
      const last = buttons[buttons.length - 1]
      last.focus()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: false }))
      expect(document.activeElement).toBe(buttons[0])
    })

    it('Shift+Tab 在第一元素时跳到最后', () => {
      const container = renderContainer(['A', 'B', 'C'])
      const { result, rerender } = renderHook(
        (props: { active: boolean }) => useFocusTrap<HTMLDivElement>({ active: props.active }),
        { initialProps: { active: false } }
      )
      result.current.current = container
      rerender({ active: true })
      const buttons = container.querySelectorAll('button')
      buttons[0].focus()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }))
      expect(document.activeElement).toBe(buttons[buttons.length - 1])
    })

    it('非 Tab/Escape 键不触发任何行为', () => {
      const container = renderContainer()
      const onEscape = vi.fn()
      const { result, rerender } = renderHook(
        (props: { active: boolean; onEscape: () => void }) =>
          useFocusTrap<HTMLDivElement>({
            active: props.active,
            onEscape: props.onEscape
          }),
        { initialProps: { active: false, onEscape } }
      )
      result.current.current = container
      rerender({ active: true, onEscape })
      const initialFocus = document.activeElement
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      expect(onEscape).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(initialFocus)
    })
  })

  describe('焦点恢复', () => {
    it('active 从 true 切到 false 时恢复原焦点', () => {
      // 在容器外放一个按钮，记录为原焦点
      document.body.innerHTML =
        '<button id="outside">Outside</button><div data-testid="trap"><button>Inside</button></div>'
      const outside = document.getElementById('outside') as HTMLButtonElement
      const container = document.querySelector<HTMLDivElement>('[data-testid="trap"]')!
      outside.focus()
      expect(document.activeElement).toBe(outside)

      const { result, rerender } = renderHook(
        (props: { active: boolean }) => useFocusTrap<HTMLDivElement>({ active: props.active }),
        { initialProps: { active: false } }
      )
      result.current.current = container
      rerender({ active: true })
      // 此时焦点应在容器内
      expect(document.activeElement).not.toBe(outside)
      // 切回 false
      rerender({ active: false })
      expect(document.activeElement).toBe(outside)
    })
  })
})
