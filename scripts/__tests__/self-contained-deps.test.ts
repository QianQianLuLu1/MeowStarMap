import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  collectOutOfRepoSpecs,
  evaluateNikkiSyncLink,
  type NikkiSyncLinkFacts
} from '../verify-nikkisync-link'

/**
 * 依赖图自包含守护（阶段 9 · 问题 2）。
 *
 * 背景：`file:../NikkiSync/...` 四条声明依赖让 CI（只 checkout 本仓）的 `npm ci` 必然失败，
 * 也让 `tsc -b` 在开发机缺失同级仓库时报 4×TS2307
 * （取证见 docs/sync-integration/09-legacy-debt-remediation-plan.md §0）。
 * 本文件把「XiangCe 必须能独立安装 / 独立编译」固化为契约：
 *   正常 — 真实 package.json 无仓库外 file: 依赖，且打包面 / 解包面仍覆盖 @nikkisync
 *   异常 — 一旦重新声明仓库外本地依赖，诊断给出 blocking fail
 *   边界 — `workspace:` 同口径判失败；仓内 file:（不逃逸仓库）不在守护范围
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

interface PackageJsonShape {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  build?: {
    files?: Array<string | { from?: string; to?: string; filter?: unknown }>
    asarUnpack?: string[]
  }
}

function readPackageJson(): PackageJsonShape {
  return JSON.parse(
    readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
  ) as PackageJsonShape
}

/** 与 scripts/__tests__/verify-nikkisync-link.test.ts 同款基线：全部事实成立。 */
function readyFacts(overrides: Partial<NikkiSyncLinkFacts> = {}): NikkiSyncLinkFacts {
  return {
    externalFileSpecs: [],
    installedLinks: [],
    builtArtifacts: [],
    migrationSqlPresent: false,
    linkTargets: [],
    nodeMajor: 26,
    sqliteImportable: true,
    electronVersion: '41.10.6',
    buildFoldHits: 0,
    packedMigrationsReadable: null,
    ...overrides
  }
}

describe('package.json 依赖图自包含', () => {
  it('正常：真实 package.json 没有任何指向仓库外的本地依赖', () => {
    expect(collectOutOfRepoSpecs(readPackageJson() as Record<string, unknown>)).toEqual([])
  })

  it('正常：@nikkisync/* 不在 dependencies 中（链接改由 npm run link:nikkisync 建立）', () => {
    const deps = readPackageJson().dependencies ?? {}
    const declared = Object.keys(deps).filter((name) => name.startsWith('@nikkisync/'))
    expect(declared).toEqual([])
  })

  it('正常：链接态的打包面与解包面仍覆盖 @nikkisync（否则产物内必然缺包）', () => {
    const build = readPackageJson().build ?? {}
    // 对象式 from/to 是唯一真能入包的形态：electron-builder 的过滤器对根 node_modules
    // 有硬排除（filter.js：relative === "node_modules" 直接 false），字符串模式
    // node_modules/@nikkisync 通配项永远命中不了任何文件（2026-10-15 实测，装机验证
    // 见 scripts/pre-dist-check.ts nikkiSyncPackedVerdict 注释）。故本守卫断言对象式
    // 入包项存在且锚点正确——字符串模式若回归，本用例随之失败。
    const nikkisyncEntry = (build.files ?? []).find(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        String((entry as { from?: unknown }).from ?? '').replace(/\\/g, '/') ===
          'node_modules/@nikkisync'
    ) as { from?: string; to?: string; filter?: unknown } | undefined
    expect(
      nikkisyncEntry,
      'build.files 缺少 @nikkisync 对象式入包项（from: node_modules/@nikkisync）'
    ).toBeDefined()
    expect(String(nikkisyncEntry?.to ?? '').replace(/\\/g, '/')).toBe('node_modules/@nikkisync')
    expect(Array.isArray(nikkisyncEntry?.filter) && nikkisyncEntry?.filter.length > 0).toBe(true)
    expect(build.asarUnpack ?? []).toContain('**/@nikkisync/**')
  })

  it('异常：重新声明 file:../ 依赖时诊断给出 blocking fail', () => {
    const checks = evaluateNikkiSyncLink(
      readyFacts({
        externalFileSpecs: ['@nikkisync/core@file:../NikkiSync/packages/core']
      })
    )
    const blocking = checks
      .filter((check) => check.ok === false && (check.level ?? 'fail') === 'fail')
      .map((check) => check.name)
    expect(blocking).toContain('dependency graph is self-contained (no out-of-repo file: specs)')
  })

  it('边界：workspace: 同口径判逃逸，仓内 file: 不在守护范围', () => {
    expect(collectOutOfRepoSpecs({ dependencies: { x: 'file:../vendor/x' } })).toEqual([
      'x@file:../vendor/x'
    ])
    expect(collectOutOfRepoSpecs({ devDependencies: { y: 'workspace:*' } })).toEqual([
      'y@workspace:*'
    ])
    expect(
      collectOutOfRepoSpecs({ optionalDependencies: { z: 'file:plugins-samples/z' } })
    ).toEqual([])
  })

  it('边界：真实 package.json 喂入诊断时不产生该 blocking 项', () => {
    const checks = evaluateNikkiSyncLink(
      readyFacts({
        externalFileSpecs: collectOutOfRepoSpecs(readPackageJson() as Record<string, unknown>)
      })
    )
    const selfCheck = checks.find(
      (check) => check.name === 'dependency graph is self-contained (no out-of-repo file: specs)'
    )
    expect(selfCheck?.ok).toBe(true)
  })
})
