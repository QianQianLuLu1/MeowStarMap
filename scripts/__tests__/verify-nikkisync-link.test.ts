import { describe, expect, it } from 'vitest'
import path from 'node:path'

import {
  CHAIN_REQUIRED_ARTIFACTS,
  NIKKISYNC_CAPABILITY_ARTIFACTS,
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
const SYNC_SERVER_CHECK = '@nikkisync/pc-companion ships the local sync server artifacts'
const METADATA_CHECK = '@nikkisync/pc-companion ships the metadata resolver artifacts'
const CAPABILITY_CHECK = '@nikkisync/pc-companion ships the capability deep-entry artifacts'
const CHAIN_CHECK = '@nikkisync/pc-companion ships the load-chain static dependency artifacts'
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

  it('异常：已链接但缺同步服务器产物时硬阻断并给出修复动作（阶段3）', () => {
    const checks = evaluateNikkiSyncLink(
      facts({ syncServerArtifactsMissing: ['dist\\src\\wechat\\GalleryRuntime.mjs'] })
    )
    expect(failing(checks)).toContain(SYNC_SERVER_CHECK)
    expect(find(checks, SYNC_SERVER_CHECK)?.detail).toContain('GalleryRuntime.mjs')
    expect(find(checks, SYNC_SERVER_CHECK)?.detail).toContain('npm run build')
  })

  it('正常：同步服务器产物齐备时该检查通过（阶段3）', () => {
    const checks = evaluateNikkiSyncLink(facts({ syncServerArtifactsMissing: [] }))
    expect(failing(checks)).toEqual([])
    expect(find(checks, SYNC_SERVER_CHECK)?.ok).toBe(true)
  })

  it('边界：事实未提供该字段时整条检查缺席（旧调用方不受影响）', () => {
    const checks = evaluateNikkiSyncLink(facts())
    expect(find(checks, SYNC_SERVER_CHECK)).toBeUndefined()
  })

  it('异常：已链接但缺元数据深入口产物时硬阻断并点名文件（阶段6）', () => {
    const checks = evaluateNikkiSyncLink(
      facts({ metadataArtifactsMissing: ['dist\\src\\metadata\\Nuan5CompatibleResolver.js'] })
    )
    expect(failing(checks)).toContain(METADATA_CHECK)
    const detail = find(checks, METADATA_CHECK)?.detail
    expect(detail).toContain('Nuan5CompatibleResolver.js')
    expect(detail).toContain('npm run build')
  })

  it('正常：元数据深入口产物齐备时该检查通过（阶段6）', () => {
    const checks = evaluateNikkiSyncLink(facts({ metadataArtifactsMissing: [] }))
    expect(failing(checks)).toEqual([])
    expect(find(checks, METADATA_CHECK)?.ok).toBe(true)
  })

  it('边界：元数据事实字段缺省时整条检查缺席（阶段6）', () => {
    const checks = evaluateNikkiSyncLink(facts())
    expect(find(checks, METADATA_CHECK)).toBeUndefined()
  })

  it('异常：已链接但缺能力深入口产物时硬阻断并点名文件（兼容层 b422193 同步）', () => {
    const checks = evaluateNikkiSyncLink(
      facts({ capabilityArtifactsMissing: ['dist\\src\\organizer\\DeletionQueue.js'] })
    )
    expect(failing(checks)).toContain(CAPABILITY_CHECK)
    const detail = find(checks, CAPABILITY_CHECK)?.detail
    expect(detail).toContain('DeletionQueue.js')
    expect(detail).toContain('npm run build')
  })

  it('正常：能力深入口产物齐备时该检查通过（兼容层 b422193 同步）', () => {
    const checks = evaluateNikkiSyncLink(facts({ capabilityArtifactsMissing: [] }))
    expect(failing(checks)).toEqual([])
    expect(find(checks, CAPABILITY_CHECK)?.ok).toBe(true)
  })

  it('边界：能力事实字段缺省时整条检查缺席（兼容层）', () => {
    const checks = evaluateNikkiSyncLink(facts())
    expect(find(checks, CAPABILITY_CHECK)).toBeUndefined()
  })

  it('边界：未链接时该检查降为 warn 的 skipped，不阻断（兼容层）', () => {
    const checks = evaluateNikkiSyncLink(
      facts({
        installedLinks: [],
        builtArtifacts: [],
        linkTargets: [],
        migrationSqlPresent: false,
        capabilityArtifactsMissing: []
      })
    )
    const capability = find(checks, CAPABILITY_CHECK)
    expect(capability?.ok).toBe(true)
    expect(capability?.level).toBe('warn')
    expect(capability?.detail).toContain('skipped')
    expect(failing(checks)).toEqual([])
  })

  it('异常：已链接但缺装载链传递依赖时硬阻断并点名文件（上游 b397e0e 同步）', () => {
    const checks = evaluateNikkiSyncLink(
      facts({ chainArtifactsMissing: ['dist\\src\\server\\MediaFingerprint.js'] })
    )
    expect(failing(checks)).toContain(CHAIN_CHECK)
    const detail = find(checks, CHAIN_CHECK)?.detail
    expect(detail).toContain('MediaFingerprint.js')
    expect(detail).toContain('npm run build')
  })

  it('正常：装载链传递依赖齐备时该检查通过并点名清单（上游 b397e0e 同步）', () => {
    const checks = evaluateNikkiSyncLink(facts({ chainArtifactsMissing: [] }))
    expect(failing(checks)).toEqual([])
    expect(find(checks, CHAIN_CHECK)?.ok).toBe(true)
    expect(find(checks, CHAIN_CHECK)?.detail).toContain('present:')
  })

  it('边界：装载链事实字段缺省时整条检查缺席（不凭空造断言）', () => {
    const checks = evaluateNikkiSyncLink(facts())
    expect(find(checks, CHAIN_CHECK)).toBeUndefined()
  })

  it('边界：未链接时装载链检查即便有缺件也降为 warn 的 skipped，不阻断（受支持默认态）', () => {
    const checks = evaluateNikkiSyncLink(
      facts({
        installedLinks: [],
        builtArtifacts: [],
        linkTargets: [],
        migrationSqlPresent: false,
        chainArtifactsMissing: ['dist\\src\\server\\MediaFingerprint.js']
      })
    )
    const chain = find(checks, CHAIN_CHECK)
    expect(chain?.ok).toBe(true)
    expect(chain?.level).toBe('warn')
    expect(chain?.detail).toContain('skipped')
    expect(failing(checks)).toEqual([])
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

describe('NIKKISYNC_CAPABILITY_ARTIFACTS 结构契约（兼容层 b422193 同步）', () => {
  it('恰好 7 个能力深入口产物，逐项钉死（pre-dist-check 打包断言共用此表）', () => {
    expect(NIKKISYNC_CAPABILITY_ARTIFACTS).toEqual([
      path.join('dist', 'src', 'organizer', 'DeletionQueue.js'),
      path.join('dist', 'src', 'scanner', 'ExtraScanDirectories.js'),
      path.join('dist', 'src', 'scanner', 'ScanDiagnostics.js'),
      path.join('dist', 'src', 'metadata', 'CachedDecodedMetadataService.js'),
      path.join('dist', 'src', 'metadata', 'MetadataOnlineConsent.js'),
      path.join('dist', 'src', 'server', 'LanAddress.js'),
      path.join('dist', 'src', 'server', 'GameVersionCalendar.js')
    ])
  })
})

describe('CHAIN_REQUIRED_ARTIFACTS 结构契约（上游 b397e0e 同步）', () => {
  it('恰好 3 个本轮被静态 import 推入本仓装载链的上游新模块，逐项钉死', () => {
    // 判据「被静态 import 且已在本仓装载链上」，逐条对应实测 import 边：
    //   row-mappers.js:3 -> ./MediaFingerprint.js（本仓深入口 ROW_MAPPER_DEEP_ENTRY 的依赖）
    //   LocalSyncServer.js -> ./AccountSyncSettings.js（该文件已闸门，此依赖原先无人点名）
    //   runtime.js -> ./organizer/NativeMediaOperations.js（在桶导出 index.js 的闭包内）
    expect(CHAIN_REQUIRED_ARTIFACTS).toEqual([
      path.join('dist', 'src', 'server', 'MediaFingerprint.js'),
      path.join('dist', 'src', 'server', 'AccountSyncSettings.js'),
      path.join('dist', 'src', 'organizer', 'NativeMediaOperations.js')
    ])
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
