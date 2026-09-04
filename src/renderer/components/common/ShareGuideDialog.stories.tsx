import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { ShareGuideDialog } from './ShareGuideDialog'

/**
 * 分享引导对话框故事。
 * 覆盖三态：已安装且运行中（3 秒自动关闭）/ 已安装未运行（「打开」按钮，经
 * window.electronAPI.share.launchApp 拉起目标应用）/ 未安装（5 秒自动关闭），
 * 以及复制失败与含跳过文件两种 copyResult 形态。
 * 全部文案走既有 i18n key（share.guide.*）。
 */

type Win = { electronAPI?: Record<string, unknown> }
const getWin = (): Win => window as unknown as Win

/**
 * 整体替换 window.electronAPI，注入 `share.launchApp`，清理时还原回桩。
 * 全局桩是双层 Proxy（无 set trap，直接写属性无效），必须整体替换。
 */
function mockShareNamespace(launchApp: (channelId: string) => Promise<unknown>) {
  return () => {
    const w = getWin()
    const prevApi = w.electronAPI
    w.electronAPI = { share: { launchApp } }
    return () => {
      w.electronAPI = prevApi
    }
  }
}

const meta: Meta<typeof ShareGuideDialog> = {
  title: 'Common/ShareGuideDialog',
  component: ShareGuideDialog,
  tags: ['autodocs'],
  argTypes: {
    channelId: { control: { type: 'select' }, options: ['wechat', 'qq', 'vivo'] },
    copyResult: { control: false }
  },
  args: {
    open: true,
    channelId: 'wechat',
    installed: true,
    running: true,
    onClose: fn()
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '分享引导对话框：复制分享码后按目标应用状态给出引导——运行中直接提示粘贴（3 秒自动关闭）、' +
          '未运行提供「打开」按钮（经 `window.electronAPI.share.launchApp`，`NotRunning` 故事在 beforeEach 覆盖该命名空间）、' +
          '未安装给出兜底说明（5 秒自动关闭）；复制失败时展示错误且不自动关闭。' +
          '无障碍要点：初始焦点落在「知道了」按钮（`initialFocusRef`），焦点陷阱与 Esc 由 BaseDialog 提供。' +
          '同置测试：`ShareGuideDialog.test.tsx`（`npm run test:renderer -- src/renderer/components/common/ShareGuideDialog.test.tsx`）。' +
          '注意：该故事组覆写全局 mock（window.electronAPI），Docs 页多预览共存时以最后挂载者为准，请在 Canvas 单故事模式验证交互语义。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof ShareGuideDialog>

/** 包装 open 本地状态：自动关闭/手动关闭后可重开 */
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

/** 已安装且运行中：引导文案 + 3 秒自动关闭 */
export const Running: Story = {
  render: function Render(args) {
    const { open, close, reopenButton } = useOpenDemo()
    return (
      <>
        {reopenButton}
        <ShareGuideDialog
          {...args}
          open={open}
          onClose={() => {
            close()
            args.onClose()
          }}
        />
      </>
    )
  }
}

/** 已安装未运行：显示「打开微信」按钮，点击经 share.launchApp 拉起（本故事已覆盖为成功） */
export const NotRunning: Story = {
  args: { running: false },
  beforeEach: mockShareNamespace(async () => ({ success: true })),
  render: function Render(args) {
    const { open, close, reopenButton } = useOpenDemo()
    return (
      <>
        {reopenButton}
        <ShareGuideDialog
          {...args}
          open={open}
          onClose={() => {
            close()
            args.onClose()
          }}
        />
      </>
    )
  }
}

/** 未安装：兜底说明 + 5 秒自动关闭 */
export const NotInstalled: Story = {
  args: { installed: false, running: false },
  render: function Render(args) {
    const { open, close, reopenButton } = useOpenDemo()
    return (
      <>
        {reopenButton}
        <ShareGuideDialog
          {...args}
          open={open}
          onClose={() => {
            close()
            args.onClose()
          }}
        />
      </>
    )
  }
}

/** 复制失败：显示错误信息，不自动关闭 */
export const CopyFailed: Story = {
  args: {
    copyResult: { success: false, message: '剪贴板不可用（示例）', count: 0, skipped: 0 }
  },
  render: function Render(args) {
    const { open, close, reopenButton } = useOpenDemo()
    return (
      <>
        {reopenButton}
        <ShareGuideDialog
          {...args}
          open={open}
          onClose={() => {
            close()
            args.onClose()
          }}
        />
      </>
    )
  }
}

/** 含跳过文件：复制成功但部分文件被跳过时给出计数提示 */
export const WithSkipped: Story = {
  args: {
    copyResult: { success: true, message: '', count: 5, skipped: 2 }
  },
  render: function Render(args) {
    const { open, close, reopenButton } = useOpenDemo()
    return (
      <>
        {reopenButton}
        <ShareGuideDialog
          {...args}
          open={open}
          onClose={() => {
            close()
            args.onClose()
          }}
        />
      </>
    )
  }
}
