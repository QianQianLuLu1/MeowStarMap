import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { TagManager } from './TagManager'
import { useMediaStore } from '../../stores/mediaStore'
import { makeMediaFile } from './story-fixtures'

/**
 * 标签管理弹窗故事。
 * 组件从 mediaStore 读取目标媒体记录，故在 beforeEach 中向 store 注入 fixture 数据
 * （整体替换 mediaFiles，清理函数还原），并在清理后还原，避免污染其他故事。
 * 添加 / 删除标签经 updateMediaFileAndPersist 持久化：Storybook 安全桩下
 * `mediaAction.updateTags` 默认 resolve，本地 store 即时更新，可直接演示交互。
 */
const meta: Meta<typeof TagManager> = {
  title: 'Gallery/TagManager',
  component: TagManager,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '单文件标签管理弹窗（基于 BaseDialog）：展示当前标签（可删除）、输入框添加新标签（Enter 或按钮）、' +
          '常用标签快捷建议；添加时大小写不敏感查重，重复时以高层级 Toast 提示。' +
          '无障碍要点：`aria-labelledby` 绑定标题，打开时初始焦点落在输入框，Esc / 遮罩关闭。' +
          '同置测试：暂无。' +
          '注意：该故事组预置全局 zustand store，Docs 页多预览共存时以最后挂载者为准，请在 Canvas 单故事模式验证交互语义。'
      }
    }
  },
  args: {
    mediaId: '7',
    onClose: fn()
  },
  beforeEach: () => {
    const prev = useMediaStore.getState()
    useMediaStore.setState({
      mediaFiles: [
        makeMediaFile({ id: '7', tags: ['日落', '旅行', 'screenshot'] }),
        makeMediaFile({ id: '8', tags: [] })
      ]
    })
    return () => useMediaStore.setState(prev)
  }
}

export default meta
type Story = StoryObj<typeof TagManager>

/** 默认：带 3 个已有标签 */
export const WithTags: Story = {}

/** 空标签：显示空状态提示文案（切换 mediaId 指向无标签记录） */
export const EmptyTags: Story = {
  args: { mediaId: '8' }
}
