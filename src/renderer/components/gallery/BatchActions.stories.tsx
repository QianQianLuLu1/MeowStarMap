import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { BatchActions } from './BatchActions'

/**
 * 批量操作浮动工具栏故事。
 * 组件完全由 props 驱动（无任何 store / IPC 依赖）：覆盖最小按钮集与全部可选能力
 * （导出到默认目录 / 批量重命名 / 归类 / 转移到档案 / 剪贴板分享 / WiFi 分享）。
 */
const meta: Meta<typeof BatchActions> = {
  title: 'Gallery/BatchActions',
  component: BatchActions,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '选中媒体后底部居中的浮动批量操作栏（`fixed` 定位，`role="toolbar"`）。' +
          '必选操作：全选 / 反选 / 删除 / 导出 / 移动 / 水印 / 清除选择；' +
          '可选操作由父组件按需注入回调后条件渲染（导出到默认目录、批量重命名、归类、转移到档案、剪贴板与 WiFi 分享）。' +
          '无障碍要点：容器 `role="toolbar"` + `aria-label`，每个图标按钮均带 `aria-label`，全部键盘可达。' +
          '同置测试：暂无（交互由 `right-click-wiring.test.ts` 与页面级测试间接覆盖）。'
      }
    }
  },
  args: {
    count: 3,
    total: 128,
    onExport: fn(),
    onMove: fn(),
    onWatermark: fn(),
    onDelete: fn(),
    onClear: fn(),
    onSelectAll: fn(),
    onInvertSelection: fn()
  }
}

export default meta
type Story = StoryObj<typeof BatchActions>

/** 默认：最小必选按钮集（选中 3 / 128） */
export const Default: Story = {}

/** 全量能力：注入全部可选回调，展示按钮条件渲染与 FLIP 重排 */
export const FullFeatured: Story = {
  args: {
    count: 42,
    onCategorize: fn(),
    onShareWifi: fn(),
    onShareClipboard: fn(),
    onBatchRename: fn(),
    onExportToDefault: fn(),
    profiles: [
      { uid: 'default', nickname: '默认档案' },
      { uid: 'nikki-002', nickname: '暖暖的衣橱' },
      { uid: 'nikki-003', nickname: '旅行相册' }
    ],
    onTransferToProfile: fn()
  }
}

/** 全选状态：已选数等于总数 */
export const AllSelected: Story = {
  args: { count: 128, total: 128 }
}

/**
 * 窄视口降级（≤640px）：标签文字隐藏仅留图标（title/aria-label 保留完整语义）。
 * 验证方式：在 Storybook 画布中将窗口/画布拖窄至 ≤640px（或直接缩放浏览器至 150%+），
 * 工具栏为 fixed 定位，@media 断点基于真实视口宽度，会自动触发图标化降级。
 * 注：项目未启用 storybook viewport addon（避免新增依赖），故不依赖 defaultViewport 参数，
 * 直接拖窄画布即为真实降级验证（见测试计划 V2）。
 */
export const IconOnlyNarrow: Story = {
  parameters: {
    viewport: { defaultViewport: 'mobile1' }
  },
  args: {
    count: 42,
    onCategorize: fn(),
    onShareWifi: fn(),
    onShareClipboard: fn(),
    onBatchRename: fn(),
    onExportToDefault: fn(),
    profiles: [{ uid: 'default', nickname: '默认档案' }],
    onTransferToProfile: fn()
  }
}

/**
 * 中屏降级（≤960px）：覆盖「641–960px 窗口在 150%/175% 系统缩放下文字更易溢出」盲区。
 * 验证方式：将画布拖窄至 ≤960px（或缩放浏览器），长中文标签（导出到默认、WiFi 分享等）
 * 隐藏仅留图标，无需靠横向滚动即可一眼看清全部操作。
 */
export const IconOnlyMedium: Story = {
  parameters: {
    viewport: { defaultViewport: 'tablet' }
  },
  args: {
    count: 42,
    onCategorize: fn(),
    onShareWifi: fn(),
    onShareClipboard: fn(),
    onBatchRename: fn(),
    onExportToDefault: fn(),
    profiles: [
      { uid: 'default', nickname: '默认档案' },
      { uid: 'nikki-002', nickname: '暖暖的衣橱' }
    ],
    onTransferToProfile: fn()
  }
}
