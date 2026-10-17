/**
 * @layer L3
 * @module src/renderer/styles/globals.css
 * @coverage 图库卡片选中态视觉（fix-image-selection-border-visibility）
 * @dependencies fs（纯源码结构断言，node 环境即可）、tailwind.config.ts（ring 令牌断言）
 * @remarks
 *   缺陷现象：图库网格 / 时间线 / 事件时间线 / 瀑布流四个视图在多选场景下，选中态
 *   卡片边框不显眼、缺乏视觉层次、辨识度低。
 *
 *   根因（四条，逐条对应下方断言）：
 *   R1 ring-offset 偏移色不跟主题：四视图用 `ring-2 ring-offset-2` 拼装选中态，只设了
 *      `--tw-ring-color` 未设 `--tw-ring-offset-color`，Tailwind 默认偏移色恒为 #fff，
 *      在柔粉/深底卡片上露白圈，2px 描边被推离卡片，视觉断裂。
 *   R2 两套描边机制打架：选中态用 ring（宿主 box-shadow）画，hover 态用
 *      `.media-card:hover::after` 的 border 画（伪元素），叠加时层次互相吞没。
 *   R3 globals.css 无选中态规则：选中样式散落在组件内联，无法被主题覆盖。
 *   R4 tailwind.config.ts 的 theme.extend 无 ringColor / ringOffsetColor，裸用 ring-2
 *      恒为默认蓝 #3b82f6，不跟随主题。
 *
 *   修复策略：把 hover 与 selected 统一到同一条「常驻 ::after 描边层」，只过渡颜色
 *   （border-color / box-shadow），杜绝 content 从无到有造成的闪现与布局抖动。
 *
 *   测试策略：CSS 为纯静态资源，jsdom 不做样式计算，故沿用仓库既有 layer-budget.test.ts
 *   的源码结构断言范式（fs.readFileSync + 剥离 /* *\/ 注释后匹配规则体）。
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import tailwindConfig from '../../../tailwind.config'

const readStripped = (...segments: string[]): string => {
  const raw = fs.readFileSync(path.resolve(process.cwd(), ...segments), 'utf-8')
  // 剥离 /* */ 注释：修复说明注释中会引用缺陷写法本身，不剥离会造成误命中
  return raw.replace(/\/\*[\s\S]*?\*\//g, '')
}

const globalsCss = readStripped('src', 'renderer', 'styles', 'globals.css')
const softPinkCss = readStripped('src', 'renderer', 'styles', 'themes', 'soft-pink-luxury.css')

/** 截取以 selector 开头、以第一个匹配的花括号块结尾的单条规则体 */
function ruleBlockOf(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) return ''
  const bodyStart = css.indexOf('{', start)
  const bodyEnd = css.indexOf('}', bodyStart)
  if (bodyStart < 0 || bodyEnd < 0) return ''
  return css.slice(start, bodyEnd + 1)
}

describe('图库卡片选中态样式（fix-image-selection-border-visibility）', () => {
  describe('常驻描边层（R2：hover 与 selected 统一到同一伪元素，杜绝闪现）', () => {
    it('核心：.media-card::after 常驻且默认透明描边（选中/取消只切颜色，不再 content 从无到有）', () => {
      const block = ruleBlockOf(globalsCss, '.media-card::after')
      expect(block, 'globals.css 中未找到 .media-card::after 规则块').not.toBe('')
      expect(block).toContain('border: 2px solid transparent')
    })

    it('正常：常驻描边层带颜色过渡（选中/取消平滑，且被 reduce-motion 通配覆盖）', () => {
      const block = ruleBlockOf(globalsCss, '.media-card::after')
      expect(block).toContain('transition:')
      expect(block).toContain('border-color')
    })
  })

  describe('选中态规则（R3：语义类 .media-card.is-selected）', () => {
    it('核心：选中态宿主带主题色外发光（--accent-soft，让卡片从网格背景浮起）', () => {
      const block = ruleBlockOf(globalsCss, '.media-card.is-selected')
      expect(block, 'globals.css 中未找到 .media-card.is-selected 规则块').not.toBe('')
      expect(block).toContain('var(--accent-soft')
    })

    it('核心：选中态描边为主题色（border-color: var(--accent)）', () => {
      const block = ruleBlockOf(globalsCss, '.media-card.is-selected::after')
      expect(block, '未找到 .media-card.is-selected::after 规则块').not.toBe('')
      expect(block).toContain('border-color: var(--accent)')
    })

    it('核心：选中态带背景色内衬（双线框，任意底色都有稳定对比度）', () => {
      const block = ruleBlockOf(globalsCss, '.media-card.is-selected::after')
      expect(block).toContain('inset 0 0 0 2px var(--bg-primary')
    })

    it('边界：选中卡悬停时描边加深一档，保留「选中 ≠ 悬停」的层次区分', () => {
      const block = ruleBlockOf(globalsCss, '.media-card.is-selected:hover::after')
      expect(block, '未找到 .media-card.is-selected:hover::after 规则块').not.toBe('')
      expect(block).toContain('var(--accent-deep')
    })

    it('边界：选中态不得引入 transform 缩放（避免与 hover scale 打架、网格抖动与相邻卡片重叠）', () => {
      for (const selector of [
        '.media-card.is-selected',
        '.media-card.is-selected::after',
        '.media-card.is-selected:hover::after'
      ]) {
        const block = ruleBlockOf(globalsCss, selector)
        expect(block, `未找到 ${selector} 规则块`).not.toBe('')
        expect(block.includes('transform:'), `${selector} 不得声明 transform`).toBe(false)
      }
    })

    it('边界：新增选中态规则不得引入 will-change（图层预算 G4：同屏上百卡片）', () => {
      for (const selector of [
        '.media-card::after',
        '.media-card.is-selected',
        '.media-card.is-selected::after',
        '.media-card.is-selected:hover::after'
      ]) {
        const block = ruleBlockOf(globalsCss, selector)
        expect(block, `未找到 ${selector} 规则块`).not.toBe('')
        expect(block.includes('will-change'), `${selector} 禁止常驻 will-change`).toBe(false)
      }
    })
  })

  describe('异常：主题变量缺失降级（var() 兜底值）', () => {
    it('选中态引用的全部主题变量均带 fallback，变量缺失时降级而非整条声明失效', () => {
      const block = ruleBlockOf(globalsCss, '.media-card.is-selected')
      expect(block).toContain('var(--accent-soft,')
      expect(block).toContain('var(--shadow-lg,')
    })

    it('内衬 / hover 叠加态的变量同样带 fallback', () => {
      expect(ruleBlockOf(globalsCss, '.media-card.is-selected::after')).toContain(
        'var(--bg-primary,'
      )
      expect(ruleBlockOf(globalsCss, '.media-card.is-selected:hover::after')).toContain(
        'var(--accent-deep,'
      )
    })
  })

  describe('异常：主题切换（soft-pink-luxury 覆盖）', () => {
    it('柔粉主题提供选中态描边覆盖，沿用该主题既有粉色语言', () => {
      const block = ruleBlockOf(softPinkCss, '.soft-pink-luxury .media-card.is-selected::after')
      expect(block, 'soft-pink-luxury.css 未找到选中态::after 覆盖').not.toBe('')
      expect(block).toContain('border-color')
    })
  })

  describe('Tailwind ring 令牌（R4：裸用 ring-2 不再恒为默认蓝）', () => {
    // tailwind.config.ts 默认导出为 Config，theme.extend 为可选字段，按需窄化取值
    const extend = tailwindConfig.theme?.extend as
      Record<string, Record<string, string> | undefined> | undefined

    it('核心：ringColor.DEFAULT 指向主题色变量（ring-2 跟随 --accent）', () => {
      expect(extend?.ringColor?.DEFAULT, 'theme.extend.ringColor 未定义').toBe('var(--accent)')
    })

    it('核心：ringOffsetColor.DEFAULT 指向背景变量（消除 ring-offset 恒为 #fff 的露白圈）', () => {
      expect(extend?.ringOffsetColor?.DEFAULT, 'theme.extend.ringOffsetColor 未定义').toBe(
        'var(--bg-primary)'
      )
    })

    it('正常：ringColor 提供 accent / accent-soft 具名变体，供语义化类名引用', () => {
      expect(extend?.ringColor?.accent).toBe('var(--accent)')
      expect(extend?.ringColor?.['accent-soft']).toBe('var(--accent-soft)')
    })
  })
})
