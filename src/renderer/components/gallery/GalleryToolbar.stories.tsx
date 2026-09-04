import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { GalleryToolbar } from './GalleryToolbar'
import { useUIStore } from '../../stores/uiStore'

/**
 * 图库工具栏故事。
 * 筛选 / 排序 / 视图模式状态来自 uiStore（zustand 内存态，无 IPC 依赖），
 * 各故事在 beforeEach 中预置 uiStore 状态、清理函数还原，避免污染其他故事。
 * 注：工具栏右侧的扫描按钮（ScanButton）挂载时会把 `scanner.onProgress` /
 * `scanner.onComplete` 当订阅函数调用；全局双层 Proxy 桩对其返回 truthy Proxy
 * （通过可选链检查）但不可调用，故本文件按规范 §4 整体替换 window.electronAPI，
 * 将二者置为 undefined（ScanButton 走早退分支），清理函数还原桩。
 */

/** 预置 uiStore 筛选/排序状态，返回还原清理函数 */
function seedUIStore(patch: Partial<ReturnType<typeof useUIStore.getState>>) {
  const prev = useUIStore.getState()
  useUIStore.setState(patch)
  return () => useUIStore.setState(prev)
}

/**
 * 整体替换 window.electronAPI（桩为双层 Proxy、无 set trap，直接写属性不生效）：
 * scanner 事件订阅字段置 undefined 让 ScanButton 安全早退；
 * 其余调用（如 settings.get）沿用桩行为即可。返回还原清理函数。
 */
function seedElectronApi() {
  const prev = window.electronAPI
  window.electronAPI = {
    scanner: { onProgress: undefined, onComplete: undefined, status: undefined },
    settings: { get: () => Promise.resolve(undefined) }
  } as never
  return () => {
    window.electronAPI = prev
  }
}

const meta: Meta<typeof GalleryToolbar> = {
  title: 'Gallery/GalleryToolbar',
  component: GalleryToolbar,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          '图库页顶部工具栏：类型筛选（全部 / 图片 / 视频）、评分与日期范围筛选、仅看丢失 / 仅看损坏开关、' +
          '排序按钮组、搜索框与右侧功能入口（导入 / 剪贴板分享 / 幻灯片 / 五种视图切换 / 扫描按钮）。' +
          '可选入口由父组件注入回调后条件渲染；「批量清理损坏」仅在仅看损坏开启且注入 `onCleanupCorrupted` 时出现。' +
          '无障碍要点：开关按钮 `aria-pressed`，评分下拉 `aria-haspopup="listbox"` + `role="option"`，' +
          '视图切换按钮带 `aria-label` 与 `aria-pressed`。' +
          '同置测试：暂无。' +
          '注意：该故事组覆写全局 mock（window.electronAPI）并预置 zustand store，Docs 页多预览共存时以最后挂载者为准，请在 Canvas 单故事模式验证交互语义。'
      }
    }
  },
  args: {
    searchInput: '',
    onSearchChange: fn()
  },
  // 每个故事从干净的默认筛选状态开始，并整体替换 electronAPI 桩（还原在清理函数中）
  beforeEach: () => {
    const restoreStore = seedUIStore({
      filterType: 'all',
      filterRating: null,
      filterDateRange: [null, null],
      showMissingOnly: false,
      showCorruptedOnly: false,
      sortBy: 'date',
      sortOrder: 'desc',
      viewMode: 'grid'
    })
    const restoreApi = seedElectronApi()
    return () => {
      restoreApi()
      restoreStore()
    }
  }
}

export default meta
type Story = StoryObj<typeof GalleryToolbar>

/** 默认：最小形态（筛选 + 排序 + 搜索 + 视图切换 + 扫描按钮） */
export const Default: Story = {}

/** 注入可选入口：导入 / 幻灯片 / 剪贴板分享 */
export const WithOptionalEntries: Story = {
  args: {
    onImport: fn(),
    onSlideshow: fn(),
    onShareClipboard: fn()
  }
}

/** 仅看损坏：激活警告态开关并注入清理回调，出现「批量清理」按钮 */
export const CorruptedOnlyWithCleanup: Story = {
  args: { onCleanupCorrupted: fn() },
  beforeEach: () => {
    const restoreStore = seedUIStore({ showCorruptedOnly: true })
    const restoreApi = seedElectronApi()
    return () => {
      restoreApi()
      restoreStore()
    }
  }
}

/** 筛选激活态：视频类型 + 4 星以上 + 名称降序 + 列表视图（演示各 active 高亮） */
export const FiltersActive: Story = {
  args: { searchInput: '日落' },
  beforeEach: () => {
    const restoreStore = seedUIStore({
      filterType: 'video',
      filterRating: 4,
      sortBy: 'name',
      sortOrder: 'asc',
      viewMode: 'list',
      showMissingOnly: true
    })
    const restoreApi = seedElectronApi()
    return () => {
      restoreApi()
      restoreStore()
    }
  }
}
