import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { ZoomableContainer } from './ZoomableContainer'

/**
 * 可缩放容器故事。
 * 覆盖：图标复位按钮 / 文字复位按钮（百分比展示）/ 点击回调（含拖拽检测）。
 * 交互提示：滚轮或双击放大后出现复位按钮，放大后可拖拽平移。
 * 复位按钮文案走既有 i18n key（detail.zoomable.*）。
 */

/** 演示用图片（SVG data URL，不引用真实本地路径） */
const DEMO_IMAGE =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420">' +
      '<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#a7c7ff"/><stop offset="1" stop-color="#ffd9ec"/>' +
      '</linearGradient></defs>' +
      '<rect width="640" height="420" fill="url(#sky)"/>' +
      '<circle cx="500" cy="110" r="52" fill="#ffe58a"/>' +
      '<path d="M0 300 L180 190 L330 290 L470 220 L640 310 L640 420 L0 420 Z" fill="#6a9c6f"/>' +
      '<path d="M0 340 L220 260 L420 350 L640 300 L640 420 L0 420 Z" fill="#40694c" opacity="0.9"/>' +
      '</svg>'
  )

const meta: Meta<typeof ZoomableContainer> = {
  title: 'Common/ZoomableContainer',
  component: ZoomableContainer,
  tags: ['autodocs'],
  argTypes: {
    resetVariant: { control: { type: 'select' }, options: ['icon', 'text'] },
    children: { control: false },
    containerStyle: { control: false }
  },
  args: {
    maxZoom: 5,
    resetVariant: 'icon',
    containerClassName: 'relative w-full h-full overflow-hidden',
    ariaLabel: '可缩放预览区'
  },
  parameters: {
    docs: {
      description: {
        component:
          '可缩放/平移共享容器：封装 useZoomable（滚轮缩放、双击缩放/复位、放大后拖拽平移）与复位按钮，' +
          '`resetVariant` 区分图标按钮（详情页）与「百分比 + 复位文字」（编辑器）。' +
          '带拖拽检测：拖拽距离 > 5px 时释放不触发 `onClick`。' +
          '无障碍要点：传 `onClick` 时容器为 `role="button"` + `tabIndex=0`，复位按钮带 `aria-label`（`detail.zoomable.resetZoom`）。' +
          '同置测试：`ZoomableContainer.test.tsx`（`npm run test:renderer -- src/renderer/components/common/ZoomableContainer.test.tsx`）。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof ZoomableContainer>

/** 默认（icon 复位）：滚轮 / 双击放大后右下角出现复位图标 */
export const Default: Story = {
  render: function Render(args) {
    return (
      <div
        className="w-[480px] h-[320px] rounded-xl overflow-hidden"
        style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--divider)' }}
      >
        <ZoomableContainer {...args}>
          <img
            src={DEMO_IMAGE}
            alt="示例图片"
            className="w-full h-full object-contain"
            draggable={false}
          />
        </ZoomableContainer>
      </div>
    )
  }
}

/** text 复位变体：编辑器用法，显示当前缩放百分比 + 复位文字按钮 */
export const TextResetVariant: Story = {
  args: { resetVariant: 'text' },
  render: function Render(args) {
    return (
      <div
        className="w-[480px] h-[320px] rounded-xl overflow-hidden"
        style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--divider)' }}
      >
        <ZoomableContainer {...args}>
          <img
            src={DEMO_IMAGE}
            alt="示例图片"
            className="w-full h-full object-contain"
            draggable={false}
          />
        </ZoomableContainer>
      </div>
    )
  }
}

/** 带点击回调：未缩放时光标为 zoom-in，点击触发 onSelect；拖拽后释放不误触发 */
export const WithClickCallback: Story = {
  args: { onClick: fn() },
  render: function Render(args) {
    return (
      <div
        className="w-[480px] h-[320px] rounded-xl overflow-hidden"
        style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--divider)' }}
      >
        <ZoomableContainer {...args}>
          <img
            src={DEMO_IMAGE}
            alt="示例图片"
            className="w-full h-full object-contain"
            draggable={false}
          />
        </ZoomableContainer>
      </div>
    )
  }
}
