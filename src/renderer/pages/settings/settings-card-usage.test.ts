/**
 * 设置页「手写卡片 → SettingsCard」的机械替换守卫。
 *
 * 为什么用源码扫描而不是 DOM 断言：SettingsCard 渲染出的正是
 * `p-3 rounded-lg` + `style={{ background: 'var(--bg-tertiary)' }}`
 * （shared.tsx:234-238），与被替换掉的手写 div **运行时结构完全相同**，
 * 所以 DOM 层面无法区分「复用了组件」和「又手写了一遍」。这类替换的验收面在源码。
 *
 * 本文件对当前 HEAD 必然是红的（21 处仍是手写 div），这就是它的红灯步骤；
 * 转绿后它反过来防止有人日后又把 SettingsCard 拆回手写 div。
 *
 * 运行：npx vitest run src/renderer/pages/settings/settings-card-usage.test.ts
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const DIR = path.resolve(__dirname)

/**
 * 替换后各文件应有的 SettingsCard 使用数（原有用量 + 本次机械替换数）：
 * about 0+2 / data 0+7 / diagnostics 0+10 / general 0+1 / profile 0+1 / scan 9+0
 */
const EXPECTED_USAGE: Record<string, number> = {
  'about-sections.tsx': 2,
  'data-sections.tsx': 7,
  'diagnostics-sections.tsx': 10,
  'general-sections.tsx': 1,
  'profile-sections.tsx': 1,
  'scan-sections.tsx': 9
}

/**
 * 与 SettingsCard 完全同构、且应当已被组件取代的手写模式：
 * p-3 rounded-lg 的 div，内联样式**只有** background: var(--bg-tertiary)。
 * 内联样式带第二项（color / border 等）或 padding 非 p-3 的一律不在替换范围——
 * 那些要换成 SettingsCard 就得给共享件加 style/size prop，本次明确不做。
 */
const HAND_ROLLED_CARD =
  /<div\b[\s\S]{0,220}?className=(?:"[^"]*p-3 rounded-lg[^"]*"|`[^`]*p-3 rounded-lg[^`]*`)[\s\S]{0,160}?style=\{\{\s*background:\s*'var\(--bg-tertiary\)',?\s*\}\}/g

describe('设置页卡片统一复用 SettingsCard', () => {
  for (const [file, expected] of Object.entries(EXPECTED_USAGE)) {
    it(`${file} 使用 SettingsCard ${expected} 次`, () => {
      const src = fs.readFileSync(path.join(DIR, file), 'utf8')
      const count = (src.match(/<SettingsCard\b/g) || []).length
      expect(count, `${file} 的 SettingsCard 用量`).toBe(expected)
    })
  }

  it('不再残留与 SettingsCard 同构的手写卡片 div', () => {
    const leftovers: string[] = []
    for (const file of Object.keys(EXPECTED_USAGE)) {
      const src = fs.readFileSync(path.join(DIR, file), 'utf8')
      const hits = src.match(HAND_ROLLED_CARD) || []
      if (hits.length) leftovers.push(`${file}: ${hits.length} 处`)
    }
    expect(leftovers, '应改用 <SettingsCard> 的手写卡片').toEqual([])
  })

  it('shared.tsx 里 SettingsCard 的定义本身不被改动语义', () => {
    const src = fs.readFileSync(path.join(DIR, 'shared.tsx'), 'utf8')
    expect(src).toContain("style={{ background: 'var(--bg-tertiary)' }}")
    expect(src).toContain('export const SettingsCard')
  })
})
