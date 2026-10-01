/**
 * App 路由兜底页主题化结构断言（plan: 2026-09-30-fix-thumbnail-skeleton-reveal N6）
 *
 * 缺陷：Suspense fallback（PageFallback）硬编码纯白 `background: '#fff'` 与浅灰
 * spinner 边框色——暗色主题下路由首次切换出现刺眼白屏闪烁，是"白屏 → 模糊 → 清晰"
 * 渐进加载链路的第一段。
 * 修复：背景与 spinner 颜色全部改用主题 CSS 变量（--bg-primary 等），双主题自适应。
 *
 * 测试策略：App.tsx 渲染依赖 store/router/i18n 全链路，沿用仓库既有"源码结构断言"
 * 模式（VirtualImageGrid.thumb.test.tsx 先例），fs 读取源码断言硬编码色值已移除、
 * 主题变量已接入（剔除注释行防误命中修复说明）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const appSrc = fs.readFileSync(path.resolve(process.cwd(), 'src', 'renderer', 'App.tsx'), 'utf-8')

/** 剔除注释行后的源码，避免修复说明注释引用缺陷写法本身造成假失败 */
const code = appSrc
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
  .join('\n')

describe('PageFallback 主题化（fix-thumbnail-skeleton-reveal N6）', () => {
  it('不得存在硬编码纯白背景 #fff（暗色主题白屏闪烁根因）', () => {
    expect(code).not.toContain('#fff')
    expect(code).not.toContain("background: '#ffffff'")
  })

  it('兜底页背景使用主题变量 var(--bg-primary)', () => {
    expect(code).toContain('var(--bg-primary)')
  })

  it('spinner 边框色不得使用硬编码浅灰（#e5e7eb / #94a3b8）', () => {
    expect(code).not.toContain('#e5e7eb')
    expect(code).not.toContain('#94a3b8')
  })
})
