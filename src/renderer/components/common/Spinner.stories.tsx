import type { Meta, StoryObj } from '@storybook/react-vite'
import { Spinner } from './Spinner'

/**
 * 公共加载圈组件故事（阶段 1 冒烟样例，同时作为阶段 2 的第一个正式 story）。
 * 覆盖四种尺寸变体、自定义颜色与自定义类名用法。
 */
const meta: Meta<typeof Spinner> = {
  title: 'Common/Spinner',
  component: Spinner,
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: { type: 'select' },
      options: ['xs', 'sm', 'md', 'lg']
    },
    color: { control: { type: 'color' } },
    className: { control: { type: 'text' } }
  },
  parameters: {
    docs: {
      description: {
        component:
          '公共加载圈组件：消除散落在各页面的 `border-2 border-current border-t-transparent rounded-full animate-spin` 重复模式。' +
          '无障碍要点：纯装饰性动画，建议由宿主容器承载 `aria-busy` 表达加载语义；颜色跟随 currentColor（可用 `color` prop 覆盖）。' +
          '同置测试：`Spinner.test.tsx`（`npm run test:renderer -- src/renderer/components/common/Spinner.test.tsx`）。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof Spinner>

/** 默认尺寸 md（32px），颜色跟随当前文本色 */
export const Default: Story = {}

/** xs：12px 行内小提示 */
export const ExtraSmall: Story = {
  args: { size: 'xs' }
}

/** sm：16px，适合按钮内/小图标旁 */
export const Small: Story = {
  args: { size: 'sm' }
}

/** lg：40px 全屏加载，配合主题强调色 */
export const Large: Story = {
  args: { size: 'lg', color: 'var(--accent)' }
}
