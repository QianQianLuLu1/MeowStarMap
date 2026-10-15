import { describe, it, expect } from 'vitest'
import { InternalError } from '../../../shared/errors/app-error'
import {
  buildShareCardPayload,
  layoutShareCards,
  parameterPresentation,
  wrapText,
  SHARE_CARD_WIDTH,
  SHARE_CARD_MAX_HEIGHT,
  SHARE_CARD_BODY_LIMIT,
  PARAMETER_ORDER
} from './shareCardModel'

/**
 * 阶段 5 · B1：分享图布局模型的几何/呈现规则单测。
 *
 * 这些常量与公式是从 `NikkiSync/apps/wechat-mini-program/miniprogram/lib/share-card.js`
 * 的 `:2`（尺寸）、`:5`（顺序）、`:15-39`（断行/分页）、`:40-51`（单位与滑轨位置）逐字移植来的，
 * 改动任一条都会让 B3 的「参考实现 vs 本实现」对拍失败，所以这里必须锁死。
 *
 * 假 ctx 的 measureText 用「每字符 20px」的定宽模型：两条实现喂同一个 ctx，
 * 断行结果只取决于代码，不取决于真实字体度量。
 */

function fakeCtx(): { measureText: (text: string) => { width: number } } {
  return { measureText: (text: string) => ({ width: Array.from(text).length * 20 }) }
}

const row = (key: string, value: unknown) => ({ key, value })

describe('常量', () => {
  it('三个尺寸常量与上游逐字一致', () => {
    expect(SHARE_CARD_WIDTH).toBe(1440)
    expect(SHARE_CARD_MAX_HEIGHT).toBe(4096)
    expect(SHARE_CARD_BODY_LIMIT).toBe(3690)
  })

  it('PARAMETER_ORDER 是 12 项且顺序为 焦距/光圈/晕影/柔光/柔光范围/亮度/曝光/对比度/饱和度/自然饱和/高光/阴影 的规范键', () => {
    expect(PARAMETER_ORDER).toEqual([
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
      'shadows'
    ])
  })
})

describe('parameterPresentation 单位与滑轨', () => {
  it('焦距加 mm、光圈加 f/ 前缀，两者都不落滑轨位', () => {
    expect(parameterPresentation('focalLength', '50')).toMatchObject({
      displayValue: '50mm',
      ratio: null,
      missing: false,
      height: 86
    })
    expect(parameterPresentation('aperture', '2.8').displayValue).toBe('f/2.8')
  })

  it('百分比族（亮度/对比度/柔光/晕影）带 %，0..100 内落滑轨', () => {
    expect(parameterPresentation('brightness', '40')).toMatchObject({
      displayValue: '40%',
      ratio: 0.4
    })
    // 越界不猜位置（对齐上游「never infer missing numeric values」）
    expect(parameterPresentation('brightness', '140')).toMatchObject({
      displayValue: '140%',
      ratio: null
    })
  })

  it('有符号族（曝光/饱和度/自然饱和/高光/阴影）用 (n+1)/2 归一，-1..1 之外不落滑轨', () => {
    expect(parameterPresentation('exposure', '0').ratio).toBe(0.5)
    expect(parameterPresentation('shadows', '-1').ratio).toBe(0)
    expect(parameterPresentation('highlights', '2').ratio).toBeNull()
    expect(parameterPresentation('exposure', '0').displayValue).toBe('0')
  })

  it('空值呈现为破折号并标记 missing', () => {
    expect(parameterPresentation('contrast', '')).toMatchObject({
      displayValue: '—',
      ratio: null,
      missing: true
    })
  })
})

describe('buildShareCardPayload', () => {
  it('别名归一：柔光强度并入柔光、鲜艳度并入自然饱和，不产生重复行', () => {
    const payload = buildShareCardPayload({
      date: '2026-10-01',
      rows: [row('gameVersion', '1.3'), row('bloomStrength', '20'), row('vibrance', '0.5')],
      outfits: []
    })
    expect(payload.version).toBe('1.3')
    expect(payload.camera.map((item) => item.key)).toEqual(['bloom', 'naturalSaturation'])
  })

  it('丢弃 CAMERA 之外的行与非空值以外的行', () => {
    const payload = buildShareCardPayload({
      date: '2026-10-01',
      rows: [row('location', '湖畔'), row('focalLength', ''), row('notAField', 'x')],
      outfits: []
    })
    expect(payload.camera).toEqual([])
    expect(payload.effects.map((item) => item.key)).toEqual(['location'])
  })

  it('穿搭名解析失败时留空，不伪造名称', () => {
    const payload = buildShareCardPayload({
      date: '',
      rows: [],
      outfits: [
        { name: '外套', key: 'k1', iconSource: 'item' },
        { name: '   ', key: 'k2', iconSource: 'item' }
      ]
    })
    expect(payload.outfit.map((item) => item.value)).toEqual(['外套', ''])
    expect(payload.outfit[0].label).toBe('')
  })
})

describe('wrapText', () => {
  it('按定宽模型逐字符断行：174px 宽每行 8 个字符', () => {
    const ctx = fakeCtx()
    expect(wrapText(ctx, 'abcdefghijklm', 174)).toEqual(['abcdefgh', 'ijklm'])
  })

  it('空串返回一个空行（上游 layoutCards 依赖这个长度不为 0 的返回值）', () => {
    expect(wrapText(fakeCtx(), '', 174)).toEqual([''])
  })
})

describe('layoutShareCards', () => {
  const payloadOf = (cameraKeys: string[], outfitCount: number, effectKeys: string[] = []) => ({
    date: '2026-10-01',
    version: '1.3',
    outfit: Array.from({ length: outfitCount }, (_, i) => ({
      label: '',
      value: `item${i}`,
      iconPath: '',
      iconSource: 'item' as const,
      key: `k${i}`
    })),
    camera: cameraKeys.map((key) => ({ key, value: '10' })),
    effects: effectKeys.map((key) => ({ key, value: 'v' }))
  })

  it('12 个规范参数一律成行，输入里没有的显示破折号且 missing', () => {
    const pages = layoutShareCards(fakeCtx() as never, payloadOf(['focalLength'], 0))
    const parameters = pages[0].parameters.filter((p) => !p.effect)
    expect(parameters).toHaveLength(PARAMETER_ORDER.length)
    expect(parameters[0]).toMatchObject({ key: 'focalLength', displayValue: '10mm' })
    const missing = parameters.find((p) => p.key === 'shadows')
    expect(missing).toMatchObject({ displayValue: '—', missing: true })
  })

  it('页高公式 = max(1740, ceil(400 + max(bodyHeight, parameterHeight)))，无穿搭时仍是 1740', () => {
    const pages = layoutShareCards(fakeCtx() as never, payloadOf([], 0))
    expect(pages).toHaveLength(1)
    expect(pages[0].height).toBe(1740)
  })

  it('穿搭超过 BODY_LIMIT 时按两列一行切页，下一页游标与行号归零', () => {
    // 定宽模型下 'itemN'(5-6 字符) 占 1 行 ⇒ 行高 198+29=227；
    // 3690/227 = 16 行装得下、第 17 行越界 ⇒ 首页 32 条，余 8 条进第二页
    const pages = layoutShareCards(fakeCtx() as never, payloadOf([], 40))
    expect(pages.map((page) => page.outfit.length)).toEqual([32, 8])
    expect(pages[0].outfit[31]).toMatchObject({ column: 1, row: 15 })
    expect(pages[1].outfit[0]).toMatchObject({ column: 0, row: 0, y: 0 })
  })

  it('effect 行高 = max(104, 28 + 行数 × 34)', () => {
    const pages = layoutShareCards(fakeCtx() as never, payloadOf([], 0, ['filter']))
    const effect = pages[0].parameters.find((p) => p.effect)
    expect(effect?.lines).toHaveLength(1)
    expect(effect?.height).toBe(104)
  })

  it('内容高度超过 MAX_HEIGHT 时抛 InternalError（不是裸 Error）', () => {
    // 首行不受切页约束（items 为空时不 finish）⇒ 一条超长名称即可顶爆页高上限
    const longName = 'x'.repeat(2000)
    const payload = {
      date: '',
      version: '',
      outfit: [
        { label: '', value: longName, iconPath: '', iconSource: 'item' as const, key: 'k0' }
      ],
      camera: [],
      effects: []
    }
    expect(() => layoutShareCards(fakeCtx() as never, payload)).toThrow(InternalError)
  })
})

describe('layoutShareCards 测量字体', () => {
  it('测量前必须把 ctx.font 设为 23px（穿搭名）与 28px（效果值），与 render 绘制字号一致', () => {
    // 字体敏感假件：字符宽度 = 当前 font 的字号；漏设 font 时按默认 10px 测量
    const seen: string[] = []
    const ctx = {
      font: '',
      measureText: (text: string) => {
        seen.push(ctx.font)
        const size = Number.parseFloat(ctx.font) || 10
        return { width: Array.from(text).length * size }
      }
    }
    const payload = buildShareCardPayload({
      date: '',
      rows: [],
      outfits: [
        { name: '一二三四五六七八九十一二三四五六七八九十', key: 'k0', iconSource: 'item' },
        { name: '短名', key: 'k1', iconSource: 'item' }
      ]
    })
    const pages = layoutShareCards(ctx as never, payload)
    // 20 字 × 23px：174px 瓦片宽下每行 7 字 ⇒ 3 行；漏设 font（10px）只有 2 行
    expect(pages[0].outfit[0]?.lines).toHaveLength(3)
    expect(seen[0]).toBe('23px sans-serif')
    const effectPayload = buildShareCardPayload({
      date: '',
      rows: [{ key: 'action', value: 'x'.repeat(40) }],
      outfits: []
    })
    const effectPages = layoutShareCards(ctx as never, effectPayload)
    const effect = effectPages[0].parameters.find((p) => p.effect)
    // 40 字 × 28px：540px 宽下每行 19 字 ⇒ 3 行；漏设 font（10px）只有 1 行
    expect(effect?.lines).toHaveLength(3)
  })
})
