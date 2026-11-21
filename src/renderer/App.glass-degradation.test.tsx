/**
 * 玻璃效果自动降级的 App / 设置页接线断言（2026-11-20 视图闪屏软件渲染自动降级 N1）
 *
 * 沿用仓库既有「源码结构断言」模式（App.theme.test.tsx 先例）：App.tsx 渲染依赖
 * store/router/i18n 全链路，jsdom 直渲染不可行；行为契约由 glass-degradation.test.ts
 * 与 AppearanceDisplaySection 渲染套件覆盖，本文件钉住两处消费点不得绕过统一决策：
 * 1. App.tsx 启动显示偏好必须经 detectSoftwareRendering + applyGlassMode；
 * 2. appearance-sections.tsx 的玻璃档位应用必须经 applyGlassMode（防设置操作
 *    用直接 classList.toggle 覆写自动降级）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const readCode = (rel: string) =>
  fs
    .readFileSync(path.resolve(process.cwd(), ...rel.split('/')), 'utf-8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n')

const appCode = readCode('src/renderer/App.tsx')
const appearanceCode = readCode('src/renderer/pages/settings/appearance-sections.tsx')

describe('软件渲染自动 glass-lite 接线（N1）', () => {
  it('App.tsx 启动偏好必须探测软件渲染并经 applyGlassMode 决策', () => {
    expect(appCode).toContain('detectSoftwareRendering')
    expect(appCode).toContain('applyGlassMode(glass)')
  })

  it('App.tsx 不得保留绕过能力检测的直接 glass-lite toggle', () => {
    expect(appCode).not.toContain("html.classList.toggle('glass-lite'")
  })

  it('appearance-sections.tsx 玻璃档位应用必须经 applyGlassMode', () => {
    expect(appearanceCode).toContain('applyGlassMode(effect)')
    expect(appearanceCode).not.toContain("classList.toggle('glass-lite'")
  })
})
