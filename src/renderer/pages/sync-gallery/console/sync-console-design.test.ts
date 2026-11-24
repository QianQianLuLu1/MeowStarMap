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
      '.sc-settings-about',
      '.sc-about-hero',
      '.sc-download-grid'
    ]) {
      expect(css).toContain(selector)
    }
    // 卡面不得再引用宿主的半透明 surface（rgba(255,255,255,.75)）：
    // 上游 --surface 是实底，半透明会让下层内容透出、观感像卡片重叠
    expect(css).not.toMatch(/--sc-surface:\s*var\(--bg-secondary\)/)
  })

  it('卡内间距单轨：视图层不得再用 space-y-* 包裹（改由 .sc-card-body 的 gap 承担）', () => {
    for (const file of ['SettingsView.tsx', 'ConnectView.tsx', 'AboutView.tsx']) {
      const source = readFileSync(resolve(consoleDir, file), 'utf8')
      expect(source, `${file} 仍在用 space-y-*`).not.toContain('space-y-')
    }
  })

  it('列表行不得逐项套 sc-service-rows（会吃掉 :first-child 分隔线与内边距）', () => {
    for (const file of ['SettingsView.tsx', 'AboutView.tsx']) {
      const source = readFileSync(resolve(consoleDir, file), 'utf8')
      expect(source, `${file} 仍有逐项 sc-service-rows 包裹`).not.toMatch(
        /<div className="sc-service-rows" key=/
      )
    }
  })

  it('嵌套非行组用 .sc-stack 承担 8px 节奏（sc-service-rows 无样式）', () => {
    const css = readFileSync(cssPath, 'utf8')
    expect(css).toContain('.sync-console .sc-stack')
    for (const file of ['SettingsView.tsx', 'HotspotCard.tsx', 'NetworkPermissionCard.tsx']) {
      const source = readFileSync(resolve(consoleDir, file), 'utf8')
      expect(source, `${file} 未使用 sc-stack`).toContain('className="sc-stack"')
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
    // 底栏已按上游形态移除：版本/重启/导出分别回到关于 hero、Android 卡与关于页
    expect(layout).not.toContain('sc-status-bar')
    expect(layout).toContain('<h1 className="sc-page-title">')
  })

  it('五入口图标互不重复：最近删除保留 trash 以区分灵感库', () => {
    const layout = readFileSync(layoutPath, 'utf8')
    expect(layout).toContain("organizer: 'trash'")
    expect(layout).not.toContain("organizer: 'album'")
  })
})
