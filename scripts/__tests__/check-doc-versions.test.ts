import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  collectCount,
  evaluateCountAssertion,
  type CountAssertion,
  type CountSource
} from '../check-doc-versions'

/**
 * check-doc-versions 计数断言单测（2026-11-14 补章轮新增）。
 *
 *   正常 — regex-in-tree / files-in-dir 事实源计数正确（含 exclude 排除）；
 *          实测值等于基线 → 通过且无漂移提醒。
 *   异常 — 事实源文件/目录不存在 → 收集失败（阻断级），文案指明锚点失效；
 *          收集失败传入 evaluate → 阻断，不误报为漂移。
 *   边界 — 零命中视为锚点失效（阻断而非"计数 0"）；
 *          实测 ≠ 基线 → warn 提醒，detail 含「基线 N → 实测 M (+/-delta)」。
 *
 * 全部用 tmp fixture，不读仓库真实源码；CLI 主流程（Electron 版本校验）由
 * pre-dist-check 链在打包时现场验证。
 */

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-doc-versions-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(rel: string, content: string): string {
  const abs = path.join(tmpDir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

describe('collectCount', () => {
  it('正常：regex-in-tree 递归计数并按 exclude 排除测试文件', () => {
    write('src/a.ts', "ipcMain.handle('x:1')\nipcMain.handle('x:2')\n")
    write('src/sub/b.ts', "ipcMain.handle('y:1')\n")
    write('src/c.test.ts', "ipcMain.handle('z:1')\n") // 应被排除

    const source: CountSource = {
      kind: 'regex-in-tree',
      dir: path.join(tmpDir, 'src'),
      pattern: /ipcMain\.handle\(/g,
      exclude: /\.test\.ts$/
    }
    expect(collectCount(source)).toEqual({ ok: true, value: 3 })
  })

  it('异常：事实源目录不存在 → 收集失败并指明路径', () => {
    const source: CountSource = {
      kind: 'files-in-dir',
      dir: path.join(tmpDir, 'missing-dir')
    }
    const got = collectCount(source)
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.reason).toContain('missing-dir')
  })

  it('异常：regex-in-file 事实源文件不存在 → 收集失败', () => {
    const source: CountSource = {
      kind: 'regex-in-file',
      file: path.join(tmpDir, 'nope.ts'),
      pattern: /foo/g
    }
    expect(collectCount(source).ok).toBe(false)
  })

  it('边界：零命中视为锚点失效（阻断），而不是合法的计数 0', () => {
    const file = write('src/empty.ts', 'const a = 1\n')
    const source: CountSource = { kind: 'regex-in-file', file, pattern: /never-matches/g }
    expect(collectCount(source).ok).toBe(false)
  })

  it('边界：include 限定只统计匹配的文件（如仅 .ts），文档 .md 中的字样不计', () => {
    write('src/a.ts', "ipcMain.handle('x:1')\n")
    write('src/doc.md', '说明文本 ipcMain.handle( 示例\n') // 应被 include 排除

    const source: CountSource = {
      kind: 'regex-in-tree',
      dir: path.join(tmpDir, 'src'),
      pattern: /ipcMain\.handle\(/g,
      include: /\.ts$/
    }
    expect(collectCount(source)).toEqual({ ok: true, value: 1 })
  })

  it('正常：files-in-dir 只统计常规文件并可排除', () => {
    write('api/a.ts', '')
    write('api/b.ts', '')
    write('api/c.test.ts', '') // 应被排除
    write('api/nested/d.ts', '') // 目录内文件不计（只看本层）

    const source: CountSource = {
      kind: 'files-in-dir',
      dir: path.join(tmpDir, 'api'),
      exclude: /\.test\.ts$/
    }
    expect(collectCount(source)).toEqual({ ok: true, value: 2 })
  })
})

describe('evaluateCountAssertion', () => {
  const assertion: CountAssertion = {
    id: 'demo-count',
    source: { kind: 'files-in-dir', dir: '/unused' },
    baseline: 2,
    hint: '对账示例文档'
  }

  it('正常：实测等于基线 → 通过且无漂移提醒', () => {
    const result = evaluateCountAssertion(assertion, { ok: true, value: 2 })
    expect(result.blocked).toBe(false)
    expect(result.warned).toBe(false)
    expect(result.detail).toContain('与基线一致')
  })

  it('边界：实测高于基线 → warn 提醒且 detail 含带符号差值', () => {
    const result = evaluateCountAssertion(assertion, { ok: true, value: 3 })
    expect(result.blocked).toBe(false)
    expect(result.warned).toBe(true)
    expect(result.detail).toContain('基线 2 → 实测 3 (+1)')
    expect(result.detail).toContain('对账示例文档')
  })

  it('边界：实测低于基线 → warn 提醒且差值带负号', () => {
    const result = evaluateCountAssertion(assertion, { ok: true, value: 1 })
    expect(result.blocked).toBe(false)
    expect(result.warned).toBe(true)
    expect(result.detail).toContain('基线 2 → 实测 1 (-1)')
  })

  it('异常：收集失败 → 阻断且文案指明锚点失效，不误报为漂移', () => {
    const result = evaluateCountAssertion(assertion, { ok: false, reason: '目录不存在' })
    expect(result.blocked).toBe(true)
    expect(result.warned).toBe(false)
    expect(result.detail).toContain('守护锚点失效')
    expect(result.detail).toContain('目录不存在')
  })
})

describe('COUNT_ASSERTIONS（仓库内置断言表）', () => {
  it('内置断言的事实源在当前仓库可收集成功（锚点自检）', async () => {
    const { COUNT_ASSERTIONS } = await import('../check-doc-versions')
    expect(COUNT_ASSERTIONS.length).toBeGreaterThanOrEqual(2)
    for (const assertion of COUNT_ASSERTIONS) {
      const got = collectCount(assertion.source)
      expect(
        got.ok,
        `${assertion.id} 锚点失效：${got.ok ? '' : (got as { reason: string }).reason}`
      ).toBe(true)
    }
  })

  it('内置断言 id 与基线均已登记（不允许无基线的断言混入）', async () => {
    const { COUNT_ASSERTIONS } = await import('../check-doc-versions')
    for (const assertion of COUNT_ASSERTIONS) {
      expect(assertion.id).toBeTruthy()
      expect(Number.isInteger(assertion.baseline)).toBe(true)
      expect(assertion.hint).toBeTruthy()
    }
  })
})
