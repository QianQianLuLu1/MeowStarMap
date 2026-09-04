import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { TaskProgressOverlay } from './TaskProgressOverlay'
import type { TaskProgress } from '../../../shared/types/progress'

/**
 * 通用任务进度浮窗故事。
 * 纯展示组件：不订阅 IPC，progress 由调用方传入。
 * 覆盖处理中（可取消）/ 阶段步骤 / 完成 / 异常四个关键状态；不依赖 window.electronAPI。
 */
const meta: Meta<typeof TaskProgressOverlay> = {
  title: 'Common/TaskProgressOverlay',
  component: TaskProgressOverlay,
  tags: ['autodocs'],
  argTypes: {
    progress: { control: false },
    children: { control: false },
    position: {
      control: { type: 'select' },
      options: ['bottom-right', 'bottom-left', 'top-right', 'top-left']
    }
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '通用任务进度浮窗（扫描 / 重复检测 / 批量编辑 / 水印 / 导入等共用）：`progress=null` 时不渲染，' +
          '终态（done / cancelled / error）隐藏 Spinner，取消按钮仅在 `canCancel=true` 且提供 `onCancel` 时显示。' +
          '无障碍要点：容器 `role="status"` + `aria-live="polite"`，进度变化自动播报；取消按钮可键盘触达。' +
          '同置测试：`TaskProgressOverlay.test.tsx`（`npm run test:renderer -- src/renderer/components/common/TaskProgressOverlay.test.tsx`）。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof TaskProgressOverlay>

const baseProgress: TaskProgress = {
  taskId: 'demo-task',
  taskType: 'scan',
  phase: 'processing',
  current: 1284,
  total: 3200,
  percent: 40,
  etaMs: 92000,
  startedAt: Date.now() - 60_000,
  canCancel: true,
  message: '正在扫描相册目录…'
}

/** 处理中：可取消，显示 ETA 与 current/total */
export const Processing: Story = {
  args: {
    progress: baseProgress,
    onCancel: fn()
  }
}

/** 阶段步骤：stages 存在时渲染「准备→处理→收尾」步骤列表 */
export const WithStages: Story = {
  args: {
    progress: {
      ...baseProgress,
      taskType: 'batch',
      message: '批量应用编辑…',
      stages: [
        { id: '0', label: '准备文件列表', status: 'done' },
        { id: '1', label: '应用参数', status: 'active', detail: '1284 / 3200' },
        { id: '2', label: '更新索引', status: 'pending' }
      ]
    },
    onCancel: fn()
  }
}

/** 完成终态：隐藏 Spinner 与取消按钮，底部显示阶段文案 */
export const Done: Story = {
  args: {
    progress: {
      ...baseProgress,
      phase: 'done',
      current: 3200,
      percent: 100,
      etaMs: 0,
      canCancel: false
    }
  }
}

/** 异常终态：阶段步骤中可标记 failed 并附带原因 */
export const ErrorState: Story = {
  args: {
    progress: {
      ...baseProgress,
      phase: 'error',
      canCancel: false,
      stages: [
        { id: '0', label: '准备文件列表', status: 'done' },
        { id: '1', label: '写入水印', status: 'failed', detail: '目标目录不可写' },
        { id: '2', label: '更新索引', status: 'pending' }
      ]
    }
  }
}
