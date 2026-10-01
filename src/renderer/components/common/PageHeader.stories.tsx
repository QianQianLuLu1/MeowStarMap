import type { Meta, StoryObj } from '@storybook/react-vite'
import { PageHeader } from './PageHeader'
import { Button } from './Button'
import { IconFolderOpen } from '../../icons'

const meta: Meta<typeof PageHeader> = {
  title: 'Common/PageHeader',
  component: PageHeader,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          '统一页面页头：图标 + 标题 + 副标题 + 右侧操作区。收敛三种手写页头流派，' +
          '所有二级页面的页头节奏与分隔线保持一致。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof PageHeader>

export const WithActions: Story = {
  args: {
    icon: <IconFolderOpen size={20} />,
    title: '回收站',
    subtitle: '已删除的照片将保留 30 天',
    actions: (
      <>
        <Button size="sm">全选</Button>
        <Button size="sm" variant="danger">
          清空回收站
        </Button>
      </>
    )
  }
}

export const PlainTitle: Story = {
  args: { title: '分类管理' }
}
