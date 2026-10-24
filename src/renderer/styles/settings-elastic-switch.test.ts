/**
 * @layer L3
 * @module src/renderer/styles/globals.css
 * @coverage 果冻开关：滑块 350ms 过冲弹簧滑动、途中横向拉长成胶囊、终点回弹恢复圆形
 * @dependencies fs（纯源码结构断言，node 环境即可）
 * @remarks
 *   复刻 layer-budget.test.ts 的「剥注释 + 规则块断言」切片范式，不做浏览器渲染。
 *   动画规格由此处钉死：
 *     - 位移（left）走 transition：中途反向点击时可从当前位置平滑重定向；
 *     - 途中拉伸（transform: scaleX）走 keyframes：与 left 分离到两个属性，
 *       避免 transition 与 animation 在同一属性上级联竞争（transition 优先级
 *       更高，会压制 keyframes——旧 :active 按压拉伸正因此必须移除）；
 *     - 开/关双向各挂一个动画名：aria-checked 翻转即 animation-name 变化，
 *       动画必然重触发（同名不会重启）。
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const globalsCssRaw = fs.readFileSync(
  path.resolve(process.cwd(), 'src', 'renderer', 'styles', 'globals.css'),
  'utf-8'
)
// 剥离 /* */ 注释后再做结构断言：说明文字不得参与规则检查
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

/** 截取 @keyframes <name> 的完整帧体（帧体含嵌套花括号，需按深度配平） */
function keyframesBlockOf(name: string): string {
  const start = globalsCss.indexOf(`@keyframes ${name} {`)
  if (start < 0) return ''
  let depth = 0
  let i = globalsCss.indexOf('{', start)
  for (; i < globalsCss.length; i++) {
    if (globalsCss[i] === '{') depth++
    else if (globalsCss[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }
  if (i >= globalsCss.length) return ''
  return globalsCss.slice(start, i + 1)
}

/** 压平空白后匹配声明（容忍 transition 多行书写格式） */
const flattened = (block: string): string => block.replace(/\s+/g, ' ')

describe('果冻开关：滑块 350ms 弹簧滑动 + 途中胶囊拉伸 + 终点回弹', () => {
  it('正常：滑块位移走 left 过渡，350ms + --ease-spring 过冲弹簧曲线', () => {
    const block = flattened(ruleBlockOf('.settings-elastic-switch-knob'))
    expect(block, 'globals.css 中未找到 .settings-elastic-switch-knob 规则块').not.toBe('')
    expect(block).toContain('transition: left 350ms var(--ease-spring)')
  })

  it('正常：开/关两方向各挂独立名 keyframes（aria-checked 翻转必重触发）', () => {
    const baseBlock = flattened(ruleBlockOf('.settings-elastic-switch-knob'))
    expect(baseBlock).toContain(
      'animation: settings-elastic-switch-jelly-off 350ms var(--ease-spring)'
    )
    const checkedBlock = flattened(
      ruleBlockOf(".settings-elastic-switch[aria-checked='true'] .settings-elastic-switch-knob")
    )
    expect(checkedBlock, "未找到 [aria-checked='true'] 滑块规则块").not.toBe('')
    expect(checkedBlock).toContain('animation-name: settings-elastic-switch-jelly-on')
  })

  it('正常：两个 keyframes 均含途中 scaleX(>1) 胶囊帧与首尾 scaleX(1) 圆形帧', () => {
    for (const name of ['settings-elastic-switch-jelly-on', 'settings-elastic-switch-jelly-off']) {
      const block = keyframesBlockOf(name)
      expect(block, `未找到 @keyframes ${name}`).not.toBe('')
      const scales = [...block.matchAll(/scaleX\(([\d.]+)\)/g)].map((m) => Number(m[1]))
      expect(scales.length, `${name} 帧数不足`).toBeGreaterThanOrEqual(3)
      expect(scales[0], `${name} 首帧必须为圆形 scaleX(1)`).toBe(1)
      expect(scales[scales.length - 1], `${name} 末帧必须回弹恢复圆形 scaleX(1)`).toBe(1)
      const peak = Math.max(...scales)
      expect(peak, `${name} 途中必须有 scaleX(>1) 胶囊拉伸帧`).toBeGreaterThan(1)
    }
  })

  it('边界：途中拉伸峰值 ≤ 1.4（18px 滑块不溢出 44px 轨道）', () => {
    for (const name of ['settings-elastic-switch-jelly-on', 'settings-elastic-switch-jelly-off']) {
      const block = keyframesBlockOf(name)
      expect(block, `未找到 @keyframes ${name}`).not.toBe('')
      const scales = [...block.matchAll(/scaleX\(([\d.]+)\)/g)].map((m) => Number(m[1]))
      expect(Math.max(...scales), `${name} 拉伸峰值超界`).toBeLessThanOrEqual(1.4)
    }
  })

  it('异常：不得回归 :active 按压拉伸（transition 会压制 keyframes 的 transform）', () => {
    expect(globalsCss).not.toContain('settings-elastic-switch:active')
  })
})

describe('果冻开关：轨道底色灰→绿渐变', () => {
  it('正常：开启态轨道 background 用 --success、border-color 用 --success-deep', () => {
    const block = flattened(ruleBlockOf(".settings-elastic-switch[aria-checked='true']"))
    expect(block, "未找到 [aria-checked='true'] 轨道规则块").not.toBe('')
    expect(block).toContain('background: var(--success)')
    expect(block).toContain('border-color: var(--success-deep)')
  })

  it('正常：轨道颜色过渡时长 350ms', () => {
    const block = flattened(ruleBlockOf('.settings-elastic-switch'))
    expect(block, '未找到 .settings-elastic-switch 规则块').not.toBe('')
    expect(block).toContain('transition: background-color 350ms')
    expect(block).toContain('border-color 350ms')
  })

  it('边界：开启态轨道不得再引用 --accent（防回归蓝色；focus 环的 accent 不在此块范围）', () => {
    const block = flattened(ruleBlockOf(".settings-elastic-switch[aria-checked='true']"))
    expect(block).not.toContain('var(--accent)')
  })
})
