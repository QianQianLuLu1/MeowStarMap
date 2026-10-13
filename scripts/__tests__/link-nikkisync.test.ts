import { describe, it, expect } from 'vitest'
import path from 'node:path'

import {
  NIKKISYNC_PACKAGE_DIRS,
  planLinks,
  resolveNikkiSyncRoot,
  toRootCandidates,
  validateRequiredSubpaths,
  type RootCandidate
} from '../link-nikkisync'

/**
 * link-nikkisync 纯函数单测（阶段 9 · 问题 2）。
 *
 * 自包含方案下 `@nikkisync/*` 不再是声明依赖，开发机链接由本脚本建立；
 * 这里只测推导逻辑（不触磁盘），真实建链由 `npm run link:nikkisync` 现场执行，
 * 因此本文件在 CI（无 ../NikkiSync）下同样可跑。
 *
 *   正常 — 候选根解析、缺失链接判 create、同目标链接判 skip
 *   异常 — 无可用根时逐项给出拒绝原因、必需子目录缺失即拒绝该根、非法子路径直接抛错
 *   边界 — 空 NIKKISYNC_ROOT 被忽略、env 优先于 sibling、链接指向别处判 replace
 */

const SUBPATHS = Object.values(NIKKISYNC_PACKAGE_DIRS)

/** 被测实现用 path.join 拼路径，测试侧同口径构造期望值（跨盘符分隔符差异不参与断言）。 */
const jp = (...segments: string[]): string => path.join(...segments)

/** 由「存在的目录集合」构造 isDirectory 替身。 */
function dirSet(dirs: string[]): (p: string) => boolean {
  return (p: string) => dirs.includes(p)
}

/** 链接现状夹具条目（对应 planLinks 的两个注入回调返回值）。 */
interface LinkState {
  exists: boolean
  target?: string
}

describe('toRootCandidates', () => {
  it('正常：按 env → sibling → vendor 顺序生成候选并标注来源', () => {
    const candidates = toRootCandidates({
      projectRoot: '/work/XiangCe',
      envRoot: '/opt/NikkiSync'
    })
    expect(candidates.map((c) => c.source)).toEqual(['env', 'sibling', 'vendor'])
    expect(candidates.map((c) => c.path)).toEqual([
      path.resolve('/opt/NikkiSync'),
      jp('/work/XiangCe', '..', 'NikkiSync'),
      jp('/work/XiangCe', 'vendor', 'NikkiSync')
    ])
  })

  it('边界：空串或纯空白的 NIKKISYNC_ROOT 被忽略', () => {
    const candidates = toRootCandidates({ projectRoot: '/work/XiangCe', envRoot: '   ' })
    expect(candidates.map((c) => c.source)).toEqual(['sibling', 'vendor'])
  })
})

describe('resolveNikkiSyncRoot', () => {
  it('正常：首个含全部包目录的候选成为根', () => {
    const candidates: RootCandidate[] = [
      { path: '/abs/ns', source: 'env' },
      { path: '/abs/sibling', source: 'sibling' }
    ]
    const result = resolveNikkiSyncRoot(
      candidates,
      dirSet(SUBPATHS.map((sub) => jp('/abs/ns', sub)))
    )
    expect(result.root).toBe('/abs/ns')
    expect(result.source).toBe('env')
    expect(result.rejected).toEqual([])
  })

  it('异常：候选目录缺少任一包目录即拒绝，并记录缺失项', () => {
    const candidates: RootCandidate[] = [{ path: '/abs/ns', source: 'env' }]
    const result = resolveNikkiSyncRoot(candidates, dirSet([jp('/abs/ns', 'packages/core')]))
    expect(result.root).toBeUndefined()
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]?.reason).toContain('apps/pc-companion')
  })

  it('异常：无候选可用时 root 为空且拒绝清单为空（调用方据此给出修复指令）', () => {
    const result = resolveNikkiSyncRoot([], () => false)
    expect(result.root).toBeUndefined()
    expect(result.rejected).toEqual([])
  })

  it('边界：多候选同时可用时按声明优先级取首个（sibling 先于 vendor）', () => {
    const sibling = jp('/work/XiangCe', '..', 'NikkiSync')
    const vendor = jp('/work/XiangCe', 'vendor', 'NikkiSync')
    const dirs = [
      ...SUBPATHS.map((sub) => jp(sibling, sub)),
      ...SUBPATHS.map((sub) => jp(vendor, sub))
    ]
    const candidates = toRootCandidates({ projectRoot: '/work/XiangCe' })
    expect(resolveNikkiSyncRoot(candidates, dirSet(dirs)).root).toBe(sibling)
  })
})

describe('validateRequiredSubpaths', () => {
  it('异常：包含 .. 逃逸或绝对路径的子路径直接抛错（不进入 fs 调用）', () => {
    expect(() => validateRequiredSubpaths(['packages/../etc'])).toThrow(/illegal subpath/)
    expect(() => validateRequiredSubpaths(['/abs/packages/core'])).toThrow(/illegal subpath/)
    expect(() => validateRequiredSubpaths([])).toThrow(/empty/)
  })

  it('正常：现有四个包目录形态全部合法', () => {
    expect(() => validateRequiredSubpaths(SUBPATHS)).not.toThrow()
  })
})

describe('planLinks', () => {
  const root = '/work/NikkiSync'
  const projectRoot = '/work/XiangCe'

  it('正常：链接不存在判 create，目标已一致判 skip', () => {
    const states: Record<string, LinkState> = {
      '@nikkisync/core': { exists: false },
      '@nikkisync/database': { exists: true, target: jp('/work/NikkiSync', 'packages/database') }
    }
    const plan = planLinks({
      root,
      projectRoot,
      realPathOf: (name) => states[name]?.target,
      linkExists: (name) => states[name]?.exists === true
    })
    const byName = Object.fromEntries(plan.map((item) => [item.name, item.action]))
    expect(byName['@nikkisync/core']).toBe('create')
    expect(byName['@nikkisync/database']).toBe('skip')
    expect(byName['@nikkisync/protocol']).toBe('create')
    expect(plan.find((item) => item.name === '@nikkisync/core')?.target).toBe(
      jp('/work/NikkiSync', 'packages/core')
    )
  })

  it('边界：链接存在但指向别处判 replace（并保留旧目标供日志回滚线索）', () => {
    const plan = planLinks({
      root,
      projectRoot,
      realPathOf: () => '/stale/place',
      linkExists: (name) => name === '@nikkisync/protocol'
    })
    const protocol = plan.find((item) => item.name === '@nikkisync/protocol')
    expect(protocol?.action).toBe('replace')
    expect(protocol?.currentTarget).toBe('/stale/place')
    expect(plan.filter((item) => item.action === 'create')).toHaveLength(3)
  })

  it('异常：根为空时不产生任何计划（调用方必须先解析出根）', () => {
    expect(
      planLinks({ root: '', projectRoot, realPathOf: () => undefined, linkExists: () => false })
    ).toEqual([])
  })
})
