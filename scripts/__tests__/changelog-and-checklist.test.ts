/**
 * T5-A 文档回写回归：CHANGELOG 与阶段计划验收清单必须与实际代码状态一致。
 *
 * 本轮只勾「真实达成」的项，并把既有失败 / 未完成项如实注记，禁止虚假勾选。
 * 2026-11-11 发版轮：CHANGELOG 断言随发版收口迁移——阶段 1–5 条目并入
 * [2.5.7-beta] 版本节、[Unreleased] 清空（check-changelog-release 闸门同判据）。
 * 2026-11-21 2.5.7 正式版发版轮：版本节由 [2.5.7-beta] 更名 [2.5.7]（beta 轮条目
 * 随正式节发布），断言锚点同步迁移。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel: string): string | null => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

describe('CHANGELOG 发版收口', () => {
  const text = () => read('CHANGELOG.md') ?? ''
  const versionSection = () => {
    const t = text()
    const start = t.indexOf('## [2.5.7]')
    const end = t.indexOf('## [2.5.6]')
    return t.slice(start, end === -1 ? undefined : end)
  }
  const unreleased = () => {
    const t = text()
    return t.slice(t.indexOf('## [Unreleased]'), t.indexOf('## [2.5.7]'))
  }

  it('[2.5.7] 版本节含阶段 1–5 的完整条目（收口后不得丢失）', () => {
    const section = versionSection()
    expect(section).toContain('阶段 1')
    expect(section).toContain('阶段 2')
    expect(section).toContain('阶段 3')
    expect(section).toContain('阶段 4')
    expect(section).toContain('阶段 5')
  })

  it('第 24 行「CDN 与 CSP 零改动」错误表述已修正为 CSP 追加 assets.papegames.com', () => {
    expect(text()).not.toContain('`cdn-user-agent.ts` 与 CSP 零改动')
    expect(text()).toContain('assets.papegames.com')
  })

  it('[Unreleased] 已收口：节标题保留但无待发布条目（与打包闸门同判据）', () => {
    expect(text()).toContain('## [Unreleased] | 未发布')
    expect(text()).toContain('## [2.5.7] - 2026-11-21')
    // 条目行（- / * 列表）不得残留；说明性文字允许
    const entryLines = unreleased()
      .split('\n')
      .filter((line) => /^\s*[-*]\s+\S/.test(line))
    expect(entryLines).toEqual([])
  })

  it('版本节新增行只写 commit 短哈希，不写 docs/plans 路径（归档判据防外部入站引用）', () => {
    // 历史行（2.5.6 及更早、2.5.7-beta 既有行）保留原文；本判据只钉本轮并入的
    // 解密库条目——其 docs/plans 引用必须已改为短哈希取证
    const section = versionSection()
    expect(section).toContain('取证见提交 `0138f73`')
    expect(section).toContain('`128bdc6`')
    expect(section).not.toContain('docs/plans/2026-11-08-解密库基线对齐上游main-实施计划.md')
  })
})

describe('阶段 5 §10 交付验收清单', () => {
  const section = () => {
    const t = read('docs/plans/2026-11-08-参考数据CDN图片合规接入-实施计划.md') ?? ''
    return t.slice(t.indexOf('## 10. 交付验收清单'))
  }

  it('6 项全部勾为 [x]（2026-11-11 发版轮全量验证绿后回写）', () => {
    const s = section()
    expect((s.match(/- \[x\]/g) ?? []).length).toBe(6)
    expect(s).not.toContain('- [ ]')
  })

  it('「相关测试全部通过并向用户演示」勾选附带真实证据注记（禁止虚假勾选）', () => {
    const s = section()
    expect(s).toContain('- [x] 相关测试全部通过')
    expect(s).toContain('8192')
    expect(s).toContain('21 passed')
    expect(s).toContain('未做人工交互演示')
  })
})
