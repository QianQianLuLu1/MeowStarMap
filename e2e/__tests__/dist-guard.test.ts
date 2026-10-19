import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { detectTscOverwrittenDist } from '../dist-guard'

/**
 * dist-guard 纯函数单测。
 *
 * 背景见 docs/plans/2026-10-19-fix-e2e-smoke-dist-pollution.md：
 * `tsc -b` 的 outDir 一旦指向 dist/main，就会把 electron-vite 的 preload bundle 覆写成
 * per-file CJS；沙箱化 preload 无法 require 兄弟文件 → window.electronAPI 整体为空 →
 * 走 launchBuiltApp() 的 e2e 用例伪装成「代码缺陷」。本守卫负责把这种环境态变成明确报错。
 *
 * 两个判据按真实产物取形状（非臆造）：
 * - electron-vite 的 preload bundle：首行 "use strict" 后紧跟 const electron = require("electron")，
 *   实测既不出现 __esModule，也不出现任何相对 require，且不产出 .d.ts。
 * - tsc 的 per-file 转译体：Object.defineProperty(exports, "__esModule", …) + require("./preload/…")，
 *   并在同目录留下 preload.d.ts。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 真实 vite bundle 的头部形状 */
const VITE_HEAD = [
  '"use strict";',
  'const electron = require("electron");',
  'const PRELOAD_LOG_PREFIX = "[preload]";',
  'const originGuard = require("electron").ipcRenderer;'
].join('\n')

/** 真实 tsc 转译体的头部形状 */
const TSC_HEAD = [
  '"use strict";',
  'Object.defineProperty(exports, "__esModule", { value: true });',
  '/**',
  ' * preload 入口：装配各命名空间模块并暴露到渲染进程',
  ' */',
  'const electron_1 = require("electron");',
  'const origin_guard_1 = require("./preload/origin-guard");',
  'const api_scanner_1 = require("./preload/api/scanner");'
].join('\n')

describe('detectTscOverwrittenDist：识别被 tsc 覆写的 preload 产物', () => {
  it('正常：electron-vite bundle 放行', () => {
    expect(detectTscOverwrittenDist(VITE_HEAD, false)).toBeNull()
  })

  it('异常：转译体 + 同名 .d.ts 判定为污染，并给出可执行动作', () => {
    const msg = detectTscOverwrittenDist(TSC_HEAD, true)
    expect(msg).not.toBeNull()
    expect(msg).toContain('npm run build')
    expect(msg).toContain('tsc -b')
  })

  it('异常：只有转译体特征（无 .d.ts 兄弟文件）同样判定为污染', () => {
    // 覆盖「手工拷贝产物 / .d.ts 被清理」的形态：__esModule + 跨文件相对 require
    expect(detectTscOverwrittenDist(TSC_HEAD, false)).not.toBeNull()
  })

  it('异常：只有 preload.d.ts 兄弟文件也判定为污染（electron-vite 从不产出声明）', () => {
    expect(detectTscOverwrittenDist('', true)).not.toBeNull()
  })

  it('边界：非字符串 / 空头部且无兄弟声明时不误报', () => {
    expect(detectTscOverwrittenDist('', false)).toBeNull()
    expect(detectTscOverwrittenDist(undefined as unknown as string, false)).toBeNull()
    expect(detectTscOverwrittenDist(undefined as unknown as string, true)).not.toBeNull()
  })

  it('边界：只消费头部，正文深处的特征不触发（保证读取成本恒定）', () => {
    const head = 'x'.repeat(512) + '\n' + TSC_HEAD
    expect(detectTscOverwrittenDist(head, false)).toBeNull()
  })

  it('真实产物锚定：已 npm run build 时，仓内 preload 必须判为干净', () => {
    const preload = path.join(repoRoot, 'dist', 'main', 'main', 'preload.js')
    // 未 build 的环境（干净克隆 / 只跑单测的 CI job）跳过，不把「无产物」当「被污染」
    if (!existsSync(preload)) {
      expect(existsSync(preload)).toBe(false)
      return
    }
    const head = readFileSync(preload, 'utf-8').slice(0, 512)
    const hasDeclarationSibling = existsSync(path.join(path.dirname(preload), 'preload.d.ts'))
    expect(detectTscOverwrittenDist(head, hasDeclarationSibling)).toBeNull()
  })
})
