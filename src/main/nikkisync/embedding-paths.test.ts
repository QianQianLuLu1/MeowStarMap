import { describe, expect, it } from 'vitest'
import path from 'node:path'

import {
  NikkiSyncAssetError,
  buildPackagingContext,
  readMigrationsSql,
  resolveDeepEntryUrl,
  resolveEntryUrl,
  resolveMigrationsSqlPath,
  resolveModuleRoot
} from './embedding-paths'

/**
 * 打包态资源路径解析单测（阶段 9 · 问题 3）。
 *
 * 关注两件在 asar 里会翻车的事：
 *   1. `@nikkisync/*` 被 asarUnpack 解出后，真实文件位于 app.asar.unpacked，
 *      而 bare specifier 解析给出的仍是 app.asar 路径 —— 装载缝需要一个可判的回退入口；
 *   2. DatabaseManager.initialize() 靠上游 `import.meta.url` 相对定位 migrations SQL，
 *      该相对路径在打包态不可靠 —— 由 XiangCe 侧解析绝对路径后显式传文本。
 * 本文件全部走注入（ctx / existsSync / readFile），不触磁盘，CI 必跑。
 */

const PROJECT_ROOT = path.resolve('D:', 'work', 'XiangCe')
const RESOURCES = path.resolve('D:', 'inst', 'resources')

/** unpacked 树存在性替身：只有列出的路径算存在。 */
function existsSet(paths: string[]): (p: string) => boolean {
  return (p: string) => paths.includes(p)
}

function packagedContext(): ReturnType<typeof buildPackagingContext> {
  return buildPackagingContext({
    isPackaged: true,
    resourcesPath: RESOURCES,
    projectRoot: PROJECT_ROOT
  })
}

describe('buildPackagingContext', () => {
  it('正常：打包态以 resourcesPath 为基准，开发态以 projectRoot 为基准', () => {
    expect(packagedContext().isPackaged).toBe(true)
    expect(packagedContext().resourcesPath).toBe(RESOURCES)
    const dev = buildPackagingContext({ isPackaged: false, projectRoot: PROJECT_ROOT })
    expect(dev.resourcesPath).toBe('')
    expect(dev.projectRoot).toBe(PROJECT_ROOT)
  })

  it('异常：打包态缺 resourcesPath 直接抛错（不静默回落到开发态）', () => {
    expect(() =>
      buildPackagingContext({
        isPackaged: true,
        resourcesPath: undefined,
        projectRoot: PROJECT_ROOT
      })
    ).toThrow(/resourcesPath/)
    expect(() =>
      buildPackagingContext({ isPackaged: true, resourcesPath: '   ', projectRoot: PROJECT_ROOT })
    ).toThrow(/resourcesPath/)
  })

  it('边界：projectRoot 为空即拒绝（所有解析都依赖它兜底）', () => {
    expect(() => buildPackagingContext({ isPackaged: false, projectRoot: '  ' })).toThrow(
      /projectRoot/
    )
  })
})

describe('resolveModuleRoot', () => {
  it('正常：开发态指向 node_modules/@nikkisync/<name>', () => {
    const dev = buildPackagingContext({ isPackaged: false, projectRoot: PROJECT_ROOT })
    const resolved = resolveModuleRoot('@nikkisync/database', dev, () => true)
    expect(resolved.root).toBe(path.join(PROJECT_ROOT, 'node_modules', '@nikkisync', 'database'))
    expect(resolved.fellBackToAsar).toBe(false)
  })

  it('正常：打包态优先取 app.asar.unpacked 下的真实目录', () => {
    const expected = path.join(
      RESOURCES,
      'app.asar.unpacked',
      'node_modules',
      '@nikkisync',
      'database'
    )
    const resolved = resolveModuleRoot(
      '@nikkisync/database',
      packagedContext(),
      existsSet([expected])
    )
    expect(resolved.root).toBe(expected)
    expect(resolved.fellBackToAsar).toBe(false)
  })

  it('边界：unpacked 缺失时回退 asar 内路径并置 fellBackToAsar', () => {
    const resolved = resolveModuleRoot('@nikkisync/core', packagedContext(), () => false)
    expect(resolved.root).toBe(
      path.join(RESOURCES, 'app.asar', 'node_modules', '@nikkisync', 'core')
    )
    expect(resolved.fellBackToAsar).toBe(true)
  })

  it('边界：连字符包名（pc-companion）与目录名一致', () => {
    const resolved = resolveModuleRoot('@nikkisync/pc-companion', packagedContext(), () => true)
    expect(path.basename(resolved.root)).toBe('pc-companion')
  })

  it('异常：非法 specifier 一律拒绝（作用域外包名、路径逃逸、空串、大写）', () => {
    const ctx = buildPackagingContext({ isPackaged: false, projectRoot: PROJECT_ROOT })
    const reject = (specifier: string) =>
      expect(() => resolveModuleRoot(specifier, ctx, () => true)).toThrow(NikkiSyncAssetError)
    reject('react')
    reject('@nikkisync/../etc')
    reject('@nikkisync/core/dist/index.js')
    reject('@nikkisync/CORE')
    reject('')
  })
})

describe('resolveEntryUrl 与 resolveMigrationsSqlPath', () => {
  it('正常：入口 URL 为 file:// 绝对形态，SQL 路径落在包内 migrations 目录', () => {
    const root = path.join(PROJECT_ROOT, 'node_modules', '@nikkisync', 'database')
    expect(resolveEntryUrl(root)).toContain('file://')
    expect(decodeURIComponent(resolveEntryUrl(root)).replace(/\\/g, '/')).toMatch(
      /\/node_modules\/@nikkisync\/database\/dist\/src\/index\.js$/
    )
    expect(resolveMigrationsSqlPath(root)).toBe(path.join(root, 'migrations', '0001_initial.sql'))
  })

  it('异常：空 root 一律拒绝（避免拼出 cwd 相对路径造成晦涩失败）', () => {
    expect(() => resolveEntryUrl('')).toThrow(NikkiSyncAssetError)
    expect(() => resolveMigrationsSqlPath('')).toThrow(NikkiSyncAssetError)
  })
})

describe('resolveDeepEntryUrl（阶段 2 · 深入口装载）', () => {
  it('正常：由包根拼出 dist/src 下的 file:// URL', () => {
    const root = path.join(PROJECT_ROOT, 'node_modules', '@nikkisync', 'pc-companion')
    const url = resolveDeepEntryUrl(root, ['server', 'row-mappers.js'])
    expect(url).toContain('file://')
    expect(decodeURIComponent(url).replace(/\\/g, '/')).toMatch(
      /\/node_modules\/@nikkisync\/pc-companion\/dist\/src\/server\/row-mappers\.js$/
    )
  })

  it('正常：多级子目录与 .mjs 产物均可解析', () => {
    const root = path.join(PROJECT_ROOT, 'node_modules', '@nikkisync', 'pc-companion')
    expect(
      decodeURIComponent(resolveDeepEntryUrl(root, ['wechat', 'GalleryRuntime.mjs'])).replace(
        /\\/g,
        '/'
      )
    ).toMatch(/\/dist\/src\/wechat\/GalleryRuntime\.mjs$/)
  })

  it('异常：空段清单 / 空段 / 点段一律拒绝（不落入 cwd）', () => {
    const root = path.join(PROJECT_ROOT, 'node_modules', '@nikkisync', 'core')
    expect(() => resolveDeepEntryUrl(root, [])).toThrow(NikkiSyncAssetError)
    expect(() => resolveDeepEntryUrl(root, [''])).toThrow(NikkiSyncAssetError)
    expect(() => resolveDeepEntryUrl('  ', ['a.js'])).toThrow(NikkiSyncAssetError)
    const bad = ['.', '..', '../evil.js', 'a\\b.js', 'a/b.js', 'server*', '中文.js']
    for (const segment of bad) {
      expect(() => resolveDeepEntryUrl(root, [segment])).toThrow(NikkiSyncAssetError)
    }
  })

  it('异常：非 JS 产物拒绝（不把任意文件包成可装载 URL）', () => {
    const root = path.join(PROJECT_ROOT, 'node_modules', '@nikkisync', 'database')
    expect(() => resolveDeepEntryUrl(root, ['migrations', '0001_initial.sql'])).toThrow(
      /\.js or \.mjs/
    )
    expect(() => resolveDeepEntryUrl(root, ['index.d.ts'])).toThrow(NikkiSyncAssetError)
  })
})

describe('readMigrationsSql', () => {
  it('正常：返回注入读取器给出的 SQL 文本', () => {
    const sql = 'CREATE TABLE assets (id TEXT);'
    expect(readMigrationsSql('/abs/0001_initial.sql', () => sql)).toBe(sql)
  })

  it('异常：空文本视为未编译，抛错并给出两侧修复指令', () => {
    expect(() => readMigrationsSql('/abs/0001_initial.sql', () => '   ')).toThrow(
      /NikkiSync has not been built/
    )
    const message = (() => {
      try {
        readMigrationsSql('/abs/0001_initial.sql', () => '')
        return ''
      } catch (error) {
        return (error as Error).message
      }
    })()
    expect(message).toContain('npm run link:nikkisync')
    expect(message).toContain('npm run build')
    expect(message).toContain('/abs/0001_initial.sql')
  })

  it('边界：读取器抛 ENOENT 时归一为 NikkiSyncAssetError 并保留原因', () => {
    expect(() =>
      readMigrationsSql('/abs/missing.sql', () => {
        throw new Error('ENOENT: no such file or directory')
      })
    ).toThrow(NikkiSyncAssetError)
  })
})
