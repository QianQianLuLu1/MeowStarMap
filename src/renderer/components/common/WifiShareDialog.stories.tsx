import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { WifiShareDialog } from './WifiShareDialog'
import { GlobalToastProvider } from '../../pages/settings/shared'

/**
 * WiFi 局域网分享对话框故事。
 * 依赖 window.electronAPI.share.startWifi / share.stopWifi：
 * 默认由全局安全桩承接（启动落入失败路径）；其余故事在 beforeEach 整体替换 `share` 命名空间。
 * 打开对话框时自动启动服务，关闭时自动停止。全部文案走既有 i18n key（share.wifi.*）。
 * 外层包 GlobalToastProvider 让全局 Toast 在故事中可见。
 */

type Win = { electronAPI?: Record<string, unknown> }
const getWin = (): Win => window as unknown as Win

/**
 * 整体替换 window.electronAPI，注入 `share` 命名空间（startWifi / stopWifi），清理时还原回桩。
 * 全局桩是双层 Proxy（无 set trap，直接写属性无效），必须整体替换。
 */
function mockShareNamespace(startWifi: (filePaths: string[]) => Promise<unknown>) {
  return () => {
    const w = getWin()
    const prevApi = w.electronAPI
    w.electronAPI = {
      share: {
        startWifi,
        stopWifi: async () => undefined
      }
    }
    return () => {
      w.electronAPI = prevApi
    }
  }
}

/** 演示文件列表（不引用真实本地路径） */
const demoFilePaths = [
  'D:\\InfinityNikki\\Photos\\demo_share_1.jpg',
  'D:\\InfinityNikki\\Photos\\demo_share_2.jpg',
  'D:\\InfinityNikki\\Photos\\demo_share_3.jpg'
]

const meta: Meta<typeof WifiShareDialog> = {
  title: 'Common/WifiShareDialog',
  component: WifiShareDialog,
  tags: ['autodocs'],
  argTypes: {
    filePaths: { control: false }
  },
  args: {
    open: true,
    filePaths: demoFilePaths,
    onClose: fn()
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'WiFi 局域网分享对话框：打开即自动启动临时 HTTP 服务，展示访问地址、6 位 PIN 认证码、文件数 / 端口 / 剩余时间，' +
          '支持复制地址、重启与停止；到期自动关闭。' +
          '依赖 `window.electronAPI.share.startWifi / share.stopWifi`：`Default` 走全局桩（startWifi resolve(undefined) 落入错误提示），' +
          '`Active` / `StartFailed` 在 beforeEach 整体替换 `share` 命名空间注入模拟返回。' +
          '无障碍要点：标题绑定 `aria-labelledby`，关闭按钮带 `aria-label`（`common.close`），焦点陷阱与 Esc 由 BaseDialog 提供。' +
          '同置测试：`WifiShareDialog.test.tsx`（`npm run test:renderer -- src/renderer/components/common/WifiShareDialog.test.tsx`）。' +
          '注意：该故事组覆写全局 mock（window.electronAPI），Docs 页多预览共存时以最后挂载者为准，请在 Canvas 单故事模式验证交互语义。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof WifiShareDialog>

/** 包装 open 本地状态：关闭后显示重开按钮 */
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

/** 默认（全局桩）：启动失败路径，停留「已停止 + 重新启动」状态 */
export const Default: Story = {
  render: function Render(args) {
    const { open, close, reopenButton } = useOpenDemo()
    return (
      <GlobalToastProvider>
        {reopenButton}
        <WifiShareDialog
          {...args}
          open={open}
          onClose={() => {
            close()
            args.onClose()
          }}
        />
      </GlobalToastProvider>
    )
  }
}

/** 启动成功：展示访问地址 + PIN 码 + 统计信息 + 倒计时 */
export const Active: Story = {
  beforeEach: mockShareNamespace(async (paths) => ({
    success: true,
    url: 'http://192.168.1.100:48621',
    port: 48621,
    pin: '385927',
    fileCount: paths.length,
    timeoutMs: 300_000
  })),
  render: function Render(args) {
    const { open, close, reopenButton } = useOpenDemo()
    return (
      <GlobalToastProvider>
        {reopenButton}
        <WifiShareDialog
          {...args}
          open={open}
          onClose={() => {
            close()
            args.onClose()
          }}
        />
      </GlobalToastProvider>
    )
  }
}

/** 启动失败（业务错误）：端口占用等场景，展示停止态与错误 Toast */
export const StartFailed: Story = {
  beforeEach: mockShareNamespace(async () => ({
    success: false,
    message: '端口 48621 已被占用（示例）'
  })),
  render: function Render(args) {
    const { open, close, reopenButton } = useOpenDemo()
    return (
      <GlobalToastProvider>
        {reopenButton}
        <WifiShareDialog
          {...args}
          open={open}
          onClose={() => {
            close()
            args.onClose()
          }}
        />
      </GlobalToastProvider>
    )
  }
}
