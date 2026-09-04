import type { Meta, StoryObj } from '@storybook/react-vite'
import { AppShell } from './AppShell'
import { useUIStore } from '../../stores/uiStore'
import { useMediaStore } from '../../stores/mediaStore'
import { makeMediaFiles } from '../gallery/story-fixtures'

/**
 * 应用外壳故事：标题栏 + 侧边栏 + 主内容插槽 + 底部状态栏（含反馈按钮）。
 * 状态栏文案由 uiStore.currentView 与 mediaStore 统计推导，
 * 故各故事在 beforeEach 中整体预置两个 store，清理函数还原，避免污染其他故事。
 * 侧边栏挂载时的档案加载（profile.list）由全局 electronAPI 安全桩兜底。
 */

const demoFiles = makeMediaFiles(12)

const demoContent = (
  <div
    className="glass-card flex-1 flex items-center justify-center text-sm"
    style={{ color: 'var(--text-secondary)' }}
  >
    主内容区（children 插槽）
  </div>
)

const meta: Meta<typeof AppShell> = {
  title: 'Layout/AppShell',
  component: AppShell,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '应用外壳：固定标题栏（拖拽区）+ 侧边栏 + 主内容区 + 底部状态栏。' +
          '状态栏左右文案按当前视图（gallery / detail / editor / categories / settings / recycle-bin / favorites / duplicates / launcher-cache）' +
          '与媒体统计动态生成；右下角常驻反馈按钮唤起 FeedbackDialog。' +
          '无障碍要点：反馈按钮带 `title` + `aria-label`；各子组件无障碍要点见其各自文档页。' +
          '同置测试：暂无。' +
          '注意：该故事组预置全局 zustand store，Docs 页多预览共存时以最后挂载者为准，请在 Canvas 单故事模式验证交互语义。'
      }
    }
  },
  args: {
    children: demoContent
  },
  beforeEach: () => {
    const prevUi = useUIStore.getState()
    const prevMedia = useMediaStore.getState()
    useUIStore.setState({
      currentView: 'gallery',
      viewStack: ['gallery'],
      sidebarCollapsed: false,
      selectedMediaIds: []
    })
    useMediaStore.setState({ mediaFiles: demoFiles, recycleBinFiles: [], categories: [] })
    return () => {
      useUIStore.setState(prevUi)
      useMediaStore.setState(prevMedia)
    }
  }
}

export default meta
type Story = StoryObj<typeof AppShell>

/** 图库视图：状态栏显示媒体汇总（12 项：图片 / 视频数量）与存储占用 */
export const GalleryView: Story = {}

/** 回收站视图 + 返回按钮：viewStack 深度 > 1 时侧边栏出现「返回」入口 */
export const RecycleBinView: Story = {
  beforeEach: () => {
    useUIStore.setState({ currentView: 'recycle-bin', viewStack: ['gallery', 'recycle-bin'] })
  }
}

/** 收藏视图：状态栏左侧显示收藏数量汇总 */
export const FavoritesView: Story = {
  beforeEach: () => {
    useUIStore.setState({ currentView: 'favorites', viewStack: ['gallery', 'favorites'] })
  }
}
