import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { Toast } from './Toast'
import type { ToastMessage } from '../../hooks/useToast'

/**
 * Toast 组件故事。
 * 覆盖单一消息三种类型、堆叠多条、带动作按钮（如"撤销"）与可交互关闭。
 * 不依赖 window.electronAPI。
 */
const meta: Meta<typeof Toast> = {
  title: 'Common/Toast',
  component: Toast,
  tags: ['autodocs'],
  argTypes: {
    messages: { control: false },
    zIndex: { control: { type: 'number' } }
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '右下角堆叠提示：success / error / info 三种类型（背景色走 `--toast-*-bg` 主题变量），' +
          'motion 入场与退出动画，支持手动关闭与可选动作按钮。' +
          '无障碍要点：error 消息使用 `role="alert"` + `aria-live="assertive"`，其余为 `role="status"` + `polite`；' +
          '关闭按钮 aria-label 走既有 i18n key `common.close`。' +
          '同置测试：`Toast.test.tsx`（`npm run test:renderer -- src/renderer/components/common/Toast.test.tsx`）。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof Toast>

/** 成功消息（绿色，默认类型） */
export const Success: Story = {
  args: {
    messages: [{ id: 'demo-success', type: 'success', text: '已保存 3 张照片' }],
    onDismiss: fn()
  }
}

/** 错误消息（红色，role="alert" 强提示） */
export const ErrorType: Story = {
  args: {
    messages: [{ id: 'demo-error', type: 'error', text: '导出失败：目标目录不可写' }],
    onDismiss: fn()
  }
}

/** 信息消息（中性色，polite 播报） */
export const Info: Story = {
  args: {
    messages: [{ id: 'demo-info', type: 'info', text: '后台正在生成缩略图' }],
    onDismiss: fn()
  }
}

/** 堆叠多条（实际业务中 useToast 最多同屏 3 条，超出 FIFO 淘汰） */
export const Stacked: Story = {
  args: {
    messages: [
      { id: 'demo-1', type: 'success', text: '导入完成：12 张照片' },
      { id: 'demo-2', type: 'info', text: '正在建立索引…' },
      { id: 'demo-3', type: 'error', text: '1 个文件损坏，已跳过' }
    ],
    onDismiss: fn()
  }
}

/** 可交互：本地 state 管理消息队列，点击 × 或动作按钮后真实移除 */
export const Interactive: Story = {
  args: {
    messages: [
      {
        id: 'demo-action',
        type: 'info',
        text: '已删除 2 张照片',
        action: { label: '撤销', onClick: () => {} }
      }
    ]
  },
  render: function Render(args) {
    const [messages, setMessages] = useState<ToastMessage[]>(args.messages ?? [])
    return (
      <Toast
        messages={messages}
        onDismiss={(id) => setMessages((prev) => prev.filter((m) => m.id !== id))}
      />
    )
  }
}
