import type { Meta, StoryObj } from '@storybook/react-vite'
import { Drawer } from './Drawer'
import { Button } from './Button'

const meta: Meta<typeof Drawer> = {
  title: 'Common/Drawer',
  component: Drawer,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          '侧滑抽屉：BaseDialog 的兄弟容器（同一焦点陷阱/遮罩/motion 预设），' +
          '适合中等复杂度次级流程。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof Drawer>

export const Open: Story = {
  render: () => (
    <Drawer
      open
      onClose={() => {}}
      title="批量重命名"
      footer={
        <>
          <Button variant="ghost">取消</Button>
          <Button variant="primary">应用</Button>
        </>
      }
    >
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        面板内容区
      </p>
    </Drawer>
  )
}
