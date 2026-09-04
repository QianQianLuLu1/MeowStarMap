import type { Meta, StoryObj } from '@storybook/react-vite'
import { MissingBadge } from './MissingBadge'

/**
 * 丢失文件角标故事。
 * 覆盖 md / sm 两种尺寸与自定义文案；文案走既有
 * i18n key（common.missingBadge.*），不依赖 window.electronAPI。
 */
const meta: Meta<typeof MissingBadge> = {
  title: 'Common/MissingBadge',
  component: MissingBadge,
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
          '丢失文件角标（红色，`--danger` 主题变量）：标记 `is_missing=true`（文件被外部删除/移动）。' +
          '组件为 `absolute` 定位，需放在 `relative` 的缩略图容器内使用。' +
          '无障碍要点：信息以文字标签呈现，不仅靠颜色区分。' +
          '同置测试：`MissingBadge.test.tsx`（`npm run test:renderer -- src/renderer/components/common/MissingBadge.test.tsx`）。'
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
type Story = StoryObj<typeof MissingBadge>

/** md：网格 / 瀑布流缩略图左上角 */
export const Default: Story = {}

/** sm：列表 / 时间线等紧凑视图 */
export const Small: Story = {
  args: { size: 'sm' }
}

/** 自定义文案（覆盖默认 i18n 标签） */
export const CustomLabel: Story = {
  args: { label: '待找回' }
}
