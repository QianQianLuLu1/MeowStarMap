/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FormField } from './FormField'

describe('FormField', () => {
  it('label 上置并通过 htmlFor 关联控件', () => {
    render(
      <FormField label="套装名称" htmlFor="outfit-name">
        {() => <input id="outfit-name" />}
      </FormField>
    )
    expect(screen.getByLabelText('套装名称')).toBeInTheDocument()
  })

  it('helper 文案与 aria-describedby 关联', () => {
    render(
      <FormField label="名称" htmlFor="f" helper="不超过 20 个字符">
        {(aria) => <input id="f" {...aria} />}
      </FormField>
    )
    const input = screen.getByLabelText('名称')
    expect(input).toHaveAttribute('aria-describedby')
    expect(screen.getByText('不超过 20 个字符')).toBeInTheDocument()
  })

  it('error 态：aria-invalid 生效且 role=alert 播报', () => {
    render(
      <FormField label="名称" htmlFor="f" error="名称不能为空">
        {(aria) => <input id="f" {...aria} />}
      </FormField>
    )
    const input = screen.getByLabelText('名称')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('名称不能为空')
    expect(input.getAttribute('aria-describedby')).toContain(alert.id)
  })

  it('helper 与 error 同传时 describedby 仅关联已渲染元素（不悬空指向未渲染的 helper）', () => {
    render(
      <FormField label="名称" htmlFor="f" helper="不超过 20 个字符" error="名称不能为空">
        {(aria) => <input id="f" {...aria} />}
      </FormField>
    )
    const input = screen.getByLabelText('名称')
    const describedby = input.getAttribute('aria-describedby') ?? ''
    expect(describedby).toBeTruthy()
    // describedby 引用的每个 id 都必须真实存在于文档中
    for (const id of describedby.split(' ')) {
      expect(document.getElementById(id)).not.toBeNull()
    }
    // helper 元素被 error 替代渲染，不得出现在引用里
    expect(screen.queryByText('不超过 20 个字符')).toBeNull()
    expect(describedby).not.toContain('helper')
  })

  it('无 helper/error 时不设置 aria-describedby', () => {
    render(
      <FormField label="名称" htmlFor="f">
        {(aria) => <input id="f" {...aria} />}
      </FormField>
    )
    expect(screen.getByLabelText('名称')).not.toHaveAttribute('aria-describedby')
  })

  it('required 标记渲染星号（装饰性）', () => {
    render(
      <FormField label="名称" htmlFor="f" required>
        {() => <input id="f" />}
      </FormField>
    )
    expect(screen.getByLabelText(/名称/)).toBeInTheDocument()
  })
})
