import type { Meta, StoryObj } from '@storybook/react-vite'
import { TitleBar } from './TitleBar'

/**
 * 标题栏故事。
 * 组件无 props、无 store / IPC 依赖，仅渲染应用图标与国际化标题文本。
 */
const meta: Meta<typeof TitleBar> = {
  title: 'Layout/TitleBar',
  component: TitleBar,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '窗口顶部标题栏：`fixed` 定位 + `app-drag`（-webkit-app-region: drag）拖拽区，' +
          '展示应用图标与标题（i18n key `titleBar.appTitle`）。实际窗口中右上角为系统窗口控制按钮区。' +
          '无障碍要点：纯展示性区域，无交互控件；文字色 `var(--text-secondary)`，与标题栏背景对比度满足辅助阅读。' +
          '同置测试：暂无。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof TitleBar>

/** 默认：跟随当前主题与语言渲染 */
export const Default: Story = {}
