import { describe, expect, it } from 'vitest'

import {
  NIKKISYNC_PACKAGE_NAMES,
  collectOutOfRepoSpecs,
  evaluateNikkiSyncLink,
  type NikkiSyncLinkFacts
} from '../verify-nikkisync-link'

/**
 * verify-nikkisync-link 纯函数单测（阶段 1 建立，阶段 9 按自包含口径重写）。
 * 只测推导逻辑，不触磁盘：链接是否真的成立由 npm run verify:nikkisync 现场判定，
 * 因此本文件在 CI（无 ../NikkiSync）下同样可跑。
 *
 *   正常 — 未链接默认态与"已链接且产物齐"都不产生 blocking
 *   异常 — 依赖图逃逸仓库 / 折叠成 require / 打包缺 schema 文件 三项各自硬阻断
 *   边界 — 半链接只告警；未构建产物与未打包时对应项跳过判定
 */

const SELF_CHECK = 'dependency graph is self-contained (no out-of-repo file: specs)'
const LINKS_CHECK = 'node_modules/@nikkisync/* links are installed'
const ARTIFACTS_CHECK = 'each linked package ships compiled dist/src/index.js + index.d.ts'
const MIGRATIONS_CHECK = '@nikkisync/database migrations/0001_initial.sql is readable'
const FOLD_CHECK = 'main-process bundles do not fold @nikkisync into require()'
const PACKED_CHECK = 'packed app.asar.unpacked ships @nikkisync/database migrations'
const DISCOVER_CHECK = 'a NikkiSync checkout is discoverable for linking'

/** 全部事实成立（默认按"已链接 + 产物齐"取满值）。 */
function facts(overrides: Partial<NikkiSyncLinkFacts> = {}): NikkiSyncLinkFacts {
  return {
    externalFileSpecs: [],
    installedLinks: [...NIKKISYNC_PACKAGE_NAMES],
    builtArtifacts: [...NIKKISYNC_PACKAGE_NAMES],
    migrationSqlPresent: true,
    linkTargets: NIKKISYNC_PACKAGE_NAMES.map((name) => `${name} -> /abs/${name}`),
    nodeMajor: 26,
    sqliteImportable: true,
    electronVersion: '41.10.6',
    buildFoldHits: 0,
    packedMigrationsReadable: null,
    ...overrides
  }
}

function failing(checks: ReturnType<typeof evaluateNikkiSyncLink>): string[] {
  return checks
    .filter((check) => check.ok === false && (check.level ?? 'fail') === 'fail')
    .map((check) => check.name)
}

function find(checks: ReturnType<typeof evaluateNikkiSyncLink>, name: string) {
  return checks.find((check) => check.name === name)
}

describe('evaluateNikkiSyncLink', () => {
  it('正常：已链接且产物齐时无阻断失败', () => {
    expect(failing(evaluateNikkiSyncLink(facts()))).toEqual([])
  })

  it('正常：未链接是受支持的默认态（warn，不阻断）', () => {
    const checks = evaluateNikkiSyncLink(
      facts({ installedLinks: [], builtArtifacts: [], linkTargets: [], migrationSqlPresent: false })
    )
    expect(failing(checks)).toEqual([])
    const links = find(checks, LINKS_CHECK)
    expect(links?.ok).toBe(true)
    expect(links?.level).toBe('warn')
    expect(links?.detail).toContain('npm run link:nikkisync')
    // 未链接时产物/SQL 两项不做判定，不能谎报失败
    expect(find(checks, ARTIFACTS_CHECK)?.detail).toContain('skipped')
    expect(find(checks, MIGRATIONS_CHECK)?.detail).toContain('skipped')
  })

  it('异常：依赖图仍声明仓库外本地依赖时硬阻断', () => {
    const checks = evaluateNikkiSyncLink(
      facts({ externalFileSpecs: ['@nikkisync/core@file:../NikkiSync/packages/core'] })
    )
    expect(failing(checks)).toContain(SELF_CHECK)
    expect(find(checks, SELF_CHECK)?.detail).toContain('npm run link:nikkisync')
  })

  it('异常：产物被折叠成 require 时硬阻断并给出命中数', () => {
    const checks = evaluateNikkiSyncLink(facts({ buildFoldHits: 2 }))
    expect(failing(checks)).toContain(FOLD_CHECK)
    expect(find(checks, FOLD_CHECK)?.detail).toContain('2 require("@nikkisync hit(s)')
  })

  it('异常：已打包但 unpacked 树里缺 @nikkisync 迁移 SQL 时硬阻断', () => {
    const checks = evaluateNikkiSyncLink(facts({ packedMigrationsReadable: false }))
    expect(failing(checks)).toContain(PACKED_CHECK)
    expect(find(checks, PACKED_CHECK)?.detail).toContain('build.files')
  })

  it('异常：已链接但 NikkiSync 未编译 / 缺 schema 时报出可执行修复指令', () => {
    const checks = evaluateNikkiSyncLink(
      facts({ builtArtifacts: ['@nikkisync/core'], migrationSqlPresent: false })
    )
    expect(find(checks, ARTIFACTS_CHECK)?.detail).toContain('npm run build')
    expect(failing(checks)).toContain(MIGRATIONS_CHECK)
  })

  it('边界：半链接（部分包缺失）只告警，不阻断', () => {
    const checks = evaluateNikkiSyncLink(
      facts({ installedLinks: ['@nikkisync/core'], builtArtifacts: ['@nikkisync/core'] })
    )
    const links = find(checks, LINKS_CHECK)
    expect(links?.ok).toBe(false)
    expect(links?.level).toBe('warn')
    expect(links?.detail).toContain('@nikkisync/database')
  })

  it('边界：未构建产物 / 未打包时对应项跳过判定（不把缺失当失败）', () => {
    const checks = evaluateNikkiSyncLink(facts({ buildFoldHits: null }))
    expect(failing(checks)).toEqual([])
    expect(find(checks, FOLD_CHECK)?.detail).toContain('not built yet')
    expect(find(checks, PACKED_CHECK)?.level).toBe('warn')
  })

  it('边界：未链接时残留的旧 release（packed 缺 SQL）不判失败', () => {
    const checks = evaluateNikkiSyncLink(
      facts({
        installedLinks: [],
        builtArtifacts: [],
        linkTargets: [],
        migrationSqlPresent: false,
        packedMigrationsReadable: false
      })
    )
    expect(failing(checks)).toEqual([])
    const packed = find(checks, PACKED_CHECK)
    expect(packed?.ok).toBe(true)
    expect(packed?.level).toBe('warn')
    expect(packed?.detail).toContain('embedding lane inactive')
  })

  it('边界：未链接但本地找得到 NikkiSync 检出时，discover 项给出可执行路径', () => {
    const checks = evaluateNikkiSyncLink(
      facts({
        installedLinks: [],
        builtArtifacts: [],
        linkTargets: [],
        candidateRoot: '/abs/NikkiSync'
      })
    )
    const discover = find(checks, DISCOVER_CHECK)
    expect(discover?.ok).toBe(true)
    expect(discover?.level).toBe('warn')
    expect(discover?.detail).toContain('/abs/NikkiSync')
    expect(discover?.detail).toContain('npm run link:nikkisync')
    expect(failing(checks)).toEqual([])
  })

  it('边界：未链接且找不到任何检出时 discover 项告警但仍不阻断', () => {
    const checks = evaluateNikkiSyncLink(
      facts({ installedLinks: [], builtArtifacts: [], linkTargets: [], candidateRoot: undefined })
    )
    const discover = find(checks, DISCOVER_CHECK)
    expect(discover?.ok).toBe(false)
    expect(discover?.level).toBe('warn')
    expect(discover?.detail).toContain('NIKKISYNC_ROOT')
    expect(failing(checks)).toEqual([])
  })

  it('边界：已链接时 discover 项跳过判定（候选根已无关）', () => {
    const checks = evaluateNikkiSyncLink(facts({ candidateRoot: '/abs/NikkiSync' }))
    const discover = find(checks, DISCOVER_CHECK)
    expect(discover?.ok).toBe(true)
    expect(discover?.detail).toContain('skipped')
  })

  it('边界：node:sqlite 在旧 Node 下只降级为 warn，不阻断', () => {
    const checks = evaluateNikkiSyncLink(facts({ nodeMajor: 22, sqliteImportable: false }))
    const sqliteCheck = find(checks, 'diagnostic host can import node:sqlite')
    expect(sqliteCheck?.ok).toBe(false)
    expect(sqliteCheck?.level).toBe('warn')
    expect(failing(checks)).toEqual([])
  })
})

describe('collectOutOfRepoSpecs', () => {
  it('正常：三个声明面合并后无逃逸 spec 时返回空数组', () => {
    expect(
      collectOutOfRepoSpecs({
        dependencies: { zod: '^4.4.3' },
        devDependencies: { typescript: '^5.9.3' },
        optionalDependencies: { '@img/sharp-libvips-win32-x64': '^1.3.2' }
      })
    ).toEqual([])
  })

  it('异常：file:../ 与 workspace: 形态一律判逃逸并保留包名与 spec', () => {
    expect(
      collectOutOfRepoSpecs({
        dependencies: { '@nikkisync/core': 'file:../NikkiSync/packages/core' },
        devDependencies: { 'local-tool': 'workspace:*' }
      })
    ).toEqual(['@nikkisync/core@file:../NikkiSync/packages/core', 'local-tool@workspace:*'])
  })

  it('边界：仓内 file:（不逃逸）、非字符串 spec、缺失声明面都不炸', () => {
    expect(collectOutOfRepoSpecs({ dependencies: { local: 'file:tools/local' } })).toEqual([])
    expect(collectOutOfRepoSpecs({ dependencies: { weird: 42 as unknown as string } })).toEqual([])
    expect(collectOutOfRepoSpecs({})).toEqual([])
  })
})
