import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * CI 失败注解可观测性守卫。
 *
 * 判据要解决的问题：GitHub Actions 的 job 日志需要仓库权限才能读
 * （`GET /actions/jobs/{id}/logs` 对匿名请求返回 403，产物 zip 返回 401），
 * 而 `GET /check-runs/{id}/annotations` 免鉴权可读。run 39583778122 的 build job
 * 只有 2 条注解且 `output.annotations_count` 恰为 2（完整集，未被截断）——
 * 说明 Playwright 一条注解都没发出去，因为 reporter 写死成只写 stdout 的 `list`。
 * 于是「哪条用例红了」只能靠人给日志，定位成本被抬到需要登录态才能收口。
 *
 * 修法口径：CI 下追加 Playwright 内置 `github` reporter，它把每条失败用例写成
 * `::error file=…,line=…,title=…::message`，即落入免鉴权可读的注解里。
 * 本地仍只用 `list`，避免终端里混入 workflow 命令噪声。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const configPath = path.join(repoRoot, 'e2e', 'playwright.config.ts')

/**
 * 取 playwright 配置里 reporter 的声明文本（两空格缩进＝defineConfig 顶层）。
 * 命中数不是 1 时抛错：宁可让守卫红，也不要在配置被重排版、值被藏起来时静默放行。
 */
export function reporterDecl(configSrc: string): string {
  const decls = configSrc
    .split(/\r?\n/)
    .filter((l) => /^ {2}reporter:/.test(l))
    .map((l) =>
      l
        .replace(/^ {2}reporter:\s*/, '')
        .replace(/,\s*$/, '')
        .trim()
    )
  if (decls.length !== 1) {
    throw new Error(`reporter 声明必须恰好一条（实际 ${decls.length} 条），配置形态已漂移`)
  }
  return decls[0]
}

/**
 * CI 门控的 github reporter 判定。
 *
 * 必须按三元表达式的**两个分支**分别校验，而不是整串里出现过 'github' 就算合规：
 * `process.env.CI ? [['github']] : [['list']]` 这种写法会在 CI 下丢掉 `list`，
 * 流水线日志里就再也看不到逐用例进度（本仓既有行为），只查子串会被它蒙过去。
 */
export function hasCiAnnotatedReporter(decl: string): boolean {
  const m = /^process\.env\.CI\s*\?\s*(.+?)\s*:\s*(.+)$/.exec(decl)
  if (!m) return false
  const ciBranch = m[1]
  const localBranch = m[2]
  return (
    ciBranch.includes("'list'") &&
    ciBranch.includes("'github'") &&
    localBranch.includes("'list'") &&
    !localBranch.includes("'github'")
  )
}

describe('e2e/playwright.config.ts 的 CI 失败注解 reporter', () => {
  it('正常：CI 门控 + list + github 三者齐备判为合规', () => {
    expect(hasCiAnnotatedReporter("process.env.CI ? [['list'], ['github']] : [['list']]")).toBe(
      true
    )
  })

  it('边界：只在 CI 下加 github；本地也挂 github 判为不合规（避免终端噪声）', () => {
    expect(hasCiAnnotatedReporter("[['list'], ['github']]")).toBe(false)
    expect(hasCiAnnotatedReporter("process.env.CI ? [['github']] : [['list']]")).toBe(false)
  })

  it('异常：reporter 被重排版成多条或藏进变量时，守卫抛错而非静默放宽', () => {
    expect(() => reporterDecl("export default {\n  reporter: [['list']]\n}\n")).not.toThrow()
    expect(() =>
      reporterDecl("export default {\n  reporter: [['list']]\n  reporter: [['dot']]\n}\n")
    ).toThrow(/恰好一条/)
    expect(() => reporterDecl("export default {\n    reporter: [['list']]\n}\n")).toThrow(
      /恰好一条/
    )
  })

  it('真实契约：CI 下冒烟失败必须产出免鉴权可读的注解', () => {
    const decl = reporterDecl(readFileSync(configPath, 'utf-8'))
    expect(
      hasCiAnnotatedReporter(decl),
      `当前 reporter = ${decl}；缺 github reporter ⇒ CI 失败用例名进不了注解，只能靠人工取日志`
    ).toBe(true)
  })
})
