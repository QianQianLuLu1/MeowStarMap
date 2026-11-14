import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 陈旧注释守护（2026-11-14 补章轮新增）。
 *
 * 背景：两处注释曾随代码演进过期——eslint.config.js 提及早已删除的 legacy 白名单块、
 * verify-nikkisync-link.ts 注释硬编码深入口数量（26 → 实际 29，数字随轮次漂移）。
 * 本守护钉住两条防线，防止同类腐化复发：
 *
 *   断言 A — eslint.config.js 不得再出现「legacy 白名单块」字样（历史块 2026-08-23 已全量
 *            清偿删除，文末仅存墓碑注释，其措辞为「存量技术债白名单」，不会误伤）；
 *   断言 B — LOAD_CHAIN_ROOTS 的文档注释不得硬编码「N 个」计数，且必须指明数量的权威
 *            载体是 verify-nikkisync-link.test.ts 的钉死断言（数量随上游对齐轮次增长，
 *            注释写死必然过期）。
 *
 *   异常兜底 — 若锚点（LOAD_CHAIN_ROOTS 声明或其文档注释）消失，测试必须响亮失败而非静默通过。
 */

describe('stale comment guard', () => {
  it('eslint.config.js 不再提及已删除的 legacy 白名单块，且 i18n 硬阻断规则仍在', () => {
    const text = readFileSync(path.join(ROOT, 'eslint.config.js'), 'utf-8')

    // 规则本体仍在（守护自身锚点自检：改错文件/改错位置时这里先红）
    expect(text).toContain('no-restricted-syntax')
    expect(text).toContain('i18nGuardSelectors')

    // 陈旧表述已移除（文末墓碑注释用「存量技术债白名单」措辞，不受影响）
    expect(text).not.toContain('legacy 白名单块')
  })

  it('verify-nikkisync-link.ts 的 LOAD_CHAIN_ROOTS 注释不硬编码深入口数量，指向测试为权威', () => {
    const source = readFileSync(path.join(ROOT, 'scripts', 'verify-nikkisync-link.ts'), 'utf-8')

    const anchor = source.indexOf('export const LOAD_CHAIN_ROOTS')
    // 异常兜底：锚点消失（重命名/移动）时响亮失败，不许静默通过
    expect(anchor).toBeGreaterThan(-1)

    const commentStart = source.lastIndexOf('/**', anchor)
    expect(commentStart).toBeGreaterThan(-1)
    const comment = source.slice(commentStart, anchor)
    // 注释块必须真的被截取到（长度下限防止空块/异常切片造成假绿）
    expect(comment.length).toBeGreaterThan(40)

    // 不硬编码「N 个」计数（历史快照：曾写过 26，数字随上游对齐轮次漂移必然过期）
    expect(comment).not.toMatch(/\d+\s*个/)

    // 数量与清单的权威载体是钉死断言的测试文件，注释必须指向它
    expect(comment).toContain('verify-nikkisync-link.test.ts')
  })
})
