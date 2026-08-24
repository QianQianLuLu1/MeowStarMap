import type { Meta, StoryObj } from '@storybook/react-vite'
import { PhotographyPanel } from './PhotographyPanel'
import type { MediaFile } from '../../stores/mediaStore'
import type { GameParamsData, PhotographyInfo } from '../../types/decryption'

/**
 * 拍摄信息面板故事。
 * 依赖 window.electronAPI.decrypt.decodeFile（经 useGameParams，带 LRU 缓存，故各故事用不同文件路径）：
 * 数据故事在 beforeEach 整体替换 `decrypt` 命名空间；
 * loading / error / empty 通过组件注入式 props 驱动。
 * 全部文案走既有 i18n key（detail.photography.* / enums.weather.* 等）。
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
    id: `photography-demo-${path}`,
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

/**
 * 演示用拍摄信息：已编辑（贴纸）+ 日期 / 时间 / 地点 / 天气 + 照片墙 + 拍摄任务。
 * weather=2 与 puzzle tag=30、interactive tag=206001 均为 enum-mappings 合法键。
 */
const DEMO_PHOTOGRAPHY: PhotographyInfo = {
  edit: { enabled: true, hasSticker: true, hasText: false },
  date: { day: 12 },
  time: { hour: 18, minute: 30, second: 42 },
  location: { pos: { x: 102.3, y: 55.1, z: -30.8 }, name: '花愿镇' },
  weather: 2,
  photoWall: [1, 2],
  tasks: [
    { type: 'puzzle', tag: 30 },
    { type: 'interactive', tag: 206001 }
  ]
}

/** 未编辑 + 无日期时间地点天气 + 无任务的最小数据（展示空值分支文案） */
const MINIMAL_PHOTOGRAPHY: PhotographyInfo = {
  edit: { enabled: false, hasSticker: false, hasText: false },
  date: null,
  time: null,
  location: null,
  weather: null,
  photoWall: [],
  tasks: []
}

const DEMO_DATA: GameParamsData = { hasParams: true, photography: DEMO_PHOTOGRAPHY }
const MINIMAL_DATA: GameParamsData = { hasParams: true, photography: MINIMAL_PHOTOGRAPHY }

const meta: Meta<typeof PhotographyPanel> = {
  title: 'Common/PhotographyPanel',
  component: PhotographyPanel,
  tags: ['autodocs'],
  argTypes: {
    variant: { control: { type: 'select' }, options: ['light', 'dark'] },
    file: { control: false },
    gameParams: { control: false }
  },
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_photography_default.jpg'),
    variant: 'light',
    showTitle: true
  },
  decorators: [(Story) => <div className="w-80 p-3">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          '拍摄信息面板：展示是否编辑 / 拍摄日期 / 时间 / 地点 / 天气 / 照片墙 / 拍摄任务，' +
          '天气与任务经 `enum-mappings` 映射为 i18n key 后 `t()` 解析（未知值回退到原始数值文案）。' +
          '数据来自 `window.electronAPI.decrypt.decodeFile`（经 `useGameParams`，LRU+TTL 缓存，故本组故事各使用不同文件路径）。' +
          '`Default` / `Dark` 在 beforeEach 整体替换 `decrypt` 命名空间注入模拟数据；' +
          '`Minimal` / `Loading` / `Error` / `Empty` 经组件注入式 props 驱动。' +
          '同置测试：`PhotographyPanel.test.tsx`（`npm run test:renderer -- src/renderer/components/common/PhotographyPanel.test.tsx`）。' +
          '注意：该故事组覆写全局 mock（window.electronAPI），Docs 页多预览共存时以最后挂载者为准，请在 Canvas 单故事模式验证交互语义。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof PhotographyPanel>

/** 默认：解密成功，完整拍摄信息（含编辑状态、天气与拍摄任务） */
export const Default: Story = {
  beforeEach: mockDecryptNamespace({ ok: true, data: DEMO_DATA })
}

/** 最小数据：未编辑且各可空字段均为空，展示「未编辑 / 未参与 / 无」分支文案 */
export const Minimal: Story = {
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_photography_minimal.jpg'),
    gameParams: MINIMAL_DATA
  }
}

/** 加载中：注入 loading 展示转圈 + `detail.photography.loadingText` */
export const Loading: Story = {
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_photography_loading.jpg'),
    loading: true
  }
}

/** 解密失败：注入 error */
export const ErrorState: Story = {
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_photography_error.jpg'),
    error: '解密失败：文件头损坏（示例）'
  }
}

/** 空数据：解密成功但无拍摄参数（注入 gameParams） */
export const Empty: Story = {
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_photography_empty.jpg'),
    gameParams: { hasParams: false }
  }
}

/** dark 变体：全屏预览深色背景上的配色 */
export const Dark: Story = {
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_photography_dark.jpg'),
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
