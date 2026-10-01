import type { Meta, StoryObj } from '@storybook/react-vite'
import { Select } from './Select'

const meta: Meta<typeof Select> = {
  title: 'Common/Select',
  component: Select,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          '统一下拉选择：原生 select 行为 + `.select` 基类外观（收窄 + 主题化 chevron + focus 光环）。'
      }
    }
  },
  args: {
    options: [
      { value: 'auto', label: '跟随系统' },
      { value: 'zh-CN', label: '简体中文' },
      { value: 'en', label: 'English' }
    ],
    'aria-label': '语言'
  }
}

export default meta
type Story = StoryObj<typeof Select>

export const Default: Story = {}

export const Disabled: Story = {
  args: { disabled: true }
}
