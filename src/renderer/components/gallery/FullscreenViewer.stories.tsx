import type { Meta, StoryObj } from '@storybook/react-vite'
import { FullscreenViewer } from './FullscreenViewer'
import { useUIStore } from '../../stores/uiStore'
import { makeMediaFiles } from './story-fixtures'

/**
 * 全屏查看器故事。
 * 组件由 uiStore 的 fullscreenOpen / fullscreenIndex 驱动显隐与定位（组件 API 无 index props，
 * 无法经本地状态包装组件隔离，故采用描述声明 + 每故事独立快照方案），
 * filteredFiles 由 props 注入（与 GalleryPage 的计算结果同构）。
 * 媒体一律使用 SVG data URL 占位（toFileUrl 对 data: 原样返回）；
 * 删除 / 另存等按钮仅在点击时触碰 electronAPI，安全桩下不会抛错。
 * 每个故事在 beforeEach 自行快照 store 全量状态并打开全屏、设定目标索引，
 * 清理函数显式关闭全屏并在二次挂载时还原快照，切断 Docs 页多预览间的状态污染链。
 */

const demoFiles = makeMediaFiles(4)

/**
 * 每个故事独立快照：避免多预览共享全局 uiStore 时索引串档。
 * 清理不直接还原快照（快照可能捕获自前一故事的脏状态），
 * 而是显式关闭全屏，保证后续预览在干净状态下挂载。
 */
function seedFullscreen(index: number) {
  return () => {
    const prev = useUIStore.getState()
    useUIStore.setState({ fullscreenOpen: true, fullscreenIndex: index })
    return () => useUIStore.setState({ ...prev, fullscreenOpen: false })
  }
}

const meta: Meta<typeof FullscreenViewer> = {
  title: 'Gallery/FullscreenViewer',
  component: FullscreenViewer,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '全屏浏览器：顶部工具栏（幻灯片播放 / 间隔、收藏、相机参数浮层、另存为、删除、关闭）、' +
          '左右导航箭头、键盘 ←→ 切换 / 空格播放幻灯片 / Esc 关闭 / Delete 删除、触摸滑动导航。' +
          '仅展示关键静态状态；完整幻灯片流程建议参考 SlideshowPlayer。' +
          '无障碍要点：容器 `role="dialog"` + `aria-modal` + `aria-label`，全部按钮带 `aria-label`，打开时焦点移入容器。' +
          '同置测试：暂无。' +
          '注意：该故事预置全局 zustand store（uiStore），Docs 页多预览共存时以最后挂载者为准，' +
          '请在 Canvas 单故事模式验证交互语义。'
      }
    }
  },
  args: {
    filteredFiles: demoFiles
  }
}

export default meta
type Story = StoryObj<typeof FullscreenViewer>

/** 默认：首张图片，仅显示「下一张」导航 */
export const Default: Story = {
  beforeEach: seedFullscreen(0)
}

/** 中间索引：左右导航箭头同时可见，标题显示「3 / 4」 */
export const AtMiddleIndex: Story = {
  beforeEach: seedFullscreen(2)
}

/** 视频文件：渲染内置播放器（data URL 非真实视频源，仅展示容器与控制条） */
export const VideoFile: Story = {
  beforeEach: seedFullscreen(3)
}
