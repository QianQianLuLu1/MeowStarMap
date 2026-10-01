import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from './Button'
import { IconDelete, IconExport } from '../../icons'

const meta: Meta<typeof Button> = {
  title: 'Common/Button',
  component: Button,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          '统一按钮组件：`.btn-*` 语义类的组件化封装。变体 primary/secondary/danger/ghost，' +
          '尺寸 sm/md/lg，支持 loading（aria-busy）与 icon。交互态（悬停/涟漪/聚焦/禁用）由 CSS 类承载。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof Button>

export const Primary: Story = {
  args: { variant: 'primary', children: '保存修改' }
}

export const Secondary: Story = {
  args: { variant: 'secondary', children: '取消' }
}

export const Danger: Story = {
  args: { variant: 'danger', children: '彻底删除', icon: <IconDelete size={14} /> }
}

export const Ghost: Story = {
  args: { variant: 'ghost', children: '导出到默认', icon: <IconExport size={14} /> }
}

export const Loading: Story = {
  args: { variant: 'primary', loading: true, children: '处理中…' }
}

export const Small: Story = {
  args: { size: 'sm', children: '小按钮' }
}

export const Large: Story = {
  args: { variant: 'primary', size: 'lg', children: '开始扫描' }
}
