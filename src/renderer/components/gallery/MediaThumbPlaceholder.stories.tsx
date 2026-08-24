import type { Meta, StoryObj } from '@storybook/react-vite'
import { MediaThumbPlaceholder } from './MediaThumbPlaceholder'

/**
 * 媒体缩略图占位/失败图标故事。
 * 覆盖 image / video / error 三种图标分支与 overlay / inline 两种定位变体。
 */
const meta: Meta<typeof MediaThumbPlaceholder> = {
  title: 'Gallery/MediaThumbPlaceholder',
  component: MediaThumbPlaceholder,
  tags: ['autodocs'],
  argTypes: {
    fileType: { control: { type: 'select' }, options: ['image', 'video'] },
    variant: { control: { type: 'select' }, options: ['overlay', 'inline'] },
    size: { control: { type: 'number' } }
  },
  args: { fileType: 'image', hasError: false },
  parameters: {
    docs: {
      description: {
        component:
          '统一各 Gallery 视图的「缩略图缺失 / 加载失败」占位图标（P1-U10）：hasError 显示警告图标，' +
          '否则按 file_type 显示图片 / 视频图标。`overlay` 变体绝对定位居中（网格视图），`inline` 变体无定位（列表视图）。' +
          '无障碍要点：纯装饰性图标，颜色取 `var(--text-tertiary)`，需与 `var(--bg-tertiary)` 底色保持可辨识对比。' +
          '同置测试：暂无（组件逻辑简单，由使用方视图测试间接覆盖）。'
      }
    }
  },
  // overlay 变体需要定位上下文，统一包一层类媒体卡片的容器便于观察
  render: (args) => (
    <div
      className="relative w-44 h-44 rounded-xl overflow-hidden"
      style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--divider)' }}
    >
      <MediaThumbPlaceholder {...args} />
    </div>
  )
}

export default meta
type Story = StoryObj<typeof MediaThumbPlaceholder>

/** 默认：图片占位图标（overlay 居中） */
export const ImagePlaceholder: Story = {}

/** 视频文件：显示视频图标 */
export const VideoPlaceholder: Story = {
  args: { fileType: 'video' }
}

/** 加载失败：显示警告图标（优先级高于文件类型） */
export const ErrorPlaceholder: Story = {
  args: { hasError: true }
}

/** inline 变体：无绝对定位，撑满父容器（列表视图用法） */
export const InlineVariant: Story = {
  args: { fileType: 'video', variant: 'inline', size: 24 }
}

/** 隐藏态：有缩略图且未出错时 visible=false，组件渲染 null */
export const Hidden: Story = {
  args: { visible: false }
}
