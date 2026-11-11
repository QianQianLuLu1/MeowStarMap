import React, { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { validateWorldMapParams } from '../../../utils/miraland-coords'
import { isAuthorizedTileTemplate } from '../../../utils/world-map-tile-host'
import type { MapBoundsPx, MapPixel, WorldMapParams } from '../../../utils/miraland-coords'

/**
 * 阶段 4：唯一持有 Leaflet 实例的组件。内嵌视图与弹窗共用本组件与同一份 view 数据，
 * 仅 scrollWheelZoom / 容器尺寸不同（两种形态都可拖拽平移、缩放、受边界约束）。
 *
 * 对齐上游 MiralandMap（flutter_map CrsSimple）：
 *   initialCenter = 标记点；initialZoom = maxZoom；minZoom = 0；maxZoom = maxZoom + 2；
 *   containCenter(bounds=(0,0)~(W,H))；TileLayer min/maxNativeZoom；单点 40×40 红标。
 * Leaflet CRS.Simple 的 lat/lng 与上游相差 256 倍，但像素落点一致，故统一以像素为准。
 */
export interface MiralandMapView {
  tile: WorldMapParams
  pixel: MapPixel
  bounds: MapBoundsPx
  crsZoom: number
  outside: boolean
}

interface MiralandMapProps {
  view: MiralandMapView
  /** 内嵌关闭滚轮缩放以免劫持侧栏滚动；弹窗开启（默认 true） */
  scrollWheelZoom?: boolean
  className?: string
}

const MARKER_SVG =
  '<svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true">' +
  '<path fill="currentColor" d="M12 1a8 8 0 0 0-8 8c0 6 8 14 8 14s8-8 8-14a8 8 0 0 0-8-8z"/>' +
  '<circle cx="12" cy="9" r="2.8" fill="var(--bg-secondary)"/>' +
  '</svg>'

interface ResolvedView {
  tile: WorldMapParams
  pixel: MapPixel
  bounds: MapBoundsPx
  crsZoom: number
  outside: boolean
}

/** view 来自外部数据（v1.db 经 IPC）与解密坐标，一律先判空/类型/边界再使用 */
function resolveView(view: MiralandMapView | null | undefined): ResolvedView | null {
  if (!view || typeof view !== 'object') return null
  const checked = validateWorldMapParams(view.tile)
  if (!checked.ok) return null
  // 纵深复核（审查修复 2026-11-11）：上层已判过 host 授权，唯一建实例点再验一次，
  // 未授权模板不得创建任何 Leaflet 实例（不依赖单一判定点不被绕过）
  if (!isAuthorizedTileTemplate(checked.params.urlTemplate).ok) return null
  const { pixel, bounds, crsZoom } = view
  if (!pixel || !Number.isFinite(pixel.px) || !Number.isFinite(pixel.py)) return null
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return null
  if (!Number.isInteger(crsZoom) || crsZoom < 0) return null
  return {
    tile: checked.params,
    pixel,
    bounds,
    crsZoom,
    outside: view.outside === true
  }
}

export const MiralandMap: React.FC<MiralandMapProps> = ({
  view,
  scrollWheelZoom = true,
  className = ''
}) => {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    const resolved = resolveView(view)
    if (!el || !resolved) return

    const { tile, pixel, bounds, crsZoom, outside } = resolved
    const crs = L.CRS.Simple
    const toLatLng = (x: number, y: number) => crs.pointToLatLng(L.point(x, y), crsZoom)
    const maxBounds = L.latLngBounds(toLatLng(0, 0), toLatLng(bounds.width, bounds.height))
    const markerLatLng = toLatLng(pixel.px, pixel.py)
    // 与上游 containCenter 一致：仅约束相机中心，marker 数据本身不 clamp
    const center = outside
      ? L.latLng(
          Math.min(Math.max(markerLatLng.lat, maxBounds.getSouth()), maxBounds.getNorth()),
          Math.min(Math.max(markerLatLng.lng, maxBounds.getWest()), maxBounds.getEast())
        )
      : markerLatLng

    const map = L.map(el, {
      crs,
      center,
      zoom: crsZoom,
      minZoom: 0,
      maxZoom: crsZoom + 2,
      maxBounds,
      maxBoundsViscosity: 1.0,
      attributionControl: false,
      zoomControl: true,
      dragging: true,
      doubleClickZoom: true,
      scrollWheelZoom
    })

    const tiles = L.tileLayer(tile.urlTemplate, {
      minNativeZoom: tile.minZoom,
      maxNativeZoom: tile.maxZoom,
      minZoom: 0,
      maxZoom: crsZoom + 2,
      noWrap: true
    })
    tiles.addTo(map)

    const marker = L.marker(markerLatLng, {
      icon: L.divIcon({
        className: 'miraland-marker',
        html: MARKER_SVG,
        iconSize: [40, 40],
        iconAnchor: [20, 40]
      })
    })
    marker.addTo(map)

    const onZoomEnd = () => map.invalidateSize({ pan: false })
    map.on('zoomend', onZoomEnd)
    // 弹窗退场动画/侧栏宽度变化后重算容器尺寸，避免瓦片错位
    const resizeObserver = new ResizeObserver(() => map.invalidateSize({ pan: false }))
    resizeObserver.observe(el)

    return () => {
      resizeObserver.disconnect()
      map.off('zoomend', onZoomEnd)
      marker.remove()
      tiles.remove()
      map.remove()
    }
  }, [view, scrollWheelZoom])

  return (
    <div
      ref={containerRef}
      className={`miraland-map-container ${className}`}
      style={{ width: '100%', height: '100%' }}
      data-testid="miraland-map"
    />
  )
}
