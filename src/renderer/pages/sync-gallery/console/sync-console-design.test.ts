// @vitest-environment node
/**
 * N2：控制台设计系统契约。
 *
 * 红→绿：先钉住“CSS 必须存在且全部限定在 .sync-console 作用域”，
 * 再落地样式；任何全局 :root/body 改写都会在这里被拦下。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 不用裸 `__dirname`：`npm run test:ci-linux` 的装置把 path 绑定换成 posix，
// 真实模块位置（Windows 反斜杠形态）会被拼成 CI 上不存在的串（ENOENT）。
const consoleDir = dirname(fileURLToPath(import.meta.url))
const cssPath = resolve(consoleDir, 'sync-console.css')
const layoutPath = resolve(consoleDir, 'SyncConsoleLayout.tsx')

describe('N2 控制台设计系统', () => {
  it('sync-console.css 存在，且关键结构选择器齐全', () => {
    const css = readFileSync(cssPath, 'utf8')
    for (const selector of [
      '.sync-console',
      '.sc-sidebar',
      '.sc-brand',
      '.sc-nav',
      '.sc-workspace',
      '.sc-page-header',
      '.sc-chip',
      ".sc-chip[data-state='ready']",
      '.sc-connection-grid',
      '.sc-card',
      '.sc-status-bar'
    ]) {
      expect(css).toContain(selector)
    }
  })

  it('所有规则都限定在 .sync-console 内，禁止全局 :root/body/* 改写', () => {
    const css = readFileSync(cssPath, 'utf8')
    expect(css).not.toMatch(/^:root\s*\{/m)
    expect(css).not.toMatch(/^body\s*\{/m)
    expect(css).not.toMatch(/^\*\s*\{/m)
    // 逐行取选择器（支持 @media 内缩进与多行选择器）：每行 `{` 前的选择器必须以 .sync-console 开头
    const selectorLines = css
      .split('\n')
      .filter((line) => line.includes('{'))
      .map((line) => line.slice(0, line.indexOf('{')).trim())
      .filter((selector) => selector.length > 0 && !selector.startsWith('@'))
    expect(selectorLines.length).toBeGreaterThan(20)
    for (const selector of selectorLines) {
      expect(selector.startsWith('.sync-console')).toBe(true)
    }
  })

  it('布局导入样式并挂载品牌/五入口骨架', () => {
    const layout = readFileSync(layoutPath, 'utf8')
    expect(layout).toContain("import './sync-console.css'")
    expect(layout).toContain('sc-sidebar')
    expect(layout).toContain('sc-brand')
    const statusBar = readFileSync(resolve(consoleDir, 'SyncStatusBar.tsx'), 'utf8')
    expect(statusBar).toContain('sc-status-bar')
  })
})
