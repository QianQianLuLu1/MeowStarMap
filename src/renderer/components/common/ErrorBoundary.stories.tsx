import type { Meta, StoryObj } from '@storybook/react-vite'
import type React from 'react'
import { ErrorBoundary } from './ErrorBoundary'
import { ZoneErrorFallback } from './ErrorFallback'

/**
 * 错误边界故事。
 * 覆盖：正常渲染 / 捕获渲染异常（默认全屏 ErrorFallback）/ 自定义区域级 fallback + 重试恢复。
 * 捕获错误时经 window.electronAPI.log.reportRendererError 上报，由全局安全桩承接。
 * 注意：演示错误会在浏览器控制台输出 React 错误日志，属预期行为。
 */

/** 每次渲染都抛错的演示子组件（触发默认全屏 fallback） */
function AlwaysBomb(): React.JSX.Element {
  throw new Error('演示错误：组件渲染过程中抛出异常')
}

/** 只抛错一次的演示子组件：首次挂载抛错，重试（重新挂载）后恢复正常 */
let threwOnce = false
function ThrowOnce() {
  if (!threwOnce) {
    threwOnce = true
    throw new Error('演示错误：首次渲染失败，重试后恢复')
  }
  return (
    <div className="p-6 rounded-lg text-sm" style={{ background: 'var(--bg-tertiary)' }}>
      子树已恢复渲染：重试（递增 key 重新挂载）成功清空了错误态。
    </div>
  )
}

const meta: Meta<typeof ErrorBoundary> = {
  title: 'Common/ErrorBoundary',
  component: ErrorBoundary,
  tags: ['autodocs'],
  argTypes: {
    children: { control: false },
    fallback: { control: false },
    resetKeys: { control: false }
  },
  parameters: {
    docs: {
      description: {
        component:
          'React 错误边界：捕获子树同步渲染异常避免白屏，并通过 `window.electronAPI.log.reportRendererError` 上报主进程（IPC 不可用时静默）。' +
          '三种用法：根边界（默认全屏 ErrorFallback + reload 兜底）/ 路由级（`resetKeys` 切页自动恢复）/ 区域级（自定义 `fallback` 仅替换出错区域）。' +
          '无法捕获事件处理器与异步错误（由 window.onerror 兜底）。' +
          '注意：`CatchesError` 故事的全屏 fallback 的「重新加载」按钮会刷新整个预览窗口。' +
          '同置测试：`ErrorBoundary.test.tsx`（`npm run test:renderer -- src/renderer/components/common/ErrorBoundary.test.tsx`）。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof ErrorBoundary>

/** 默认：子树正常渲染，边界透明 */
export const Default: Story = {
  render: () => (
    <ErrorBoundary>
      <div className="p-6 rounded-lg text-sm" style={{ background: 'var(--bg-tertiary)' }}>
        子树渲染正常，ErrorBoundary 不产生任何额外 DOM。
      </div>
    </ErrorBoundary>
  )
}

/** 捕获渲染异常：展示默认全屏 ErrorFallback（重试 / 打开日志目录 / 复制错误信息） */
export const CatchesError: Story = {
  render: () => (
    <ErrorBoundary>
      <AlwaysBomb />
    </ErrorBoundary>
  )
}

/** 区域级自定义 fallback：出错只替换本区域，点击「重试」重新挂载子树后恢复 */
export const WithCustomFallback: Story = {
  // 模块级标志复位：Docs 页二次挂载（或重进故事）时恢复「首次挂载抛错」演示语义
  beforeEach: () => {
    threwOnce = false
  },
  render: () => (
    <div className="w-96">
      <ErrorBoundary fallback={ZoneErrorFallback}>
        <ThrowOnce />
      </ErrorBoundary>
    </div>
  )
}
