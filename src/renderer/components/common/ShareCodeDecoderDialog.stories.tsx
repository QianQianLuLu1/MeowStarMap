import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn, userEvent, within } from 'storybook/test'
import { ShareCodeDecoderDialog } from './ShareCodeDecoderDialog'
import { storybookI18n } from '../../../../.storybook/decorators/i18n'

/**
 * 分享码解码对话框故事。
 * 依赖 window.electronAPI.decrypt.decodeClothDiy / decodeHomeBuild / encodeCameraParams / lookupCloth：
 * 默认由全局安全桩承接；数据故事在 beforeEach 整体替换 `decrypt` 命名空间（partial），
 * 并用 play 自动输入示例码触发解码以展示结果区。
 * 全部文案走既有 i18n key（common.shareCodeDecoder.*）。
 */

type Win = { electronAPI?: Record<string, unknown> }
const getWin = (): Win => window as unknown as Win

/**
 * 整体替换 window.electronAPI，注入 `decrypt` 命名空间的实现（partial：只挂用到的方法），
 * 清理时还原回桩。全局桩是双层 Proxy（无 set trap，直接写属性无效），必须整体替换。
 */
function mockDecryptNamespace(decrypt: Record<string, unknown>) {
  return () => {
    const w = getWin()
    const prevApi = w.electronAPI
    w.electronAPI = { decrypt }
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

/** structured 服饰投影示例：3 件（第 2 件查询无数据，演示 #id 兜底） */
const DEMO_STRUCTURED = {
  poseId: 90,
  clothes: [
    { id: 2113020301, clothType: 30, state: 0, species: 211, outfitFeature: 301 },
    { id: 2113020302, clothType: 41, state: 2, species: 211, outfitFeature: 302 },
    { id: 502050401, clothType: 50, state: 9, species: 502, outfitFeature: 401 }
  ]
}

/** lookupCloth 示例实现：除 2113020302 外都给名称/图标（图标指向真实 CDN，演示图不存在时走 onError 兜底） */
async function demoLookupCloth(ids: number[]) {
  return {
    ok: true,
    data: Object.fromEntries(
      ids.map((id) => [
        String(id),
        id === 2113020302
          ? {}
          : {
              name: `示例服饰 ${id}`,
              iconUrl: `https://cdn.gongeo.us/images/items/icons/${id}.png`
            }
      ])
    )
  }
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
          '分享码解码 / 加密参数对话框：三个 Tab——服装 DIY 解码（`decrypt.decodeClothDiy` + `decrypt.lookupCloth`）、家园搭建解码（`decrypt.decodeHomeBuild`）、' +
          '拍摄参数加密（`decrypt.encodeCameraParams`）。`Default` 走全局桩（解码无结果返回）；' +
          '`DecodeSuccess`（structured 列表 + 名称/图标补齐）/ `StructuredParseFailed`（解析失败 + 原始数据折叠区）/ ' +
          '`OfflineDegraded`（离线降级，仅时间戳/UID）/ `DecodeFailed` 在 beforeEach 整体替换 `decrypt` 命名空间，' +
          '并用 play 自动输入示例码演示结果区。' +
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

/** 解码成功（结构化）：decodeClothDiy 返回 ok + structured，lookupCloth 补齐名称/图标（缺数据条目回退 #id） */
export const DecodeSuccess: Story = {
  beforeEach: mockDecryptNamespace({
    decodeClothDiy: async () => ({
      ok: true,
      data: {
        timestamp: 1755936000,
        uidBytes: '1a2b3c4d5e6f',
        networkData: '[:k:v, 2113020301:0, 2113020302:0, 502050401:0] 染色分享码网络数据示例',
        structured: DEMO_STRUCTURED
      }
    }),
    lookupCloth: demoLookupCloth
  }),
  play: async ({ canvasElement }) => {
    await typeAndDecode(canvasElement)
  }
}

/** 结构化解析失败：structured 为 null，友好错误 + 原始网络数据折叠区 */
export const StructuredParseFailed: Story = {
  beforeEach: mockDecryptNamespace({
    decodeClothDiy: async () => ({
      ok: true,
      data: {
        timestamp: 1755936000,
        uidBytes: '1a2b3c4d5e6f',
        networkData: '[:k:v, ...] 无法解析的原始网络数据示例',
        structured: null
      }
    })
  }),
  play: async ({ canvasElement }) => {
    await typeAndDecode(canvasElement)
  }
}

/** 离线降级：网络解码不可用，仅展示时间戳/UID，不报错 */
export const OfflineDegraded: Story = {
  beforeEach: mockDecryptNamespace({
    decodeClothDiy: async () => ({
      ok: true,
      message: '网络解码不可用（示例）',
      data: { timestamp: 1755936000, uidBytes: '1a2b3c4d5e6f' }
    })
  }),
  play: async ({ canvasElement }) => {
    await typeAndDecode(canvasElement)
  }
}

/** 解码失败：decodeClothDiy 返回 ok=false + 业务错误信息 */
export const DecodeFailed: Story = {
  beforeEach: mockDecryptNamespace({
    decodeClothDiy: async () => ({
      ok: false,
      message: '分享码校验失败：内容不完整（示例）'
    })
  }),
  play: async ({ canvasElement }) => {
    await typeAndDecode(canvasElement)
  }
}
