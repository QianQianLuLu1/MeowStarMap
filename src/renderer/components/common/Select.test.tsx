/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Select } from './Select'

describe('Select', () => {
  it('渲染 options 并支持选中值', () => {
    const onChange = vi.fn()
    render(
      <Select
        options={[
          { value: 'zh', label: '简体中文' },
          { value: 'en', label: 'English' }
        ]}
        value="zh"
        onChange={onChange}
        aria-label="语言"
      />
    )
    const select = screen.getByRole('combobox', { name: '语言' })
    expect(select).toHaveValue('zh')
    fireEvent.change(select, { target: { value: 'en' } })
    expect(onChange).toHaveBeenCalled()
  })

  it('disabled 属性透传', () => {
    render(<Select options={[{ value: 'a', label: 'A' }]} disabled aria-label="选项" />)
    expect(screen.getByRole('combobox', { name: '选项' })).toBeDisabled()
  })
})
