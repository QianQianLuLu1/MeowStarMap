/**
 * @layer L3
 * @module src/renderer/styles/globals.css
 * @coverage 图层预算：禁止给会批量实例化的卡片类元素配置常驻 will-change（G4）
 * @dependencies fs（纯源码结构断言，node 环境即可）
 * @remarks
 *   根因 G4：`.media-card` 是图库网格/列表/瀑布流/时间线视图批量实例化的卡片容器，
 *   虚拟列表同屏可达数十至上百个。其规则体中的 `will-change: transform` 会让每个
 *   卡片无条件提升为独立合成层（图层爆炸）：
 *     - View Transitions 拍摄 root 快照时必须逐一光栅化全部层，是过渡动画起点的
 *       一次性掉帧来源；
 *     - 常驻层长期占用 GPU 显存，降低后续合成帧率。
 *   悬停仅做 `transform: scale(1.02)`，合成器会在 transform 变化期间自动提层，
 *   静态期保留 will-change 无收益。仓库内已有同手法的先例注释：
 *   `globals.css` 的毛玻璃卡片（会破坏 backdrop-filter）与 `.page-enter`
 *   （动画结束后类被 JS 移除，无需持续提示合成层）。
 *
 *   断言全部基于对 globals.css 的源码结构检查（参考 right-click-wiring.test.ts
 *   的切片范式），不做任何浏览器渲染。
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const globalsCssRaw = fs.readFileSync(
  path.resolve(process.cwd(), 'src', 'renderer', 'styles', 'globals.css'),
  'utf-8'
)
// 剥离 /* */ 注释后再做结构断言：注释是写给人看的说明文字，
// 不得参与 will-change 预算检查（否则修复说明本身会触发误报）
const globalsCss = globalsCssRaw.replace(/\/\*[\s\S]*?\*\//g, '')

/** 截取以 selector 开头、以第一个匹配的花括号块结尾的单条规则体 */
function ruleBlockOf(selector: string): string {
  const start = globalsCss.indexOf(`${selector} {`)
  if (start < 0) return ''
  const bodyStart = globalsCss.indexOf('{', start)
  const bodyEnd = globalsCss.indexOf('}', bodyStart)
  if (bodyStart < 0 || bodyEnd < 0) return ''
  return globalsCss.slice(start, bodyEnd + 1)
}

describe('图层预算（G4：消除图库卡片常驻合成层）', () => {
  it('核心：.media-card 规则体不得包含 will-change（防止同屏上百卡片图层爆炸）', () => {
    const block = ruleBlockOf('.media-card')
    expect(block, 'globals.css 中未找到 .media-card 规则块').not.toBe('')
    expect(block.includes('will-change'), '卡片类元素禁止常驻 will-change').toBe(false)
  })

  it('正常：悬停放大效果保留（不得因清理 will-change 误删 transform）', () => {
    const hoverBlock = ruleBlockOf('.media-card:hover')
    expect(hoverBlock, '未找到 .media-card:hover 规则块').not.toBe('')
    expect(hoverBlock).toContain('transform: scale(')
  })

  it('边界：全文 will-change 声明不得携带不可合成的 background-color 值', () => {
    const declarations = globalsCss.match(/will-change:[^;]+;/g) ?? []
    const offenders = declarations.filter((d) => d.includes('background-color'))
    expect(offenders, 'background-color 不参与合成，写入 will-change 只会白占层').toEqual([])
  })
})
