/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SliderControl } from './SliderControl'

describe('SliderControl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('渲染 label 文案', () => {
    render(<SliderControl label="亮度" value={0} onChange={vi.fn()} />)
    expect(screen.getByText('亮度')).toBeTruthy()
  })

  it('渲染当前 value 数字', () => {
    render(<SliderControl label="亮度" value={42} onChange={vi.fn()} />)
    expect(screen.getByText('42')).toBeTruthy()
  })

  it('value 透传到 input.value', () => {
    render(<SliderControl label="亮度" value={50} onChange={vi.fn()} />)
    const slider = screen.getByRole('slider') as HTMLInputElement
    expect(slider.value).toBe('50')
  })

  it('默认 min=-100 透传到 input.min', () => {
    render(<SliderControl label="亮度" value={0} onChange={vi.fn()} />)
    expect((screen.getByRole('slider') as HTMLInputElement).min).toBe('-100')
  })

  it('默认 max=100 透传到 input.max', () => {
    render(<SliderControl label="亮度" value={0} onChange={vi.fn()} />)
    expect((screen.getByRole('slider') as HTMLInputElement).max).toBe('100')
  })

  it('默认 step=1 透传到 input.step', () => {
    render(<SliderControl label="亮度" value={0} onChange={vi.fn()} />)
    expect((screen.getByRole('slider') as HTMLInputElement).step).toBe('1')
  })

  it('自定义 min/max/step 透传', () => {
    render(
      <SliderControl label="曝光" value={0} min={-50} max={50} step={0.5} onChange={vi.fn()} />
    )
    const slider = screen.getByRole('slider') as HTMLInputElement
    expect(slider.min).toBe('-50')
    expect(slider.max).toBe('50')
    expect(slider.step).toBe('0.5')
  })

  it('拖动滑块触发 onChange 携带数字值', () => {
    const onChange = vi.fn()
    render(<SliderControl label="亮度" value={0} onChange={onChange} />)
    fireEvent.change(screen.getByRole('slider'), { target: { value: '30' } })
    expect(onChange).toHaveBeenCalledWith(30)
  })

  it('onPointerUp 触发 onCommit', () => {
    const onCommit = vi.fn()
    render(<SliderControl label="亮度" value={0} onChange={vi.fn()} onCommit={onCommit} />)
    fireEvent.pointerUp(screen.getByRole('slider'))
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('onKeyUp 触发 onCommit', () => {
    const onCommit = vi.fn()
    render(<SliderControl label="亮度" value={0} onChange={vi.fn()} onCommit={onCommit} />)
    fireEvent.keyUp(screen.getByRole('slider'))
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('未传 onCommit 时 onPointerUp 不报错', () => {
    expect(() => {
      render(<SliderControl label="亮度" value={0} onChange={vi.fn()} />)
      fireEvent.pointerUp(screen.getByRole('slider'))
    }).not.toThrow()
  })

  it('渲染 unit 文案（如 K）', () => {
    render(
      <SliderControl label="色温" value={5500} min={3000} max={9000} unit="K" onChange={vi.fn()} />
    )
    expect(screen.getByText('5500K')).toBeTruthy()
  })

  it('双击 value 数字时优先调用 onReset', () => {
    const onReset = vi.fn()
    const onChange = vi.fn()
    render(<SliderControl label="亮度" value={50} onChange={onChange} onReset={onReset} />)
    fireEvent.doubleClick(screen.getByText('50'))
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('无 onReset 但有 defaultValue 时双击调用 onChange(defaultValue)', () => {
    const onChange = vi.fn()
    render(<SliderControl label="亮度" value={50} defaultValue={0} onChange={onChange} />)
    fireEvent.doubleClick(screen.getByText('50'))
    expect(onChange).toHaveBeenCalledWith(0)
  })

  it('无 onReset 无 defaultValue 时双击调用 onChange(min)', () => {
    const onChange = vi.fn()
    render(<SliderControl label="亮度" value={50} min={-100} onChange={onChange} />)
    fireEvent.doubleClick(screen.getByText('50'))
    expect(onChange).toHaveBeenCalledWith(-100)
  })

  it('双击滑块本身触发 onReset', () => {
    const onReset = vi.fn()
    render(<SliderControl label="亮度" value={50} onChange={vi.fn()} onReset={onReset} />)
    fireEvent.doubleClick(screen.getByRole('slider'))
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('value=0 在 min=-100 max=100 时不报错', () => {
    expect(() => {
      render(<SliderControl label="亮度" value={0} min={-100} max={100} onChange={vi.fn()} />)
    }).not.toThrow()
  })

  it('value 等于 min 时正常渲染', () => {
    render(<SliderControl label="亮度" value={-100} min={-100} max={100} onChange={vi.fn()} />)
    expect(screen.getByText('-100')).toBeTruthy()
  })

  it('value 等于 max 时正常渲染', () => {
    render(<SliderControl label="亮度" value={100} min={-100} max={100} onChange={vi.fn()} />)
    expect(screen.getByText('100')).toBeTruthy()
  })
})
