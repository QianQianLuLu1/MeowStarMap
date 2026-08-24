import type { Meta, StoryObj } from '@storybook/react-vite'
import { UpdateDialog, type UpdatePayload } from './UpdateDialog'

/**
 * 自动更新弹窗故事。
 * 组件无 props，状态机由主进程经 electronAPI.app.onUpdate 推送；
 * 全局安全桩是双层 Proxy（写属性无效），全部故事在 beforeEach 中整体替换 window.electronAPI
 * 以覆盖 `app` 命名空间（onUpdate / downloadUpdate / installUpdate），
 * 按阶段推送载荷以展示各分支。全部文案走既有 i18n key（updateDialog.* / settings.about.*）。
 */

type Push = (p: UpdatePayload) => void

type Win = { electronAPI?: Record<string, unknown> }
const getWin = (): Win => window as unknown as Win

/**
 * 覆盖 `app` 命名空间：onUpdate 注册后由 emit 向组件推送载荷。
 * 注意：全局桩是双层 Proxy（get trap 每次返回新子 Proxy），对其写属性无效，
 * 所以这里直接整体替换 window.electronAPI，并在清理时还原回桩对象。
 */
function mockAppNamespace(emit: (push: Push) => (() => void) | void) {
  return () => {
    const w = getWin()
    const prevApi = w.electronAPI
    let emitCleanup: (() => void) | void
    w.electronAPI = {
      app: {
        onUpdate: (cb: Push) => {
          emitCleanup = emit(cb)
          return () => {
            emitCleanup?.()
          }
        },
        downloadUpdate: async () => undefined,
        installUpdate: async () => undefined
      },
      shell: { openExternal: async () => undefined }
    }
    return () => {
      emitCleanup?.()
      w.electronAPI = prevApi
    }
  }
}

const meta: Meta<typeof UpdateDialog> = {
  title: 'Common/UpdateDialog',
  component: UpdateDialog,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '自动更新弹窗：状态机由主进程驱动（checking → available → downloading → downloaded），' +
          '模态阶段（available / downloaded / error / not-available）居中，下载进度为右下角非阻塞卡片，checking 为轻量 toast。' +
          '依赖 `window.electronAPI.app.onUpdate / downloadUpdate / installUpdate` 与 `shell.openExternal`（「确定」跳官网），' +
          '本组故事均在 beforeEach 覆盖 `app` 命名空间推送模拟载荷。' +
          '无障碍要点：模态容器 `role="dialog"` + `aria-modal` + `aria-label`（`updateDialog.ariaLabel`），进度卡片 `role="status"` + `polite`。' +
          '同置测试：`UpdateDialog.test.tsx`（源码契约断言，`npm run test:renderer -- src/renderer/components/common/UpdateDialog.test.tsx`）。' +
          '注意：该故事组覆写全局 mock（window.electronAPI），Docs 页多预览共存时以最后挂载者为准，请在 Canvas 单故事模式验证交互语义。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof UpdateDialog>

/** 发现新版本：居中模态，含发布说明，「稍后」关闭 / 「立即下载」触发 downloadUpdate */
export const Available: Story = {
  beforeEach: mockAppNamespace((push) => {
    const timer = setTimeout(() => {
      push({
        stage: 'available',
        version: '2.4.0',
        releaseNotes:
          '- 新增：智能分组支持按拍摄场景自动归类\n- 优化：批量水印导出速度提升约 40%\n- 修复：时间线视图在跨月事件处滚动卡顿'
      })
    }, 50)
    return () => clearTimeout(timer)
  })
}

/** 下载中：右下角进度卡片实时推进，100% 后自动进入「已下载」安装模态 */
export const DownloadingToDownloaded: Story = {
  beforeEach: mockAppNamespace((push) => {
    let percent = 0
    push({ stage: 'downloading', version: '2.4.0', percent })
    const timer = setInterval(() => {
      percent += 10
      if (percent >= 100) {
        clearInterval(timer)
        push({ stage: 'downloaded', version: '2.4.0', readyToInstall: true })
      } else {
        push({ stage: 'downloading', version: '2.4.0', percent })
      }
    }, 400)
    return () => clearInterval(timer)
  })
}

/** 更新出错：模态提供「关闭」与「确定」（打开项目官网） */
export const ErrorState: Story = {
  beforeEach: mockAppNamespace((push) => {
    const timer = setTimeout(() => push({ stage: 'error', errorMessage: 'network timeout' }), 50)
    return () => clearTimeout(timer)
  })
}

/** 已是最新版本：not-available 也进入模态（不再仅弹 toast） */
export const NotAvailable: Story = {
  beforeEach: mockAppNamespace((push) => {
    const timer = setTimeout(() => push({ stage: 'not-available' }), 50)
    return () => clearTimeout(timer)
  })
}
