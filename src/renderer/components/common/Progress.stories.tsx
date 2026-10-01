import type { Meta, StoryObj } from '@storybook/react-vite'
import { Progress } from './Progress'

const meta: Meta<typeof Progress> = {
  title: 'Common/Progress',
  component: Progress,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          '进度条：确定态（value 0-100 映射宽度）与不定态（纯 transform 扫描动画）。' +
          '容器承载 progressbar 语义，宿主建议配合 aria-busy 使用。'
      }
    }
  },
  decorators: [
    (Story) => (
      <div style={{ width: 320, padding: 16 }}>
        <Story />
      </div>
    )
  ]
}

export default meta
type Story = StoryObj<typeof Progress>

export const Determinate: Story = {
  args: { value: 64, 'aria-label': '扫描进度' }
}

export const Indeterminate: Story = {
  args: { indeterminate: true, 'aria-label': '处理中' }
}
