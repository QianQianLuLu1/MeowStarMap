/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Progress } from './Progress'

describe('Progress', () => {
  it('确定态：value 映射 fill 宽度与 aria-valuenow', () => {
    render(<Progress value={40} aria-label="扫描进度" />)
    const bar = screen.getByRole('progressbar', { name: '扫描进度' })
    expect(bar).toHaveAttribute('aria-valuenow', '40')
    expect(bar.firstElementChild).toHaveStyle({ width: '40%' })
  })

  it('value 越界钳制到 0-100', () => {
    render(<Progress value={150} aria-label="进度" />)
    expect(screen.getByRole('progressbar', { name: '进度' })).toHaveAttribute(
      'aria-valuenow',
      '100'
    )
  })

  it('不定态：无 aria-valuenow 且容器 aria-busy', () => {
    render(<Progress indeterminate aria-label="处理中" />)
    const bar = screen.getByRole('progressbar', { name: '处理中' })
    expect(bar).toHaveAttribute('aria-busy', 'true')
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(bar.firstElementChild?.className).toContain('progress-bar-fill-indeterminate')
  })
})
