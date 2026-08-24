import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { FeedbackDialog } from './FeedbackDialog'

/**
 * 错误反馈对话框故事。
 * 全部文案走既有 i18n key（common.feedbackDialog.*）。
 * 依赖 window.electronAPI：默认由全局安全桩承接；
 * 「导出成功」故事在 beforeEach 中覆盖 `log.exportZip` 命名空间以展示成功态。
 */

// 覆盖桩用的最小类型切面（真实类型见 src/renderer/vite-env.d.ts 的 WindowElectronAPI）
// 注意：全局桩是双层 Proxy（get trap 每次返回新子 Proxy），对其写属性无效，
// 因此覆盖时必须整体替换 window.electronAPI。
type LogNamespace = { exportZip?: () => Promise<unknown> }
type Win = { electronAPI?: Record<string, unknown> }
const getWin = (): Win => window as unknown as Win

/** 整体替换 window.electronAPI，注入指定 log 命名空间，清理时还原回桩 */
function mockLogNamespace(log: LogNamespace) {
  return () => {
    const w = getWin()
    const prevApi = w.electronAPI
    w.electronAPI = { log }
    return () => {
      w.electronAPI = prevApi
    }
  }
}

const meta: Meta<typeof FeedbackDialog> = {
  title: 'Common/FeedbackDialog',
  component: FeedbackDialog,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '错误反馈对话框：填写问题描述（≤500 字）、勾选附带日志/系统信息、一键导出诊断包，并提供 QQ 群 / GitHub Issues 联系方式。' +
          '依赖 `window.electronAPI.log.exportZip`（Storybook 全局桩默认 resolve(undefined)，导出会落到失败文案；' +
          '「导出成功」故事在 beforeEach 中覆盖了该命名空间）。' +
          '无障碍要点：标题绑定 `aria-labelledby`，表单控件均有关联 label，焦点陷阱与 Esc 关闭由 BaseDialog 提供。' +
          '同置测试：`FeedbackDialog.test.tsx`（`npm run test:renderer -- src/renderer/components/common/FeedbackDialog.test.tsx`）。' +
          '注意：该故事组覆写全局 mock（window.electronAPI），Docs 页多预览共存时以最后挂载者为准，请在 Canvas 单故事模式验证交互语义。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof FeedbackDialog>

/** 默认：走全局 electronAPI 桩，点击「导出诊断包」可见失败文案路径 */
export const Default: Story = {
  args: {
    open: true,
    onClose: fn()
  }
}

/** 导出成功：覆盖 log.exportZip 返回 { success: true } */
export const ExportSuccess: Story = {
  args: {
    open: true,
    onClose: fn()
  },
  beforeEach: mockLogNamespace({ exportZip: async () => ({ success: true }) })
}

/** 导出失败（带原因）：覆盖 log.exportZip 返回业务错误信息 */
export const ExportFailed: Story = {
  args: {
    open: true,
    onClose: fn()
  },
  beforeEach: mockLogNamespace({
    exportZip: async () => ({ success: false, message: '磁盘空间不足，无法打包日志' })
  })
}
