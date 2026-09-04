import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { EmptyState } from './EmptyState'
import { IconImage } from '../../icons'

/**
 * 统一空态组件故事。
 * 覆盖 empty / loading / error 三态与 CTA 按钮组合；不依赖 window.electronAPI。
 */
const meta: Meta<typeof EmptyState> = {
  title: 'Common/EmptyState',
  component: EmptyState,
  tags: ['autodocs'],
  argTypes: {
    icon: { control: false },
    status: {
      control: { type: 'select' },
      options: ['empty', 'loading', 'error']
    },
    spinnerSize: {
      control: { type: 'select' },
      options: ['sm', 'md', 'lg']
    }
  },
  parameters: {
    docs: {
      description: {
        component:
          '统一三态空态组件（empty / loading / error）：loading 态自动以 Spinner 替代图标，' +
          '标题与 CTA 文案未传时走既有 i18n key（`common.loading` / `common.loadFailed` / `common.retry`）。' +
          '无障碍要点：CTA 为原生 button，可 Tab 聚焦；错误态建议同时提供重试回调。' +
          '同置测试：`EmptyState.test.tsx`（`npm run test:renderer -- src/renderer/components/common/EmptyState.test.tsx`）。'
      }
    }
  },
  // 组件内部使用 h-full 撑满，外层给定固定高度便于预览
  decorators: [
    (Story) => (
      <div style={{ height: '260px', width: '420px' }}>
        <Story />
      </div>
    )
  ]
}

export default meta
type Story = StoryObj<typeof EmptyState>

/** 默认空态：图标 + 标题 + 副标题 + CTA */
export const Default: Story = {
  args: {
    icon: <IconImage size={48} />,
    title: '暂无文件',
    subtitle: '点击导入按钮添加你的第一张照片',
    ctaLabel: '导入照片',
    onCta: fn()
  }
}

/** 加载中：自动显示 Spinner，标题默认走 common.loading */
export const Loading: Story = {
  args: {
    status: 'loading'
  }
}

/** 错误态：未传 CTA 文案时默认显示 common.retry */
export const Error: Story = {
  args: {
    status: 'error',
    subtitle: '读取目录失败：路径不存在',
    onCta: fn()
  }
}

/** 错误态 + 自定义重试文案 */
export const ErrorWithCustomCta: Story = {
  args: {
    status: 'error',
    title: '缩略图生成失败',
    ctaLabel: '重新生成',
    onCta: fn()
  }
}
