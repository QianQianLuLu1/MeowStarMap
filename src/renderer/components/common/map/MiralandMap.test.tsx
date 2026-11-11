/**
 * @vitest-environment jsdom
 *
 * 阶段 4 T5：唯一 L.map() 实现的参数对齐与生命周期。
 * - 正常：MapOptions / TileLayer / Marker 参数逐项对齐上游 MiralandMap；
 * - 异常：非法 view 不创建实例也不抛错；
 * - 边界：outside 只 clamp 相机中心、marker 数据不动；卸载时 remove/off/disconnect 成对释放。
 *
 * Leaflet 在 jsdom 无真实布局，故 L.map/tileLayer/marker/divIcon 用假实现；
 * CRS.Simple 的 unproject 数学在 mock 内按真实公式给出（lat=-py/2^z, lng=px/2^z），
 * 与 T2 的 256 倍口径一致。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { MiralandMap } from './MiralandMap'
import type { MiralandMapView } from './MiralandMap'

const { fakeMap, fakeTiles, fakeMarker, fakeL } = vi.hoisted(() => {
  const fakeMap = {
    on: vi.fn(),
    off: vi.fn(),
    invalidateSize: vi.fn(),
    remove: vi.fn()
  }
  const fakeTiles = { addTo: vi.fn(), remove: vi.fn() }
  const fakeMarker = { addTo: vi.fn(), remove: vi.fn() }
  const fakeL = {
    CRS: {
      Simple: {
        pointToLatLng: (p: { x: number; y: number }, z: number) => ({
          lat: -p.y / Math.pow(2, z),
          lng: p.x / Math.pow(2, z)
        })
      }
    },
    point: (x: number, y: number) => ({ x, y }),
    latLng: (lat: number, lng: number) => ({ lat, lng }),
    latLngBounds: (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => ({
      getSouth: () => Math.min(a.lat, b.lat),
      getNorth: () => Math.max(a.lat, b.lat),
      getWest: () => Math.min(a.lng, b.lng),
      getEast: () => Math.max(a.lng, b.lng)
    }),
    map: vi.fn((..._args: unknown[]) => fakeMap),
    tileLayer: vi.fn((..._args: unknown[]) => fakeTiles),
    marker: vi.fn((..._args: unknown[]) => fakeMarker),
    divIcon: vi.fn((..._args: unknown[]) => _args[0])
  }
  return { fakeMap, fakeTiles, fakeMarker, fakeL }
})

vi.mock('leaflet', () => ({ ...fakeL, default: fakeL }))
vi.mock('leaflet/dist/leaflet.css', () => ({}))

const TILE = {
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

const VIEW: MiralandMapView = {
  tile: TILE,
  pixel: { px: 120, py: -40 },
  bounds: { width: 1024, height: 1024 },
  crsZoom: 3,
  outside: false
}

let roDisconnect: ReturnType<typeof vi.fn>
let roObserve: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  roDisconnect = vi.fn()
  roObserve = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = roObserve
      unobserve = vi.fn()
      disconnect = roDisconnect
      constructor(_cb: unknown) {}
    }
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MiralandMap — 正常', () => {
  it('MapOptions 逐项对齐上游（CRS.Simple / zoom / 边界 / 交互）', () => {
    render(<MiralandMap view={VIEW} />)
    expect(fakeL.map).toHaveBeenCalledTimes(1)
    const options = fakeL.map.mock.calls[0][1] as Record<string, unknown>
    expect(options.crs).toBe(fakeL.CRS.Simple)
    expect(options.zoom).toBe(3)
    expect(options.minZoom).toBe(0)
    expect(options.maxZoom).toBe(5)
    expect(options.maxBoundsViscosity).toBe(1)
    expect(options.attributionControl).toBe(false)
    expect(options.dragging).toBe(true)
    expect(options.scrollWheelZoom).toBe(true)
    expect(options.center).toEqual({ lat: 5, lng: 15 })
    expect(options.maxBounds).toBeDefined()
  })

  it('TileLayer 使用官方模板与原生 zoom 上下限，不传自定义 headers/UA', () => {
    render(<MiralandMap view={VIEW} />)
    expect(fakeL.tileLayer).toHaveBeenCalledTimes(1)
    const tileLayerArgs = fakeL.tileLayer.mock.calls[0]
    const url = tileLayerArgs[0]
    const options = tileLayerArgs[1] as Record<string, unknown>
    expect(url).toBe(TILE.urlTemplate)
    expect(options.minNativeZoom).toBe(0)
    expect(options.maxNativeZoom).toBe(3)
    expect(options.noWrap).toBe(true)
    expect(options).not.toHaveProperty('headers')
    expect(fakeTiles.addTo).toHaveBeenCalledWith(fakeMap)
  })

  // 审查修复（2026-11-11）：view 虽经上层 isAuthorizedTileTemplate 判定，
  // 唯一建实例点仍须纵深复核 host 授权——未授权模板不得创建任何 Leaflet 实例。
  it('异常：未授权 host 模板 → 不创建 Leaflet 实例（纵深复核）', () => {
    const evilView: MiralandMapView = {
      ...VIEW,
      tile: { ...TILE, urlTemplate: 'https://evil.example.com/maps/{z}-{x}-{y}.webp' }
    }
    render(<MiralandMap view={evilView} />)
    expect(fakeL.map).not.toHaveBeenCalled()
    expect(fakeL.tileLayer).not.toHaveBeenCalled()
  })

  it('Marker 落在换算后的像素点，divIcon 尺寸与锚点对齐上游 40×40', () => {
    render(<MiralandMap view={VIEW} />)
    expect(fakeL.marker).toHaveBeenCalledTimes(1)
    expect(fakeL.marker.mock.calls[0][0]).toEqual({ lat: 5, lng: 15 })
    const icon = fakeL.divIcon.mock.calls[0][0] as Record<string, unknown>
    expect(icon.iconSize).toEqual([40, 40])
    expect(icon.iconAnchor).toEqual([20, 40])
    expect(icon.html).toBeTypeOf('string')
    expect(fakeMarker.addTo).toHaveBeenCalledWith(fakeMap)
  })

  it('内嵌形态关闭滚轮缩放（不劫持侧栏滚动），其余交互保持', () => {
    render(<MiralandMap view={VIEW} scrollWheelZoom={false} />)
    const options = fakeL.map.mock.calls[0][1] as Record<string, unknown>
    expect(options.scrollWheelZoom).toBe(false)
    expect(options.dragging).toBe(true)
  })
})

describe('MiralandMap — 异常', () => {
  it('view 为空 / tile 或 pixel 缺失 → 不创建地图实例也不抛错', () => {
    const bad = [
      null,
      {},
      { ...VIEW, tile: null },
      { ...VIEW, pixel: null },
      { ...VIEW, bounds: null }
    ]
    for (const view of bad) {
      expect(() => render(<MiralandMap view={view as unknown as MiralandMapView} />)).not.toThrow()
    }
    expect(fakeL.map).not.toHaveBeenCalled()
  })
})

describe('MiralandMap — 边界与生命周期', () => {
  it('outside=true 时只 clamp 相机中心，marker 仍用原始像素', () => {
    render(<MiralandMap view={{ ...VIEW, outside: true }} />)
    const options = fakeL.map.mock.calls[0][1] as Record<string, unknown>
    expect(options.center).not.toEqual({ lat: 5, lng: 15 })
    expect(fakeL.marker.mock.calls[0][0]).toEqual({ lat: 5, lng: 15 })
  })

  it('卸载时 map.remove / off / ResizeObserver.disconnect / 图层移除各一次且成对', () => {
    const { unmount } = render(<MiralandMap view={VIEW} />)
    expect(fakeL.map).toHaveBeenCalledTimes(1)
    const onZoomEnd = fakeMap.on.mock.calls.find((call) => call[0] === 'zoomend')?.[1]
    expect(onZoomEnd).toBeTypeOf('function')

    unmount()

    expect(fakeMap.off).toHaveBeenCalledWith('zoomend', onZoomEnd)
    expect(roDisconnect).toHaveBeenCalledTimes(1)
    expect(roObserve).toHaveBeenCalledTimes(1)
    expect(fakeTiles.remove).toHaveBeenCalledTimes(1)
    expect(fakeMarker.remove).toHaveBeenCalledTimes(1)
    expect(fakeMap.remove).toHaveBeenCalledTimes(1)

    unmount()
    expect(fakeMap.remove).toHaveBeenCalledTimes(1)
  })

  it('Swift 重复挂载/卸载（StrictMode 双 mount）→ 每次创建都配套销毁', () => {
    const first = render(<MiralandMap view={VIEW} />)
    first.unmount()
    const second = render(<MiralandMap view={VIEW} />)
    second.unmount()
    expect(fakeL.map).toHaveBeenCalledTimes(2)
    expect(fakeMap.remove).toHaveBeenCalledTimes(2)
    expect(roDisconnect).toHaveBeenCalledTimes(2)
  })

  it('view 变化时销毁旧实例并重建（不泄漏旧 map）', () => {
    const { rerender } = render(<MiralandMap view={VIEW} />)
    rerender(<MiralandMap view={{ ...VIEW, pixel: { px: 200, py: 300 } }} />)
    expect(fakeMap.remove).toHaveBeenCalledTimes(1)
    expect(fakeL.map).toHaveBeenCalledTimes(2)
  })
})
