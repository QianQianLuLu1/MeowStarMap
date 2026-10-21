import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

/**
 * 工作流里第三方/官方 action 的运行时版本守卫。
 *
 * 要收口的告警（run 39583778122 的 build/coverage job 各一条 warning）：
 *   Node.js 20 is deprecated. The following actions target Node.js 20 but are being
 *   forced to run on Node.js 24: actions/upload-artifact@v4.
 * 判据取数（2026-10-21，读自 action 自己的仓库，不凭印象）：
 *   - actions/upload-artifact：最新 v7.0.2；v6.0.0 发布说明「now runs on Node.js 24
 *     (runs.using: node24) and requires a minimum Actions Runner version of 2.327.1」
 *     ⇒ node24 的最低主版本是 **6**；v7.0.0 另加 `archive` 入参（默认 true＝v4 行为）。
 *   - softprops/action-gh-release：@v2 的 action.yml 实测 `runs.using: "node20"`；
 *     v3.0.0 发布说明只讲一件事「moves the action runtime from Node 20 to Node 24」
 *     ⇒ 最低主版本是 **3**。
 * 本仓 5 处 upload 步骤在用的入参只有 name / path（多行 + `!` 排除）/ if-no-files-found /
 * retention-days，逐条对照 v7 README 仍成立 ⇒ 升级属纯版本号变更，零入参改写。
 *
 * 边界说明：本守卫只能钉「主版本号」，不能证明真实 runner 上不再产生该告警——
 * 那一步只能等远端运行读数（见计划 §8 待远端确认清单）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'build.yml')

/** node24 起算的最低主版本；键为 `owner/repo` */
export const MIN_MAJOR: Record<string, number> = {
  'actions/upload-artifact': 6,
  'softprops/action-gh-release': 3
}

/** upload-artifact v7 文档声明的全部入参键（出现集合外的键即配置已失效） */
export const UPLOAD_ARTIFACT_INPUTS = new Set([
  'name',
  'path',
  'if-no-files-found',
  'retention-days',
  'compression-level',
  'overwrite',
  'include-hidden-files',
  'archive'
])

export interface WorkflowStep {
  name?: string
  uses?: string
  with?: Record<string, unknown>
}

/** 解析 `uses: owner/repo@ref`；ref 必须是 `v<数字>` 主版本号形态 */
export function parseUses(uses: string): { action: string; major: number | null } | null {
  const m = /^([^@\s]+)@(\S+)$/.exec(uses.trim())
  if (!m) return null
  const action = m[1]
  const ref = m[2]
  const v = /^v(\d+)$/.exec(ref)
  return { action, major: v ? Number(v[1]) : null }
}

/** 对一个 job 的 steps 求违规清单：主版本过低 / ref 形态不合规 / 入参失效 / 产物重名 */
export function findStepViolations(steps: WorkflowStep[]): string[] {
  const violations: string[] = []
  const uploadNames: string[] = []
  for (const step of steps) {
    if (!step.uses) continue
    const parsed = parseUses(step.uses)
    if (!parsed) {
      violations.push(`uses 形态不合规：${step.uses}`)
      continue
    }
    const { action, major } = parsed
    if (major === null) {
      // 钉 @main / @sha 会让 action 内容可变，本仓约定一律用主版本号
      violations.push(`${action} 未使用主版本号（实际 ${step.uses}）`)
      continue
    }
    const min = MIN_MAJOR[action]
    if (min !== undefined && major < min) {
      violations.push(`${action}@v${major} 低于 node24 起算的最低主版本 v${min}`)
    }
    if (action === 'actions/upload-artifact') {
      for (const key of Object.keys(step.with ?? {})) {
        if (!UPLOAD_ARTIFACT_INPUTS.has(key)) {
          violations.push(`actions/upload-artifact 不认的入参键：${key}`)
        }
      }
      const name = String((step.with as Record<string, unknown> | undefined)?.name ?? '')
      if (name) {
        if (uploadNames.includes(name)) violations.push(`同一 job 内产物重名：${name}`)
        uploadNames.push(name)
      }
    }
  }
  return violations
}

/** 取 workflow 的 jobs 结构（`uses` 只出现在 steps 里） */
export function readJobs(workflowSrc: string): Record<string, WorkflowStep[]> {
  const doc = parse(workflowSrc) as {
    jobs?: Record<string, { steps?: WorkflowStep[] }>
  }
  const out: Record<string, WorkflowStep[]> = {}
  for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
    out[jobId] = Array.isArray(job?.steps) ? job.steps : []
  }
  return out
}

describe('工作流 action 运行时版本', () => {
  it('正常：v7 + 四个在用入参判为合规', () => {
    expect(
      findStepViolations([
        {
          uses: 'actions/upload-artifact@v7',
          with: { name: 'x', path: 'a\n!b\n', 'if-no-files-found': 'ignore', 'retention-days': 14 }
        }
      ])
    ).toEqual([])
  })

  it('异常：@v4 低于 node24 起算的最低主版本', () => {
    const v = findStepViolations([{ uses: 'actions/upload-artifact@v4', with: { name: 'x' } }])
    expect(v).toEqual(['actions/upload-artifact@v4 低于 node24 起算的最低主版本 v6'])
  })

  it('异常：ref 用 @main / @sha 一律判违规（内容可变）', () => {
    expect(findStepViolations([{ uses: 'actions/upload-artifact@main' }])).toEqual([
      'actions/upload-artifact 未使用主版本号（实际 actions/upload-artifact@main）'
    ])
    expect(findStepViolations([{ uses: 'actions/checkout@abc123def' }])).toEqual([
      'actions/checkout 未使用主版本号（实际 actions/checkout@abc123def）'
    ])
  })

  it('边界：v7 新入参 archive 被接受；拼错的键判违规；同 job 产物重名判违规', () => {
    expect(
      findStepViolations([
        { uses: 'actions/upload-artifact@v7', with: { name: 'a', archive: false } }
      ])
    ).toEqual([])
    expect(
      findStepViolations([
        { uses: 'actions/upload-artifact@v7', with: { name: 'a', 'retention-days-2': 7 } }
      ])
    ).toEqual(['actions/upload-artifact 不认的入参键：retention-days-2'])
    expect(
      findStepViolations([
        { uses: 'actions/upload-artifact@v7', with: { name: 'dup' } },
        { uses: 'actions/upload-artifact@v7', with: { name: 'dup' } }
      ])
    ).toEqual(['同一 job 内产物重名：dup'])
  })

  it('边界：未被 MIN_MAJOR 覆盖的 action 只校验 ref 形态，不臆造版本要求', () => {
    expect(findStepViolations([{ uses: 'actions/checkout@v5' }])).toEqual([])
  })

  it('真实契约：build.yml 全部 action 必须落在 node24 主版本线上且入参合法', () => {
    const jobs = readJobs(readFileSync(workflowPath, 'utf-8'))
    const violations = Object.entries(jobs).flatMap(([jobId, steps]) =>
      findStepViolations(steps).map((v) => `${jobId}: ${v}`)
    )
    expect(
      violations,
      `以下 action 仍指向被弃用的 Node 20 运行时（CI 会打 warning 并由 runner 强制升版执行）：\n${violations.join('\n')}`
    ).toEqual([])
  })
})
