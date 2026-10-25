import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  NIKKISYNC_PACKAGE_NAMES,
  NIKKISYNC_REQUIRED_EXPORTS,
  NikkiSyncLoadError,
  hasNikkiSyncLink,
  isNikkiSyncLinked,
  loadAllNikkiSyncPackages,
  loadNikkiSyncPackage,
  nikkisyncExport,
  resolveLoadHint,
  specifierFor,
  type NikkiSyncPackageName
} from './runtime-loader'

/**
 * NikkiSync 依赖链接测试（整合阶段 1）。
 *
 * 覆盖 docs/sync-integration/01-dependency-link-plan.md §11 用例 1-7：
 * 四包可装载、各包关键导出非 undefined、内存库可建表、协议常量符合契约、
 * Runtime 入口可解析但绝不启动（不产生端口/mDNS/TLS 副作用）。
 *
 * 链接缺失时整个 linked 套件 skip（用例 7）：环境缺失不能被记成逻辑失败。
 * skip 门控用 hasNikkiSyncLink() 而非目录存在判定：自包含方案下 @nikkisync 不再是
 * 声明依赖，npm 剪枝后的残留目录或悬空 junction 均不得被当成“已链接”。
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const LINKED = hasNikkiSyncLink(projectRoot)

/** 0001_initial.sql 的 12 张业务表（sqlite_sequence 为派生对象，单独断言下限）。 */
const BUSINESS_TABLES = [
  'app_settings',
  'assets',
  'change_journal',
  'device_sync_state',
  'library_state',
  'metadata_dictionary_entries',
  'metadata_dictionary_state',
  'paired_devices',
  'pairing_sessions',
  'resolver_candidates',
  'resources',
  'schema_migrations'
]

describe('runtime-loader 纯函数面（不依赖链接是否就绪）', () => {
  it('包名表恰好四项且 specifier 带 @nikkisync 作用域', () => {
    expect(NIKKISYNC_PACKAGE_NAMES).toHaveLength(4)
    for (const name of NIKKISYNC_PACKAGE_NAMES) {
      expect(specifierFor(name)).toMatch(/^@nikkisync\//)
    }
  })

  it('用例 6：未知包名在装载前即抛错，不返回半初始化的模块图', async () => {
    await expect(loadNikkiSyncPackage('nope' as NikkiSyncPackageName)).rejects.toThrow(
      /Unknown NikkiSync package key/
    )
  })

  it('resolveLoadHint 区分折叠成 require / 链接缺失 / 其他', () => {
    expect(resolveLoadHint('require() cannot be used ... ERR_REQUIRE_ASYNC_MODULE')).toContain(
      'folded into require()'
    )
    expect(resolveLoadHint("Cannot find package '@nikkisync/core'")).toContain('npm install')
    expect(resolveLoadHint('something unexpected')).toContain('inspect the original error')
  })

  it('nikkisyncExport 对缺失导出抛错而非返回 undefined', () => {
    expect(() => nikkisyncExport({ present: 1 }, 'absent')).toThrow(/Expected export "absent"/)
    expect(nikkisyncExport({ present: 1 }, 'present')).toBe(1)
  })

  it('hasNikkiSyncLink 按包内 package.json 判定：不存在的根与悬空链接均返回 false', () => {
    expect(hasNikkiSyncLink('/definitely/not/a/project/root')).toBe(false)
    // 未建链的默认态（自包含方案）下项目根也必须给出 false
    if (!LINKED) expect(hasNikkiSyncLink(projectRoot)).toBe(false)
  })

  it('兼容层（b422193 同步）：core 必需导出表覆盖 decoded-metadata 三个桶导出纯函数', () => {
    // 上游 core 桶导出追加 `export * from './decoded-metadata.js'`（b422193）；
    // 三符号入表后，链接态用例 1b 会在真实上游产物上逐个探测其存在与形态。
    expect(NIKKISYNC_REQUIRED_EXPORTS.core).toMatchObject({
      normalizeNuan5Photo: 'function',
      normalizeNikkiGalleryPhoto: 'function',
      mergePhotoMetadataGaps: 'function'
    })
  })
})

describe.skipIf(!LINKED)('runtime-loader 装载面（需 @nikkisync/* 链接就绪）', () => {
  it('用例 1：四包均可 await import，模块对象非 undefined 且有导出', async () => {
    const modules = await loadAllNikkiSyncPackages()
    for (const name of NIKKISYNC_PACKAGE_NAMES) {
      const loaded = modules[name]
      expect(loaded, `${name} module`).toBeDefined()
      expect(typeof loaded).toBe('object')
      expect(Object.keys(loaded).length).toBeGreaterThan(0)
    }
  })

  it('用例 1b：NIKKISYNC_REQUIRED_EXPORTS 逐项非 undefined 且 typeof 符合预期', async () => {
    const modules = await loadAllNikkiSyncPackages()
    for (const name of NIKKISYNC_PACKAGE_NAMES) {
      for (const [exportName, expectedType] of Object.entries(NIKKISYNC_REQUIRED_EXPORTS[name])) {
        const value = nikkisyncExport(modules[name], exportName)
        expect(typeof value, `${name}.${exportName}`).toBe(expectedType)
      }
    }
  })

  it('用例 2：core 的领域常量与 AssetResolver 非 undefined，toPathKey 可调用', async () => {
    const core = await loadNikkiSyncPackage('core')
    expect(nikkisyncExport(core, 'ASSET_RESOLVER_VERSION')).toBe(1)
    expect(nikkisyncExport(core, 'AssetResolver')).toBeTypeOf('function')
    expect(nikkisyncExport(core, 'ASSET_TYPES')).toContain('photo')
    expect(nikkisyncExport(core, 'RESOURCE_ROLES')).toContain('source_primary')
    const toPathKey = nikkisyncExport(core, 'toPathKey') as (input: string) => string
    expect(typeof toPathKey('C:\\Game\\ScreenShot\\A.JPG')).toBe('string')
  })

  it('用例 3：database 的 DatabaseManager 可建内存库并落 12 张业务表', async () => {
    const database = await loadNikkiSyncPackage('database')
    const DatabaseManager = nikkisyncExport(database, 'DatabaseManager') as {
      new (file: string): {
        connection: {
          exec(sql: string): void
          prepare(sql: string): { all(): unknown[]; get(): unknown }
        }
        initialize(): void
        close(): void
      }
    }
    const manager = new DatabaseManager(':memory:')
    try {
      manager.initialize()
      const rows = manager.connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
      const names = rows.map((row) => row.name)
      for (const table of BUSINESS_TABLES) {
        expect(names, `table ${table}`).toContain(table)
      }
      // 12 业务表 + 可能派生的 sqlite_sequence
      expect(names.length).toBeGreaterThanOrEqual(BUSINESS_TABLES.length)
    } finally {
      manager.close()
    }
  })

  it('用例 4：protocol 的 PROTOCOL_VERSION / API_ROUTES / buildPairingUri 符合契约', async () => {
    const protocol = await loadNikkiSyncPackage('protocol')
    expect(nikkisyncExport(protocol, 'PROTOCOL_VERSION')).toBe(1)
    const apiRoutes = nikkisyncExport(protocol, 'API_ROUTES') as Record<string, unknown>
    expect(Object.keys(apiRoutes)).toHaveLength(12)
    expect(nikkisyncExport(protocol, 'buildPairingUri')).toBeTypeOf('function')
  })

  it('用例 5：pc-companion 暴露 Context 与 Runtime 入口，且未产生任何监听副作用', async () => {
    const pcCompanion = await loadNikkiSyncPackage('pcCompanion')
    const createContext = nikkisyncExport(pcCompanion, 'createPcCompanionContext') as (
      file?: string
    ) => { database: { close(): void }; protocolVersion: number }
    const runtime = nikkisyncExport(pcCompanion, 'PcCompanionRuntime') as {
      prototype: { start?: unknown; stop?: unknown }
    }
    expect(runtime).toBeTypeOf('function')
    // 只确认入口存在，绝不调用：start() 会把 scanner discovery 作为硬前置并起 LAN/mDNS
    expect(runtime.prototype.start).toBeTypeOf('function')
    expect(runtime.prototype.stop).toBeTypeOf('function')

    const context = createContext(':memory:')
    try {
      expect(context.database).toBeDefined()
      expect(context.protocolVersion).toBe(1)
    } finally {
      context.database.close()
    }
  })

  it('用例 7：isNikkiSyncLinked 在链接就绪时为 true', async () => {
    expect(await isNikkiSyncLinked()).toBe(true)
  })

  it('装载失败路径抛 NikkiSyncLoadError 并携带可执行 hint', async () => {
    // 用真实存在但无导出的空 specifier 触发：改测未知导出更稳，此处校验错误类型契约
    const modules = await loadAllNikkiSyncPackages()
    expect(() => nikkisyncExport(modules.core, 'DefinitelyNotExported')).toThrow(
      /Expected export "DefinitelyNotExported"/
    )
    const error = new NikkiSyncLoadError('core', '@nikkisync/core', new Error('boom'), 'hint text')
    expect(error.name).toBe('NikkiSyncLoadError')
    expect(error.message).toContain('hint text')
    expect(error.hint).toBe('hint text')
  })
})
