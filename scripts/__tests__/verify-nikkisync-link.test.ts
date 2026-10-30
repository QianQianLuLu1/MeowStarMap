import { describe, expect, it } from 'vitest'
import fs, { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CHAIN_REQUIRED_ARTIFACTS,
  LOAD_CHAIN_ROOTS,
  NIKKISYNC_CAPABILITY_ARTIFACTS,
  NIKKISYNC_PACKAGE_NAMES,
  closureLoadChain,
  collectOutOfRepoSpecs,
  describeLoadChainClosure,
  evaluateNikkiSyncLink,
  type NikkiSyncLinkFacts
} from '../verify-nikkisync-link'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

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

// ===== 装载链闭包（DEBT-040 收口：人工点名清单 → 按 import 图派生闭包）=====
// 回归背景：四张点名清单只能覆盖「已知的那几条边」。上游每加一条静态依赖就得回来补表，
// 漏补一次的后果是「verify:nikkisync 与 pre-dist-check 双双全绿，运行期才 ERR_MODULE_NOT_FOUND」
// （2026-10-29 那轮的 R4 形状，实测装载链 50 个模块里只有 19 个被点名）。闭包判据不需要补表：
// 它逐条相对边验目标文件在不在。
//
// 如实限定保护面（勿夸大，与 docs/技术债清单.md DEBT-040 同一口径）：`build.files` 以
// `from: node_modules/@nikkisync` + `filter: ['**/*']` 整树搬运、`asarUnpack` 含 `**/@nikkisync/**`，
// 所以「打包时单文件漏解包」今天结构上不可能发生。本判据拦的是**上游构建产物本身就缺件**
// （只跑了 tsc 没跑 esbuild、增量构建掉件等），不得在文档里写成「防止漏文件」。
//
// 覆盖面交代：下面 12 个虚拟树用例在 CI（ubuntu-latest，无 ../NikkiSync）同样跑；
// 唯一读真实产物树的「真实树读数」用例按链接在位门控，未建链时判 skip 并打印理由——
// 与仓内 `*.linked.test.ts` 同一形制，不是用 skip 换绿。

const CLOSURE_CHECK =
  '@nikkisync/pc-companion load chain closure resolves (every relative import target exists)'

/**
 * 测试侧的相对说明符推导：只用正斜杠切拼，不读宿主分隔符语义 ⇒ Windows 开发机与 ubuntu CI
 * 得到同一串键，因此无须在 `path-semantics-guard.test.ts` 登记（约定 §6 的第 1 档：只当键用）。
 */
function posixResolve(from: string, specifier: string): string {
  const segments = from.split('/')
  segments.pop()
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') segments.pop()
    else segments.push(part)
  }
  return segments.join('/')
}

/** 虚拟树：表里没有的相对路径即「文件不存在」；值本身是模块源码 */
function runClosure(
  files: Record<string, string>,
  roots: readonly string[] = ['dist/src/index.js']
) {
  return closureLoadChain(
    roots,
    (relative) => (relative in files ? (files[relative] as string) : null),
    posixResolve,
    (relative) => relative in files
  )
}

describe('closureLoadChain — 按 import 图派生装载链闭包', () => {
  it('正常：链上目标齐 ⇒ 零缺件、零读不动，visited 覆盖全部可达模块', () => {
    const result = runClosure({
      'dist/src/index.js': "export * from './src/a.js'\n",
      'dist/src/src/a.js': "import { b } from './b.js'\nexport const a = b\n",
      'dist/src/src/b.js': 'export const b = 2\n'
    })
    expect(result.dangling).toEqual([])
    expect(result.unreadable).toEqual([])
    expect(result.visited).toBe(3)
  })

  it('正常：八种相对引用写法都算边（少认一种就是漏判覆盖面）', () => {
    const target = (name: string): string => `dist/src/src/${name}.js`
    const files: Record<string, string> = {}
    for (const name of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']) {
      files[target(name)] = 'export const x = 1\n'
    }
    files['dist/src/index.js'] = [
      "import d from './src/m1.js'",
      "import { a } from './src/m2.js'",
      "import * as ns from './src/m3.js'",
      "import './src/m4.js'",
      "export { b } from './src/m5.js'",
      "export * from './src/m6.js'",
      "const c = require('./src/m7.js')",
      "const p = import('./src/m8.js')"
    ].join('\n')
    const result = runClosure(files)
    expect(result.dangling).toEqual([])
    // 根 + 八个目标 = 9；写漏任何一种写法都会少一个 visited（防恒绿的读数锚）
    expect(result.visited).toBe(9)
  })

  it('异常：import from 的目标缺失 ⇒ 点名「谁引用了哪条边」（修复前无判定核，此形状恒绿）', () => {
    const result = runClosure({
      'dist/src/index.js': "export * from './src/a.js'\n",
      'dist/src/src/a.js': "import { m } from './missing.js'\nexport const a = m\n"
    })
    expect(result.dangling).toEqual([{ from: 'dist/src/src/a.js', specifier: './missing.js' }])
  })

  it('异常：export-from / require() / 动态 import() 三种写法的缺件同样逐条点名', () => {
    const result = runClosure({
      'dist/src/index.js': [
        "export { x } from './gone1.js'",
        "const y = require('./gone2.js')",
        "const z = import('./gone3.js')"
      ].join('\n')
    })
    expect(result.dangling).toEqual([
      { from: 'dist/src/index.js', specifier: './gone1.js' },
      { from: 'dist/src/index.js', specifier: './gone2.js' },
      { from: 'dist/src/index.js', specifier: './gone3.js' }
    ])
  })

  it('异常：文件存在但读不动 ⇒ 记进 unreadable，不得当成「没有出边」静默放行', () => {
    const result = closureLoadChain(
      ['dist/src/index.js'],
      () => null,
      posixResolve,
      () => true
    )
    expect(result.unreadable).toEqual(['dist/src/index.js'])
    expect(result.dangling).toEqual([])
    expect(describeLoadChainClosure(result)).toContain('unreadable')
  })

  it('边界：注释里的示例路径不判为边（行注释与块注释两种形态）', () => {
    const result = runClosure({
      'dist/src/index.js': [
        "// 修法示例：import x from './not-an-edge-1.js'",
        "/* 历史：require('./not-an-edge-2.js') 曾在此 */",
        'export const a = 1'
      ].join('\n')
    })
    expect(result.dangling).toEqual([])
    expect(result.visited).toBe(1)
  })

  it('边界：裸包名、node: 前缀与绝对 URL 都不入闭包', () => {
    const result = runClosure({
      'dist/src/index.js': [
        "import fs from 'node:fs'",
        "import { db } from '@nikkisync/database'",
        "import _ from 'lodash'",
        "import u from 'file:///abs/x.js'"
      ].join('\n')
    })
    expect(result.dangling).toEqual([])
    expect(result.visited).toBe(1)
  })

  it('边界：环与共享子图只计一次，不重复入队也不死循环', () => {
    const result = runClosure({
      'dist/src/index.js': "import './src/a.js'\nimport './src/b.js'\n",
      'dist/src/src/a.js': "import { b } from './b.js'\nimport { c } from './c.js'\n",
      'dist/src/src/b.js': "import { a } from './a.js'\nimport { c } from './c.js'\n",
      'dist/src/src/c.js': "import { a } from './a.js'\n"
    })
    expect(result.dangling).toEqual([])
    expect(result.visited).toBe(4)
  })

  it('边界：根清单里的根自身缺失 ⇒ 以 <root> 点名（深入口没产出时不能只报「无」）', () => {
    const result = runClosure({ 'dist/src/index.js': 'export const a = 1\n' }, [
      'dist/src/index.js',
      'dist/src/server/row-mappers.js'
    ])
    expect(result.dangling).toEqual([
      { from: '<root>', specifier: 'dist/src/server/row-mappers.js' }
    ])
  })

  it('读数文案：干净时给模块数与根数，缺件多时折叠尾部（不刷屏）', () => {
    const clean = runClosure({ 'dist/src/index.js': 'export const a = 1\n' })
    expect(describeLoadChainClosure(clean)).toContain('1 module(s) reachable from 1 root(s)')
    const many: Record<string, string> = {
      'dist/src/index.js': Array.from(
        { length: 10 },
        (_, i) => `import x${i} from './gone${i}.js'`
      ).join('\n')
    }
    const folded = describeLoadChainClosure(runClosure(many))
    expect(folded).toContain('(+2 more)')
    expect(folded).toContain('run the full `npm run build` in NikkiSync')
  })
})

describe('LOAD_CHAIN_ROOTS 结构契约', () => {
  /** 与 `src/main/nikkisync/runtime-facade.ts` 的深入口常量比对时统一成正斜杠键（约定 §6 第 1 档） */
  const toForward = (value: string): string => value.split(path.sep).join('/')

  it('恰好 13 个根：上游桶导出 + 本仓 12 个 *_DEEP_ENTRY', () => {
    expect(LOAD_CHAIN_ROOTS).toHaveLength(13)
    expect(toForward(LOAD_CHAIN_ROOTS[0] as string)).toBe('dist/src/index.js')
  })

  it('与 runtime-facade.ts 里声明的全部 *_DEEP_ENTRY 逐项相等（装载缝增删深入口而未补根表 ⇒ 红）', () => {
    const facade = readFileSync(
      path.join(ROOT, 'src', 'main', 'nikkisync', 'runtime-facade.ts'),
      'utf-8'
    )
    const declared: string[] = []
    for (const match of facade.matchAll(/export const [A-Z0-9_]+_DEEP_ENTRY\s*=\s*\[([^\]]*)\]/g)) {
      const parts = (match[1] as string)
        .split(',')
        .map((segment) => segment.trim().replace(/^['"]|['"]$/g, ''))
        .filter((segment) => segment.length > 0)
      declared.push(['dist', 'src', ...parts].join('/'))
    }
    expect(declared.sort()).toEqual(
      LOAD_CHAIN_ROOTS.map(toForward)
        .filter((relative) => relative !== 'dist/src/index.js')
        .sort()
    )
  })
})

describe('closureLoadChain 真实树读数（仅已建链时判据成立）', () => {
  const pcCompanion = path.join(ROOT, 'node_modules', '@nikkisync', 'pc-companion', 'dist', 'src')
  const LINKED = fs.existsSync(path.join(pcCompanion, 'index.js'))
  const suite = LINKED ? describe : describe.skip

  suite('链接态：本仓装载缝真正吃到的那棵树', () => {
    it('闭包 >= 50 个模块、零缺件边、零读不动', () => {
      const targetDir = fs.realpathSync(path.join(ROOT, 'node_modules/@nikkisync/pc-companion'))
      const result = closureLoadChain(
        LOAD_CHAIN_ROOTS,
        (relative) => {
          try {
            return fs.readFileSync(path.join(targetDir, relative), 'utf8')
          } catch {
            return null
          }
        },
        (from, specifier) => path.normalize(path.join(path.dirname(from), specifier)),
        (relative) => fs.existsSync(path.join(targetDir, relative))
      )
      // 下界取自 DEBT-040 的实测读数（50 个模块 / 19 个被点名），上游只增不减
      expect(result.visited).toBeGreaterThanOrEqual(50)
      expect(result.dangling).toEqual([])
      expect(result.unreadable).toEqual([])
    })
  })
})

describe('evaluateNikkiSyncLink 的闭包检查项', () => {
  it('正常：dangling 与 unreadable 皆空 ⇒ 不进 blocking，detail 给出模块数', () => {
    const checks = evaluateNikkiSyncLink(
      facts({ loadChainDangling: [], loadChainUnreadable: [], loadChainVisited: 50 })
    )
    expect(failing(checks)).not.toContain(CLOSURE_CHECK)
    expect(find(checks, CLOSURE_CHECK)?.detail).toContain('50 module(s)')
  })

  it('异常：有缺件边 ⇒ blocking 点名该检查，且 detail 指名是哪条边', () => {
    const checks = evaluateNikkiSyncLink(
      facts({
        loadChainDangling: [{ from: 'dist/src/server/row-mappers.js', specifier: './gone.js' }],
        loadChainUnreadable: [],
        loadChainVisited: 49
      })
    )
    expect(failing(checks)).toContain(CLOSURE_CHECK)
    expect(find(checks, CLOSURE_CHECK)?.detail).toContain('row-mappers.js -> ./gone.js')
  })

  it('边界：facts 缺省时整条检查缺席（未取得事实不得伪装成绿，与其余产物面同口径）', () => {
    const checks = evaluateNikkiSyncLink(facts())
    expect(find(checks, CLOSURE_CHECK)).toBeUndefined()
  })

  it('边界：未链接时降级为 warn，不进 blocking（未建链是受支持的默认态）', () => {
    const checks = evaluateNikkiSyncLink(
      facts({
        installedLinks: [],
        builtArtifacts: [],
        loadChainDangling: [{ from: 'a.js', specifier: './b.js' }],
        loadChainUnreadable: [],
        loadChainVisited: 0
      })
    )
    expect(failing(checks)).not.toContain(CLOSURE_CHECK)
    expect(find(checks, CLOSURE_CHECK)?.level).toBe('warn')
    expect(find(checks, CLOSURE_CHECK)?.detail).toContain('skipped (no links present')
  })
})
