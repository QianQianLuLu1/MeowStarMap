import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { IconInfo, IconShare, IconCopy, IconWeChat, IconQQ, IconVivo } from '../../icons'

/**
 * 右键菜单故事。
 * 覆盖：常规菜单项（图标 / 分隔线 / 禁用 / 危险项）+ 二级子菜单（分享渠道）+ 视口边缘反向定位。
 * 菜单项文案为示例数据（真实调用方走各自页面的 i18n key）；
 * 菜单容器 aria-label 走既有 i18n key（common.contextMenu.*）。
 */

/** 演示菜单项：覆盖图标、子菜单、分隔线、禁用、危险五种形态 */
const demoItems: ContextMenuItem[] = [
  { id: 'view', label: '查看详情', icon: <IconInfo size={14} />, onClick: fn() },
  { id: 'copy-name', label: '复制文件名', icon: <IconCopy size={14} />, onClick: fn() },
  {
    id: 'share',
    label: '分享',
    icon: <IconShare size={14} />,
    submenu: [
      { id: 'wechat', label: '分享到微信', icon: <IconWeChat size={14} />, onClick: fn() },
      { id: 'qq', label: '分享到 QQ', icon: <IconQQ size={14} />, onClick: fn() },
      { id: 'vivo', label: '传输到 vivo 手机', icon: <IconVivo size={14} />, onClick: fn() }
    ]
  },
  { id: 'sep-1', label: '', divider: true },
  { id: 'backup', label: '云端备份（不可用）', disabled: true },
  { id: 'delete', label: '移入回收站', danger: true, onClick: fn() }
]

const meta: Meta<typeof ContextMenu> = {
  title: 'Common/ContextMenu',
  component: ContextMenu,
  tags: ['autodocs'],
  argTypes: {
    items: { control: false }
  },
  args: {
    x: 120,
    y: 90,
    items: demoItems,
    onClose: fn()
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '通用右键菜单（Portal 到 body）：支持图标、分隔线、禁用项、危险项与二级子菜单（hover 展开）。' +
          '内置视口边界检测：菜单超出视口时反向定位，高度受限时限制 maxHeight 并滚动。' +
          '无障碍要点：`role="menu"` / `role="menuitem"` / `role="separator"`，打开时焦点落在首项，' +
          '↑/↓ 键循环导航、Enter/空格触发、Esc 关闭；菜单带 `aria-label`（`common.contextMenu.ariaLabel`）。' +
          '同置测试：`ContextMenu.test.tsx`（`npm run test:renderer -- src/renderer/components/common/ContextMenu.test.tsx`）。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof ContextMenu>

/** 默认：完整菜单形态（图标 / 子菜单 / 分隔线 / 禁用 / 危险项） */
export const Default: Story = {}

/** 靠近视口右下角：演示边界检测的反向定位（菜单向左上偏移避免溢出） */
export const NearViewportEdge: Story = {
  args: { x: 920, y: 620 }
}
