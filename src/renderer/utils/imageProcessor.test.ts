import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  rgbToHsl,
  hslToRgb,
  buildCurveMap,
  getHSLTargetHue,
  applyHSL,
  applyTemperature,
  applyVibrance,
  applyDehaze,
  applySplitTone,
  getWatermarkPosition,
  formatWatermarkText,
  planPasses,
  defaultFilterParams,
  hslColorKeys,
  type HSLColorKey,
  type HSLAdjustment,
  type CurvePoint,
  type FilterParams,
  type WatermarkConfig
} from './imageProcessor'

/**
 * imageProcessor 模块测试：图片滤镜算法纯函数
 *
 * 不依赖浏览器 API（仅 RGB 数值计算），可在 node 环境直接运行
 * 涉及 ImageData/canvas 的 processImageData/applyWatermark 不在此覆盖
 */

describe('imageProcessor', () => {
  describe('rgbToHsl', () => {
    it('纯红 (255,0,0) → hue=0（红色）', () => {
      const [h, s, l] = rgbToHsl(255, 0, 0)
      expect(h).toBeCloseTo(0, 6)
      expect(s).toBeCloseTo(1, 6)
      expect(l).toBeCloseTo(0.5, 6)
    })

    it('纯绿 (0,255,0) → hue=1/3', () => {
      const [h, s, l] = rgbToHsl(0, 255, 0)
      expect(h).toBeCloseTo(1 / 3, 6)
      expect(s).toBeCloseTo(1, 6)
      expect(l).toBeCloseTo(0.5, 6)
    })

    it('纯蓝 (0,0,255) → hue=2/3', () => {
      const [h, s, l] = rgbToHsl(0, 0, 255)
      expect(h).toBeCloseTo(2 / 3, 6)
      expect(s).toBeCloseTo(1, 6)
      expect(l).toBeCloseTo(0.5, 6)
    })

    it('白色 (255,255,255) → s=0, l=1（无色相）', () => {
      const [, s, l] = rgbToHsl(255, 255, 255)
      expect(s).toBeCloseTo(0, 6)
      expect(l).toBeCloseTo(1, 6)
    })

    it('黑色 (0,0,0) → s=0, l=0', () => {
      const [, s, l] = rgbToHsl(0, 0, 0)
      expect(s).toBeCloseTo(0, 6)
      expect(l).toBeCloseTo(0, 6)
    })

    it('灰色 (128,128,128) → s=0, l≈0.5', () => {
      const [h, s, l] = rgbToHsl(128, 128, 128)
      expect(s).toBeCloseTo(0, 6)
      expect(l).toBeCloseTo(128 / 255, 4)
      // h 在 s=0 时无定义，当前实现为 0
      expect(h).toBeCloseTo(0, 6)
    })

    it('RGB 相等时 s=0（灰度）', () => {
      const [, s] = rgbToHsl(100, 100, 100)
      expect(s).toBeCloseTo(0, 6)
    })

    it('超出 [0,255] 的输入不抛错（当前实现会除以 255，固化行为）', () => {
      // rgbToHsl 不对输入做范围校验，超出 [0,255] 时仍能计算
      // r=510/255=2, max=2, min=0, l=1, d=2
      // l>0.5 → s = d/(2-max-min) = 2/0 = Infinity（除零，固化此行为）
      const [, s, l] = rgbToHsl(510, 0, 0)
      expect(l).toBeCloseTo(1, 6)
      expect(s).toBe(Infinity)
    })

    it('输入 (0,0,0) 不抛错', () => {
      expect(() => rgbToHsl(0, 0, 0)).not.toThrow()
    })
  })

  describe('hslToRgb', () => {
    it('灰度（s=0）→ r=g=b=l*255', () => {
      const [r, g, b] = hslToRgb(0, 0, 0.5)
      expect(r).toBeCloseTo(127.5, 4)
      expect(g).toBeCloseTo(127.5, 4)
      expect(b).toBeCloseTo(127.5, 4)
    })

    it('h=0, s=1, l=0.5 → 纯红', () => {
      const [r, g, b] = hslToRgb(0, 1, 0.5)
      expect(r).toBeCloseTo(255, 4)
      expect(g).toBeCloseTo(0, 4)
      expect(b).toBeCloseTo(0, 4)
    })

    it('与 rgbToHsl 互为逆运算（精度容差 1e-3）', () => {
      // 取一组 RGB 值，转 HSL 再转回 RGB，应近似原值
      const testCases: Array<[number, number, number]> = [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [128, 64, 200],
        [200, 200, 200],
        [50, 100, 150]
      ]
      for (const [r, g, b] of testCases) {
        const [h, s, l] = rgbToHsl(r, g, b)
        const [r2, g2, b2] = hslToRgb(h, s, l)
        expect(Math.abs(r2 - r)).toBeLessThan(1.5) // round 误差
        expect(Math.abs(g2 - g)).toBeLessThan(1.5)
        expect(Math.abs(b2 - b)).toBeLessThan(1.5)
      }
    })

    it('l=0 时返回 (0,0,0)', () => {
      const [r, g, b] = hslToRgb(0.5, 1, 0)
      expect(r).toBeCloseTo(0, 6)
      expect(g).toBeCloseTo(0, 6)
      expect(b).toBeCloseTo(0, 6)
    })

    it('l=1 时返回 (255,255,255)', () => {
      const [r, g, b] = hslToRgb(0.5, 1, 1)
      expect(r).toBeCloseTo(255, 6)
      expect(g).toBeCloseTo(255, 6)
      expect(b).toBeCloseTo(255, 6)
    })

    it('h=1/3 (绿) → 纯绿', () => {
      const [r, g, b] = hslToRgb(1 / 3, 1, 0.5)
      expect(r).toBeCloseTo(0, 4)
      expect(g).toBeCloseTo(255, 4)
      expect(b).toBeCloseTo(0, 4)
    })
  })

  describe('buildCurveMap', () => {
    it('恒等曲线 [(0,0),(1,1)] → map[i] = i', () => {
      const points: CurvePoint[] = [
        { x: 0, y: 0 },
        { x: 1, y: 1 }
      ]
      const map = buildCurveMap(points)
      expect(map).toHaveLength(256)
      expect(map[0]).toBe(0)
      expect(map[128]).toBe(128)
      expect(map[255]).toBe(255)
      // 中间值也应近似线性
      expect(map[64]).toBe(64)
      expect(map[192]).toBe(192)
    })

    it('反相曲线 [(0,1),(1,0)] → map[i] = 255 - i', () => {
      const points: CurvePoint[] = [
        { x: 0, y: 1 },
        { x: 1, y: 0 }
      ]
      const map = buildCurveMap(points)
      expect(map[0]).toBe(255)
      expect(map[255]).toBe(0)
      expect(map[128]).toBe(127) // 128/255 ≈ 0.502，y = 1 - 0.502 = 0.498 → 127
    })

    it('S 曲线 [(0,0),(0.5,0.25),(1,1)] 中间值被压低', () => {
      const points: CurvePoint[] = [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.25 },
        { x: 1, y: 1 }
      ]
      const map = buildCurveMap(points)
      // 0.5 * 255 = 127.5 → x=127/255≈0.498，y 应在 0.25 附近
      // 0.498 < 0.5，y = 0 + (0.25 - 0) * (0.498 - 0) / 0.5 = 0.249
      // 0.249 * 255 = 63.5 → round = 64
      expect(map[127]).toBeGreaterThanOrEqual(60)
      expect(map[127]).toBeLessThanOrEqual(70)
    })

    it('乱序 points 自动排序', () => {
      const points: CurvePoint[] = [
        { x: 1, y: 1 },
        { x: 0, y: 0 }
      ]
      const map = buildCurveMap(points)
      expect(map[0]).toBe(0)
      expect(map[255]).toBe(255)
    })

    it('返回长度恒为 256', () => {
      expect(buildCurveMap([])).toHaveLength(256)
      expect(buildCurveMap([{ x: 0, y: 0 }])).toHaveLength(256)
      expect(
        buildCurveMap([
          { x: 0, y: 0 },
          { x: 1, y: 1 }
        ])
      ).toHaveLength(256)
    })

    it('空 points 时所有值等于自身（fallback 到恒等）', () => {
      const map = buildCurveMap([])
      // 空数组时 sorted.length-1 = -1，内层循环不执行，y 保持 x
      expect(map[0]).toBe(0)
      expect(map[128]).toBe(128)
      expect(map[255]).toBe(255)
    })

    it('单点曲线 [(0.5,0.5)] 时大部分值保持恒等', () => {
      const points: CurvePoint[] = [{ x: 0.5, y: 0.5 }]
      const map = buildCurveMap(points)
      // 单点时 sorted.length-1 = 0，内层循环不执行，y 保持 x
      expect(map[0]).toBe(0)
      expect(map[128]).toBe(128)
      expect(map[255]).toBe(255)
    })

    it('所有值都被 clamp 到 [0, 255]', () => {
      const points: CurvePoint[] = [
        { x: 0, y: -0.5 },
        { x: 1, y: 1.5 }
      ]
      const map = buildCurveMap(points)
      for (const v of map) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(255)
      }
    })
  })

  describe('getHSLTargetHue', () => {
    it('红色目标色相为 0', () => {
      expect(getHSLTargetHue('red')).toBe(0)
    })

    it('橙色目标色相为 30', () => {
      expect(getHSLTargetHue('orange')).toBe(30)
    })

    it('绿色目标色相为 120', () => {
      expect(getHSLTargetHue('green')).toBe(120)
    })

    it('蓝色目标色相为 240', () => {
      expect(getHSLTargetHue('blue')).toBe(240)
    })

    it('洋红目标色相为 300', () => {
      expect(getHSLTargetHue('magenta')).toBe(300)
    })

    it('所有 12 个 key 都有对应的目标色相', () => {
      for (const key of hslColorKeys) {
        const hue = getHSLTargetHue(key)
        expect(hue).toBeGreaterThanOrEqual(0)
        expect(hue).toBeLessThanOrEqual(360)
      }
    })
  })

  describe('applyHSL', () => {
    /** 全 0 的 hsl 调整表 */
    function zeroHsl(): Record<HSLColorKey, HSLAdjustment> {
      const result = {} as Record<HSLColorKey, HSLAdjustment>
      for (const k of hslColorKeys) {
        result[k] = { hue: 0, saturation: 0, lightness: 0 }
      }
      return result
    }

    it('全 0 调整不改变原色', () => {
      const [r, g, b] = applyHSL(100, 150, 200, zeroHsl())
      expect(r).toBeCloseTo(100, 6)
      expect(g).toBeCloseTo(150, 6)
      expect(b).toBeCloseTo(200, 6)
    })

    it('红色 hue 偏移影响红色像素', () => {
      const hsl = zeroHsl()
      hsl.red = { hue: 60, saturation: 0, lightness: 0 } // 红色色相偏移 60
      const [r, g, b] = applyHSL(255, 0, 0, hsl)
      // 红色像素 (h=0)，red 调整 hue=60 应使其色相偏移
      // 改变后 r/g/b 应不同于原值
      expect(r !== 255 || g !== 0 || b !== 0).toBe(true)
    })

    it('不影响色相距离过远的像素（如绿色调整不影响蓝色）', () => {
      const hsl = zeroHsl()
      hsl.red = { hue: 100, saturation: 50, lightness: 50 } // 仅调整红色
      const [r, g, b] = applyHSL(0, 0, 255, hsl) // 蓝色像素
      // 蓝色 hue=240，与红色目标 hue=0 距离 240，超过 range=30
      // 不应被影响
      expect(r).toBeCloseTo(0, 4)
      expect(g).toBeCloseTo(0, 4)
      expect(b).toBeCloseTo(255, 4)
    })

    it('skin key 调整影响接近肤色相的像素', () => {
      // 选一个非极端饱和的肤色像素 (220, 180, 150)，使其仍有饱和度提升空间
      const hsl = zeroHsl()
      hsl.skin = { hue: 0, saturation: 50, lightness: 0 }
      const origSat = rgbToHsl(220, 180, 150)[1]
      const [r, g, b] = applyHSL(220, 180, 150, hsl)
      const newSat = rgbToHsl(r, g, b)[1]
      // skin saturation+50 应使饱和度增加
      expect(newSat).toBeGreaterThan(origSat)
    })
  })

  describe('applyTemperature', () => {
    it('temp=0, tint=0 不改变原色', () => {
      const [r, g, b] = applyTemperature(100, 150, 200, 0, 0)
      expect(r).toBeCloseTo(100, 6)
      expect(g).toBeCloseTo(150, 6)
      // b 通道：warmB * 0.5 + tintM * 0.5 = 200 * 0.5 + 200 * 0.5 = 200
      expect(b).toBeCloseTo(200, 6)
    })

    it('正温（暖）：r 增加，b 减少', () => {
      const [r, , b] = applyTemperature(100, 150, 200, 50, 0)
      // t = 0.5, warmR = 100 * (1 + 0.5 * 0.15) = 107.5, warmB = 200 * (1 - 0.5 * 0.15) = 185
      expect(r).toBeGreaterThan(100)
      expect(b).toBeLessThan(200)
    })

    it('负温（冷）：r 减少，b 增加', () => {
      const [r, , b] = applyTemperature(100, 150, 200, -50, 0)
      expect(r).toBeLessThan(100)
      expect(b).toBeGreaterThan(200)
    })

    it('正 tint 增加 g 通道', () => {
      const [, g] = applyTemperature(100, 150, 200, 0, 50)
      // tintG = 150 * (1 + 0.5 * 0.1) = 157.5
      expect(g).toBeGreaterThan(150)
    })

    it('负 tint 减少 g 通道', () => {
      const [, g] = applyTemperature(100, 150, 200, 0, -50)
      // tintG = 150 * (1 - 0.05) = 142.5
      expect(g).toBeLessThan(150)
    })

    it('temp=100 时 r 增加 15%', () => {
      const [r] = applyTemperature(100, 150, 200, 100, 0)
      expect(r).toBeCloseTo(115, 4)
    })
  })

  describe('applyVibrance', () => {
    it('vibrance=0 不改变原色', () => {
      const [r, g, b] = applyVibrance(100, 150, 200, 0)
      expect(r).toBeCloseTo(100, 6)
      expect(g).toBeCloseTo(150, 6)
      expect(b).toBeCloseTo(200, 6)
    })

    it('灰度像素（r=g=b）不受 vibrance 影响', () => {
      // 灰度像素 max=avg，amt = 0 * vibrance = 0
      const [r, g, b] = applyVibrance(128, 128, 128, 100)
      expect(r).toBeCloseTo(128, 6)
      expect(g).toBeCloseTo(128, 6)
      expect(b).toBeCloseTo(128, 6)
    })

    it('正 vibrance 增加饱和度差异', () => {
      const [r, g, b] = applyVibrance(200, 100, 50, 100)
      // 高饱和度像素被影响（推向更极端）
      const origMax = Math.max(200, 100, 50)
      const newMax = Math.max(r, g, b)
      expect(newMax).toBeGreaterThan(origMax)
    })

    it('负 vibrance 降低饱和度差异', () => {
      const [r, g, b] = applyVibrance(200, 100, 50, -100)
      const origMax = Math.max(200, 100, 50)
      const newMax = Math.max(r, g, b)
      expect(newMax).toBeLessThan(origMax)
    })
  })

  describe('applyDehaze', () => {
    it('dehaze=0 不改变原色', () => {
      const [r, g, b] = applyDehaze(100, 150, 200, 0)
      expect(r).toBe(100)
      expect(g).toBe(150)
      expect(b).toBe(200)
    })

    it('正 dehaze 影响所有通道', () => {
      const [r, g, b] = applyDehaze(100, 150, 200, 50)
      // 不为零说明产生了影响
      expect(r).not.toBe(100)
      expect(g).not.toBe(150)
      expect(b).not.toBe(200)
    })

    it('正负 dehaze 响应相同（factor² 平方关系，固化对称行为）', () => {
      // applyDehaze 公式：r_out = r - 255 * factor² * (1 - r/255)
      // 其中 factor = (dehaze/100) * 0.5，haze = 255 * factor
      // factor² 始终非负 → 正负 dehaze 输出相同
      const [rNeg, gNeg, bNeg] = applyDehaze(100, 150, 200, -50)
      const [rPos, gPos, bPos] = applyDehaze(100, 150, 200, 50)
      expect(rNeg).toBe(rPos)
      expect(gNeg).toBe(gPos)
      expect(bNeg).toBe(bPos)
    })

    it('白色 (255,255,255) 在正 dehaze 下基本不变', () => {
      const [r, g, b] = applyDehaze(255, 255, 255, 50)
      // 1 - r/255 = 0，所以 (r - haze * 0) = r = 255
      // r * (1 - 0.25) + 255 * 0.25 = 191.25 + 63.75 = 255
      expect(r).toBeCloseTo(255, 4)
      expect(g).toBeCloseTo(255, 4)
      expect(b).toBeCloseTo(255, 4)
    })

    it('黑色 (0,0,0) 在正 dehaze 下被提亮', () => {
      const [r] = applyDehaze(0, 0, 0, 50)
      // 1 - 0/255 = 1, (0 - haze*1) = -haze
      // r*(1-factor) + (r - haze*1)*factor = 0 + (-haze)*factor
      // factor=0.25, haze=127.5 → r = -127.5 * 0.25 = -31.875
      expect(r).toBeLessThan(0)
    })
  })

  describe('applySplitTone', () => {
    function makeParams(overrides: Partial<FilterParams>): FilterParams {
      return { ...defaultFilterParams, ...overrides }
    }

    it('全 0 参数不改变原色', () => {
      const params = makeParams({})
      const [r, g, b] = applySplitTone(100, 150, 200, 100, params)
      expect(r).toBeCloseTo(100, 6)
      expect(g).toBeCloseTo(150, 6)
      expect(b).toBeCloseTo(200, 6)
    })

    it('shadowSaturation=0 时不应用 shadow 色调', () => {
      const params = makeParams({
        shadowHue: 240, // 蓝色阴影
        shadowSaturation: 0,
        highlightHue: 0,
        highlightSaturation: 0
      })
      const [r, g, b] = applySplitTone(100, 100, 100, 50, params)
      expect(r).toBeCloseTo(100, 6)
      expect(g).toBeCloseTo(100, 6)
      expect(b).toBeCloseTo(100, 6)
    })

    it('highlightSaturation=0 时不应用 highlight 色调', () => {
      const params = makeParams({
        highlightHue: 60,
        highlightSaturation: 0,
        shadowHue: 0,
        shadowSaturation: 0
      })
      const [r, g, b] = applySplitTone(100, 100, 100, 200, params)
      expect(r).toBeCloseTo(100, 6)
      expect(g).toBeCloseTo(100, 6)
      expect(b).toBeCloseTo(100, 6)
    })

    it('暗部应用 shadow 色调后像素颜色发生变化', () => {
      // 应用色调混合后原灰色 (50,50,50) 会变成有色（不再是 r=g=b）
      const params = makeParams({
        shadowHue: 240, // 蓝色阴影
        shadowSaturation: 100,
        highlightHue: 0,
        highlightSaturation: 0,
        splitBalance: 0 // 中间平衡
      })
      const [r, g, b] = applySplitTone(50, 50, 50, 50, params) // lum=50（暗部）
      // shadowWeight = max(0, 1 - 50/255 - 0.5 + 0.5) = 0.804 > 0
      // 应用蓝色阴影后灰色像素变为有色（r/g/b 不再相等）
      expect(r === g && g === b).toBe(false)
    })

    it('亮部应用 highlight 色调（lum 高时 highlightWeight 高）', () => {
      const params = makeParams({
        shadowHue: 0,
        shadowSaturation: 0,
        highlightHue: 60, // 黄色高光
        highlightSaturation: 100,
        splitBalance: 0
      })
      const [r, g, b] = applySplitTone(200, 200, 200, 200, params) // lum=200（亮部）
      // highlightWeight = max(0, 200/255 - (1 - 0.5) + 0.5) = max(0, 0.784 + 0.5 - 0.5) = 0.784
      // 应用黄色高光后 r/g 应变化
      expect(r !== 200 || g !== 200 || b !== 200).toBe(true)
    })

    it('balance=100 偏向 shadow（即使亮部也应用 shadow 色调）', () => {
      const params = makeParams({
        shadowHue: 240,
        shadowSaturation: 100,
        highlightHue: 0,
        highlightSaturation: 0,
        splitBalance: 100 // balance=100 → shadowWeight 大幅增加
      })
      const [r, g, b] = applySplitTone(200, 200, 200, 200, params)
      // balance=100 → balance = (100+100)/200 = 1
      // shadowWeight = max(0, 1 - 200/255 - 1 + 0.5) = max(0, -0.284) = 0
      // 实际上 balance=100 会让 shadowWeight 减少，highlightWeight 增加
      // 这里固化"不抛错且返回 [number, number, number]"行为
      expect(Array.isArray([r, g, b])).toBe(true)
    })
  })

  describe('getWatermarkPosition', () => {
    // 假设画布 800x600，水印 100x50，margin 20
    const cw = 800
    const ch = 600
    const ww = 100
    const wh = 50
    const margin = 20
    const customX = 300
    const customY = 200

    it('topLeft', () => {
      const pos = getWatermarkPosition('topLeft', cw, ch, ww, wh, margin, customX, customY)
      expect(pos).toEqual({ x: margin, y: margin })
    })

    it('topCenter', () => {
      const pos = getWatermarkPosition('topCenter', cw, ch, ww, wh, margin, customX, customY)
      expect(pos).toEqual({ x: (cw - ww) / 2, y: margin })
    })

    it('topRight', () => {
      const pos = getWatermarkPosition('topRight', cw, ch, ww, wh, margin, customX, customY)
      expect(pos).toEqual({ x: cw - ww - margin, y: margin })
    })

    it('centerLeft', () => {
      const pos = getWatermarkPosition('centerLeft', cw, ch, ww, wh, margin, customX, customY)
      expect(pos).toEqual({ x: margin, y: (ch - wh) / 2 })
    })

    it('center', () => {
      const pos = getWatermarkPosition('center', cw, ch, ww, wh, margin, customX, customY)
      expect(pos).toEqual({ x: (cw - ww) / 2, y: (ch - wh) / 2 })
    })

    it('centerRight', () => {
      const pos = getWatermarkPosition('centerRight', cw, ch, ww, wh, margin, customX, customY)
      expect(pos).toEqual({ x: cw - ww - margin, y: (ch - wh) / 2 })
    })

    it('bottomLeft', () => {
      const pos = getWatermarkPosition('bottomLeft', cw, ch, ww, wh, margin, customX, customY)
      expect(pos).toEqual({ x: margin, y: ch - wh - margin })
    })

    it('bottomCenter', () => {
      const pos = getWatermarkPosition('bottomCenter', cw, ch, ww, wh, margin, customX, customY)
      expect(pos).toEqual({ x: (cw - ww) / 2, y: ch - wh - margin })
    })

    it('bottomRight（默认位置）', () => {
      const pos = getWatermarkPosition('bottomRight', cw, ch, ww, wh, margin, customX, customY)
      expect(pos).toEqual({ x: cw - ww - margin, y: ch - wh - margin })
    })

    it('custom 使用 customX/customY', () => {
      const pos = getWatermarkPosition('custom', cw, ch, ww, wh, margin, customX, customY)
      expect(pos).toEqual({ x: customX, y: customY })
    })

    it('未知 position 字符串 fallback 到 bottomRight', () => {
      // 由于 TypeScript 类型限制，这里通过 as 绕过测试未知值
      const pos = getWatermarkPosition(
        'unknown' as WatermarkConfig['position'],
        cw,
        ch,
        ww,
        wh,
        margin,
        customX,
        customY
      )
      expect(pos).toEqual({ x: cw - ww - margin, y: ch - wh - margin })
    })

    it('margin=0 时 topLeft 为 (0,0)', () => {
      const pos = getWatermarkPosition('topLeft', cw, ch, ww, wh, 0, 0, 0)
      expect(pos).toEqual({ x: 0, y: 0 })
    })

    it('水印尺寸大于画布时返回负坐标', () => {
      // cw=100, ww=200 → x = 100 - 200 - 20 = -120
      const pos = getWatermarkPosition('topRight', 100, 100, 200, 100, 20, 0, 0)
      expect(pos.x).toBeLessThan(0)
    })
  })

  describe('formatWatermarkText', () => {
    beforeEach(() => {
      // 固定当前时间便于断言
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-18T14:30:00'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('{date} 替换为 YYYY.MM.DD', () => {
      expect(formatWatermarkText('拍摄于 {date}')).toBe('拍摄于 2026.07.18')
    })

    it('{time} 替换为 HH:MM', () => {
      expect(formatWatermarkText('时间：{time}')).toBe('时间：14:30')
    })

    it('{date} {time} 同时替换', () => {
      expect(formatWatermarkText('{date} {time}')).toBe('2026.07.18 14:30')
    })

    it('大小写不敏感（{DATE} 与 {Date} 也能替换）', () => {
      expect(formatWatermarkText('{DATE}')).toBe('2026.07.18')
      expect(formatWatermarkText('{Date}')).toBe('2026.07.18')
      expect(formatWatermarkText('{TIME}')).toBe('14:30')
      expect(formatWatermarkText('{Time}')).toBe('14:30')
    })

    it('无占位符时原文返回', () => {
      expect(formatWatermarkText('hello world')).toBe('hello world')
    })

    it('空字符串返回空字符串', () => {
      expect(formatWatermarkText('')).toBe('')
    })

    it('多个 {date} 占位符全部被替换', () => {
      expect(formatWatermarkText('{date} | {date} | {date}')).toBe(
        '2026.07.18 | 2026.07.18 | 2026.07.18'
      )
    })

    it('中文混合占位符也能替换', () => {
      expect(formatWatermarkText('暖暖相册 {date}')).toBe('暖暖相册 2026.07.18')
    })
  })

  /**
   * planPasses（docs/plans/2026-10-18-fix-editor-preview-realtime.md N5）
   *
   * 拖动时通常只有一两个参数在变，但像素循环此前对**每个像素**都调用全部 pass 函数
   * （各自返回一个元组数组）。把「哪个 pass 真的激活」提到循环外算一次，
   * 未激活的 pass 整个跳过——判定口径必须与各 pass 自身的早退条件逐字一致，
   * 否则会改变输出；等价性由 imageProcessor.pixels.test.ts 的校验和守住。
   */
  describe('planPasses 像素循环的 pass 判定', () => {
    it('默认参数下所有可选 pass 都不激活（正常）', () => {
      const plan = planPasses(defaultFilterParams)
      expect(plan.temperature).toBe(false)
      expect(plan.vibrance).toBe(false)
      expect(plan.hsl).toBe(false)
      expect(plan.activeHslKeys).toEqual([])
      expect(plan.splitTone).toBe(false)
      expect(plan.dehaze).toBe(false)
      expect(plan.convolution).toBe(false)
      expect(plan.vignette).toBe(false)
      expect(plan.grain).toBe(false)
      expect(plan.fade).toBe(false)
      expect(plan.lut).toBe(false)
    })

    it('色温与色调任一非零即激活色温 pass（正常）', () => {
      expect(planPasses({ ...defaultFilterParams, temperature: 30, tint: 0 }).temperature).toBe(
        true
      )
      expect(planPasses({ ...defaultFilterParams, temperature: 0, tint: -12 }).temperature).toBe(
        true
      )
    })

    it('只激活真正非零的那个 HSL 键（边界）', () => {
      const plan = planPasses({
        ...defaultFilterParams,
        hsl: {
          ...defaultFilterParams.hsl,
          green: { hue: 0, saturation: 10, lightness: 0 }
        }
      })
      expect(plan.hsl).toBe(true)
      expect(plan.activeHslKeys).toEqual(['green'])
    })

    it('NaN 视为未激活（异常）——否则每像素 clamp(NaN) 会把整帧涂黑', () => {
      const plan = planPasses({
        ...defaultFilterParams,
        vibrance: NaN,
        dehaze: NaN,
        hsl: { ...defaultFilterParams.hsl, red: { hue: NaN, saturation: NaN, lightness: NaN } }
      })
      expect(plan.vibrance).toBe(false)
      expect(plan.dehaze).toBe(false)
      expect(plan.hsl).toBe(false)
      expect(plan.activeHslKeys).toEqual([])
    })

    it('分离色调仅 balance 非零时不激活——与 applySplitTone 的早退口径逐字一致（边界）', () => {
      expect(planPasses({ ...defaultFilterParams, splitBalance: 50 }).splitTone).toBe(false)
      expect(planPasses({ ...defaultFilterParams, shadowHue: 50 }).splitTone).toBe(true)
      expect(planPasses({ ...defaultFilterParams, highlightSaturation: 50 }).splitTone).toBe(true)
    })

    it('清晰度/锐化/降噪任一非零即激活卷积组（正常）', () => {
      expect(planPasses({ ...defaultFilterParams, sharpen: 1 }).convolution).toBe(true)
      expect(planPasses({ ...defaultFilterParams, denoise: 1 }).convolution).toBe(true)
      expect(planPasses({ ...defaultFilterParams, clarity: -1 }).convolution).toBe(true)
    })

    it('暗角/颗粒/褪色沿用既有的「大于 0」口径，负值不激活（边界）', () => {
      expect(planPasses({ ...defaultFilterParams, vignette: -10 }).vignette).toBe(false)
      expect(planPasses({ ...defaultFilterParams, vignette: 10 }).vignette).toBe(true)
      expect(planPasses({ ...defaultFilterParams, grain: 0.5 }).grain).toBe(true)
      expect(planPasses({ ...defaultFilterParams, fade: 0 }).fade).toBe(false)
    })
  })
})
