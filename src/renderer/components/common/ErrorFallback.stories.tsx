import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { ErrorFallback, RouteErrorFallback, ZoneErrorFallback } from './ErrorFallback'

/**
 * 错误兜底页故事。
 * 覆盖：全屏根边界 fallback（含组件栈变体）/ 路由级 / 区域级三种形态。
 * 全部文案走既有 i18n key（errorFallback.*）；
 * 「打开日志目录」经 window.electronAPI.log.openDirectory，由全局安全桩承接。
 */

const demoError = new Error('示例渲染异常：无法读取媒体库索引（SQLite 文件被占用）')

const demoComponentStack =
  '\n    at MediaGrid (GalleryPage.tsx:112)\n    at GalleryPage (GalleryPage.tsx:45)\n    at ErrorBoundary (ErrorBoundary.tsx:60)\n    at App (App.tsx:30)'

const meta: Meta<typeof ErrorFallback> = {
  title: 'Common/ErrorFallback',
  component: ErrorFallback,
  tags: ['autodocs'],
  argTypes: {
    error: { control: false },
    componentStack: { control: false }
  },
  args: {
    error: demoError,
    onRetry: fn()
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '错误兜底页：ErrorBoundary 捕获渲染异常时展示，提供重试 / 打开日志目录（`window.electronAPI.log.openDirectory`，Storybook 中由全局桩承接）/ 复制错误信息三个操作，' +
          '可展开查看错误堆栈与组件栈。同文件还导出路由级 `RouteErrorFallback`（占据内容区）与区域级 `ZoneErrorFallback`（小占位块）。' +
          '无障碍要点：按钮均有可见文案，详情页展开为 `<pre>` 可聚焦滚动。' +
          '同置测试：`ErrorFallback.test.tsx`（`npm run test:renderer -- src/renderer/components/common/ErrorFallback.test.tsx`）。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof ErrorFallback>

/** 默认：全屏根边界兜底页 */
export const Default: Story = {}

/** 带组件栈：展开详情后可见 React 组件栈 */
export const WithComponentStack: Story = {
  args: { componentStack: demoComponentStack }
}

/** 路由级：仅占据内容区，侧边栏/工具栏保持可用，提供区域重试 */
export const RouteFallback: Story = {
  render: () => (
    <div className="w-full h-[420px]" style={{ border: '1px dashed var(--divider)' }}>
      <RouteErrorFallback error={demoError} reset={fn()} componentStack={demoComponentStack} />
    </div>
  )
}

/** 区域级：小占位块，仅替换出错区域（如预览画布、插件面板） */
export const ZoneFallback: Story = {
  render: () => (
    <div className="w-80 h-52" style={{ border: '1px dashed var(--divider)' }}>
      <ZoneErrorFallback error={demoError} reset={fn()} />
    </div>
  )
}
