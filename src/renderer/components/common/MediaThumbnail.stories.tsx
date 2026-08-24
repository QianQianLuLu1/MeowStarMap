import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { MediaThumbnail } from './MediaThumbnail'

/**
 * 公共媒体缩略图组件故事。
 * 覆盖：正常缩略图 / 视频占位 / 丢失角标 / 损坏容错 / 加载失败降级 / 小号角标。
 * 示例图片使用 SVG data URL，不引用真实本地路径。
 */

/** 演示用缩略图（SVG data URL，渐变风景示意） */
const DEMO_THUMB =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#ffd7e8"/><stop offset="1" stop-color="#8ec5fc"/>' +
      '</linearGradient></defs>' +
      '<rect width="480" height="360" fill="url(#g)"/>' +
      '<circle cx="360" cy="90" r="42" fill="#fff3b0"/>' +
      '<path d="M0 260 L140 170 L260 250 L360 190 L480 270 L480 360 L0 360 Z" fill="#5e8c61" opacity="0.85"/>' +
      '</svg>'
  )

/** 无法解码的 src（截断的 base64），触发 img onError → 警告占位 */
const BROKEN_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

const meta: Meta<typeof MediaThumbnail> = {
  title: 'Common/MediaThumbnail',
  component: MediaThumbnail,
  tags: ['autodocs'],
  argTypes: {
    fileType: { control: { type: 'select' }, options: ['image', 'video'] },
    badgeSize: { control: { type: 'select' }, options: ['md', 'sm'] },
    className: { control: false },
    imgClassName: { control: false }
  },
  args: {
    src: DEMO_THUMB,
    alt: '示例缩略图',
    fileType: 'image',
    onClick: fn(),
    onContextMenu: fn()
  },
  // 组件自身为 w-full h-full，由外层容器给定演示尺寸
  decorators: [
    (Story) => (
      <div
        className="w-56 h-40 rounded-lg overflow-hidden"
        style={{ border: '1px solid var(--divider)' }}
      >
        <Story />
      </div>
    )
  ],
  parameters: {
    docs: {
      description: {
        component:
          '公共媒体缩略图组件：统一包装 img + MissingBadge + CorruptedBadge + MediaThumbPlaceholder + onError 错误处理。' +
          '损坏文件不再尝试加载缩略图（直接占位），加载失败显示警告图标而非破碎图。' +
          '无障碍要点：`alt` 文本来自文件名，角标自带 aria-label 与 tooltip。' +
          '同置测试：`MediaThumbnail.test.tsx`（`npm run test:renderer -- src/renderer/components/common/MediaThumbnail.test.tsx`）。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof MediaThumbnail>

/** 默认：正常缩略图 */
export const Default: Story = {}

/** 视频文件无缩略图：显示视频图标占位 */
export const VideoPlaceholder: Story = {
  args: { src: null, fileType: 'video', alt: '示例视频' }
}

/** 丢失文件：红色丢失角标（缩略图仍在） */
export const Missing: Story = {
  args: { isMissing: true }
}

/** 损坏文件：橙色损坏角标 + 占位图，跳过缩略图加载；hover 角标可见失败原因 */
export const Corrupted: Story = {
  args: {
    isCorrupted: true,
    corruptedReason: '示例：图像数据块校验失败（CRC 错误）'
  }
}

/** 加载失败：src 存在但解码失败，onError 后降级为警告占位 */
export const BrokenImage: Story = {
  args: { src: BROKEN_SRC, alt: '加载失败示例' }
}

/** 小号角标（网格密集视图用）：丢失 + 损坏同时标记 */
export const SmallBadges: Story = {
  args: {
    badgeSize: 'sm',
    isMissing: true,
    isCorrupted: true,
    corruptedReason: '示例：视频流无法解析'
  }
}
