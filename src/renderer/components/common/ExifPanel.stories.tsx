import type { Meta, StoryObj } from '@storybook/react-vite'
import { ExifPanel } from './ExifPanel'
import type { MediaFile } from '../../stores/mediaStore'

/**
 * EXIF 面板故事。
 * 依赖 window.electronAPI.file.getExif（经 useExif）：
 * 默认由全局安全桩承接（空态）；数据/错误故事在 beforeEach 中整体替换 `file` 命名空间。
 * 全部文案走既有 i18n key（detail.exif.*）。
 */

type Win = { electronAPI?: Record<string, unknown> }
const getWin = (): Win => window as unknown as Win

/**
 * 整体替换 window.electronAPI，注入 `file` 命名空间的 getExif 实现，清理时还原回桩。
 * 全局桩是双层 Proxy（无 set trap，直接写属性无效），必须整体替换。
 */
function mockFileNamespace(getExif: (filePath: string) => Promise<unknown>) {
  return () => {
    const w = getWin()
    const prevApi = w.electronAPI
    w.electronAPI = { file: { getExif } }
    return () => {
      w.electronAPI = prevApi
    }
  }
}

/** 演示文件（不引用真实本地路径） */
const demoFile: MediaFile = {
  id: 'exif-demo-1',
  file_path: 'D:\\InfinityNikki\\Photos\\NikkiPhotos_HighQuality\\IMG_20260823_143000.jpg',
  file_name: 'IMG_20260823_143000.jpg',
  file_type: 'image',
  file_ext: '.jpg',
  file_size: 3_145_728,
  width: 3840,
  height: 2160,
  created_at: '2026-08-23T14:30:00',
  modified_at: '2026-08-23T14:30:00',
  tags: [],
  rating: 0,
  is_favorite: false,
  notes: '',
  scene_category: 'screenshot',
  media_source: 'game',
  album_type: '高质量照片'
}

/** 演示用完整 EXIF 数据 */
const DEMO_EXIF = {
  camera: 'NIKON Z 8',
  lens: 'NIKKOR Z 50mm f/1.2 S',
  aperture: 'f/1.8',
  shutter: '1/500s',
  iso: 200,
  focalLength: '50mm',
  dateTaken: '2026-08-23T14:30:00',
  gps: { latitude: 31.230416, longitude: 121.473701 },
  width: 3840,
  height: 2160
}

const meta: Meta<typeof ExifPanel> = {
  title: 'Common/ExifPanel',
  component: ExifPanel,
  tags: ['autodocs'],
  argTypes: {
    variant: { control: { type: 'select' }, options: ['light', 'dark'] },
    file: { control: false }
  },
  args: {
    file: demoFile,
    variant: 'light',
    showTitle: true
  },
  decorators: [(Story) => <div className="w-80 p-3">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          'EXIF 拍摄参数面板：经 `useExif` 调用 `window.electronAPI.file.getExif` 读取图片元数据，' +
          '视频文件不展示本区块。支持一键复制全部参数（`detail.exif.copyLabel`）。' +
          '本组故事：`Default` 走全局桩呈现空态；`WithData` / `LoadError` / `Dark` 在 beforeEach 整体替换 `file.getExif` 命名空间。' +
          '无障碍要点：复制按钮带 `aria-label`（`detail.exif.copyAriaLabel`），加载态为 `polite` 文案。' +
          '同置测试：`ExifPanel.test.tsx`（`npm run test:renderer -- src/renderer/components/common/ExifPanel.test.tsx`）。' +
          '注意：该故事组覆写全局 mock（window.electronAPI），Docs 页多预览共存时以最后挂载者为准，请在 Canvas 单故事模式验证交互语义。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof ExifPanel>

/** 默认（全局桩）：getExif resolve(undefined) → 空态提示 */
export const Default: Story = {}

/** 完整数据：覆盖全部字段行 + 复制按钮 */
export const WithData: Story = {
  beforeEach: mockFileNamespace(async () => DEMO_EXIF)
}

/** 读取失败：错误前缀 + 原因（`detail.exif.errorPrefix`） */
export const LoadError: Story = {
  beforeEach: mockFileNamespace(async () => {
    throw new Error('文件读取失败（示例）')
  })
}

/** 无标题变体：嵌入详情页侧栏时隐藏标题行 */
export const NoTitle: Story = {
  args: { showTitle: false },
  beforeEach: mockFileNamespace(async () => DEMO_EXIF)
}

/** dark 变体：全屏预览深色背景上的半透明样式 */
export const Dark: Story = {
  args: { variant: 'dark' },
  beforeEach: mockFileNamespace(async () => DEMO_EXIF),
  decorators: [
    (Story) => (
      <div className="w-80 p-4 rounded-xl" style={{ background: '#20242e' }}>
        <Story />
      </div>
    )
  ]
}
