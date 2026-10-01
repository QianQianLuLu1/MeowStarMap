import type { Meta, StoryObj } from '@storybook/react-vite'
import { FloatingActionBar } from './FloatingActionBar'
import { Button } from './Button'
import { IconDelete, IconRestore } from '../../icons'

const meta: Meta<typeof FloatingActionBar> = {
  title: 'Common/FloatingActionBar',
  component: FloatingActionBar,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          '底部浮动操作栏：居中悬浮玻璃卡 + 阴影-xl，scrollable 模式支持横向细滚动条。' +
          '统一 Duplicates/RecycleBin 底栏实现（ariaLabel 必填；层级 z-40 低于 Toast/任务浮层）。'
      }
    }
  },
  decorators: [
    (Story) => (
      <div style={{ height: 160, position: 'relative' }}>
        <Story />
      </div>
    )
  ]
}

export default meta
type Story = StoryObj<typeof FloatingActionBar>

export const BatchActions: Story = {
  render: () => (
    <FloatingActionBar ariaLabel="批量操作">
      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        已选择 3 项
      </span>
      <Button size="sm" icon={<IconRestore size={14} />}>
        恢复
      </Button>
      <Button size="sm" variant="danger" icon={<IconDelete size={14} />}>
        彻底删除
      </Button>
    </FloatingActionBar>
  )
}

export const Scrollable: Story = {
  render: () => (
    <FloatingActionBar ariaLabel="导出操作" scrollable>
      <Button size="sm"> 导出到默认 </Button>
      <Button size="sm">WiFi 分享</Button>
      <Button size="sm">重命名</Button>
      <Button size="sm">水印</Button>
      <Button size="sm" variant="danger">
        删除
      </Button>
    </FloatingActionBar>
  )
}
