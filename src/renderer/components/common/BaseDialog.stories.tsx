import { useState, type ComponentProps, type ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { BaseDialog } from './BaseDialog'

/** 包装 open 本地状态：默认打开，关闭后显示重开按钮，保证交互可循环演示 */
function OpenStateWrapper({
  args,
  children
}: {
  args: ComponentProps<typeof BaseDialog>
  children?: ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <>
      {!open && (
        <button className="btn-primary" onClick={() => setOpen(true)}>
          打开对话框
        </button>
      )}
      <BaseDialog
        {...args}
        open={open}
        onClose={() => {
          setOpen(false)
          args.onClose?.()
        }}
      >
        {children ?? args.children}
      </BaseDialog>
    </>
  )
}

/**
 * 对话框公共骨架故事。
 * 覆盖完整模式（title + footer）、尺寸档位与禁止遮罩关闭；
 * 关闭交互经 BaseDialog 内部 IconButton / Esc / 遮罩触发，
 * 其 aria-label 走既有 i18n key `common.close`。不依赖 window.electronAPI。
 */
const meta: Meta<typeof BaseDialog> = {
  title: 'Common/BaseDialog',
  component: BaseDialog,
  tags: ['autodocs'],
  argTypes: {
    children: { control: false },
    footer: { control: false },
    headerExtra: { control: false },
    initialFocusRef: { control: false },
    size: {
      control: { type: 'select' },
      options: ['sm', 'md', 'lg', 'xl']
    }
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '全部弹窗的公共骨架：遮罩 fade + 卡片 scaleFade 双层动画、焦点陷阱、Esc 关闭、遮罩点击关闭。' +
          '传入 `title` 自动渲染 Header（含右上角关闭按钮），传入 `footer` 自动渲染底部按钮组。' +
          '无障碍要点：`role="dialog"` + `aria-modal`，打开时焦点被陷阱捕获并落在 `initialFocusRef`（默认首个可聚焦元素），' +
          'Esc 键关闭并恢复焦点。' +
          '同置测试：`BaseDialog.test.tsx`（`npm run test:renderer -- src/renderer/components/common/BaseDialog.test.tsx`）。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof BaseDialog>

/** 完整模式：title 自动渲染 Header，footer 自动渲染底部按钮组；可真实关闭再打开 */
export const WithTitleAndFooter: Story = {
  args: {
    open: true,
    title: '编辑名称',
    size: 'md',
    onClose: fn(),
    children: (
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        对话框正文内容。
      </p>
    ),
    footer: (
      <>
        <button className="btn-secondary">取消</button>
        <button className="btn-primary">保存</button>
      </>
    )
  },
  render: (args) => <OpenStateWrapper args={args} />
}

/** 大尺寸档位（xl）：用于内容较多的弹窗 */
export const SizeXl: Story = {
  args: {
    open: true,
    title: '批量导入',
    size: 'xl',
    onClose: fn(),
    children: (
      <div className="space-y-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
        <p>xl 档位最大宽度为 36rem（max-w-xl）。</p>
        <p>卡片追加 `cardClassName` 可控制 max-h 与滚动。</p>
      </div>
    )
  },
  render: (args) => <OpenStateWrapper args={args} />
}

/** 禁止遮罩关闭：点击遮罩不触发 onClose，仅右上角按钮 / Esc 可关闭 */
export const PersistentOverlay: Story = {
  args: {
    open: true,
    title: '处理中，请稍候',
    size: 'sm',
    closeOnOverlayClick: false,
    onClose: fn(),
    children: (
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        点击遮罩不会关闭本对话框。
      </p>
    )
  },
  render: (args) => <OpenStateWrapper args={args} />
}
