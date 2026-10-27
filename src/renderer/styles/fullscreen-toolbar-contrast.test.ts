/**
 * @layer L3
 * @module src/renderer/styles/globals.css
 * @coverage 全屏预览顶部工具栏标识对比度（fullscreen-toolbar-contrast）
 * @dependencies fs（纯源码结构断言，node 环境即可）
 * @remarks
 *   缺陷：全屏查看器顶部工具栏的图标按钮写 `icon-btn text-[var(--text-on-overlay)]`，
 *   但 `.icon-btn` 是**裸 CSS**，源序在 `@tailwind utilities`（globals.css 第 4~6 行）之后，
 *   两者同为 (0,1,0) → 后源序的 `.icon-btn` 胜出，图标实际是 `--text-secondary`(#666666)；
 *   hover 再被 `.icon-btn:hover` 改成 `--text-primary`(#1a1a1a)，压在黑色遮罩与暗色照片上
 *   几乎不可见。
 *
 *   修复：新增 `.icon-btn.icon-btn-on-overlay` 叠加态变体（特异性抬到 (0,2,0)，显式覆盖
 *   hover / focus-visible / disabled 三态），配一组「压在照片上」的遮罩控件令牌。
 *   另在柔粉主题的 hover 规则加 `:not(.icon-btn-on-overlay)` 守卫，与源序解耦
 *   （两者同为 (0,3,0)，而 .storybook/preview.ts 刻意反转源序）。
 *
 *   测试策略：CSS 为静态资源且 jsdom 不应用样式表，故沿用仓库既有
 *   layer-budget.test.ts / selection-prominence.test.ts 的源码结构断言范式
 *   （readStripped + ruleBlockOf），两个 helper 逐字复制而不抽公共模块——守护测试文件不宜被动。
 *   N9~N12 为「今天即通过」的安全网，用于锁死「不影响其它页面」与「不用 !important」。
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

const VARIANT = '.icon-btn.icon-btn-on-overlay'

describe('全屏工具栏遮罩控件令牌（fullscreen-toolbar-contrast）', () => {
  it('核心：:root 定义 60% 黑胶囊底（纯白照片上白图标仍有 5.74:1 的来源）', () => {
    expect(globalsCss).toContain('--overlay-control-bg: rgba(0, 0, 0, 0.6);')
  })

  it('核心：前景复用既有 --text-on-overlay，不新增第二个白色', () => {
    expect(globalsCss).toContain('--overlay-control-fg: var(--text-on-overlay);')
  })

  it('核心：hover / active 两档底与描边令牌齐备（三态可区分）', () => {
    expect(globalsCss).toContain('--overlay-control-bg-hover: rgba(0, 0, 0, 0.72);')
    expect(globalsCss).toContain('--overlay-control-bg-active: rgba(0, 0, 0, 0.78);')
    expect(globalsCss).toContain('--overlay-control-border: rgba(255, 255, 255, 0.28);')
    expect(globalsCss).toContain('--overlay-control-border-hover: rgba(255, 255, 255, 0.45);')
    expect(globalsCss).toContain('--overlay-control-border-active: rgba(255, 255, 255, 0.65);')
  })
})

describe('遮罩变体规则 .icon-btn.icon-btn-on-overlay', () => {
  it('核心：变体基规则声明前景 / 胶囊底 / 描边三项', () => {
    const block = ruleBlockOf(globalsCss, VARIANT)
    expect(block, `globals.css 中未找到 ${VARIANT} 规则块`).not.toBe('')
    expect(block).toContain('color: var(--overlay-control-fg);')
    expect(block).toContain('background: var(--overlay-control-bg);')
    expect(block).toContain('border: 1px solid var(--overlay-control-border);')
  })

  it('核心（源序闸门）：变体必须晚于 .icon-btn:hover，否则同特异性被反压（亦防误入 @layer）', () => {
    // 同特异性 (0,2,0) 下靠源序决胜；若被误放进更早的 @layer components 块也会在此暴露
    expect(globalsCss.indexOf(`${VARIANT} {`)).toBeGreaterThan(
      globalsCss.indexOf('.icon-btn:hover {')
    )
  })

  it('核心：hover 态不得回落到 .icon-btn:hover 的近黑 --text-primary', () => {
    const block = ruleBlockOf(globalsCss, `${VARIANT}:hover`)
    expect(block, `未找到 ${VARIANT}:hover 规则块`).not.toBe('')
    expect(block).toContain('background: var(--overlay-control-bg-hover);')
    expect(block).not.toContain('color: var(--text-primary)')
  })

  it('核心：焦点态用白环 + 内暗环双色，不沿用深底上仅 2.78:1 的 accent 蓝环', () => {
    const block = ruleBlockOf(globalsCss, `${VARIANT}:focus-visible`)
    expect(block, `未找到 ${VARIANT}:focus-visible 规则块`).not.toBe('')
    expect(block).toContain('outline: 2px solid var(--overlay-control-ring);')
    expect(block).toContain('box-shadow: var(--overlay-control-ring-shadow);')
    expect(block).not.toContain('var(--accent)')
  })

  it('核心：禁用态压过 .icon-btn:disabled 的 opacity 0.5（半透明会让胶囊在浅色照片上失效）', () => {
    const block = ruleBlockOf(globalsCss, `${VARIANT}:disabled`)
    expect(block, `未找到 ${VARIANT}:disabled 规则块`).not.toBe('')
    expect(block).toContain('color: var(--overlay-control-fg-disabled);')
    expect(block).toContain('opacity: 1;')
  })
})

describe('主题层叠：柔粉主题不得吞掉变体 hover', () => {
  it('核心：柔粉主题 hover 规则排除遮罩变体（两者同为 (0,3,0)，只能靠守卫解耦源序）', () => {
    expect(softPinkCss).toContain('.soft-pink-luxury .icon-btn:hover:not(.icon-btn-on-overlay) {')
  })

  it('核心：不得残留无守卫的旧写法', () => {
    expect(softPinkCss).not.toContain('.soft-pink-luxury .icon-btn:hover {')
  })
})

describe('安全网：不污染全局类、不越界、不玩 !important（今天即通过）', () => {
  it('边界：遮罩令牌不进主题变量块（对比度由照片而非主题决定，同步会触发漂移告警）', () => {
    expect(softPinkCss).not.toContain('--overlay-control-')
    expect(softPinkCss).not.toContain('--favorite-on-overlay')
  })

  it('边界：全局 .icon-btn 本体一字未改（其它 26 个使用方不受影响）', () => {
    const block = ruleBlockOf(globalsCss, '.icon-btn')
    expect(block, 'globals.css 中未找到 .icon-btn 规则块').not.toBe('')
    expect(block).toContain('color: var(--text-secondary);')
    expect(block).toContain('border: none;')
    expect(block).toContain('width: 36px;')
  })

  it('边界：全局 .icon-btn:hover 的缩放未被吃掉（交互不回归）', () => {
    const block = ruleBlockOf(globalsCss, '.icon-btn:hover')
    expect(block).toContain('transform: scale(1.1)')
  })

  it('边界：四个新规则块一律不得使用 !important', () => {
    for (const selector of [
      VARIANT,
      `${VARIANT}:hover`,
      `${VARIANT}:focus-visible`,
      `${VARIANT}:disabled`
    ]) {
      const block = ruleBlockOf(globalsCss, selector)
      expect(block.includes('!important'), `${selector} 禁止使用 !important`).toBe(false)
    }
  })
})
