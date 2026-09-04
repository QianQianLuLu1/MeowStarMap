import type { Meta, StoryObj } from '@storybook/react-vite'
import { OutfitPanel } from './OutfitPanel'
import type { MediaFile } from '../../stores/mediaStore'
import type { GameParamsData, DressingParams } from '../../types/decryption'

/**
 * 搭配信息面板故事。
 * 依赖 window.electronAPI.decrypt.decodeFile（经 useGameParams，带 LRU 缓存，故各故事用不同文件路径）：
 * 数据故事在 beforeEach 整体替换 `decrypt` 命名空间；
 * loading / error / empty 通过组件注入式 props 驱动。
 * 全部文案走既有 i18n key（detail.dressing.* / enums.clothType.* 等）。
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
    id: `outfit-demo-${path}`,
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

/** 演示用搭配数据：三件服装（含焕新/进化状态）+ 一条祝福闪光 */
const DEMO_DRESSING: DressingParams = {
  clothes: [
    { id: 30012, clothType: 10, clothTypeName: '连衣裙', state: 2, species: 0 },
    { id: 40517, clothType: 50, clothTypeName: '发型', state: 0, species: 1 },
    { id: 60102, clothType: 80, clothTypeName: '饰品', state: 3, species: 0 }
  ],
  eureka: [{ id: 20010, level: 3, color: 1, attachmentPoint: 2, outfit: 5 }]
}

const DEMO_DATA: GameParamsData = { hasParams: true, dressing: DEMO_DRESSING }

const meta: Meta<typeof OutfitPanel> = {
  title: 'Common/OutfitPanel',
  component: OutfitPanel,
  tags: ['autodocs'],
  argTypes: {
    variant: { control: { type: 'select' }, options: ['light', 'dark'] },
    file: { control: false },
    gameParams: { control: false }
  },
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_outfit_default.jpg'),
    variant: 'light',
    showTitle: true
  },
  decorators: [(Story) => <div className="w-80 p-3">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          '搭配信息面板：按服装部位逐件展示「名称 #ID [状态]」，祝福闪光含套装名 / 颜色 / 挂载点 / 等级；' +
          '部位与状态名经 `enum-mappings` 映射为 i18n key 后 `t()` 解析，单品名经 `cloth-name-lookup` 查询（未收录时回退 `clothTypeName`）。' +
          '数据来自 `window.electronAPI.decrypt.decodeFile`（经 `useGameParams`，LRU+TTL 缓存，故本组故事各使用不同文件路径）。' +
          '`Default` / `Dark` 在 beforeEach 整体替换 `decrypt` 命名空间注入模拟数据；' +
          '`Loading` / `Error` / `Empty` 经组件注入式 props 驱动。' +
          '同置测试：`OutfitPanel.test.tsx`（`npm run test:renderer -- src/renderer/components/common/OutfitPanel.test.tsx`）。' +
          '注意：该故事组覆写全局 mock（window.electronAPI），Docs 页多预览共存时以最后挂载者为准，请在 Canvas 单故事模式验证交互语义。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof OutfitPanel>

/** 默认：解密成功，服装列表 + 祝福闪光 */
export const Default: Story = {
  beforeEach: mockDecryptNamespace({ ok: true, data: DEMO_DATA })
}

/** 加载中：注入 loading */
export const Loading: Story = {
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_outfit_loading.jpg'),
    loading: true
  }
}

/** 解密失败：注入 error */
export const ErrorState: Story = {
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_outfit_error.jpg'),
    error: '解密失败：文件头损坏（示例）'
  }
}

/** 空数据：解密成功但无搭配参数（注入 gameParams） */
export const Empty: Story = {
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_outfit_empty.jpg'),
    gameParams: { hasParams: false }
  }
}

/** dark 变体：全屏预览深色背景上的配色 */
export const Dark: Story = {
  args: {
    file: makeDemoFile('D:\\InfinityNikki\\Photos\\demo_outfit_dark.jpg'),
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
