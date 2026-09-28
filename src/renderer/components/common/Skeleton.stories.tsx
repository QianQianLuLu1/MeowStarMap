import type { Meta, StoryObj } from '@storybook/react-vite'
import { Skeleton, SkeletonGrid, SkeletonList, SkeletonDetail } from './Skeleton'

/**
 * 骨架屏组件族故事：加载占位与最终布局一致，杜绝白屏闪烁。
 * 复用 globals.css 的 .skeleton 渐变动画（颜色走 --skeleton-from/to，双主题自适应）。
 */
const meta: Meta<typeof Skeleton> = {
  title: 'Common/Skeleton',
  component: Skeleton,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          '骨架屏基元与组合（Grid/List/Detail）：加载态与最终布局同形。' +
          'reduce-motion 下动画自动静止。同置测试：`Skeleton.test.tsx`。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof Skeleton>

/** 基元：矩形块 */
export const Rect: Story = {
  args: { className: 'w-48 h-32' }
}

/** 基元：文本条 */
export const Text: Story = {
  args: { variant: 'text', className: 'w-64' }
}

/** 基元：圆形 */
export const Circle: Story = {
  args: { variant: 'circle', className: 'w-12 h-12' }
}

/** 媒体网格占位（图库/回收站加载态） */
export const MediaGrid: StoryObj<typeof SkeletonGrid> = {
  render: (args) => <SkeletonGrid {...args} />,
  args: { count: 12 }
}

/** 分组列表占位（重复检测扫描态） */
export const GroupList: StoryObj<typeof SkeletonList> = {
  render: (args) => <SkeletonList {...args} />,
  args: { rows: 3 }
}

/** 详情页布局占位 */
export const Detail: StoryObj<typeof SkeletonDetail> = {
  render: (args) => (
    <div className="h-[480px]">
      <SkeletonDetail {...args} />
    </div>
  ),
  args: {}
}
