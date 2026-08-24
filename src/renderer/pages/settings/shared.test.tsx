/**
 * @vitest-environment jsdom
 *
 * SettingsToggle（设置板块「弹性开关」）单元测试
 *
 * 覆盖 7 个维度：渲染 / 无障碍 / 交互 / 禁用 / 容错 / 参数校验 / 样式挂载点，
 * 外加 SettingsRow 回归。
 *
 * 说明：SettingsToggle 自身不调用 t()，文案由调用方传入，
 * 故此处直接传中文字面量（测试文件不受 i18n 硬编码规则约束）。
 * motion/react 已在 tests/setup.ts 全局 mock（shared.tsx 间接依赖 Toast → motion）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { SettingsToggle, SettingsRow } from './shared'

/** 静默 console.error 并返回 spy，供容错类用例断言 */
const silenceConsoleError = () => vi.spyOn(console, 'error').mockImplementation(() => {})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SettingsToggle — 渲染', () => {
  it('T01 渲染 role="switch" 元素', () => {
    render(<SettingsToggle label="自动扫描" checked={false} onChange={vi.fn()} />)
    expect(screen.getByRole('switch')).toBeTruthy()
  })

  it('T02 渲染可见 label 文本', () => {
    render(<SettingsToggle label="自动扫描" checked={false} onChange={vi.fn()} />)
    expect(screen.getByText('自动扫描')).toBeTruthy()
  })

  it('T03 传 description 时渲染描述文本', () => {
    render(
      <SettingsToggle
        label="自动扫描"
        description="启动时自动扫描新增截图"
        checked={false}
        onChange={vi.fn()}
      />
    )
    expect(screen.getByText('启动时自动扫描新增截图')).toBeTruthy()
  })

  it('T04 不传 description 时不渲染描述节点', () => {
    render(<SettingsToggle label="自动扫描" checked={false} onChange={vi.fn()} />)
    expect(screen.queryByText('启动时自动扫描新增截图')).toBeNull()
    expect(screen.getByRole('switch').closest('div')?.querySelector('p')).toBeNull()
  })
})

describe('SettingsToggle — 无障碍', () => {
  it('T05 checked=true → aria-checked="true"', () => {
    render(<SettingsToggle label="自动扫描" checked={true} onChange={vi.fn()} />)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })

  it('T06 checked=false → aria-checked="false"', () => {
    render(<SettingsToggle label="自动扫描" checked={false} onChange={vi.fn()} />)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  })

  it('T07 aria-labelledby 指向可见 label 节点', () => {
    render(<SettingsToggle label="自动扫描" checked={false} onChange={vi.fn()} />)
    const labelledBy = screen.getByRole('switch').getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    expect(document.getElementById(labelledBy as string)?.textContent).toBe('自动扫描')
  })

  it('T08 传 description 时 aria-describedby 关联描述节点', () => {
    render(
      <SettingsToggle
        label="自动扫描"
        description="启动时自动扫描新增截图"
        checked={false}
        onChange={vi.fn()}
      />
    )
    const describedBy = screen.getByRole('switch').getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      '启动时自动扫描新增截图'
    )
  })

  it('T09 不传 description 时无 aria-describedby', () => {
    render(<SettingsToggle label="自动扫描" checked={false} onChange={vi.fn()} />)
    expect(screen.getByRole('switch').getAttribute('aria-describedby')).toBeNull()
  })
})

describe('SettingsToggle — 交互', () => {
  it('T10 checked=false 时点击回调 onChange(true)', () => {
    const onChange = vi.fn()
    render(<SettingsToggle label="自动扫描" checked={false} onChange={onChange} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('T11 checked=true 时点击回调 onChange(false)', () => {
    const onChange = vi.fn()
    render(<SettingsToggle label="自动扫描" checked={true} onChange={onChange} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('T12 使用原生 button（type=button），天然支持 Space / Enter 键盘切换', () => {
    render(<SettingsToggle label="自动扫描" checked={false} onChange={vi.fn()} />)
    const sw = screen.getByRole('switch')
    expect(sw.tagName).toBe('BUTTON')
    expect(sw.getAttribute('type')).toBe('button')
  })
})

describe('SettingsToggle — 禁用', () => {
  it('T13 disabled 时点击不触发 onChange', () => {
    const onChange = vi.fn()
    render(<SettingsToggle label="自动扫描" checked={false} onChange={onChange} disabled />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('T14 disabled 时元素带原生 disabled 属性', () => {
    render(<SettingsToggle label="自动扫描" checked={false} onChange={vi.fn()} disabled />)
    expect(screen.getByRole('switch')).toBeDisabled()
  })
})

describe('SettingsToggle — 容错', () => {
  it('T15 onChange 抛错时不向上冒泡，且 console.error 上报', () => {
    const spy = silenceConsoleError()
    const onChange = vi.fn(() => {
      throw new Error('boom')
    })
    render(<SettingsToggle label="自动扫描" checked={false} onChange={onChange} />)
    expect(() => fireEvent.click(screen.getByRole('switch'))).not.toThrow()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalled()
  })

  it('T16 onChange 非函数时点击不抛错，且 console.error 上报', () => {
    const spy = silenceConsoleError()
    render(
      <SettingsToggle
        label="自动扫描"
        checked={false}
        onChange={undefined as unknown as (checked: boolean) => void}
      />
    )
    expect(() => fireEvent.click(screen.getByRole('switch'))).not.toThrow()
    expect(spy).toHaveBeenCalled()
  })

  it('T16b label 为空字符串时仍渲染开关，并 console.error 上报', () => {
    const spy = silenceConsoleError()
    render(<SettingsToggle label="" checked={false} onChange={vi.fn()} />)
    expect(screen.getByRole('switch')).toBeTruthy()
    expect(spy).toHaveBeenCalled()
  })
})

describe('SettingsToggle — 参数校验', () => {
  it('T17 checked 传非 boolean 真值时 aria-checked 归一化为 "true"', () => {
    render(<SettingsToggle label="自动扫描" checked={1 as unknown as boolean} onChange={vi.fn()} />)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })

  it('T17b checked 传非 boolean 假值时 aria-checked 归一化为 "false"，点击回调 true', () => {
    const onChange = vi.fn()
    render(
      <SettingsToggle
        label="自动扫描"
        checked={undefined as unknown as boolean}
        onChange={onChange}
      />
    )
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith(true)
  })
})

describe('SettingsToggle — 弹性动效挂载点', () => {
  it('T18 开关带 .settings-elastic-switch 类，内部滑块带 -knob 类', () => {
    render(<SettingsToggle label="自动扫描" checked={false} onChange={vi.fn()} />)
    const sw = screen.getByRole('switch')
    expect(sw).toHaveClass('settings-elastic-switch')
    expect(sw.querySelector('.settings-elastic-switch-knob')).toBeTruthy()
  })
})

describe('SettingsRow — 回归', () => {
  it('T19 仍正常渲染 label / description / children', () => {
    render(
      <SettingsRow label="界面语言" description="切换后立即生效">
        <button type="button">简体中文</button>
      </SettingsRow>
    )
    expect(screen.getByText('界面语言')).toBeTruthy()
    expect(screen.getByText('切换后立即生效')).toBeTruthy()
    expect(screen.getByText('简体中文')).toBeTruthy()
  })
})
