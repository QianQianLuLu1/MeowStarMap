import { describe, it, expect } from 'vitest'
import { openSync, readSync, closeSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listTrackedPaths } from '../check-md-links'

/**
 * 源文件编码守卫：被跟踪文件一律 UTF-8 无 BOM，且 eslint 不得再有 BOM 降级行。
 *
 * 收口的债务（DEBT-030）：HEAD 中 11 个 `src/renderer/components/common/*.test.tsx`
 * 带 UTF-8 BOM，`eslint.config.js` 的测试/stories 豁免块把 `unicode-bom` 降为 warn 渐进收敛，
 * 于是 CI 的 `npm run lint` 长期带 11 条 warning 注解（每 check run 注解截断在 ~10 条，
 * CI 页面只显示 10 条，第 11 条 SliderControl.test.tsx 被截掉 ⇒ 判据必须取本地全量读数）。
 *
 * 作用域用 `git ls-files` 的 tracked 集合而非 fs.existsSync：与 scripts/check-md-links.ts 同口径，
 * 本机留存/未跟踪文件不该进闸门，被跟踪的一律要清。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BOM = [0xef, 0xbb, 0xbf]

/** 仅当首 3 字节严格等于 EF BB BF 才算带 BOM（不做「看起来像文本」的推断） */
export function hasBom(head: ArrayLike<number>): boolean {
  return BOM.every((b, i) => head[i] === b)
}

/** 读 tracked 文件的前 3 字节；空文件返回短数组（判无 BOM） */
export function readHead3(absPath: string): number[] {
  const buf = Buffer.alloc(3)
  let fd: number | undefined
  try {
    fd = openSync(absPath, 'r')
    const n = readSync(fd, buf, 0, 3, 0)
    return Array.from(buf.subarray(0, n))
  } catch {
    return []
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** 全仓 tracked 文件里带 BOM 的路径清单（tracked 集合复用 check-md-links 的同一实现） */
export function findTrackedFilesWithBom(root: string = repoRoot): string[] {
  return [...listTrackedPaths()].filter((rel) => hasBom(readHead3(path.join(root, rel))))
}

/** eslint.config.js 里 BOM 规则的两处落点：全局 error 必须留，测试块 warn 必须无 */
export function bomRuleState(eslintSrc: string): {
  globalError: boolean
  downgrade: boolean
  downgradeLines: number[]
} {
  const lines = eslintSrc.split(/\r?\n/)
  return {
    globalError: /'unicode-bom':\s*\[\s*'error',\s*'never'\s*\]/.test(eslintSrc),
    downgrade: /'unicode-bom':\s*'warn'/.test(eslintSrc),
    downgradeLines: lines
      .map((l, i) => (/'unicode-bom':\s*'warn'/.test(l) ? i + 1 : 0))
      .filter((n) => n > 0)
  }
}

describe('源文件编码：tracked 文件不得带 BOM，eslint 不得有降级行', () => {
  it('正常：EF BB BF 之外的首字节判为无 BOM', () => {
    expect(hasBom([0x2f, 0x2a, 0x2a])).toBe(false)
    expect(hasBom([0x69, 0x6d, 0x70])).toBe(false)
    expect(hasBom([])).toBe(false)
  })

  it('异常：首 3 字节为 EF BB BF 判为有 BOM', () => {
    expect(hasBom([0xef, 0xbb, 0xbf, 0x2f])).toBe(true)
    // 只有 2 字节时不得误判（截断读取的边界）
    expect(hasBom([0xef, 0xbb])).toBe(false)
  })

  it('边界：BOM 降级行必须不存在，但全局 error 规则必须仍在（不许顺手删掉规则本身）', () => {
    const state = bomRuleState(readFileSync(path.join(repoRoot, 'eslint.config.js'), 'utf-8'))
    expect(state.globalError, 'eslint.config.js 的全局 unicode-bom error 规则被删了').toBe(true)
    expect(
      state.downgrade,
      `仍存在 unicode-bom 降级行（行号 ${state.downgradeLines.join(', ')}）⇒ 测试文件 BOM 只出 warning`
    ).toBe(false)
  })

  it('边界：豁免块内其余规则不得被顺手删除', () => {
    const src = readFileSync(path.join(repoRoot, 'eslint.config.js'), 'utf-8')
    expect(src).toContain("'no-restricted-syntax': 'off'")
    expect(src).toContain("'local/core-path-guard': 'off'")
  })

  it('真实契约：全仓 tracked 文件零 BOM', () => {
    const hits = findTrackedFilesWithBom()
    expect(
      hits,
      `以下被跟踪文件仍带 UTF-8 BOM（CI npm run lint 会逐条出 warning 注解）：\n${hits.join('\n')}`
    ).toEqual([])
  })
})
