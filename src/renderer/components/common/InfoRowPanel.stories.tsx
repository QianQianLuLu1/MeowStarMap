import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { InfoRowPanel, type InfoRow, type ParamGroup } from './InfoRowPanel'
import { IconCamera } from '../../icons'

/**
 * 信息行面板（5 个 InfoPanel 的公共渲染载体）故事。
 * 覆盖：扁平 rows / 分组 groups / loading / error / empty / 复制按钮（含已复制态）/ dark 变体。
 * 纯展示组件，不依赖 window.electronAPI；缺省文案走既有 i18n key（infoPanel.*）。
 */

const DEMO_ROWS: InfoRow[] = [
  { label: '巨大化', value: '开启' },
  { label: '隐藏暖暖', value: '关闭' },
  { label: '位置', value: '(102.3, 55.1, -30.8)' },
  { label: '旋转', value: 'Yaw 12.0°, Pitch 0.0°, Roll -3.5°' },
  { label: '缩放', value: '(1.00, 1.00, 1.00)' }
]

const DEMO_GROUPS: ParamGroup[] = [
  {
    title: '镜头与构图',
    rows: [
      { label: '竖构图', value: '是' },
      { label: '缩放', value: '1.20x' },
      { label: '焦距', value: '35.0mm' }
    ]
  },
  {
    title: '画面调节',
    rows: [
      { label: '亮度', value: '50%' },
      { label: '曝光', value: '55%' },
      { label: '对比度', value: '48%' }
    ]
  }
]

const meta: Meta<typeof InfoRowPanel> = {
  title: 'Common/InfoRowPanel',
  component: InfoRowPanel,
  tags: ['autodocs'],
  argTypes: {
    variant: { control: { type: 'select' }, options: ['light', 'dark'] },
    icon: { control: false },
    rows: { control: false },
    groups: { control: false },
    emptyText: { control: false }
  },
  args: {
    icon: <IconCamera size={14} />,
    title: '相机参数',
    rows: DEMO_ROWS,
    variant: 'light',
    showTitle: true
  },
  decorators: [(Story) => <div className="w-80 p-3">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          '5 个游戏参数面板（相机 / 暖暖 / 搭配 / 拍摄 / 交互物）的公共渲染载体：' +
          '统一 loading / error / empty / data 四态与 light / dark 双主题，支持扁平 `rows` 与分组 `groups` 两种数据形态，' +
          '可选复制按钮（传入 `onCopy` 时显示）。调用方负责数据获取，本组件只做展示。' +
          '无障碍要点：复制按钮带 `title` / `aria-label`（`infoPanel.copyTitle` / `infoPanel.copyAriaLabel`）。' +
          '同置测试：`InfoRowPanel.test.tsx`（`npm run test:renderer -- src/renderer/components/common/InfoRowPanel.test.tsx`）。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof InfoRowPanel>

/** 默认：扁平 rows 数据 */
export const Default: Story = {}

/** 分组数据：相机参数面板的形态（多组小标题 + 行） */
export const Grouped: Story = {
  args: { rows: undefined, groups: DEMO_GROUPS }
}

/** 加载中：转圈 + 自定义加载文案 */
export const Loading: Story = {
  args: { rows: [], loading: true, loadingText: '正在读取参数…' }
}

/** 错误态：前缀 + 错误详情 */
export const ErrorState: Story = {
  args: { rows: [], error: '解密失败：文件头损坏（示例）', errorPrefix: '读取失败' }
}

/** 空态：无数据时的提示文案 */
export const Empty: Story = {
  args: { rows: [], emptyText: '该照片未包含游戏参数' }
}

/** 复制按钮：传入 onCopy 后标题行右侧出现复制入口 */
export const WithCopy: Story = {
  args: { rows: DEMO_ROWS, onCopy: fn(), copyLabel: '复制参数代码' }
}

/** 已复制态：按钮文案切换为「已复制」（`infoPanel.copied`） */
export const Copied: Story = {
  args: { rows: DEMO_ROWS, onCopy: fn(), copied: true, copyLabel: '复制参数代码' }
}

/** dark 变体：全屏预览深色背景上的配色 */
export const Dark: Story = {
  args: {
    variant: 'dark',
    groups: DEMO_GROUPS,
    rows: undefined,
    onCopy: fn(),
    copyLabel: '复制参数代码'
  },
  decorators: [
    (Story) => (
      <div className="w-80 p-4 rounded-xl" style={{ background: '#20242e' }}>
        <Story />
      </div>
    )
  ]
}
