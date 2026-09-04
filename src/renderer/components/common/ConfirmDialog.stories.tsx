import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * 确认对话框故事。
 * 覆盖 primary / danger 两种确认按钮变体与自定义按钮文案；
 * 未传文案时走既有 i18n key `common.cancel` / `common.confirm`。不依赖 window.electronAPI。
 */
const meta: Meta<typeof ConfirmDialog> = {
  title: 'Common/ConfirmDialog',
  component: ConfirmDialog,
  tags: ['autodocs'],
  argTypes: {
    confirmVariant: {
      control: { type: 'select' },
      options: ['primary', 'danger']
    }
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '轻量确认弹窗（基于 BaseDialog）：打开时初始焦点落在确认按钮上（`initialFocusRef`），' +
          '`danger` 变体用于删除等破坏性操作。' +
          '无障碍要点：标题与 `aria-labelledby` 绑定，Esc / 遮罩点击等同取消；确认按钮默认获焦，回车即可确认。' +
          '同置测试：`ConfirmDialog.test.tsx`（`npm run test:renderer -- src/renderer/components/common/ConfirmDialog.test.tsx`）。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof ConfirmDialog>

/** 包装 open 本地状态：默认打开，确认/取消后显示重开按钮 */
function useOpenDemo() {
  const [open, setOpen] = useState(true)
  const close = () => setOpen(false)
  const reopenButton = open ? null : (
    <button className="btn-primary" onClick={() => setOpen(true)}>
      打开对话框
    </button>
  )
  return { open, close, reopenButton }
}

/** 默认（primary）：普通确认操作 */
export const Default: Story = {
  args: {
    open: true,
    title: '清空回收站',
    message: '回收站中共有 12 个文件，清空后将无法恢复。\n确定继续吗？',
    onConfirm: fn(),
    onCancel: fn()
  },
  render: function Render(args) {
    const { open, close, reopenButton } = useOpenDemo()
    return (
      <>
        {reopenButton}
        <ConfirmDialog
          {...args}
          open={open}
          onConfirm={() => {
            close()
            args.onConfirm?.()
          }}
          onCancel={() => {
            close()
            args.onCancel?.()
          }}
        />
      </>
    )
  }
}

/** 危险变体：删除类操作使用 btn-danger 强调后果 */
export const Danger: Story = {
  args: {
    open: true,
    title: '永久删除',
    message: '此操作将从磁盘彻底删除 3 张照片，无法恢复。',
    confirmVariant: 'danger',
    confirmText: '永久删除',
    onConfirm: fn(),
    onCancel: fn()
  },
  render: function Render(args) {
    const { open, close, reopenButton } = useOpenDemo()
    return (
      <>
        {reopenButton}
        <ConfirmDialog
          {...args}
          open={open}
          onConfirm={() => {
            close()
            args.onConfirm?.()
          }}
          onCancel={() => {
            close()
            args.onCancel?.()
          }}
        />
      </>
    )
  }
}
