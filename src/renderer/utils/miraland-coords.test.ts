import { describe, it, expect } from 'vitest'
import { validateWorldMapParams, gameCoordsToMapPixel } from './miraland-coords'
import type { WorldMapParams } from './miraland-coords'

/**
 * 阶段 4 T2：游戏坐标 → 地图像素换算。
 *
 * 期望值一律由本文件内的 dartOracle 独立复算上游 main @ dc1b30b 的
 * `lib/modules/nuan5_params/presentation/miraland_map.dart` → MiralandCoords，
 * 绝不 import 生产函数充当期望值，避免「自己验自己」。
 *
 * 上游公式：
 *   px = originalPointX + x * pxPreUnit
 *   py = originalPointY + y * pxPreUnit
 *   scale = 256 * 2^zoom（flutter_map CrsSimple）
 *   LatLng(-py / scale, px / scale)   // (lat, lng)
 */

interface OracleTile {
  maxZoom: number
  originalPointX: number
  originalPointY: number
  pxPreUnit: number
}

/** 上游 Dart MiralandCoords.coordsToLatLng 的逐字复算（独立 oracle） */
function dartOracle(x: number, y: number, t: OracleTile) {
  const scale = 256 * Math.pow(2, t.maxZoom)
  const px = t.originalPointX + x * t.pxPreUnit
  const py = t.originalPointY + y * t.pxPreUnit
  return { px, py, lat: -py / scale, lng: px / scale }
}

/** 官方「奇迹大陆大地图」瓦片实采参数（docs/plans/…实施计划.md §12） */
const OFFICIAL: WorldMapParams = {
  worldId: 1,
  urlTemplate:
    'https://assets.papegames.com/maps/tiles-1/{z}-{x}-{y}.webp?x-oss-process=image/format,webp',
  minZoom: 0,
  maxZoom: 6,
  mapWidthOfMaxZoom: 16384,
  mapHeightOfMaxZoom: 16384,
  // originalPointX / pxPreUnit 未实采，用固定合成值；实采记录为 originalPointY = -51838.2
  originalPointX: 8192,
  originalPointY: -51838.2,
  pxPreUnit: 4
}

/** 逐值可断言的合成样本 */
const SYNTHETIC: WorldMapParams = {
  worldId: 4020034,
  urlTemplate: 'https://assets.papegames.com/maps/tiles-1/{z}-{x}-{y}.webp',
  minZoom: 0,
  maxZoom: 3,
  mapWidthOfMaxZoom: 1024,
  mapHeightOfMaxZoom: 1024,
  originalPointX: 100,
  originalPointY: -50,
  pxPreUnit: 2
}

describe('validateWorldMapParams', () => {
  it('正常：合法参数原样通过', () => {
    const r = validateWorldMapParams(OFFICIAL)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.params).toEqual(OFFICIAL)
  })

  it('异常：null / 数组 / 字符串 / 空对象 → invalid-tile-params', () => {
    for (const bad of [null, undefined, [], 'garbage', 42, {}]) {
      expect(validateWorldMapParams(bad)).toEqual({
        ok: false,
        reason: 'invalid-tile-params'
      })
    }
  })

  it('异常：数值字段为 NaN/Infinity/字符串 → invalid-tile-params', () => {
    for (const bad of [NaN, Infinity, -Infinity, '6', null]) {
      expect(validateWorldMapParams({ ...OFFICIAL, maxZoom: bad })).toEqual({
        ok: false,
        reason: expect.stringMatching(/invalid-tile-params|unsupported-zoom/)
      })
    }
  })

  it('异常：urlTemplate 缺失/空白 → invalid-tile-params', () => {
    for (const bad of [undefined, '', '   ', 123]) {
      expect(validateWorldMapParams({ ...OFFICIAL, urlTemplate: bad })).toEqual({
        ok: false,
        reason: 'invalid-tile-params'
      })
    }
  })

  it('边界：pxPreUnit<=0、宽/高<=0、worldId 非法 → invalid-tile-params', () => {
    const cases: Array<Partial<WorldMapParams>> = [
      { pxPreUnit: 0 },
      { pxPreUnit: -1 },
      { mapWidthOfMaxZoom: 0 },
      { mapHeightOfMaxZoom: -10 },
      { worldId: 0 },
      { worldId: -1 },
      { worldId: 1.5 }
    ]
    for (const patch of cases) {
      expect(validateWorldMapParams({ ...OFFICIAL, ...patch })).toEqual({
        ok: false,
        reason: 'invalid-tile-params'
      })
    }
  })

  it('边界：zoom 非法（负数/小数/超上限/minZoom>maxZoom）→ unsupported-zoom', () => {
    const cases: Array<Partial<WorldMapParams>> = [
      { maxZoom: -1 },
      { maxZoom: 1.5 },
      { maxZoom: 31 },
      { minZoom: -1 },
      { minZoom: 7 },
      { minZoom: 1.5 }
    ]
    for (const patch of cases) {
      expect(validateWorldMapParams({ ...OFFICIAL, ...patch })).toEqual({
        ok: false,
        reason: 'unsupported-zoom'
      })
    }
  })
})

describe('gameCoordsToMapPixel（与上游 MiralandCoords 一致）', () => {
  it('正常：合成样本 (10,5) → px=120, py=-40，与上游 oracle 逐值相等', () => {
    const r = gameCoordsToMapPixel({ x: 10, y: 5 }, SYNTHETIC)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const oracle = dartOracle(10, 5, SYNTHETIC)
    expect(r.pixel.px).toBe(oracle.px)
    expect(r.pixel.py).toBe(oracle.py)
    expect(r.pixel).toEqual({ px: 120, py: -40 })
    expect(r.crsZoom).toBe(3)
    expect(r.bounds).toEqual({ width: 1024, height: 1024 })
  })

  it('正常：负值 originalPointY 直接代入、不翻转 y 轴（与上游一致）', () => {
    const r = gameCoordsToMapPixel({ x: 0, y: 0 }, SYNTHETIC)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.pixel).toEqual({ px: 100, py: -50 })
  })

  it('正常：官方实采参数下 6 个世界均与上游 oracle 一致', () => {
    for (const worldId of [1, 4020034, 10000001, 10000002, 10000010, 10000027]) {
      const tile = { ...OFFICIAL, worldId }
      const r = gameCoordsToMapPixel({ x: 123.5, y: -456.25 }, tile)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const oracle = dartOracle(123.5, -456.25, tile)
      expect(r.pixel.px).toBe(oracle.px)
      expect(r.pixel.py).toBe(oracle.py)
    }
  })

  it('正常：z 不参与换算（上游只用 x/y），传入 z 不改结果', () => {
    const a = gameCoordsToMapPixel({ x: 12, y: 34 }, SYNTHETIC)
    const b = gameCoordsToMapPixel({ x: 12, y: 34, z: 999 }, SYNTHETIC)
    expect(a).toEqual(b)
  })

  it('显式钉住 CRS 口径：Leaflet 的 lat/lng 恰为上游 Dart 的 256 倍', () => {
    // 上游 flutter_map CrsSimple: scale = 256 * 2^z；Leaflet CRS.Simple: scale = 2^z。
    // 二者在 zoom=maxZoom 落到同一像素，但 lat/lng 数值差 256 倍，禁止直接比对 lat/lng。
    const r = gameCoordsToMapPixel({ x: 10, y: 5 }, SYNTHETIC)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const oracle = dartOracle(10, 5, SYNTHETIC)
    const leafletLat = -r.pixel.py / Math.pow(2, r.crsZoom)
    const leafletLng = r.pixel.px / Math.pow(2, r.crsZoom)
    expect(leafletLat).toBe(5)
    expect(leafletLng).toBe(15)
    expect(leafletLat / oracle.lat).toBe(256)
    expect(leafletLng / oracle.lng).toBe(256)
  })

  it('异常：coords 非对象 / 缺字段 / NaN / Infinity / 字符串 → invalid-coords', () => {
    const cases: unknown[] = [
      null,
      undefined,
      [],
      'garbage',
      {},
      { x: NaN, y: 1 },
      { x: Infinity, y: 1 },
      { x: 1, y: '5' },
      { x: 1 },
      { y: 1 }
    ]
    for (const bad of cases) {
      expect(gameCoordsToMapPixel(bad, SYNTHETIC)).toEqual({
        ok: false,
        reason: 'invalid-coords'
      })
    }
  })

  it('异常：tile 非法时先于 coords 报错，不产生像素', () => {
    expect(gameCoordsToMapPixel({ x: 1, y: 2 }, null)).toEqual({
      ok: false,
      reason: 'invalid-tile-params'
    })
  })

  it('边界：1e308 量级乘积溢出 → invalid-coords（不静默返回 Infinity）', () => {
    const r = gameCoordsToMapPixel({ x: 1e308, y: 1e308 }, SYNTHETIC)
    expect(r).toEqual({ ok: false, reason: 'invalid-coords' })
  })

  it('边界：outside 只标记不 clamp，界内/边界值/超界三态可判定', () => {
    const inside = gameCoordsToMapPixel({ x: 100, y: 100 }, SYNTHETIC)
    expect(inside.ok && inside.outside).toBe(false)
    // px = 100 + 462*2 = 1024（恰好等于 width）→ 不算越界
    const onEdge = gameCoordsToMapPixel({ x: 462, y: 100 }, SYNTHETIC)
    expect(onEdge.ok && onEdge.outside).toBe(false)
    const far = gameCoordsToMapPixel({ x: 1e6, y: 1e6 }, SYNTHETIC)
    expect(far.ok && far.outside).toBe(true)
    if (far.ok) expect(far.pixel.px).toBe(2000100)
  })
})
