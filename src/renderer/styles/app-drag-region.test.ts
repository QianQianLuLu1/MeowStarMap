/**
 * @layer L3
 * @module src/renderer/styles/globals.css
 * @coverage 隐藏标题栏（titleBarStyle:'hidden' + WCO）窗口可拖拽区 window-drag-region
 * @dependencies fs、path（纯源码结构断言，node 环境即可）
 * @remarks
 *   缺陷：WCO 隐藏原生标题栏后，渲染层必须用 app-region: drag 显式声明可拖拽区；
 *   TitleBar.tsx:9 已引用 .app-drag 类，但 globals.css / 主题 CSS / tailwind.config
 *   均无对应规则 → 窗口无法拖动。
 *   CSS 为静态资源、jsdom 不应用样式表，故沿用仓库既有源码结构断言范式
 *   （readStripped + ruleBlockOf，helper 逐字复制不抽公共模块）。
 *   铁律：修复前（阶段 0）本文件所有用例必须 FAILED；逐节点落 CSS 后转绿。
 *   局限：OS 级窗口拖拽无法在 vitest/jsdom 中行为级复现，真实手感见人工清单。
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const readStripped = (...segments: string[]): string => {
  const raw = fs.readFileSync(path.resolve(process.cwd(), ...segments), 'utf-8')
  return raw.replace(/\/\*[\s\S]*?\*\//g, '')
}

const globalsCss = readStripped('src', 'renderer', 'styles', 'globals.css')

function ruleBlockOf(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) return ''
  const bodyStart = css.indexOf('{', start)
  const bodyEnd = css.indexOf('}', bodyStart)
  if (bodyStart < 0 || bodyEnd < 0) return ''
  return css.slice(start, bodyEnd + 1)
}

describe('窗口可拖拽区 CSS 契约（window-drag-region）', () => {
  describe('节点1 · .app-drag 拖拽区声明与非法值防护', () => {
    it('正常：globals.css 定义 .app-drag 规则块', () => {
      expect(ruleBlockOf(globalsCss, '.app-drag'), '未找到 .app-drag 规则块').not.toBe('')
    })
    it('正常：声明带前缀 -webkit-app-region: drag', () => {
      expect(ruleBlockOf(globalsCss, '.app-drag')).toMatch(
        /^[ \t]*-webkit-app-region:[ \t]*drag[ \t]*;/m
      )
    })
    it('正常：声明无前缀 app-region: drag（行锚定，缺此声明即红）', () => {
      // 行锚定至关重要：裸 /app-region:/ 会命中 -webkit-app-region 子串 → 假绿灯
      expect(ruleBlockOf(globalsCss, '.app-drag')).toMatch(/^[ \t]*app-region:[ \t]*drag[ \t]*;/m)
    })
    it('正常：拖拽区禁用文本选择（拖动不误选标题文字）', () => {
      expect(ruleBlockOf(globalsCss, '.app-drag')).toMatch(/^[ \t]*user-select:[ \t]*none[ \t]*;/m)
    })
    it('异常/非法值：.app-drag 块内不得把 app-region 写成 no-drag/none/initial', () => {
      const block = ruleBlockOf(globalsCss, '.app-drag')
      expect(block, '前置：.app-drag 块必须存在').not.toBe('')
      expect(block).not.toMatch(/^[ \t]*-?webkit-app-region:[ \t]*(no-drag|none|initial)[ \t]*;/m)
      expect(block).not.toMatch(/^[ \t]*app-region:[ \t]*(no-drag|none|initial)[ \t]*;/m)
    })
  })

  describe('节点2 · .app-no-drag 排除区工具', () => {
    it('正常：定义 .app-no-drag 规则块', () => {
      expect(ruleBlockOf(globalsCss, '.app-no-drag'), '未找到 .app-no-drag 规则块').not.toBe('')
    })
    it('正常：.app-no-drag 同时声明双前缀 no-drag', () => {
      const block = ruleBlockOf(globalsCss, '.app-no-drag')
      expect(block).toMatch(/^[ \t]*-webkit-app-region:[ \t]*no-drag[ \t]*;/m)
      expect(block).toMatch(/^[ \t]*app-region:[ \t]*no-drag[ \t]*;/m)
    })
  })

  describe('边界 · 拖拽区契约完整性', () => {
    it('边界：.app-drag 与 .app-no-drag 为两个独立块，且 drag 块不含 no-drag', () => {
      const drag = ruleBlockOf(globalsCss, '.app-drag')
      const noDrag = ruleBlockOf(globalsCss, '.app-no-drag')
      expect(drag, '前置：.app-drag 块必须存在').not.toBe('')
      expect(noDrag, '前置：.app-no-drag 块必须存在').not.toBe('')
      expect(drag).not.toMatch(/no-drag/)
    })
    it('边界：body/:root/html 上不得声明全局 no-drag（否则整片拖拽区被几何减掉）', () => {
      expect(ruleBlockOf(globalsCss, '.app-drag'), '前置：拖拽区契约须已落地').not.toBe('')
      expect(ruleBlockOf(globalsCss, '.app-no-drag'), '前置：排除区契约须已落地').not.toBe('')
      const offenders = globalsCss.match(/(?:body|:root|html)[^{}]*\{[^}]*no-drag/g) ?? []
      expect(offenders, '存在全局级 no-drag，会减掉拖拽区').toEqual([])
    })
  })
})
