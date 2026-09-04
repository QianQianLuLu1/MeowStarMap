import type { Meta, StoryObj } from '@storybook/react-vite'
import { Sidebar } from './Sidebar'
import { useUIStore } from '../../stores/uiStore'
import { useMediaStore } from '../../stores/mediaStore'
import { makeMediaFiles } from '../gallery/story-fixtures'

/**
 * 侧边栏故事。
 * Sidebar 与 uiStore / mediaStore 深度耦合（导航栈、折叠态、分组维度、媒体统计、档案列表），
 * 无 props 可注入，故事通过 beforeEach 预置 store 的最小可渲染状态，清理函数还原。
 * 说明：挂载时的 `loadProfiles()` 经全局 electronAPI 安全桩返回 undefined，
 * 内部捕获异常并回退为空档案列表（控制台可见一条 error 日志），不影响渲染。
 */

const demoFiles = makeMediaFiles(12)

const meta: Meta<typeof Sidebar> = {
  title: 'Layout/Sidebar',
  component: Sidebar,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          '主导航侧边栏（毛玻璃面板 + spring 折叠动画）：返回入口（viewStack 深度 > 1 时出现）、' +
          '角色档案切换器、七个导航项、图库视图下的智能分组快捷面板，底部为图片 / 视频 / 分类 / 存储统计。' +
          '无障碍要点：折叠与返回按钮带 `title`，导航项 active 态以样式高亮；' +
          '档案菜单与分组菜单为点击展开的 `role="menu"` / 按钮列表，支持点击外部关闭。' +
          '同置测试：暂无。' +
          '注意：该故事组预置全局 zustand store，Docs 页多预览共存时以最后挂载者为准，请在 Canvas 单故事模式验证交互语义。'
      }
    }
  },
  beforeEach: () => {
    const prevUi = useUIStore.getState()
    const prevMedia = useMediaStore.getState()
    useUIStore.setState({
      currentView: 'gallery',
      viewStack: ['gallery'],
      sidebarCollapsed: false,
      groupDimension: 'none'
    })
    useMediaStore.setState({
      mediaFiles: demoFiles,
      categories: [],
      profiles: [],
      currentProfileUid: 'default'
    })
    return () => {
      useUIStore.setState(prevUi)
      useMediaStore.setState(prevMedia)
    }
  },
  // motion.aside 使用 h-full，需要带高度的容器
  render: () => (
    <div style={{ height: 640 }}>
      <Sidebar />
    </div>
  )
}

export default meta
type Story = StoryObj<typeof Sidebar>

/** 默认：展开态（220px），图库视图下含智能分组快捷区与底部统计 */
export const Expanded: Story = {}

/** 折叠态（64px）：仅显示导航图标 */
export const Collapsed: Story = {
  beforeEach: () => {
    useUIStore.setState({ sidebarCollapsed: true })
  }
}

/** 带返回入口：viewStack 深度 > 1（已进入子层级） */
export const WithBackEntry: Story = {
  beforeEach: () => {
    useUIStore.setState({ currentView: 'categories', viewStack: ['gallery', 'categories'] })
  }
}
