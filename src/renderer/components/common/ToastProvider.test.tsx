/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { GlobalToastProvider, useGlobalToast } from './ToastProvider'

function Probe(): React.ReactElement {
  const showMessage = useGlobalToast()
  return (
    <button type="button" onClick={() => showMessage('已保存', 'success')}>
      trigger
    </button>
  )
}

describe('GlobalToastProvider（迁移后）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    // 用例失败时也不能把 fake timers 泄漏给后续用例
    vi.useRealTimers()
  })

  it('context 提供 showMessage 且渲染 Toast 反馈', () => {
    render(
      <GlobalToastProvider>
        <Probe />
      </GlobalToastProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'trigger' }))
    expect(screen.getByText('已保存')).toBeInTheDocument()
    // 3s 自动消失（useToast 默认 duration）
    act(() => {
      vi.advanceTimersByTime(3200)
    })
    expect(screen.queryByText('已保存')).toBeNull()
  })

  it('Provider 外使用 hook 时不抛错（no-op 默认值）', () => {
    expect(() => render(<Probe />)).not.toThrow()
  })
})
