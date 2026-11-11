/**
 * @vitest-environment jsdom
 *
 * 阶段 4 T6：拍摄地点地图的三态决策与两种形态。
 * - 正常：内嵌 + 弹窗共用同一份换算结果（view），两者都可交互；
 * - 异常：旧数据 / 参考数据未就绪 / 无瓦片 / 无匹配世界 / 未授权 host / 参数非法
 *         各自对应上游语义的明确空态，按钮禁用且不渲染地图；
 * - 边界：loading 态、outside 提示但地图仍渲染、关键 i18n key 非空。
 *
 * 用固定 fixture 注入数据，绕过解密 hook 与 IPC；地图实例本身在 T5 单独验证。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import i18n from '../../../i18n'
import { LocationMapSection } from './LocationMapSection'
import type { WorldMapParams } from '../../../utils/miraland-coords'
import type { LocationInfo } from '../../../types/decryption'

const { useGameParamsSpy, useWorldMapTilesSpy } = vi.hoisted(() => ({
  useGameParamsSpy: vi.fn((..._args: unknown[]) => ({
    data: null,
    loading: false,
    error: null,
    refresh: vi.fn()
  })),
  useWorldMapTilesSpy: vi.fn((..._args: unknown[]) => ({
    tiles: [],
    serviceAvailable: false,
    loading: false,
    error: null
  }))
}))
vi.mock('../../../hooks/useGameParams', () => ({
  useGameParams: (...args: unknown[]) => useGameParamsSpy(...args)
}))
vi.mock('../../../hooks/useWorldMapTiles', () => ({
  useWorldMapTiles: (...args: unknown[]) => useWorldMapTilesSpy(...args)
}))
vi.mock('./LazyMiralandMap', () => ({
  LazyMiralandMap: ({
    view,
    scrollWheelZoom
  }: {
    view: { pixel: { px: number; py: number } }
    scrollWheelZoom?: boolean
  }) => (
    <div
      data-testid="miraland-map"
      data-px={String(view.pixel.px)}
      data-py={String(view.pixel.py)}
      data-scroll={String(scrollWheelZoom)}
    />
  )
}))

const TILE: WorldMapParams = {
  worldId: 1,
  urlTemplate: 'https://assets.papegames.com/maps/tiles-1/{z}-{x}-{y}.webp',
  minZoom: 0,
  maxZoom: 3,
  mapWidthOfMaxZoom: 1024,
  mapHeightOfMaxZoom: 1024,
  originalPointX: 100,
  originalPointY: -50,
  pxPreUnit: 2
}

const LOCATION: LocationInfo = {
  pos: { x: 10, y: 5, z: 0 },
  name: null,
  worldId: 1
}

const READY = { location: LOCATION, tiles: [TILE], serviceAvailable: true }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('LocationMapSection — 正常', () => {
  it('有数据 → 内嵌地图 + 按钮；点击打开弹窗，两种形态共用同一 view 且都可交互', async () => {
    render(<LocationMapSection fixture={READY} />)
    expect(screen.getAllByTestId('miraland-map')).toHaveLength(1)
    expect(screen.getAllByTestId('miraland-map')[0]).toHaveAttribute('data-px', '120')
    expect(screen.getAllByTestId('miraland-map')[0]).toHaveAttribute('data-py', '-40')
    // 内嵌仍可拖拽/按钮缩放，仅关闭滚轮以免劫持侧栏滚动
    expect(screen.getAllByTestId('miraland-map')[0]).toHaveAttribute('data-scroll', 'false')

    fireEvent.click(screen.getByRole('button', { name: '点击定位到地图' }))

    await waitFor(() => expect(screen.getAllByTestId('miraland-map')).toHaveLength(2))
    const dialogMap = screen.getAllByTestId('miraland-map')[1]
    expect(dialogMap).toHaveAttribute('data-px', '120')
    expect(dialogMap).toHaveAttribute('data-py', '-40')
    expect(dialogMap).toHaveAttribute('data-scroll', 'true')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('拍摄地点')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.getAllByTestId('miraland-map')).toHaveLength(1))
  })

  it('outside=true → 明确提示但仍渲染地图与标记（数据不 clamp）', () => {
    render(
      <LocationMapSection
        fixture={{
          ...READY,
          location: { ...LOCATION, pos: { x: 1e6, y: 1e6, z: 0 } }
        }}
      />
    )
    expect(screen.getByText('拍摄点超出地图范围')).toBeInTheDocument()
    expect(screen.getAllByTestId('miraland-map')).toHaveLength(1)
    expect(screen.getAllByTestId('miraland-map')[0]).toHaveAttribute('data-px', '2000100')
  })
})

describe('LocationMapSection — 异常（空态语义对齐上游）', () => {
  it('旧照片无地点标识 → outdatedVersion 文案、按钮禁用、无地图', () => {
    render(
      <LocationMapSection fixture={{ ...READY, location: { ...LOCATION, worldId: undefined } }} />
    )
    expect(screen.getByText('2.9版本及之前的图片暂不支持查看拍摄地点')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '点击定位到地图' })).toBeDisabled()
    expect(screen.queryAllByTestId('miraland-map')).toHaveLength(0)
  })

  it('location 为 null → 同样走旧数据空态', () => {
    render(<LocationMapSection fixture={{ ...READY, location: null }} />)
    expect(screen.getByText('2.9版本及之前的图片暂不支持查看拍摄地点')).toBeInTheDocument()
  })

  it('参考数据未就绪（available:false）→ 数据缺失 + 尚未就绪副标题', () => {
    render(<LocationMapSection fixture={{ ...READY, serviceAvailable: false }} />)
    expect(screen.getByText('数据缺失')).toBeInTheDocument()
    expect(screen.getByText('参考数据尚未就绪')).toBeInTheDocument()
    expect(screen.queryAllByTestId('miraland-map')).toHaveLength(0)
  })

  it('瓦片列表为空 → 数据缺失 + 暂无地图数据副标题', () => {
    render(<LocationMapSection fixture={{ ...READY, tiles: [] }} />)
    expect(screen.getByText('数据缺失')).toBeInTheDocument()
    expect(screen.getByText('暂无地图数据')).toBeInTheDocument()
  })

  it('无匹配 worldId → 该地点暂不支持查看地图', () => {
    render(<LocationMapSection fixture={{ ...READY, tiles: [{ ...TILE, worldId: 999 }] }} />)
    expect(screen.getByText('该地点暂不支持查看地图')).toBeInTheDocument()
    expect(screen.queryAllByTestId('miraland-map')).toHaveLength(0)
  })

  it('未授权 host（上游作者自有 CDN）→ fail-closed，不渲染地图、不请求瓦片', () => {
    render(
      <LocationMapSection
        fixture={{
          ...READY,
          tiles: [
            {
              ...TILE,
              urlTemplate: 'https://cdn.nikkialbums.com/maps/{z}-{x}-{y}.webp'
            }
          ]
        }}
      />
    )
    expect(screen.getByText('该地点暂不支持查看地图')).toBeInTheDocument()
    expect(screen.queryAllByTestId('miraland-map')).toHaveLength(0)
  })

  it('换算参数非法 → 该地点暂不支持查看地图，不崩溃', () => {
    render(<LocationMapSection fixture={{ ...READY, tiles: [{ ...TILE, pxPreUnit: 0 }] }} />)
    expect(screen.getByText('该地点暂不支持查看地图')).toBeInTheDocument()
  })
})

describe('LocationMapSection — 边界', () => {
  it('loading → 显示地图加载中，不渲染地图', () => {
    render(<LocationMapSection fixture={{ ...READY, loading: true }} />)
    expect(screen.getByText('地图加载中')).toBeInTheDocument()
    expect(screen.queryAllByTestId('miraland-map')).toHaveLength(0)
  })

  it('关键 i18n key 在 zh-CN 中非空且不回退为 key 名', () => {
    const keys = [
      'locationMap.title',
      'locationMap.clickToView',
      'locationMap.loading',
      'locationMap.outdatedVersion',
      'locationMap.lackData',
      'locationMap.notReady',
      'locationMap.noTiles',
      'locationMap.lackWorldMap',
      'locationMap.outsideBounds'
    ]
    for (const key of keys) {
      const text = i18n.t(key)
      expect(text).toBeTruthy()
      expect(text).not.toBe(key)
    }
  })
})

// 审查修复（2026-11-11）：非游戏图片不渲染地图节（对齐 PhotographyPanel 守卫），
// 注入 gameParams 时禁用内部解密 hook，避免重复 decodeFile 与白发 refdata IPC。
describe('LocationMapSection — 文件守卫与注入（审查修复）', () => {
  const makeFile = (over: Record<string, unknown> = {}) =>
    ({
      file_path: '/x.jpg',
      file_type: 'image',
      album_type: 'NikkiPhotos_HighQuality',
      account_uid: 'acc-1',
      ...over
    }) as unknown as import('../../../stores/mediaStore').MediaFile

  it('视频文件 → 整体隐藏，且两个 hook 均禁用', () => {
    const { container } = render(<LocationMapSection file={makeFile({ file_type: 'video' })} />)
    expect(container.firstChild).toBeNull()
    expect(useGameParamsSpy.mock.calls[0]![3]).toBe(false)
    expect(useWorldMapTilesSpy).toHaveBeenCalledWith(false)
  })

  it('非游戏相册图片（album_type 缺失）→ 整体隐藏', () => {
    const { container } = render(<LocationMapSection file={makeFile({ album_type: null })} />)
    expect(container.firstChild).toBeNull()
    expect(useWorldMapTilesSpy).toHaveBeenCalledWith(false)
  })

  it('注入 gameParams → 内部解密 hook 禁用，地图节仍按注入数据渲染', () => {
    const injected = {
      hasParams: true,
      photography: { location: LOCATION }
    } as unknown as import('../../../types/decryption').GameParamsData
    const { container } = render(<LocationMapSection file={makeFile()} gameParams={injected} />)
    expect(useGameParamsSpy.mock.calls[0]![3]).toBe(false)
    expect(container.firstChild).not.toBeNull()
  })

  it('游戏图片且未注入 → 两个 hook 均启用', () => {
    render(<LocationMapSection file={makeFile()} />)
    expect(useGameParamsSpy.mock.calls[0]![3]).toBe(true)
    expect(useWorldMapTilesSpy).toHaveBeenCalledWith(true)
  })
})
