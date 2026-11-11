/**
 * 阶段 4：游戏坐标 → 地图像素换算（纯函数，零 IO / 零地图库依赖）。
 *
 * 对齐上游 nikki_albums main @ dc1b30b 的 MiralandCoords：
 *   px = originalPointX + x * pxPreUnit
 *   py = originalPointY + y * pxPreUnit
 * 上游再把像素除以 `256 * 2^maxZoom` 得到 flutter_map CrsSimple 的 lat/lng；
 * 本项目用 Leaflet CRS.Simple（scale = 2^z），两者在 zoom=maxZoom 落到同一像素，
 * 但 lat/lng 数值差 256 倍。因此「与上游一致」以地图像素为准，
 * lat/lng 换算由地图组件用 Leaflet 自身能力完成，本模块不重复实现。
 */
import type { WorldMapTileInfo } from '../../shared/types/electron-api'

export type WorldMapParams = WorldMapTileInfo

export interface MapPixel {
  px: number
  py: number
}

export interface MapBoundsPx {
  width: number
  height: number
}

export type CoordFailureReason = 'invalid-tile-params' | 'invalid-coords' | 'unsupported-zoom'

export type TileParamsResult =
  { ok: true; params: WorldMapParams } | { ok: false; reason: CoordFailureReason }

export type ConversionResult =
  | { ok: true; pixel: MapPixel; outside: boolean; bounds: MapBoundsPx; crsZoom: number }
  | { ok: false; reason: CoordFailureReason }

/** 瓦片金字塔常规上限；超出后 2^zoom 失去意义，直接判不支持（上游实采 maxZoom=6） */
const MAX_SUPPORTED_ZOOM = 30

const NUMERIC_FIELDS = [
  'worldId',
  'minZoom',
  'maxZoom',
  'mapWidthOfMaxZoom',
  'mapHeightOfMaxZoom',
  'originalPointX',
  'originalPointY',
  'pxPreUnit'
] as const

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(reason: CoordFailureReason): { ok: false; reason: CoordFailureReason } {
  return { ok: false, reason }
}

/** 外部数据（v1.db 经 IPC）默认不可信：逐字段判空、类型、边界，绝不猜默认值 */
export function validateWorldMapParams(tile: unknown): TileParamsResult {
  if (!isRecord(tile)) return fail('invalid-tile-params')
  for (const key of NUMERIC_FIELDS) {
    if (!isFiniteNumber(tile[key])) return fail('invalid-tile-params')
  }
  if (typeof tile.urlTemplate !== 'string' || !tile.urlTemplate.trim()) {
    return fail('invalid-tile-params')
  }

  const params = tile as unknown as WorldMapParams
  if (!Number.isSafeInteger(params.worldId) || params.worldId <= 0) {
    return fail('invalid-tile-params')
  }
  if (params.mapWidthOfMaxZoom <= 0 || params.mapHeightOfMaxZoom <= 0 || params.pxPreUnit <= 0) {
    return fail('invalid-tile-params')
  }
  if (
    !Number.isInteger(params.minZoom) ||
    params.minZoom < 0 ||
    !Number.isInteger(params.maxZoom) ||
    params.maxZoom < 0 ||
    params.maxZoom > MAX_SUPPORTED_ZOOM ||
    params.minZoom > params.maxZoom
  ) {
    return fail('unsupported-zoom')
  }

  return { ok: true, params: { ...params } }
}

/**
 * 游戏坐标 → 最大 zoom 下的地图像素。
 * z 不参与换算（上游只用 x/y）；originalPointY 的负值直接代入，不翻转 y 轴。
 * outside 只作标记，不 clamp 数据（错误不静默失败）。
 */
export function gameCoordsToMapPixel(coords: unknown, tile: unknown): ConversionResult {
  const validated = validateWorldMapParams(tile)
  if (!validated.ok) return validated
  if (!isRecord(coords) || !isFiniteNumber(coords.x) || !isFiniteNumber(coords.y)) {
    return fail('invalid-coords')
  }

  const { params } = validated
  const px = params.originalPointX + coords.x * params.pxPreUnit
  const py = params.originalPointY + coords.y * params.pxPreUnit
  if (!Number.isFinite(px) || !Number.isFinite(py)) return fail('invalid-coords')

  const bounds: MapBoundsPx = {
    width: params.mapWidthOfMaxZoom,
    height: params.mapHeightOfMaxZoom
  }
  return {
    ok: true,
    pixel: { px, py },
    outside: px < 0 || py < 0 || px > bounds.width || py > bounds.height,
    bounds,
    crsZoom: params.maxZoom
  }
}
