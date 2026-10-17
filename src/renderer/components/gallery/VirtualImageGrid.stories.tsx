import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { VirtualImageGrid } from './VirtualImageGrid'
import { makeMediaFiles } from './story-fixtures'

/**
 * 虚拟化网格视图故事（react-virtuoso VirtuosoGrid）。
 * 组件完全由 props 驱动：媒体数据使用 SVG data URL 占位（见 story-fixtures）。
 * VirtuosoGrid 需要带高度的滚动容器，故包一层固定高度外壳。
 */

const demoFiles = makeMediaFiles(24)

const meta: Meta<typeof VirtualImageGrid> = {
  title: 'Gallery/VirtualImageGrid',
  component: VirtualImageGrid,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '虚拟化网格视图（性能重构 v3：迁移至 react-virtuoso，万级文件滚动帧率 ≥ 55 FPS）。' +
          '支持响应式列数、缩略图分级加载（low → standard → high）、键盘 ↑↓←→/Home/End/Enter/Space 导航、' +
          '收藏徽标、视频时长徽标、丢失 / 损坏角标降级与触屏常驻操作按钮。' +
          '无障碍要点：容器 `role="grid"` + `aria-label`，单元格 `role="gridcell"` + `aria-selected`，焦点项带 accent outline。' +
          '同置测试：暂无。'
      }
    }
  },
  args: {
    items: demoFiles,
    selectedIds: [],
    onSelect: fn(),
    onHover: fn(),
    onContextMenu: fn()
  },
  render: (args) => (
    <div style={{ height: 560, padding: 16 }} className="flex flex-col">
      <VirtualImageGrid {...args} />
    </div>
  )
}

export default meta
type Story = StoryObj<typeof VirtualImageGrid>

/** 默认：24 条混合状态数据（悬停卡片可见文件名 / 体积浮层） */
export const Default: Story = {}

/** 选中态：第 1、3 项带 accent 描边 */
export const WithSelection: Story = {
  args: { selectedIds: ['1', '3'] }
}

/**
 * 多选模式选中态（fix-image-selection-border-visibility 手验入口）：
 * 卡片左上角渲染 MediaCheckbox，选中卡片带 `is-selected` 语义类——
 * 由 globals.css 的 `.media-card.is-selected` 提供「主题色描边 + 背景色内衬
 * 双线框 + 阴影加深 + accent-soft 外发光」四层视觉；悬停时描边加深一档。
 */
export const WithMultiSelect: Story = {
  args: {
    selectedIds: ['1', '3', '4'],
    multiSelectMode: true,
    onToggleSelection: fn()
  }
}

/** 卡片快捷操作：注入编辑 / 收藏 / 删除回调（仅图片显示编辑按钮） */
export const WithCardActions: Story = {
  args: { onEdit: fn(), onFavorite: fn(), onDelete: fn() }
}

/** 无限滚动页脚：加载中状态（role="status" aria-live="polite"） */
export const LoadingMoreFooter: Story = {
  args: { onEndReached: fn(), loadingMore: true, hasMore: true }
}

/** 无限滚动页脚：没有更多内容（传入 onEndReached 且 hasMore=false 时显示结束文案） */
export const NoMoreFooter: Story = {
  args: { onEndReached: fn(), loadingMore: false, hasMore: false }
}
