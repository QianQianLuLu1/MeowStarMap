import { describe, it, expect } from 'vitest'
import { buildShareCardInput } from './shareCardInput'
import type { GameParamsData } from '../../types/decryption'

/**
 * 阶段 5 · B1：解密参数 → 分享图载荷的装配单测。
 * 关注三件事：键取全、缺值不伪造、穿搭名走本地字典（解析不出就留空）。
 */

const fullCamera = {
  focalLength: 50,
  apertureSection: 2.8,
  brightness: 10,
  exposure: -0.3,
  contrast: -0.2,
  saturation: 0.5,
  vibrance: 0.1,
  highlights: -0.5,
  shadows: 0.6,
  vignetteIntensity: 20,
  bloomIntensity: 35,
  bloomThreshold: 0.4,
  portraitMode: true,
  zoom: 1.5,
  rotation: 12,
  cameraYaw: 0,
  cameraPitch: 0,
  cameraLoc: null,
  pose: 7,
  framedMoment: 0,
  momoHidden: null,
  rawParams: '',
  filter: { id: '201', strength: 1 },
  light: { id: '305', strength: 1 }
}

describe('buildShareCardInput', () => {
  it('camera 齐备时产出 12 项规范参数 + 2 项追加（镜头旋转、景深）', () => {
    const data: GameParamsData = { hasParams: true, camera: fullCamera }
    const payload = buildShareCardInput(data, { gameVersion: '1.3.2' })
    expect(payload.version).toBe('1.3.2')
    const keys = payload.camera.map((row) => row.key)
    for (const key of [
      'focalLength',
      'aperture',
      'vignette',
      'bloom',
      'bloomRange',
      'brightness',
      'exposure',
      'contrast',
      'saturation',
      'naturalSaturation',
      'highlights',
      'shadows',
      'rotation'
    ]) {
      expect(keys, `缺少 ${key}`).toContain(key)
    }
    // portraitMode=true → 景深行给 1（与游戏内的开关口径一致）
    expect(payload.camera.find((row) => row.key === 'depthOfField')?.value).toBe('1')
  })

  it('效果区取 pose / 光源 / 滤镜 / 地点', () => {
    const data: GameParamsData = {
      hasParams: true,
      camera: fullCamera,
      photography: {
        edit: { enabled: false, hasSticker: false, hasText: false },
        date: null,
        time: null,
        location: { pos: { x: 0, y: 0, z: 0 }, name: '誓言泉' },
        weather: null,
        photoWall: [],
        tasks: []
      }
    }
    const payload = buildShareCardInput(data)
    const effectKeys = payload.effects.map((row) => row.key)
    expect(effectKeys).toEqual(['action', 'lighting', 'filter', 'location'])
    expect(payload.effects.find((row) => row.key === 'location')?.value).toBe('誓言泉')
  })

  it('参数缺失时仍产出载荷，12 项全部按缺值呈现（不伪造数值）', () => {
    const payload = buildShareCardInput(null)
    expect(payload.camera).toEqual([])
    expect(payload.outfit).toEqual([])
    expect(payload.date).toBe('')
  })

  it('非有限数与缺失字段不产出行', () => {
    const camera = { ...fullCamera, focalLength: Number.NaN }
    delete (camera as { vignetteIntensity?: number }).vignetteIntensity
    const data: GameParamsData = { hasParams: true, camera }
    const payload = buildShareCardInput(data)
    const keys = payload.camera.map((row) => row.key)
    expect(keys).not.toContain('focalLength')
    expect(keys).not.toContain('vignette')
  })

  it('穿搭名走本地字典：已知 ID 解析出名称，未知 ID 留空', () => {
    const data: GameParamsData = {
      hasParams: true,
      dressing: {
        clothes: [
          { id: 1020100001, clothType: 1, clothTypeName: null, state: 0, species: 0 },
          { id: 999999999999, clothType: 1, clothTypeName: null, state: 0, species: 0 }
        ],
        eureka: []
      }
    }
    const payload = buildShareCardInput(data)
    expect(payload.outfit.map((item) => item.value)).toEqual(['时光讯号', ''])
    expect(payload.outfit.map((item) => item.iconSource)).toEqual(['item', 'item'])
  })

  it('穿搭上限 100 条（与上游 outfit 通道的 total 上界一致）', () => {
    const data: GameParamsData = {
      hasParams: true,
      dressing: {
        clothes: Array.from({ length: 130 }, (_, i) => ({
          id: 900000000000 + i,
          clothType: 1,
          clothTypeName: null,
          state: 0,
          species: 0
        })),
        eureka: []
      }
    }
    expect(buildShareCardInput(data).outfit).toHaveLength(100)
  })

  it('只有 camera（无 dressing/photography）时效果区仍取 pose/光源/滤镜，不得静默丢行', () => {
    const camera = { ...fullCamera }
    delete (camera as { filter?: unknown }).filter
    delete (camera as { light?: unknown }).light
    const data: GameParamsData = { hasParams: true, camera }
    const payload = buildShareCardInput(data)
    expect(payload.effects.map((row) => row.key)).toEqual(['action'])
    expect(payload.effects[0]?.value).toBe('7')
  })
})
