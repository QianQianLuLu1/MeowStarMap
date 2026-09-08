/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/components/gallery/MediaCheckbox
 * @coverage 多选勾选框：受控选中态、无障碍属性、点击冒泡隔离
 *
 * 测试策略：真实 render + fireEvent，验证正常流程（勾选/取消）、
 * 异常流程（点击不得冒泡到卡片容器）、边界条件（未选中不渲染勾选图标）。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MediaCheckbox } from './MediaCheckbox'

describe('MediaCheckbox｜正常流程', () => {
  it('应渲染 role=checkbox 且 aria-checked 反映未选中态', () => {
    render(<MediaCheckbox checked={false} onChange={() => {}} />)
    const box = screen.getByRole('checkbox')
    expect(box.getAttribute('aria-checked')).toBe('false')
  })

  it('点击未选中项应回调 onChange(true)', () => {
    const onChange = vi.fn()
    render(<MediaCheckbox checked={false} onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('点击已选中项应回调 onChange(false)', () => {
    const onChange = vi.fn()
    render(<MediaCheckbox checked={true} onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('选中态应设置 aria-checked=true 并渲染勾选图标', () => {
    render(<MediaCheckbox checked={true} onChange={() => {}} />)
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('media-checkbox-icon')).toBeTruthy()
  })
})

describe('MediaCheckbox｜异常流程（冒泡隔离）', () => {
  it('点击勾选框不应冒泡触发卡片的 onClick', () => {
    const onCardClick = vi.fn()
    const onChange = vi.fn()
    render(
      <div onClick={onCardClick}>
        <MediaCheckbox checked={false} onChange={onChange} />
      </div>
    )
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onCardClick, '勾选框点击必须 stopPropagation，否则会连带打开全屏').not.toHaveBeenCalled()
  })

  it('mousedown / dblclick 同样不应冒泡到卡片', () => {
    const onCardMouseDown = vi.fn()
    const onCardDoubleClick = vi.fn()
    render(
      <div onMouseDown={onCardMouseDown} onDoubleClick={onCardDoubleClick}>
        <MediaCheckbox checked={false} onChange={() => {}} />
      </div>
    )
    const box = screen.getByRole('checkbox')
    fireEvent.mouseDown(box)
    fireEvent.doubleClick(box)
    expect(onCardMouseDown).not.toHaveBeenCalled()
    expect(onCardDoubleClick).not.toHaveBeenCalled()
  })
})

describe('MediaCheckbox｜边界条件', () => {
  it('未选中时不应渲染勾选图标', () => {
    render(<MediaCheckbox checked={false} onChange={() => {}} />)
    expect(screen.queryByTestId('media-checkbox-icon')).toBeNull()
  })

  it('传入 aria-label 时应透传到按钮', () => {
    render(<MediaCheckbox checked={false} onChange={() => {}} label="select-item" />)
    expect(screen.getByRole('checkbox').getAttribute('aria-label')).toBe('select-item')
  })

  it('自定义 className 应追加到按钮上（供父级定位）', () => {
    render(<MediaCheckbox checked={false} onChange={() => {}} className="absolute top-2 left-2" />)
    expect(screen.getByRole('checkbox').className).toContain('absolute')
  })
})
