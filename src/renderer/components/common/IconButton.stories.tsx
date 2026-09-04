import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { IconButton } from './IconButton'
import { IconClose, IconFavorite, IconDelete } from '../../icons'

/**
 * 公共图标按钮组件故事。
 * 覆盖默认态、禁用态与自定义类名（缩小尺寸）用法，不依赖 window.electronAPI。
 */
const meta: Meta<typeof IconButton> = {
  title: 'Common/IconButton',
  component: IconButton,
  tags: ['autodocs'],
  args: {
    onClick: fn()
  },
  argTypes: {
    children: { control: false },
    type: {
      control: { type: 'select' },
      options: ['button', 'submit', 'reset']
    }
  },
  parameters: {
    docs: {
      description: {
        component:
          '统一 36x36 图标按钮（`.icon-btn`：hover 缩放 + ripple），消除各弹窗手写的关闭按钮模板。' +
          '无障碍要点：`aria-label` 为必填项（屏幕阅读器唯一可读信息），需与 `title`（视觉 tooltip）语义一致；键盘可通过 Tab 聚焦、Enter/Space 触发。' +
          '同置测试：`IconButton.test.tsx`（`npm run test:renderer -- src/renderer/components/common/IconButton.test.tsx`）。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof IconButton>

/** 默认：关闭按钮（最常见用法） */
export const Default: Story = {
  args: {
    'aria-label': '关闭',
    title: '关闭',
    children: <IconClose size={18} />
  }
}

/** 禁用态：按钮不可点击，样式由 .icon-btn:disabled 承接 */
export const Disabled: Story = {
  args: {
    'aria-label': '收藏',
    title: '收藏',
    disabled: true,
    children: <IconFavorite size={18} />
  }
}

/** 危险操作（如删除），通过 className 追加颜色覆盖 */
export const Danger: Story = {
  args: {
    'aria-label': '删除',
    title: '删除',
    className: 'text-red-400',
    children: <IconDelete size={18} />
  }
}
