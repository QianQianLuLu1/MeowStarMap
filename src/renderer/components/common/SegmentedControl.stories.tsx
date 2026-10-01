import type { Meta, StoryObj } from '@storybook/react-vite'
import { SegmentedControl } from './SegmentedControl'
import { IconGrid, IconList, IconTimeline } from '../../icons'

const meta: Meta<typeof SegmentedControl> = {
  title: 'Common/SegmentedControl',
  component: SegmentedControl,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          '分段切换器：统一四处手写药丸 tab 的单一实现。active 药丸以 layoutId 弹性滑动，' +
          'reduce-motion 退化为瞬时切换。radiogroup/radio 语义。'
      }
    }
  },
  args: {
    ariaLabel: '视图模式',
    options: [
      { value: 'grid', label: '网格', icon: <IconGrid size={14} /> },
      { value: 'list', label: '列表', icon: <IconList size={14} /> },
      { value: 'timeline', label: '时间线', icon: <IconTimeline size={14} /> }
    ]
  }
}

export default meta
type Story = StoryObj<typeof SegmentedControl>

export const GridActive: Story = {
  args: { value: 'grid' }
}

export const TimelineActive: Story = {
  args: { value: 'timeline' }
}

export const Compact: Story = {
  args: { value: 'list', size: 'sm' }
}
