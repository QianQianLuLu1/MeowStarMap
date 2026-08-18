/**
 * @layer L1
 * @module src/main/video-editor/watermark-builder
 * @coverage buildWatermarkFilter
 * @remarks 纯函数单测：验证文本/图片/9 宫格/平铺/旋转/透明度 等场景的 ffmpeg 滤镜串构造
 */
import { describe, it, expect } from 'vitest'
import { buildWatermarkFilter } from './watermark-builder'
import type { WatermarkConfig, WatermarkText, WatermarkImage } from '../../shared/types/watermark'

/** 构造测试用 WatermarkConfig */
function makeConfig(overrides: Partial<WatermarkConfig>): WatermarkConfig {
  return {
    position: 'bottomRight',
    customX: 0,
    customY: 0,
    rotation: 0,
    margin: 20,
    tile: false,
    tileSpacingX: 50,
    tileSpacingY: 50,
    ...overrides
  }
}

function makeText(overrides: Partial<WatermarkText>): WatermarkText {
  return {
    content: 'NikkiGallery',
    font: 'Arial',
    size: 24,
    color: '#FFFFFF',
    opacity: 1,
    bold: false,
    italic: false,
    underline: false,
    ...overrides
  }
}

function makeImage(overrides: Partial<WatermarkImage>): WatermarkImage {
  return {
    path: 'C:\\watermark.png',
    width: 200,
    height: 80,
    opacity: 0.8,
    blendMode: 'normal',
    ...overrides
  }
}

describe('watermark-builder - buildWatermarkFilter', () => {
  describe('空值与无效场景', () => {
    it('config 为 null → 返回空 filter', () => {
      const r = buildWatermarkFilter(null)
      expect(r.filter).toBe('')
      expect(r.inputs).toEqual([])
      expect(r.useFilterComplex).toBe(false)
    })

    it('config 为 undefined → 返回空 filter', () => {
      const r = buildWatermarkFilter(undefined)
      expect(r.filter).toBe('')
      expect(r.inputs).toEqual([])
    })

    it('文本和图片均不存在 → 返回空 filter', () => {
      const r = buildWatermarkFilter(makeConfig({}))
      expect(r.filter).toBe('')
      expect(r.useFilterComplex).toBe(false)
    })

    it('文本 content 为空 → 跳过文本水印', () => {
      const r = buildWatermarkFilter(makeConfig({ text: makeText({ content: '' }) }))
      expect(r.filter).toBe('')
      expect(r.useFilterComplex).toBe(false)
    })

    it('图片 path 为空 → 跳过图片水印', () => {
      const r = buildWatermarkFilter(makeConfig({ image: makeImage({ path: '' }) }))
      expect(r.filter).toBe('')
      expect(r.useFilterComplex).toBe(false)
    })
  })

  describe('文本水印 - 基本构造', () => {
    it('文本水印 → drawtext 滤镜，useFilterComplex=false', () => {
      const r = buildWatermarkFilter(
        makeConfig({ text: makeText({}), position: 'bottomRight', margin: 20 })
      )
      expect(r.useFilterComplex).toBe(false)
      expect(r.inputs).toEqual([])
      expect(r.filter).toMatch(/^drawtext=/)
      expect(r.filter).toContain("text='NikkiGallery'")
      expect(r.filter).toContain('fontsize=24')
      expect(r.filter).toContain('fontcolor=0xffffffff')
      expect(r.filter).toContain("font='Arial'")
    })

    it('font 为绝对路径 → 使用 fontfile=', () => {
      const r = buildWatermarkFilter(
        makeConfig({
          text: makeText({ font: 'C:\\Windows\\Fonts\\arial.ttf' })
        })
      )
      expect(r.filter).toContain("fontfile='C:\\Windows\\Fonts\\arial.ttf'")
      expect(r.filter).not.toContain("font='")
    })

    it('font 为 Unix 路径 → 使用 fontfile=', () => {
      const r = buildWatermarkFilter(
        makeConfig({
          text: makeText({ font: '/usr/share/fonts/arial.ttf' })
        })
      )
      expect(r.filter).toContain("fontfile='/usr/share/fonts/arial.ttf'")
    })

    it('font 为字体名称 → 使用 font=', () => {
      const r = buildWatermarkFilter(makeConfig({ text: makeText({ font: 'Microsoft YaHei' }) }))
      expect(r.filter).toContain("font='Microsoft YaHei'")
    })

    it('size 被四舍五入为整数', () => {
      const r = buildWatermarkFilter(makeConfig({ text: makeText({ size: 24.7 }) }))
      expect(r.filter).toContain('fontsize=25')
    })

    it('size 为 0 → 文本水印无效', () => {
      const r = buildWatermarkFilter(makeConfig({ text: makeText({ size: 0 }) }))
      expect(r.filter).toBe('')
    })
  })

  describe('文本水印 - 颜色与透明度', () => {
    it('颜色 #FFFFFF + opacity=1 → fontcolor=0xffffffff', () => {
      const r = buildWatermarkFilter(
        makeConfig({ text: makeText({ color: '#FFFFFF', opacity: 1 }) })
      )
      expect(r.filter).toContain('fontcolor=0xffffffff')
    })

    it('颜色 #FF0000 + opacity=0.5 → fontcolor=0xff000080', () => {
      const r = buildWatermarkFilter(
        makeConfig({ text: makeText({ color: '#FF0000', opacity: 0.5 }) })
      )
      expect(r.filter).toContain('fontcolor=0xff000080')
    })

    it('颜色简写 #FFF → 扩展为 #FFFFFF', () => {
      const r = buildWatermarkFilter(makeConfig({ text: makeText({ color: '#FFF' }) }))
      expect(r.filter).toContain('fontcolor=0xffffffff')
    })

    it('opacity 超出 1 → 截断为 1', () => {
      const r = buildWatermarkFilter(makeConfig({ text: makeText({ opacity: 1.5 }) }))
      expect(r.filter).toContain('fontcolor=0xffffffff')
    })

    it('opacity 为负 → 截断为 0', () => {
      const r = buildWatermarkFilter(makeConfig({ text: makeText({ opacity: -0.5 }) }))
      expect(r.filter).toContain('fontcolor=0xffffff00')
    })

    it('无效颜色字符串 → 回退白色', () => {
      const r = buildWatermarkFilter(makeConfig({ text: makeText({ color: 'invalid-color' }) }))
      expect(r.filter).toContain('fontcolor=0xffffffff')
    })

    it('颜色已带 alpha → 直接使用', () => {
      const r = buildWatermarkFilter(makeConfig({ text: makeText({ color: '#FF000080' }) }))
      expect(r.filter).toContain('fontcolor=0xff000080')
    })
  })

  describe('文本水印 - 9 宫格位置', () => {
    const text = makeText({})
    const margin = 20

    it('topLeft → x=margin, y=margin', () => {
      const r = buildWatermarkFilter(makeConfig({ text, position: 'topLeft', margin }))
      expect(r.filter).toContain(`x=${margin}`)
      expect(r.filter).toContain(`y=${margin}`)
    })

    it('topCenter → x=(w-text_w)/2, y=margin', () => {
      const r = buildWatermarkFilter(makeConfig({ text, position: 'topCenter', margin }))
      expect(r.filter).toContain('x=(w-text_w)/2')
      expect(r.filter).toContain(`y=${margin}`)
    })

    it('topRight → x=w-text_w-margin, y=margin', () => {
      const r = buildWatermarkFilter(makeConfig({ text, position: 'topRight', margin }))
      expect(r.filter).toContain(`x=w-text_w-${margin}`)
      expect(r.filter).toContain(`y=${margin}`)
    })

    it('centerLeft → x=margin, y=(h-text_h)/2', () => {
      const r = buildWatermarkFilter(makeConfig({ text, position: 'centerLeft', margin }))
      expect(r.filter).toContain(`x=${margin}`)
      expect(r.filter).toContain('y=(h-text_h)/2')
    })

    it('center → x=(w-text_w)/2, y=(h-text_h)/2', () => {
      const r = buildWatermarkFilter(makeConfig({ text, position: 'center', margin }))
      expect(r.filter).toContain('x=(w-text_w)/2')
      expect(r.filter).toContain('y=(h-text_h)/2')
    })

    it('centerRight → x=w-text_w-margin, y=(h-text_h)/2', () => {
      const r = buildWatermarkFilter(makeConfig({ text, position: 'centerRight', margin }))
      expect(r.filter).toContain(`x=w-text_w-${margin}`)
      expect(r.filter).toContain('y=(h-text_h)/2')
    })

    it('bottomLeft → x=margin, y=h-text_h-margin', () => {
      const r = buildWatermarkFilter(makeConfig({ text, position: 'bottomLeft', margin }))
      expect(r.filter).toContain(`x=${margin}`)
      expect(r.filter).toContain(`y=h-text_h-${margin}`)
    })

    it('bottomCenter → x=(w-text_w)/2, y=h-text_h-margin', () => {
      const r = buildWatermarkFilter(makeConfig({ text, position: 'bottomCenter', margin }))
      expect(r.filter).toContain('x=(w-text_w)/2')
      expect(r.filter).toContain(`y=h-text_h-${margin}`)
    })

    it('bottomRight → x=w-text_w-margin, y=h-text_h-margin', () => {
      const r = buildWatermarkFilter(makeConfig({ text, position: 'bottomRight', margin }))
      expect(r.filter).toContain(`x=w-text_w-${margin}`)
      expect(r.filter).toContain(`y=h-text_h-${margin}`)
    })

    it('custom → x=customX, y=customY', () => {
      const r = buildWatermarkFilter(
        makeConfig({
          text,
          position: 'custom',
          customX: 150,
          customY: 200,
          margin
        })
      )
      expect(r.filter).toContain('x=150')
      expect(r.filter).toContain('y=200')
    })
  })

  describe('文本水印 - 转义', () => {
    it('单引号转义为 close-quote + escaped quote + reopen', () => {
      const r = buildWatermarkFilter(makeConfig({ text: makeText({ content: "it's me" }) }))
      expect(r.filter).toContain("text='it'\\''s me'")
    })

    it('空字符串 content → 文本水印无效', () => {
      const r = buildWatermarkFilter(makeConfig({ text: makeText({ content: '' }) }))
      expect(r.filter).toBe('')
    })
  })

  describe('图片水印 - 基本构造', () => {
    it('图片水印 → filter_complex + inputs，useFilterComplex=true', () => {
      const r = buildWatermarkFilter(
        makeConfig({
          image: makeImage({}),
          position: 'bottomRight',
          margin: 20
        })
      )
      expect(r.useFilterComplex).toBe(true)
      expect(r.inputs).toEqual(['C:\\watermark.png'])
      expect(r.filter).toContain('[1:v]')
      expect(r.filter).toContain('scale=200:80')
      expect(r.filter).toContain('format=rgba')
      expect(r.filter).toContain('colorchannelmixer=aa=0.8000')
      expect(r.filter).toContain('[wm]')
      expect(r.filter).toContain('[0:v][wm]overlay=')
    })

    it('opacity=1 时不输出 colorchannelmixer', () => {
      const r = buildWatermarkFilter(makeConfig({ image: makeImage({ opacity: 1 }) }))
      expect(r.filter).not.toContain('colorchannelmixer')
    })

    it('opacity 超出范围 → 截断到 0-1', () => {
      const r = buildWatermarkFilter(makeConfig({ image: makeImage({ opacity: 1.5 }) }))
      expect(r.filter).not.toContain('colorchannelmixer')
    })

    it('width/height 为 0 → 跳过 scale', () => {
      const r = buildWatermarkFilter(makeConfig({ image: makeImage({ width: 0, height: 0 }) }))
      expect(r.filter).not.toContain('scale=')
    })
  })

  describe('图片水印 - 9 宫格位置', () => {
    const image = makeImage({})

    it('topLeft → overlay=margin:margin', () => {
      const r = buildWatermarkFilter(makeConfig({ image, position: 'topLeft', margin: 10 }))
      expect(r.filter).toContain('overlay=10:10')
    })

    it('topCenter → overlay=(W-w)/2:margin', () => {
      const r = buildWatermarkFilter(makeConfig({ image, position: 'topCenter', margin: 10 }))
      expect(r.filter).toContain('overlay=(W-w)/2:10')
    })

    it('topRight → overlay=W-w-margin:margin', () => {
      const r = buildWatermarkFilter(makeConfig({ image, position: 'topRight', margin: 10 }))
      expect(r.filter).toContain('overlay=W-w-10:10')
    })

    it('center → overlay=(W-w)/2:(H-h)/2', () => {
      const r = buildWatermarkFilter(makeConfig({ image, position: 'center', margin: 10 }))
      expect(r.filter).toContain('overlay=(W-w)/2:(H-h)/2')
    })

    it('bottomRight → overlay=W-w-margin:H-h-margin', () => {
      const r = buildWatermarkFilter(makeConfig({ image, position: 'bottomRight', margin: 15 }))
      expect(r.filter).toContain('overlay=W-w-15:H-h-15')
    })

    it('custom → overlay=customX:customY', () => {
      const r = buildWatermarkFilter(
        makeConfig({
          image,
          position: 'custom',
          customX: 100,
          customY: 50,
          margin: 10
        })
      )
      expect(r.filter).toContain('overlay=100:50')
    })
  })

  describe('图片水印 - 平铺模式', () => {
    it('tile=true → 输出 tile 滤镜并 overlay=0:0', () => {
      const r = buildWatermarkFilter(
        makeConfig({
          image: makeImage({ width: 100, height: 50 }),
          tile: true,
          tileSpacingX: 30,
          tileSpacingY: 20
        })
      )
      expect(r.filter).toContain('tile=130:70')
      expect(r.filter).toContain('overlay=0:0')
    })

    it('平铺 + 文本水印 → 末尾追加 drawtext', () => {
      const r = buildWatermarkFilter(
        makeConfig({
          text: makeText({}),
          image: makeImage({ width: 100, height: 50 }),
          tile: true,
          tileSpacingX: 30,
          tileSpacingY: 20
        })
      )
      expect(r.filter).toContain('overlay=0:0')
      expect(r.filter).toMatch(/overlay=0:0,drawtext=/)
    })
  })

  describe('图片水印 - 旋转', () => {
    it('rotation=45 → 输出 rotate 滤镜', () => {
      const r = buildWatermarkFilter(
        makeConfig({
          image: makeImage({}),
          rotation: 45
        })
      )
      // 45° = 0.785398 rad
      expect(r.filter).toContain('rotate=0.785398')
      expect(r.filter).toContain('fillcolor=0x00000000')
      expect(r.filter).toContain('ow=rotw(iw,ih)')
      expect(r.filter).toContain('oh=roth(iw,ih)')
    })

    it('rotation=0 → 不输出 rotate', () => {
      const r = buildWatermarkFilter(makeConfig({ image: makeImage({}), rotation: 0 }))
      expect(r.filter).not.toContain('rotate=')
    })

    it('rotation=-30 → 输出负角度', () => {
      const r = buildWatermarkFilter(makeConfig({ image: makeImage({}), rotation: -30 }))
      expect(r.filter).toContain('rotate=-0.523599')
    })
  })

  describe('文本 + 图片水印并存', () => {
    it('文本和图片同时存在 → filter_complex，drawtext 追加在 overlay 之后', () => {
      const r = buildWatermarkFilter(
        makeConfig({
          text: makeText({}),
          image: makeImage({}),
          position: 'bottomRight',
          margin: 10
        })
      )
      expect(r.useFilterComplex).toBe(true)
      expect(r.inputs).toEqual(['C:\\watermark.png'])
      expect(r.filter).toMatch(/\[0:v\]\[wm\]overlay=.*?,drawtext=/)
    })

    it('文本 content 为空 + 图片存在 → 仅图片水印', () => {
      const r = buildWatermarkFilter(
        makeConfig({
          text: makeText({ content: '' }),
          image: makeImage({})
        })
      )
      expect(r.useFilterComplex).toBe(true)
      expect(r.filter).not.toContain('drawtext=')
    })
  })
})
