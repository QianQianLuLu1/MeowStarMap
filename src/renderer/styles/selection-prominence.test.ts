/**
 * @layer L3
 * @module src/renderer/styles/globals.css
 * @coverage 图库卡片选中态显著度与层叠遮挡（selection-prominence-and-occlusion）
 * @dependencies fs（纯源码结构断言，node 环境即可）
 * @remarks
 *   本轮不重做选中态描边（那部分已由 fix-image-selection-border-visibility 落地并被
 *   media-card-selection.test.ts 锁死），只修它确实遗留的两条缺陷：
 *
 *   D1 遮挡（主因）：`.media-card*` 全部规则无任何 z-index，而 `.media-card:hover` 带
 *      `transform: scale(1.02)` 会新建层叠上下文，使「悬停中的邻居卡片」绘制在
 *      「已选中但静止的卡片」之上，把选中外环与描边整条盖掉——多选时鼠标划过相邻图片，
 *      选中态时有时无。
 *   D2 不显眼：选中态唯一的外向信号是 `0 0 0 3px var(--accent-soft)`，而 --accent-soft
 *      默认仅 12% alpha（柔粉主题 14%），3px 光环在深底上近乎不可见。
 *
 *   修复策略：新增由 --accent 派生的 --selection-halo 令牌（同 --focus-ring 手法，
 *   主题切换自动跟随），选中态叠加「贴边 2px 实色环 → 5px 光晕带 → 柔光 → 浮起阴影」
 *   四层重量，并用 z-index 建立 未选中(0) < 悬停(1) < 选中(2) < 选中且悬停/焦点(3) 层序。
 *   保留 ::after 的双线内衬语义，只加外缘重量，churn 最小。
 *
 *   测试策略：CSS 为静态资源且 jsdom 不应用样式表，故沿用仓库既有 layer-budget.test.ts
 *   与 media-card-selection.test.ts 的源码结构断言范式（readStripped + ruleBlockOf），
 *   两个 helper 逐字复制而不抽公共模块——守护测试文件不宜被动。
 *   文末「安全网」用例今天即通过，非红灯，用于证明本次没有为了好看踩破
 *   虚拟列表性能红线（禁 transform 缩放、禁常驻 will-change）。
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const readStripped = (...segments: string[]): string => {
  const raw = fs.readFileSync(path.resolve(process.cwd(), ...segments), 'utf-8')
  // 剥离块注释：修复说明注释中会引用缺陷写法本身，不剥离会造成误命中
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

describe('图库选中态显著度与遮挡修复（selection-prominence-and-occlusion）', () => {
  describe('D2 显著度：选中态外缘重量', () => {
    it('核心：:root 定义由 --accent 派生的 --selection-halo 令牌', () => {
      expect(globalsCss).toContain(
        '--selection-halo: color-mix(in srgb, var(--accent) 38%, transparent);'
      )
    })

    it('核心：选中卡带贴边 2px 实色 accent 外环（不依赖 alpha 猜测的最高对比信号）', () => {
      const block = ruleBlockOf(globalsCss, '.media-card.is-selected')
      expect(block, 'globals.css 中未找到 .media-card.is-selected 规则块').not.toBe('')
      expect(block).toContain('0 0 0 2px var(--accent,')
    })

    it('核心：光晕带改走 --selection-halo，且保留 --accent-soft 兜底', () => {
      const block = ruleBlockOf(globalsCss, '.media-card.is-selected')
      expect(block).toContain('var(--selection-halo, var(--accent-soft, transparent))')
    })

    it('正常：柔光层保留 --accent-soft 与浮起阴影，四层由内而外叠加', () => {
      const block = ruleBlockOf(globalsCss, '.media-card.is-selected')
      expect(block).toContain('0 0 14px 5px var(--accent-soft,')
      expect(block).toContain('var(--shadow-lg,')
    })

    it('边界：光晕 spread 为 5px，小于网格间距 16px，相邻选中卡光环不粘连', () => {
      const block = ruleBlockOf(globalsCss, '.media-card.is-selected')
      expect(block).toContain('0 0 0 5px var(--selection-halo,')
      expect(block).not.toContain('0 0 0 6px')
      expect(block).not.toContain('0 0 0 8px')
    })
  })

  describe('D1 遮挡：选中态层序抬升', () => {
    it('遮挡：悬停卡抬到 z-index 1（自身浮于静止兄弟之上）', () => {
      const block = ruleBlockOf(globalsCss, '.media-card:hover')
      expect(block, 'globals.css 中未找到 .media-card:hover 规则块').not.toBe('')
      expect(block).toContain('z-index: 1')
    })

    it('遮挡：选中卡抬到 z-index 2，高于任何悬停邻居', () => {
      const block = ruleBlockOf(globalsCss, '.media-card.is-selected')
      expect(block).toContain('z-index: 2')
    })

    it('遮挡：选中且悬停抬到 z-index 3，避免被后续 DOM 兄弟中的悬停卡追平', () => {
      const block = ruleBlockOf(globalsCss, '.media-card.is-selected:hover')
      expect(block, '未找到 .media-card.is-selected:hover 规则块').not.toBe('')
      expect(block).toContain('z-index: 3')
    })

    it('遮挡：键盘焦点卡同样抬到 z-index 3，焦点描边不被邻居盖住', () => {
      const block = ruleBlockOf(globalsCss, '.media-card:focus-visible')
      expect(block, '未找到 .media-card:focus-visible 规则块').not.toBe('')
      expect(block).toContain('z-index: 3')
    })

    it('边界：层序严格递增，且卡片基态不带正 z-index', () => {
      const base = ruleBlockOf(globalsCss, '.media-card')
      expect(base).not.toContain('z-index:')
      const hover = ruleBlockOf(globalsCss, '.media-card:hover')
      const selected = ruleBlockOf(globalsCss, '.media-card.is-selected')
      const both = ruleBlockOf(globalsCss, '.media-card.is-selected:hover')
      const order = [hover, selected, both].map((b) => Number(/z-index: (\d)/.exec(b)?.[1] ?? 0))
      expect(order).toEqual([1, 2, 3])
    })
  })

  describe('键盘焦点基线：CSS 注释提前闭合 bug', () => {
    it('核心：全局 :focus-visible 基线未被提前闭合的注释吞掉', () => {
      // 注释正文里出现注释收尾符号会让注释块提前闭合，其后半截变成非法选择器垃圾串，
      // 导致紧随的规则被 CSS 解析器整条丢弃。剥离块注释后仍残留收尾符号即为该缺陷。
      // 注意：单靠 toContain 选择器文本今天是假绿灯（垃圾串尾部恰好带该文本），
      // 真正的红灯是本条残留符号断言。
      expect(globalsCss.includes('*/'), 'globals.css 存在提前闭合的注释').toBe(false)
      expect(globalsCss).toContain(':focus-visible {')
    })

    it('正常：键盘焦点基线带 accent 描边与 2px 偏移', () => {
      const block = ruleBlockOf(globalsCss, ':focus-visible')
      expect(block, '未找到 :focus-visible 规则块').not.toBe('')
      expect(block).toContain('outline: 2px solid var(--accent)')
      expect(block).toContain('outline-offset: 2px')
    })
  })

  describe('主题层叠：柔粉主题不得吞掉选中外环', () => {
    // 实测缺陷（浏览器 computed box-shadow 复现）：柔粉主题的卡片宿主阴影规则与
    // `.media-card.is-selected` 特异性相同（均 0,2,0），靠源序决胜；而
    // `.storybook/preview.ts` 为了让主题变量能覆盖 :root，刻意在 globals.css 之后再引入
    // 主题 CSS，源序反转后主题规则整条盖掉选中外环（computed box-shadow 只剩一层粉色柔光）。
    // 更糟的是 `.soft-pink-luxury .media-card:hover` 为 (0,3,0)，无论源序都压过 (0,2,0)
    // 的选中态——即生产环境里「悬停一张已选中的卡片」同样会让外环消失。
    // 解法：把主题对宿主阴影的声明限定为「非选中」，让选中态归 globals 所有，
    // 与源序解耦（不用 !important，也不玩特异性军备竞赛）。
    it('核心：柔粉主题宿主基础阴影规则排除选中态', () => {
      expect(softPinkCss).toContain('.soft-pink-luxury .media-card:not(.is-selected) {')
    })

    it('核心：柔粉主题宿主悬停阴影规则排除选中态', () => {
      expect(softPinkCss).toContain('.soft-pink-luxury .media-card:hover:not(.is-selected) {')
    })

    it('边界：主题仍保留选中态描边覆盖（pink 语言不丢失）', () => {
      const block = ruleBlockOf(softPinkCss, '.soft-pink-luxury .media-card.is-selected::after')
      expect(block, '未找到柔粉主题选中态 ::after 覆盖').not.toBe('')
      expect(block).toContain('border-color')
    })
  })

  describe('安全网：不得为显著度踩破性能与动效红线（今天即通过）', () => {
    const SELECTORS = [
      '.media-card::after',
      '.media-card.is-selected',
      '.media-card.is-selected::after',
      '.media-card.is-selected:hover',
      '.media-card.is-selected:hover::after',
      '.media-card:focus-visible'
    ]

    it('边界：选中态相关规则一律不得声明 transform（避免与 hover scale 打架造成网格抖动）', () => {
      for (const selector of SELECTORS) {
        const block = ruleBlockOf(globalsCss, selector)
        expect(block.includes('transform:'), `${selector} 不得声明 transform`).toBe(false)
      }
    })

    it('边界：选中态相关规则一律不得常驻 will-change（图层预算 G4：同屏上百卡片）', () => {
      for (const selector of SELECTORS) {
        const block = ruleBlockOf(globalsCss, selector)
        expect(block.includes('will-change'), `${selector} 禁止常驻 will-change`).toBe(false)
      }
    })
  })
})
