import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { SliderControl } from './SliderControl'

/**
 * 滑块控件故事。
 * 组件是受控输入，故事内用本地 state 包装以演示真实拖动；
 * 覆盖默认范围、自定义范围/单位、双击复位三种用法。不依赖 window.electronAPI。
 */
const meta: Meta<typeof SliderControl> = {
  title: 'Common/SliderControl',
  component: SliderControl,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          '编辑器参数滑块：受控组件，轨道填充比例跟随 `--accent` 主题变量；' +
          '拖动过程只触发 `onChange`，松手（`onPointerUp`）与键盘调整（`onKeyUp`）才触发 `onCommit`，避免频繁提交；' +
          '双击数值或滑杆复位（优先 `onReset`，其次 `defaultValue`，兜底 `min`）。' +
          '无障碍要点：原生 `input[type=range]`，方向键可调；数值区使用等宽字体便于读数。' +
          '同置测试：`SliderControl.test.tsx`（`npm run test:renderer -- src/renderer/components/common/SliderControl.test.tsx`）。'
      }
    }
  },
  decorators: [
    (Story) => (
      <div style={{ width: '320px' }}>
        <Story />
      </div>
    )
  ]
}

export default meta
type Story = StoryObj<typeof SliderControl>

/** 默认：-100 ~ 100，可拖动，松手触发 onCommit */
export const Default: Story = {
  args: {
    label: '亮度',
    value: 0,
    onChange: fn(),
    onCommit: fn()
  },
  render: function Render(args) {
    const [value, setValue] = useState(args.value ?? 0)
    return (
      <SliderControl
        {...args}
        label={args.label ?? '亮度'}
        value={value}
        onChange={(v) => {
          setValue(v)
          args.onChange?.(v)
        }}
      />
    )
  }
}

/** 自定义范围与单位：色温 2000K ~ 10000K，双击数值/滑杆复位到默认值 */
export const WithUnitAndReset: Story = {
  args: {
    label: '色温',
    value: 5500,
    min: 2000,
    max: 10000,
    step: 100,
    unit: 'K',
    defaultValue: 5500,
    onChange: fn(),
    onCommit: fn(),
    onReset: fn()
  },
  render: function Render(args) {
    const [value, setValue] = useState(args.value ?? 5500)
    return (
      <SliderControl
        {...args}
        label={args.label ?? '色温'}
        value={value}
        onChange={(v) => {
          setValue(v)
          args.onChange?.(v)
        }}
        onReset={() => {
          setValue(args.defaultValue ?? 5500)
          args.onReset?.()
        }}
      />
    )
  }
}
