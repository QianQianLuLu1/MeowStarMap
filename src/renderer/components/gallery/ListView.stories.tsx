import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { ListView } from './ListView'
import { makeMediaFiles } from './story-fixtures'

/**
 * 列表视图故事（react-virtuoso 虚拟化）。
 * 组件完全由 props 驱动：媒体数据使用 SVG data URL 占位（见 story-fixtures），
 * 含正常 / 收藏 / 视频 / 丢失 / 损坏混合状态。Virtuoso 需要带高度的容器，故包一层固定高度外壳。
 */

const demoFiles = makeMediaFiles(24)

const meta: Meta<typeof ListView> = {
  title: 'Gallery/ListView',
  component: ListView,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '虚拟化列表视图（性能重构 v3：迁移至 react-virtuoso，万级文件滚动帧率 ≥ 55 FPS）。' +
          '行内展示缩略图（损坏文件降级为占位图标 + 角标）、文件名、创建日期、分辨率、体积与评分星标。' +
          '交互：单击选中、Ctrl/⌘ 单击切换多选、Enter/Space 打开、↑↓ 键盘导航。' +
          '无障碍要点：每行 `role="listitem"` + `aria-selected` + `tabIndex=0`，丢失文件以 50% 透明度 + 角标双通道提示。' +
          '同置测试：暂无。'
      }
    }
  },
  args: {
    files: demoFiles,
    selectedIds: [],
    onSelect: fn(),
    onToggleSelection: fn(),
    onContextMenu: fn()
  },
  render: (args) => (
    <div style={{ height: 460, padding: 16 }}>
      <ListView {...args} />
    </div>
  )
}

export default meta
type Story = StoryObj<typeof ListView>

/** 默认：24 条混合状态数据（含收藏 / 视频 / 丢失 / 损坏） */
export const Default: Story = {}

/** 选中态：第 2、4 行高亮（accent 背景 + 白色文字） */
export const WithSelection: Story = {
  args: { selectedIds: ['2', '4'] }
}

/** 降级合集：仅展示丢失与损坏文件，观察角标与占位图标 */
export const DegradedOnly: Story = {
  args: { files: demoFiles.filter((f) => f.is_missing || f.is_corrupted) }
}
