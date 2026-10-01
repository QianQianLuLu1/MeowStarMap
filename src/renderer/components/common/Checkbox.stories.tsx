import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { Checkbox } from './Checkbox'

const meta: Meta<typeof Checkbox> = {
  title: 'Common/Checkbox',
  component: Checkbox,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          '通用圆形勾选框：由 MediaCheckbox 泛化的表单级控件。支持可见 label（label 包裹可点）。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof Checkbox>

function InteractiveCheckbox(): React.ReactElement {
  const [on, setOn] = useState(false)
  return <Checkbox checked={on} onChange={setOn} label="受控勾选" />
}

export const Unchecked: Story = {
  args: { checked: false, label: '同步元数据' }
}

export const Checked: Story = {
  args: { checked: true, label: '同步元数据' }
}

export const Interactive: Story = {
  render: () => <InteractiveCheckbox />
}
