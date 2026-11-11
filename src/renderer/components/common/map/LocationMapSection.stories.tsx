import type { Meta, StoryObj } from '@storybook/react-vite'
import { LocationMapSection } from './LocationMapSection'
import type { WorldMapParams } from '../../../utils/miraland-coords'

/**
 * 阶段 4 演示资产：固定 fixture，不依赖私人照片，也不新增调试入口。
 * 瓦片 host 为游戏官方 assets.papegames.com（#20 条款 6，无需额外 UA）；
 * UnauthorizedCdn 故事演示上游作者自有 CDN 被 fail-closed 拒绝后的空态。
 */
const OFFICIAL_TILE: WorldMapParams = {
  worldId: 1,
  urlTemplate:
    'https://assets.papegames.com/maps/tiles-1/{z}-{x}-{y}.webp?x-oss-process=image/format,webp',
  minZoom: 0,
  maxZoom: 6,
  mapWidthOfMaxZoom: 16384,
  mapHeightOfMaxZoom: 16384,
  // 以下三个值未实采，用固定合成值；仅用于离线演示换算与打点
  originalPointX: 8192,
  originalPointY: -51838.2,
  pxPreUnit: 4
}

const LOCATION = { pos: { x: 10, y: 5, z: 0 }, name: null, worldId: 1 }

const READY = {
  location: LOCATION,
  tiles: [OFFICIAL_TILE],
  serviceAvailable: true
}

const meta: Meta<typeof LocationMapSection> = {
  title: 'Common/LocationMapSection',
  component: LocationMapSection,
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div style={{ width: 420, padding: 16 }}>
        <Story />
      </div>
    )
  ],
  parameters: {
    docs: {
      description: {
        component:
          '拍摄地点地图定位：内嵌视图 + 独立弹窗共用同一份瓦片参数与坐标换算结果。' +
          '三种空态语义对齐上游 nikki_albums：旧照片无 WorldID、参考数据缺失、该地点暂不支持查看地图。'
      }
    }
  }
}
export default meta

type Story = StoryObj<typeof meta>

export const WithOfficialTiles: Story = {
  args: { fixture: READY }
}

/** 自动打开弹窗，便于演示第二种形态（内嵌与弹窗共用同一 view） */
export const DialogOpened: Story = {
  args: { fixture: READY },
  play: ({ canvasElement }) => {
    canvasElement.querySelector('button')?.click()
  }
}

export const OutdatedPhoto: Story = {
  args: { fixture: { ...READY, location: { ...LOCATION, worldId: undefined } } }
}

export const ReferenceDataMissing: Story = {
  args: { fixture: { ...READY, serviceAvailable: false } }
}

export const NoTiles: Story = {
  args: { fixture: { ...READY, tiles: [] } }
}

export const UnsupportedWorld: Story = {
  args: { fixture: { ...READY, tiles: [{ ...OFFICIAL_TILE, worldId: 999 }] } }
}

export const UnauthorizedCdn: Story = {
  args: {
    fixture: {
      ...READY,
      tiles: [
        {
          ...OFFICIAL_TILE,
          urlTemplate: 'https://cdn.nikkialbums.com/maps/{z}-{x}-{y}.webp'
        }
      ]
    }
  }
}

export const Loading: Story = {
  args: { fixture: { ...READY, loading: true } }
}

export const OutsideBounds: Story = {
  args: {
    fixture: { ...READY, location: { ...LOCATION, pos: { x: 1e6, y: 1e6, z: 0 } } }
  }
}
