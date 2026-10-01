import type { Meta, StoryObj } from '@storybook/react-vite'
import { Tooltip } from './Tooltip'
import { IconInfo } from '../../icons'

const meta: Meta<typeof Tooltip> = {
  title: 'Common/Tooltip',
  component: Tooltip,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          '统一工具提示：hover + focus 双通道，portal + 视口钳制定位，替代原生 title 属性。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof Tooltip>

export const Top: Story = {
  render: () => (
    <Tooltip content="将修改应用到所有选中的照片">
      <button type="button" className="btn-secondary">
        批量应用
      </button>
    </Tooltip>
  )
}

export const WithIconButton: Story = {
  render: () => (
    <Tooltip content="照片信息">
      <button type="button" className="icon-btn" aria-label="信息">
        <IconInfo size={16} />
      </button>
    </Tooltip>
  )
}
