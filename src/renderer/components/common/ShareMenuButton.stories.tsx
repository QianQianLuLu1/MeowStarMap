import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { ShareMenuButton } from './ShareMenuButton'

/**
 * 分享菜单按钮故事。
 * 覆盖：默认小尺寸 / 工具栏中尺寸 / 自定义文案 / 禁用态。
 * 渠道文案走既有 i18n key（share.menu.*），默认按钮文案为 `share.menu.label`。
 * 不依赖 window.electronAPI（复制与拉起由调用方负责）。
 */
const meta: Meta<typeof ShareMenuButton> = {
  title: 'Common/ShareMenuButton',
  component: ShareMenuButton,
  tags: ['autodocs'],
  argTypes: {
    size: { control: { type: 'select' }, options: ['sm', 'md'] }
  },
  args: {
    onSelect: fn(),
    size: 'sm'
  },
  decorators: [
    (Story) => (
      // 下拉菜单向下展开，预留空间避免被画布裁剪
      <div className="p-6 flex justify-center" style={{ minHeight: 260 }}>
        <Story />
      </div>
    )
  ],
  parameters: {
    docs: {
      description: {
        component:
          '分享渠道下拉按钮：点击展开微信 / QQ / vivo 三个渠道（文案走 `share.menu.*` i18n key），' +
          '选择后触发 `onSelect(channelId)`，由调用方执行复制 + 弹引导窗（ShareGuideDialog）。' +
          '无障碍要点：触发按钮 `aria-haspopup="menu"` + `aria-expanded`，下拉 `role="menu"`，Esc 与点击外部关闭。' +
          '同置测试：`ShareMenuButton.test.tsx`（`npm run test:renderer -- src/renderer/components/common/ShareMenuButton.test.tsx`）。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof ShareMenuButton>

/** 默认（sm）：批量操作栏用法 */
export const Default: Story = {}

/** md 尺寸：顶部工具栏用法 */
export const Medium: Story = {
  args: { size: 'md' }
}

/** 自定义文案：调用方覆盖默认「分享」标签 */
export const CustomLabel: Story = {
  args: { label: '分享给好友', title: '选择渠道后自动复制分享码' }
}

/** 禁用态：无可分享文件时 */
export const Disabled: Story = {
  args: { disabled: true }
}
