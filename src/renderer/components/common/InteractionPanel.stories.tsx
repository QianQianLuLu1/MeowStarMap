import type { Meta, StoryObj } from '@storybook/react-vite'
import { InteractionPanel } from './InteractionPanel'
import type { MediaFile } from '../../stores/mediaStore'
import type { GameParamsData, InteractionParams } from '../../types/decryption'

/**
 * 交互物信息面板故事。
 * 依赖 window.electronAPI.decrypt.decodeFile（经 useGameParams，带 LRU 缓存，故各故事用不同文件路径）：
 * 数据故事在 beforeEach 整体替换 `decrypt` 命名空间；
 * loading / error / empty 通过组件注入式 props 驱动。
 * 全部文案走既有 i18n key（detail.interaction.*）。
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
    id: `interaction-demo-${path}`,
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

/** 演示用交互物数据：有坐骑、无载具、两个交互物对象 */
const DEMO_INTERACTIONS: InteractionParams = {
  mount: {
    id: 50101,
    loc: { x: 98.2, y: 51.7, z: -28.4 },
    rot: { yaw: 45.0, pitch: 0.0, roll: 0.0 },
    scale: { x: 1.0, y: 1.0, z: 1.0 }
  },
  carrier: null,
  interactions: [
    {
      id: 206001,
      loc: { x: 104.6, y: 57.3, z: -31.2 },
      rot: { yaw: -12.5, pitch: 3.0, roll: 0.0 },
      scale: { x: 0.8, y: 0.8, z: 0.8 }
    },
    {
      id: 'npc_042',
      loc: { x: 110.1, y: 60.9, z: -35.5 },
      rot: { yaw: 178.0, pitch: 0.0, roll: 0.0 },
      scale: { x: 1.2, y: 1.2, z: 1.2 }
    }
  ]
}

/** 无坐骑 / 无载具 / 无交互物的最小数据（展示 `detail.interaction.none` 分支） */
const MINIMAL_INTERACTIONS: InteractionParams = { mount: null, carrier: null, interactions: [] }

const DEMO_DATA: GameParamsData = { hasParams: true, interactions: DEMO_INTERACTIONS }
const MINIMAL_DATA: GameParamsData = { hasParams: true, interactions: MINIMAL_INTERACTIONS }

const meta: Meta<typeof InteractionPanel> = {
  title: 'Common/InteractionPanel',
  component: InteractionPanel,
  tags: ['autodocs'],
  argTypes: {
    variant: { control: { type: 'select' }, options: ['light', 'dark'] },
    file: { control: false },
    gameParams: { control: false }
  },
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_interaction_default.jpg'),
    variant: 'light',
    showTitle: true
  },
  decorators: [(Story) => <div className="w-80 p-3">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          '交互物信息面板：逐行展示坐骑 / 载具 / 交互物列表，每行含 `#ID` 与「位置 / 旋转 / 缩放」三段格式化数值。' +
          '数据来自 `window.electronAPI.decrypt.decodeFile`（经 `useGameParams`，LRU+TTL 缓存，故本组故事各使用不同文件路径）。' +
          '`Default` / `Dark` 在 beforeEach 整体替换 `decrypt` 命名空间注入模拟数据；' +
          '`Minimal` / `Loading` / `Error` / `Empty` 经组件注入式 props 驱动。' +
          '同置测试：`InteractionPanel.test.tsx`（`npm run test:renderer -- src/renderer/components/common/InteractionPanel.test.tsx`）。' +
          '注意：该故事组覆写全局 mock（window.electronAPI），Docs 页多预览共存时以最后挂载者为准，请在 Canvas 单故事模式验证交互语义。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof InteractionPanel>

/** 默认：解密成功，坐骑 + 两个交互物（含字符串 ID 场景），载具为空 */
export const Default: Story = {
  beforeEach: mockDecryptNamespace({ ok: true, data: DEMO_DATA })
}

/** 最小数据：坐骑 / 载具 / 交互物均为空，展示「无」分支文案 */
export const Minimal: Story = {
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_interaction_minimal.jpg'),
    gameParams: MINIMAL_DATA
  }
}

/** 加载中：注入 loading 展示转圈 + `detail.interaction.loadingText` */
export const Loading: Story = {
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_interaction_loading.jpg'),
    loading: true
  }
}

/** 解密失败：注入 error */
export const ErrorState: Story = {
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_interaction_error.jpg'),
    error: '解密失败：文件头损坏（示例）'
  }
}

/** 空数据：解密成功但无交互参数（注入 gameParams） */
export const Empty: Story = {
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_interaction_empty.jpg'),
    gameParams: { hasParams: false }
  }
}

/** dark 变体：全屏预览深色背景上的配色 */
export const Dark: Story = {
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_interaction_dark.jpg'),
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
