import type { Meta, StoryObj } from '@storybook/react-vite'
import { CorruptedBadge } from './CorruptedBadge'

/**
 * 损坏文件角标故事。
 * 覆盖 md / sm 两种尺寸与带失败原因 tooltip 的用法；文案走既有
 * i18n key（common.corruptedBadge.*），不依赖 window.electronAPI。
 */
const meta: Meta<typeof CorruptedBadge> = {
  title: 'Common/CorruptedBadge',
  component: CorruptedBadge,
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: { type: 'select' },
      options: ['md', 'sm']
    }
  },
  parameters: {
    docs: {
      description: {
        component:
          '损坏文件角标（橙色，区别于丢失的红色）：组件为 `absolute` 定位，需放在 `relative` 的缩略图容器内使用。' +
          '传入 `reason` 时原生 `title` tooltip 显示失败原因（i18n key `common.corruptedBadge.titleWithReason`）。' +
          '无障碍要点：信息同时以文字标签呈现，不仅靠颜色区分；hover 可查看原因。' +
          '同置测试：角标行为契约可参考姊妹组件 `MissingBadge.test.tsx`（CorruptedBadge 的同置测试待补齐）。'
      }
    }
  },
  // 角标为 absolute 定位，用模拟缩略图容器承接
  decorators: [
    (Story) => (
      <div
        className="relative rounded-lg overflow-hidden"
        style={{ width: '180px', height: '120px', background: 'var(--bg-tertiary)' }}
      >
        <Story />
      </div>
    )
  ]
}

export default meta
type Story = StoryObj<typeof CorruptedBadge>

/** md：网格 / 瀑布流缩略图左上角 */
export const Default: Story = {}

/** sm：列表 / 时间线等紧凑视图 */
export const Small: Story = {
  args: { size: 'sm' }
}

/** 带失败原因：hover 角标可看到 tooltip */
export const WithReason: Story = {
  args: {
    reason: 'JPEG 数据流在 62% 处截断，解码失败（libvips: VipsJpeg: premature end of file）'
  }
}
