import type { Meta, StoryObj } from '@storybook/react-vite'
import { CameraInfoPanel } from './CameraInfoPanel'
import type { MediaFile } from '../../stores/mediaStore'
import type { GameParamsData, RichCameraParams } from '../../types/decryption'

/**
 * 相机参数面板故事。
 * 依赖 window.electronAPI.decrypt.decodeFile（经 useGameParams，带 LRU 缓存，故各故事用不同文件路径）：
 * 数据故事在 beforeEach 整体替换 `decrypt` 命名空间；
 * loading / error / empty 通过组件注入式 props（gameParams / loading / error）驱动。
 * 全部文案走既有 i18n key（camera.*）。
 */

type Win = { electronAPI?: Record<string, unknown> }
const getWin = (): Win => window as unknown as Win

/**
 * 整体替换 window.electronAPI，注入 decrypt.decodeFile 的返回，清理时还原回桩。
 * 全局桩是双层 Proxy（无 set trap，直接写属性无效），必须整体替换。
 */
function mockDecryptNamespace(result: unknown) {
  return () => {
    const w = getWin()
    const prevApi = w.electronAPI
    w.electronAPI = { decrypt: { decodeFile: async () => result } }
    return () => {
      w.electronAPI = prevApi
    }
  }
}

/** 演示文件（不引用真实本地路径；每个故事路径唯一以避开 useGameParams 缓存） */
function makeDemoFile(path: string): MediaFile {
  return {
    id: `camera-demo-${path}`,
    file_path: path,
    file_name: path.split('\\').pop() ?? path,
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
}

/** 演示用富相机参数（数值经 cameraToGroups 转为百分比/角度展示） */
const DEMO_CAMERA: RichCameraParams = {
  focalLength: 35,
  apertureSection: 2,
  brightness: 0.5,
  exposure: 0.55,
  contrast: 0.48,
  saturation: 0.6,
  vibrance: 0.45,
  highlights: 0.4,
  shadows: 0.52,
  vignetteIntensity: 0.2,
  bloomIntensity: 0.35,
  bloomThreshold: 0.6,
  portraitMode: true,
  filter: { id: 'Fresh_001', strength: 0.5 },
  light: { id: 'DirectionLight_L', strength: 0.7 },
  rawParams: 'focal=35;aperture=2;brightness=50;exposure=55;contrast=48',
  zoom: 1.2,
  rotation: 3.5,
  cameraYaw: -12,
  cameraPitch: 8,
  cameraLoc: { x: 102.3, y: 55.1, z: -30.8 },
  pose: 0,
  framedMoment: 0,
  momoHidden: 'disabled'
}

const DEMO_DATA: GameParamsData = { hasParams: true, camera: DEMO_CAMERA }

const meta: Meta<typeof CameraInfoPanel> = {
  title: 'Common/CameraInfoPanel',
  component: CameraInfoPanel,
  tags: ['autodocs'],
  argTypes: {
    variant: { control: { type: 'select' }, options: ['light', 'dark'] },
    file: { control: false },
    gameParams: { control: false }
  },
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_camera_default.jpg'),
    variant: 'light',
    showTitle: true
  },
  decorators: [(Story) => <div className="w-80 p-3">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          '相机参数面板：仅对游戏内拍摄的图片（`file_type=image` 且有 `album_type`）展示，' +
          '数据来自 `window.electronAPI.decrypt.decodeFile`（经 `useGameParams`，LRU+TTL 缓存，故本组故事各使用不同文件路径）。' +
          '`Default` / `Dark` 在 beforeEach 整体替换 `decrypt` 命名空间注入模拟数据；' +
          '`Loading` / `Error` / `Empty` 经组件注入式 props 驱动（PropertiesDialog 复用同款机制）。' +
          '标题行提供「复制参数代码」按钮（`camera.copyCode`）。' +
          '无障碍要点：复制按钮带 `aria-label`（`infoPanel.copyAriaLabel`）。' +
          '同置测试：`CameraInfoPanel.test.tsx`（`npm run test:renderer -- src/renderer/components/common/CameraInfoPanel.test.tsx`）。' +
          '注意：该故事组覆写全局 mock（window.electronAPI），Docs 页多预览共存时以最后挂载者为准，请在 Canvas 单故事模式验证交互语义。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof CameraInfoPanel>

/** 默认：解密成功，四组参数（镜头与构图 / 光学与光效 / 画面调节 / 场景与特效）+ 复制按钮 */
export const Default: Story = {
  beforeEach: mockDecryptNamespace({ ok: true, data: DEMO_DATA })
}

/** 加载中：注入 loading 展示转圈 + `camera.loading` 文案 */
export const Loading: Story = {
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_camera_loading.jpg'),
    loading: true
  }
}

/** 解密失败：注入 error，展示 `camera.errorPrefix` + 原因 */
export const ErrorState: Story = {
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_camera_error.jpg'),
    error: '解密失败：文件头损坏（示例）'
  }
}

/** 空数据：解密成功但无相机参数（注入 gameParams） */
export const Empty: Story = {
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_camera_empty.jpg'),
    gameParams: { hasParams: false }
  }
}

/** dark 变体：全屏预览深色背景上的配色 */
export const Dark: Story = {
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_camera_dark.jpg'),
    variant: 'dark'
  },
  beforeEach: mockDecryptNamespace({ ok: true, data: DEMO_DATA }),
  decorators: [
    (Story) => (
      <div className="w-80 p-4 rounded-xl" style={{ background: '#20242e' }}>
        <Story />
      </div>
    )
  ]
}
