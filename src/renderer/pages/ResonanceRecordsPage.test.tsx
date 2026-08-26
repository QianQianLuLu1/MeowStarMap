/**
 * @jest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ResonanceRecordsPage } from './ResonanceRecordsPage'

describe('ResonanceRecordsPage', () => {
  it('渲染共鸣录四段文案（品牌/板块名/功能描述+状态）', () => {
    render(<ResonanceRecordsPage />)

    expect(screen.getByText('无限暖暖')).toBeTruthy()
    expect(screen.getByText('暖暖共鸣录')).toBeTruthy()
    expect(screen.getByText('无限暖暖共鸣记录与搭配助手 即将上线')).toBeTruthy()
  })

  it('渲染共鸣录图标（IconMessage）', () => {
    const { container } = render(<ResonanceRecordsPage />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
  })

  it('渲染过程无未捕获错误', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<ResonanceRecordsPage />)).not.toThrow()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
