import { describe, expect, it, vi } from 'vitest'
import {
  CLOTHING_SEARCH_DEEP_ENTRY,
  METADATA_DIAGNOSTICS_DEEP_ENTRY,
  NUAN5_RESOLVER_DEEP_ENTRY,
  PROFILE_STATS_DEEP_ENTRY,
  SUIT_SEARCH_DEEP_ENTRY,
  createQuerySurface,
  createRuntimeSession
} from './runtime-facade'
import type { RuntimeSurface } from './runtime-facade'
import type { EmbeddedRuntimeLike } from './runtime-types'
import { DEFAULT_METADATA_BATCH_SIZE, NUAN5_METADATA_ENDPOINT } from './metadata-resolver-driver'
import {
  clearNikkiSyncResourcePaths,
  isNikkiSyncResourcePath,
  nikkiSyncResourcePathCount,
  nikkiSyncResourceRevision
} from './resource-allowlist'

/**
 * 阶段 4（UI Bridge）查询面扩容单测。
 *
 * 口径：`createQuerySurface` 是**零转换**的转发层，因此本文件只断言三件事——
 * ① 入参如何逐字交给上游 `SyncReadRepository` / 上游索引函数；
 * ② 上游返回值如何原样出现在响应里（行映射只调上游 mapper，不自己拼字段）；
 * ③ 分页/失效判据与搜索源装配与上游 `LocalSyncServer` 私有实现同判据。
 * 真链路的逐字一致性由 `runtime-facade.linked.test.ts` 与
 * `library-paging.linked.test.ts` 兜底（CI 未建链时整件 skip）。
 */

// ---------------------------------------------------------------- 夹具

interface RepoRows {
  assets: Record<string, unknown>[]
  resourcesByAsset: Record<string, Record<string, unknown>[]>
  changes: Record<string, unknown>[]
  suitAssets: Record<string, unknown>[]
  suitResources: Record<string, unknown>[]
  currentRevision: number
  minimumJournalRevision: number | undefined
}

/** 造一个只含查询面所需方法的假 Runtime（不碰 node:fs、不建库）。 */
function createSurface(rows: RepoRows) {
  const repoCalls: Array<Record<string, unknown>> = []
  class FakeSyncReadRepository {
    constructor(private readonly database: unknown) {}
    currentRevision(): number {
      void this.database
      return rows.currentRevision
    }
    minimumJournalRevision(): number | undefined {
      return rows.minimumJournalRevision
    }
    listAssets(query: Record<string, unknown>): Record<string, unknown>[] {
      repoCalls.push(query)
      return rows.assets
    }
    getAsset(assetId: string): Record<string, unknown> | undefined {
      return rows.assets.find((row) => row.asset_id === assetId)
    }
    listResources(assetId: string): Record<string, unknown>[] {
      return rows.resourcesByAsset[assetId] ?? []
    }
    getResource(): Record<string, unknown> | undefined {
      return undefined
    }
    listChangesAfter(revision: number, limit: number): Record<string, unknown>[] {
      repoCalls.push({ revision, limit })
      return rows.changes
    }
    listSuitSearchAssets(): Record<string, unknown>[] {
      return rows.suitAssets
    }
    listSuitSearchResources(): Record<string, unknown>[] {
      return rows.suitResources
    }
  }

  const searchSuitLibrary = vi.fn((assets: unknown, manifest: unknown, query: string) => ({
    kind: 'suits',
    count: (assets as unknown[]).length,
    manifest,
    query
  }))
  const searchClothingLibrary = vi.fn((assets: unknown, manifest: unknown, query: string) => ({
    kind: 'clothing',
    count: (assets as unknown[]).length,
    manifest,
    query
  }))
  const buildProfileStats = vi.fn((assets: unknown, manifest: unknown, revision: number) => ({
    kind: 'stats',
    count: (assets as unknown[]).length,
    manifest,
    revision
  }))
  const getActiveManifest = vi.fn(() => ({ provider: 'fake', entries: [] }))
  class FakeMetadataDictionaryRepository {
    getActiveManifest(): unknown {
      return getActiveManifest()
    }
  }

  const database = {
    SyncReadRepository: FakeSyncReadRepository,
    MetadataDictionaryRepository: FakeMetadataDictionaryRepository
  } as unknown as NikkiSyncModuleLike
  const rowMappers = {
    mapAssetSummary: (row: Record<string, unknown>) => ({ __mapped: 'summary', row }),
    mapAssetDetail: (row: Record<string, unknown>) => ({ __mapped: 'detail', row }),
    mapResourceRow: (row: Record<string, unknown>) => ({ __mapped: 'resource', row }),
    mapChangeRow: (row: Record<string, unknown>) => ({ __mapped: 'change', row })
  }
  const suitSearchIndex = { searchSuitLibrary }
  const clothingSearchIndex = { searchClothingLibrary }
  const profileStatsIndex = { buildProfileStats }

  const surface = {
    database,
    rowMappers,
    suitSearchIndex,
    clothingSearchIndex,
    profileStatsIndex
  } as unknown as RuntimeSurface
  const runtime = { database: { fake: true } } as unknown as EmbeddedRuntimeLike
  return {
    surface,
    runtime,
    rows,
    searchSuitLibrary,
    searchClothingLibrary,
    buildProfileStats,
    getActiveManifest,
    repoCalls
  }
}

/** 装载面模块在本测试里只作为不透明命名空间使用，避免引上游类型。 */
type NikkiSyncModuleLike = Record<string, unknown>

const emptyRows = (over?: Partial<RepoRows>): RepoRows => ({
  assets: [],
  resourcesByAsset: {},
  changes: [],
  suitAssets: [],
  suitResources: [],
  currentRevision: 42,
  minimumJournalRevision: undefined,
  ...over
})

// ---------------------------------------------------------------- 用例

describe('nikkisync 深入口常量', () => {
  it('搜索与统计各自指向 pc-companion 的 server 子模块', () => {
    // 这三组常量决定 resolveDeepEntryUrl 的落点，写错即在运行期 ERR_MODULE_NOT_FOUND
    expect(SUIT_SEARCH_DEEP_ENTRY).toEqual(['server', 'SuitSearchIndex.js'])
    expect(CLOTHING_SEARCH_DEEP_ENTRY).toEqual(['server', 'ClothingSearchIndex.js'])
    expect(PROFILE_STATS_DEEP_ENTRY).toEqual(['server', 'ProfileStatsIndex.js'])
  })
})

describe('nikkisync 阶段 6 元数据解析深入口常量', () => {
  it('Nuan5 解析器与解析诊断各自指向 pc-companion 的 metadata 子模块', () => {
    // 两者都**不在**上游 `dist/src/index.js` 桶导出内（已实测：桶里只 re-export
    // `metadata/MetadataResolverPipeline.js` 与 `metadata/types.js`），因此只能走深入口。
    // 段名写错 ⇒ 运行期 ERR_MODULE_NOT_FOUND，与 server/* 三入口同类风险，必须在编译期钉死。
    expect(NUAN5_RESOLVER_DEEP_ENTRY).toEqual(['metadata', 'Nuan5CompatibleResolver.js'])
    expect(METADATA_DIAGNOSTICS_DEEP_ENTRY).toEqual([
      'metadata',
      'MetadataResolutionDiagnostics.js'
    ])
  })
})

describe('createQuerySurface 批量资源记录', () => {
  it('meta 模式逐行调上游 mapResourceRow，键为 assetId', async () => {
    const fixture = createSurface(
      emptyRows({
        resourcesByAsset: {
          'a/1': [
            { resource_id: 'r1', role: 'source_high_quality' },
            { resource_id: 'r2', role: 'source_motion' }
          ],
          'a/2': [{ resource_id: 'r3', role: 'source_primary' }]
        }
      })
    )
    const queries = createQuerySurface(fixture.surface, fixture.runtime)
    const result = await queries.listResourceRecords(['a/1', 'a/2'], 'meta')
    expect(result).toEqual({
      byAsset: {
        'a/1': [
          { __mapped: 'resource', row: { resource_id: 'r1', role: 'source_high_quality' } },
          { __mapped: 'resource', row: { resource_id: 'r2', role: 'source_motion' } }
        ],
        'a/2': [{ __mapped: 'resource', row: { resource_id: 'r3', role: 'source_primary' } }]
      }
    })
  })

  it('path 模式给 resources.source_path 原值，不包装不改写', async () => {
    const fixture = createSurface(
      emptyRows({
        resourcesByAsset: {
          'a/1': [{ resource_id: 'r1', source_path: 'D:\\Game\\X6Game\\a.png' }]
        }
      })
    )
    const queries = createQuerySurface(fixture.surface, fixture.runtime)
    const result = await queries.listResourceRecords(['a/1'], 'path')
    expect(result).toEqual({ byAsset: { 'a/1': { r1: 'D:\\Game\\X6Game\\a.png' } } })
  })

  it('无资源的资产给空数组，不被静默丢弃', async () => {
    const fixture = createSurface(emptyRows())
    const queries = createQuerySurface(fixture.surface, fixture.runtime)
    const meta = await queries.listResourceRecords(['a/missing'], 'meta')
    expect(meta).toEqual({ byAsset: { 'a/missing': [] } })
    const paths = await queries.listResourceRecords(['a/missing'], 'path')
    expect(paths).toEqual({ byAsset: { 'a/missing': {} } })
  })
})

describe('createQuerySurface 增量变更', () => {
  it('未落后于日志保留下界时逐行 mapChangeRow 并带当前 revision', async () => {
    const fixture = createSurface(
      emptyRows({
        changes: [
          { revision: 41, type: 'asset.updated', asset_id: 'a/1', occurred_at: '2026-10-14' }
        ],
        minimumJournalRevision: 10
      })
    )
    const queries = createQuerySurface(fixture.surface, fixture.runtime)
    const result = await queries.listChanges(40, 500)
    expect(result).toEqual({
      changes: [
        {
          __mapped: 'change',
          row: { revision: 41, type: 'asset.updated', asset_id: 'a/1', occurred_at: '2026-10-14' }
        }
      ],
      libraryRevision: 42,
      fullResyncRequired: false
    })
    // limit 逐字下传上游（上游缺省 1000，本层不得自造默认）
    expect(fixture.repoCalls[fixture.repoCalls.length - 1]).toEqual({ revision: 40, limit: 500 })
  })

  it('判据与上游一致：after < minimum - 1 才判全量重同步，且此时 changes 为空', async () => {
    const fixture = createSurface(
      emptyRows({
        changes: [{ revision: 1, asset_id: 'a/1' }],
        minimumJournalRevision: 10
      })
    )
    const queries = createQuerySurface(fixture.surface, fixture.runtime)
    const result = await queries.listChanges(8, 1000)
    expect(result.fullResyncRequired).toBe(true)
    expect(result.changes).toEqual([])
    expect(result.libraryRevision).toBe(42)
  })

  it('边界：after 恰为 minimum - 1 时仍走增量（不放大成全量重扫）', async () => {
    const fixture = createSurface(
      emptyRows({ changes: [{ revision: 9, asset_id: 'a/1' }], minimumJournalRevision: 10 })
    )
    const queries = createQuerySurface(fixture.surface, fixture.runtime)
    const result = await queries.listChanges(9, 1000)
    expect(result.fullResyncRequired).toBe(false)
    expect(result.changes).toHaveLength(1)
  })

  it('边界：日志表为空（minimum 为 undefined）时不判全量', async () => {
    const fixture = createSurface(emptyRows({ minimumJournalRevision: undefined }))
    const queries = createQuerySurface(fixture.surface, fixture.runtime)
    const result = await queries.listChanges(0, 1000)
    expect(result.fullResyncRequired).toBe(false)
    expect(result.changes).toEqual([])
  })
})

describe('createQuerySurface 搜索与统计', () => {
  it('搜索源按上游 suitSearchSource 的装配形状产出', async () => {
    const fixture = createSurface(
      emptyRows({
        suitAssets: [
          { asset_id: 'a/1', metadata_json: '{"dressing":{}}' },
          { asset_id: 'a/2', metadata_json: null }
        ],
        suitResources: [
          { asset_id: 'a/1', resource_id: 'r1' },
          { asset_id: 'a/1', resource_id: 'r2' },
          { asset_id: 'a/2', resource_id: 'r3' }
        ]
      })
    )
    const queries = createQuerySurface(fixture.surface, fixture.runtime)
    await queries.searchSuits('花')
    const [assets, manifest, query] = fixture.searchSuitLibrary.mock.calls[0] as [
      Array<Record<string, unknown>>,
      unknown,
      string
    ]
    // 资源按 asset_id 分组后逐资产喂给 mapAssetSummary；无资源资产给空数组
    expect(assets.map((item) => item.asset)).toEqual([
      { __mapped: 'summary', row: { asset_id: 'a/1', metadata_json: '{"dressing":{}}' } },
      { __mapped: 'summary', row: { asset_id: 'a/2', metadata_json: null } }
    ])
    // metadata_json 为 NULL 时上游给的是 String(null) === 'null'（其索引的跳过条件是
    // `if (!metadataJson) continue`，因此 NULL 行**不**被跳过）。本层必须逐字照抄，
    // 否则与真实 /v1/search/* 端点行为分叉——固化上游口径，禁止「改成 undefined 更干净」。
    expect(assets[1].metadataJson).toBe('null')
    expect(assets[0].metadataJson).toBe('{"dressing":{}}')
    expect(manifest).toEqual({ provider: 'fake', entries: [] })
    // 零转换：query 原样下传，trim 由上游内部负责
    expect(query).toBe('花')
  })

  it('同 revision 内复用搜索源，revision 前进后重建', async () => {
    const fixture = createSurface(emptyRows({ suitAssets: [{ asset_id: 'a/1' }] }))
    const queries = createQuerySurface(fixture.surface, fixture.runtime)
    await queries.searchSuits('a')
    await queries.searchClothing('b')
    expect(fixture.searchSuitLibrary).toHaveBeenCalledTimes(1)
    expect(fixture.searchClothingLibrary).toHaveBeenCalledTimes(1)
    const firstAssets = fixture.searchSuitLibrary.mock.calls[0][0]
    const secondAssets = fixture.searchClothingLibrary.mock.calls[0][0]
    expect(secondAssets).toBe(firstAssets)

    // revision 前进 ⇒ 缓存必须失效，否则新扫描出来的资产永远进不了搜索
    fixture.rows.currentRevision = 43
    await queries.searchSuits('c')
    expect(fixture.searchSuitLibrary).toHaveBeenCalledTimes(2)
    expect(fixture.searchSuitLibrary.mock.calls[1][0]).not.toBe(firstAssets)
  })

  it('服装搜索与档案统计各归上游，统计带当前 libraryRevision', async () => {
    const fixture = createSurface(emptyRows({ suitAssets: [{ asset_id: 'a/1' }] }))
    const queries = createQuerySurface(fixture.surface, fixture.runtime)
    const clothing = await queries.searchClothing('  裙 ')
    const stats = await queries.profileStats()
    expect(clothing).toEqual({
      kind: 'clothing',
      count: 1,
      manifest: { provider: 'fake', entries: [] },
      query: '  裙 '
    })
    expect(stats).toEqual({
      kind: 'stats',
      count: 1,
      manifest: { provider: 'fake', entries: [] },
      revision: 42
    })
  })

  it('字典仓储缺失时不伪造 manifest，交上游按 undefined 处理', async () => {
    const fixture = createSurface(emptyRows({ suitAssets: [{ asset_id: 'a/1' }] }))
    const brokenSurface = {
      ...fixture.surface,
      database: {
        SyncReadRepository: (fixture.surface.database as NikkiSyncModuleLike).SyncReadRepository,
        MetadataDictionaryRepository: class {
          getActiveManifest(): undefined {
            return undefined
          }
        }
      }
    } as unknown as RuntimeSurface
    const queries = createQuerySurface(brokenSurface, fixture.runtime)
    await queries.searchSuits('花')
    expect(fixture.searchSuitLibrary.mock.calls[0][1]).toBeUndefined()
  })
})

describe('createQuerySurface 路径登记与 media:// 授权联动', () => {
  it('path 模式把交出去的路径按当前 libraryRevision 登记进授权表；meta 模式不登记', async () => {
    clearNikkiSyncResourcePaths()
    const fixture = createSurface(
      emptyRows({
        currentRevision: 77,
        resourcesByAsset: {
          'a/1': [
            { resource_id: 'r1', source_path: '/mock/nikki/a.png' },
            { resource_id: 'r2', source_path: '/mock/nikki/a.mp4' }
          ]
        }
      })
    )
    const queries = createQuerySurface(fixture.surface, fixture.runtime)

    // meta 模式不送路径，因此也不该动授权表
    await queries.listResourceRecords(['a/1'], 'meta')
    expect(isNikkiSyncResourcePath('/mock/nikki/a.png')).toBe(false)

    await queries.listResourceRecords(['a/1'], 'path')
    expect(isNikkiSyncResourcePath('/mock/nikki/a.png')).toBe(true)
    expect(isNikkiSyncResourcePath('/mock/nikki/a.mp4')).toBe(true)
    expect(nikkiSyncResourceRevision()).toBe(77)
    clearNikkiSyncResourcePaths()
  })

  it('空资源资产不登记任何东西', async () => {
    clearNikkiSyncResourcePaths()
    const fixture = createSurface(emptyRows({ currentRevision: 5 }))
    const queries = createQuerySurface(fixture.surface, fixture.runtime)
    await queries.listResourceRecords(['a/none'], 'path')
    expect(nikkiSyncResourcePathCount()).toBe(0)
    clearNikkiSyncResourcePaths()
  })
})

describe('createRuntimeSession 组装失败的句柄归还（阶段 4 审查修复）', () => {
  it('runtime 构造成功后的导出缺失抛错时关闭已建库再上抛（Windows 锁库防护）', async () => {
    const close = vi.fn()
    const runtimeLike = {
      database: {
        connection: { prepare: () => ({ all: () => [], get: () => undefined }), exec: () => {} },
        initialize: () => {},
        close
      },
      scanner: {
        start: async () => ({}),
        stop: async () => {},
        fullScan: async () => ({}),
        rescanPath: async () => ({}),
        getStatus: () => ({})
      },
      server: {
        serverId: 'server_fake',
        start: async () => ({ host: '127.0.0.1', port: 38137, secure: true }),
        stop: async () => {},
        createPairingPayload: () => ({})
      },
      createPairingUri: () => 'NS1|server_fake|127.0.0.1|38137|tok|0|' + 'a'.repeat(64)
    } as unknown as EmbeddedRuntimeLike
    // pcCompanion 缺 LocalTlsIdentityService ⇒ nikkisyncExport 在 runtime 建成之后才抛错
    const surface = {
      pcCompanion: {
        PcCompanionRuntime: class {
          constructor() {
            return runtimeLike
          }
        }
      },
      database: { PairingRepository: class {} },
      rowMappers: {},
      suitSearchIndex: {},
      clothingSearchIndex: {},
      profileStatsIndex: {}
    } as unknown as RuntimeSurface

    await expect(
      createRuntimeSession(
        {
          databaseFile: '/tmp/userData/nikkisync/nikkisync.db',
          watcher: false,
          projectRoot: '/tmp/x'
        },
        surface
      )
    ).rejects.toThrow(/LocalTlsIdentityService/)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('createQuerySurface 既有三面不变', () => {
  it('listAssets 仍按 limit+1 前瞻并原样返回 items', async () => {
    const fixture = createSurface(emptyRows({ assets: [{ asset_id: 'a/1' }, { asset_id: 'a/2' }] }))
    const queries = createQuerySurface(fixture.surface, fixture.runtime)
    const page = await queries.listAssets({ limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(fixture.repoCalls[0]).toMatchObject({ limit: 2 })
  })

  it('getAssetDetail 仍原样返回 mapAssetDetail 结果', async () => {
    const fixture = createSurface(emptyRows({ assets: [{ asset_id: 'a/1' }] }))
    const queries = createQuerySurface(fixture.surface, fixture.runtime)
    await expect(queries.getAssetDetail('a/1')).resolves.toEqual({
      __mapped: 'detail',
      row: { asset_id: 'a/1' }
    })
  })
})

// ---------------------------------------------------------------- 阶段 6：单缝注入

interface SessionFixture {
  surface: RuntimeSurface
  /** 上游 `PcCompanionRuntime` 实际收到的配置对象（注入缝的唯一可观察面）。 */
  capturedConfig: () => Record<string, unknown> | undefined
  /** 上游 resolver 构造参数（用于确认端点是显式下传而非吃默认值）。 */
  resolverConfigs: Record<string, unknown>[]
  metadataHandle: { start: () => void; stop: () => void; runOnce: () => Promise<number> }
  diagnostics: (database: unknown, resolverEnabled: boolean) => unknown
  close: () => void
}

/**
 * 只喂 `createRuntimeSession` 所需的假装载面。
 * 关键复刻点：上游 `runtime.ts:74-81` **仅在 `metadataResolver` 键存在时**才构造服务实例，
 * 因此假 Runtime 也按同一条件挂 `metadataResolver`，否则测不出「键缺失」的真实后果。
 */
function createSessionFixture(): SessionFixture {
  const close = vi.fn()
  const metadataHandle = {
    start: vi.fn(),
    stop: vi.fn(),
    runOnce: vi.fn(async () => 0)
  }
  const resolverConfigs: Record<string, unknown>[] = []
  let capturedConfig: Record<string, unknown> | undefined
  const runtimeShape = {
    database: {
      connection: { prepare: () => ({ all: () => [], get: () => undefined }), exec: () => {} },
      initialize: () => {},
      close
    },
    scanner: {
      start: async () => ({}),
      stop: async () => {},
      fullScan: async () => ({}),
      rescanPath: async () => ({}),
      getStatus: () => ({})
    },
    server: {
      serverId: 'server_fake',
      start: async () => ({ host: '127.0.0.1', port: 38137, secure: true }),
      stop: async () => {},
      createPairingPayload: () => ({})
    },
    createPairingUri: () => 'NS1|server_fake|127.0.0.1|38137|tok|0|' + 'a'.repeat(64)
  } as Record<string, unknown>

  const surface = {
    pcCompanion: {
      PcCompanionRuntime: class {
        constructor(config: Record<string, unknown>) {
          capturedConfig = config
          if (config.metadataResolver) runtimeShape.metadataResolver = metadataHandle
          return runtimeShape as unknown as EmbeddedRuntimeLike
        }
      },
      LocalTlsIdentityService: class {
        getOrCreate() {
          return { keyPem: 'k', certPem: 'c', fingerprintSha256: 'f', createdAt: 'now' }
        }
      }
    },
    database: {
      PairingRepository: class {
        getDevice(): undefined {
          return undefined
        }
        revoke(): void {}
      },
      // createQuerySurface 在会话组装期就会 new 这两个仓储（只构造、不调方法），
      // 因此假面必须是**可构造的类**；查询行为由上面的 createSurface 用例覆盖。
      SyncReadRepository: class {},
      MetadataDictionaryRepository: class {}
    },
    rowMappers: {},
    suitSearchIndex: {},
    clothingSearchIndex: {},
    profileStatsIndex: {},
    nuan5Resolver: {
      Nuan5CompatibleResolver: class {
        constructor(config?: Record<string, unknown>) {
          resolverConfigs.push(config ?? {})
        }
        readonly id = 'nuan5-compatible'
      }
    },
    metadataDiagnostics: {
      metadataResolutionDiagnostics: vi.fn(() => ({ schemaVersion: 1, withCamera: 0 }))
    }
  } as unknown as RuntimeSurface

  return {
    surface,
    capturedConfig: () => capturedConfig,
    resolverConfigs,
    metadataHandle: metadataHandle as unknown as SessionFixture['metadataHandle'],
    diagnostics: surface.metadataDiagnostics.metadataResolutionDiagnostics,
    close: close as unknown as () => void
  }
}

const sessionOptions = (enabled?: boolean) => ({
  databaseFile: '/tmp/userData/nikkisync/nikkisync.db',
  watcher: false,
  projectRoot: '/tmp/x',
  ...(enabled === undefined ? {} : { metadataResolverEnabled: enabled })
})

describe('createRuntimeSession 元数据解析单缝注入（阶段 6）', () => {
  it('B-7 开关缺省/关闭：配置只有 databaseFile+scanner+server，且不构造 resolver', async () => {
    const fixture = createSessionFixture()
    const session = await createRuntimeSession(sessionOptions(false), fixture.surface)
    const config = fixture.capturedConfig()
    expect(config && Object.keys(config).sort()).toEqual(['databaseFile', 'scanner', 'server'])
    expect(config && 'metadataResolver' in config).toBe(false)
    expect(fixture.resolverConfigs).toEqual([])
    // 未开启 ⇒ 驱动面整个缺席（编排层据此判 0 轮，不需要再读开关）
    expect(session.metadataRunOnce).toBeUndefined()
    // 没有上游服务句柄时 stop 必须是 no-op，不能抛
    expect(() => session.stopMetadataResolver()).not.toThrow()
    expect(fixture.metadataHandle.stop).not.toHaveBeenCalled()
  })

  it('B-8 开关开启：下发 resolver 与收窄的 service，且绝不含 intervalMs', async () => {
    const fixture = createSessionFixture()
    await createRuntimeSession(sessionOptions(true), fixture.surface)
    const config = fixture.capturedConfig()
    const injected = config?.metadataResolver as {
      resolver: { id: string }
      service: Record<string, unknown>
    }
    expect(injected.resolver.id).toBe('nuan5-compatible')
    expect(injected.service.batchSize).toBe(DEFAULT_METADATA_BATCH_SIZE)
    expect(injected.service.enabled).toBe(true)
    // 上游用 `config.intervalMs ?? 15_000` 取值：下发 0 会造出 setInterval(fn, 0)，
    // 而下发任何 intervalMs 都意味着把自轮询引进本仓（本阶段刻意改为扫描后驱动）。
    expect(injected.service).not.toHaveProperty('intervalMs')
    // 端点必须显式下传，保证设置页披露与实际出口同源
    expect(fixture.resolverConfigs[0]).toEqual({ endpoint: NUAN5_METADATA_ENDPOINT })
    expect(String(fixture.resolverConfigs[0].endpoint)).toMatch(/^https:\/\//)
  })

  it('B-9 stopMetadataResolver 委托上游服务句柄的 stop', async () => {
    const fixture = createSessionFixture()
    const session = await createRuntimeSession(sessionOptions(true), fixture.surface)
    session.stopMetadataResolver()
    expect(fixture.metadataHandle.stop).toHaveBeenCalledTimes(1)
  })

  it('B-10 metadataRunOnce 逐字透传上游返回值', async () => {
    const fixture = createSessionFixture()
    const session = await createRuntimeSession(sessionOptions(true), fixture.surface)
    fixture.metadataHandle.runOnce.mockImplementationOnce(async () => 3)
    await expect(session.metadataRunOnce?.()).resolves.toBe(3)
  })

  it('B-11 诊断面将当前库句柄与开关原样下传上游', async () => {
    const fixture = createSessionFixture()
    const session = await createRuntimeSession(sessionOptions(true), fixture.surface)
    session.metadataDiagnostics()
    const spy = fixture.diagnostics as unknown as ReturnType<typeof vi.fn>
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][1]).toBe(true)
    expect(spy.mock.calls[0][0]).toBe(
      (session.runtime as unknown as { database: unknown }).database
    )
  })

  it('边界：开关缺省（undefined）与显式 false 同形 —— 都不注入', async () => {
    const fixture = createSessionFixture()
    await createRuntimeSession(sessionOptions(), fixture.surface)
    expect(fixture.capturedConfig() && 'metadataResolver' in fixture.capturedConfig()!).toBe(false)
  })
})
