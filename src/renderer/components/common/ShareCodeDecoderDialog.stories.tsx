import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn, userEvent, within } from 'storybook/test'
import { ShareCodeDecoderDialog } from './ShareCodeDecoderDialog'
import { storybookI18n } from '../../../../.storybook/decorators/i18n'

/**
 * 分享码解码对话框故事。
 * 依赖 window.electronAPI.decrypt.decodeClothDiy / decodeHomeBuild / encodeCameraParams：
 * 默认由全局安全桩承接；数据故事在 beforeEach 整体替换 `decrypt` 命名空间，
 * 并用 play 自动输入示例码触发解码以展示结果区。
 * 全部文案走既有 i18n key（common.shareCodeDecoder.*）。
 */

type Win = { electronAPI?: Record<string, unknown> }
const getWin = (): Win => window as unknown as Win

/**
 * 整体替换 window.electronAPI，注入 `decrypt` 命名空间的解码实现，清理时还原回桩。
 * 全局桩是双层 Proxy（无 set trap，直接写属性无效），必须整体替换。
 */
function mockDecryptNamespace(decodeClothDiy: (code: string) => Promise<unknown>) {
  return () => {
    const w = getWin()
    const prevApi = w.electronAPI
    w.electronAPI = { decrypt: { decodeClothDiy } }
    return () => {
      w.electronAPI = prevApi
    }
  }
}

/** play：在输入框键入示例分享码并点击解码按钮（按 role + 实际可见文案定位，跟随当前语言） */
async function typeAndDecode(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  await userEvent.type(canvas.getByRole('textbox'), 'DEMO-SHARE-CODE-2026', { delay: 8 })
  await userEvent.click(
    canvas.getByRole('button', {
      name: storybookI18n.t('common.shareCodeDecoder.decodeButton')
    })
  )
}

const meta: Meta<typeof ShareCodeDecoderDialog> = {
  title: 'Common/ShareCodeDecoderDialog',
  component: ShareCodeDecoderDialog,
  tags: ['autodocs'],
  args: {
    open: true,
    onClose: fn()
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '分享码解码 / 加密参数对话框：三个 Tab——服装 DIY 解码（`decrypt.decodeClothDiy`）、家园搭建解码（`decrypt.decodeHomeBuild`）、' +
          '拍摄参数加密（`decrypt.encodeCameraParams`）。`Default` 走全局桩（解码无结果返回）；' +
          '`DecodeSuccess` / `DecodeFailed` 在 beforeEach 整体替换 `decrypt` 命名空间，并用 play 自动输入示例码演示结果区。' +
          '无障碍要点：标题绑定 `aria-labelledby`，关闭按钮带 `aria-label`（`common.shareCodeDecoder.closeAriaLabel`），' +
          '焦点陷阱与 Esc 由 BaseDialog 提供。' +
          '同置测试：`ShareCodeDecoderDialog.test.tsx`（`npm run test:renderer -- src/renderer/components/common/ShareCodeDecoderDialog.test.tsx`）。' +
          '注意：该故事组覆写全局 mock（window.electronAPI），Docs 页多预览共存时以最后挂载者为准，请在 Canvas 单故事模式验证交互语义。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof ShareCodeDecoderDialog>

/** 默认（全局桩）：可切换 Tab 与输入，解码返回 undefined 不展示结果区 */
export const Default: Story = {}

/** 解码成功：覆盖 decodeClothDiy 返回时间戳 / UID / 网络数据 */
export const DecodeSuccess: Story = {
  beforeEach: mockDecryptNamespace(async () => ({
    success: true,
    data: {
      timestamp: 1755936000,
      uidBytes: '0x1A2B3C4D5E6F',
      networkData: 'SGVsbG8gSW5maW5pdHkgTmlra2khIHRoaXMgaXMgYSBkZW1vIG5ldHdvcmsgcGF5bG9hZA=='
    }
  })),
  play: async ({ canvasElement }) => {
    await typeAndDecode(canvasElement)
  }
}

/** 解码失败：覆盖 decodeClothDiy 返回业务错误信息 */
export const DecodeFailed: Story = {
  beforeEach: mockDecryptNamespace(async () => ({
    success: false,
    message: '分享码校验失败：内容不完整（示例）'
  })),
  play: async ({ canvasElement }) => {
    await typeAndDecode(canvasElement)
  }
}
