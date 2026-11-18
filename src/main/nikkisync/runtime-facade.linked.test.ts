import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { hasNikkiSyncLink, NIKKISYNC_PACKAGES } from './runtime-loader'
import { buildPackagingContext, resolveDeepEntryUrl, resolveModuleRoot } from './embedding-paths'
import {
  createManagerDependencies,
  createRuntimeSession,
  decodePageCursor,
  encodePageCursor,
  GALLERY_RUNTIME_DEEP_ENTRY,
  loadRuntimeSurface
} from './runtime-facade'
import { createRuntimeManager } from './runtime-manager'
import type { NikkiSyncRuntimeSession, NikkiSyncSessionOptions } from './runtime-types'

/**
 * 内嵌门面链接态集成用例（整合阶段 2 · T3）。
 *
 * 与 `runtime-manager.test.ts` 的分工：那边只测本仓编排（假会话）；这里**真装载**
 * `@nikkisync/*` 产物，验证「数据库创建 / 目录发现 / 扫描 / 查询」四件事确实由上游完成：
 * 建表来自 `0001_initial.sql`，资产来自上游 `ScannerService` + `ScanReconciler` +
 * `AssetResolver`，DTO 来自上游 `SyncReadRepository` + `server/row-mappers.js`。
 *
 * 未建链时整件 skip（环境缺失不得记成逻辑失败），门控按包内 package.json 判定
 * （悬空 junction 会让目录存在判定给出假就绪）。
 *
 * 夹具体现：上游按目录名分类（`ResourceClassifier.classifyKind`），因此合成
 * `X6Game/Saved/GamePlayPhotos/<uid>/{NikkiPhotos_HighQuality,NikkiPhotos_LowQuality,Videos}`。
 * 真机数据同样跑过（见 docs/sync-integration/02-runtime-embed-plan.md §10：31 资产 / 6 motion_photo），
 * 但真机不可复现且依赖外置盘，因此仓库门禁以夹具为准。
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const LINKED = hasNikkiSyncLink(projectRoot)
const suite = LINKED ? describe : describe.skip

/**
 * 上游 `0001_initial.sql` 建的 14 张业务表。
 * a49764bb：迁移全文原地追加 `nuan5_resolution` / `nuan5_endpoint_state`，
 * 上游 `DatabaseManager.initialize()` 无版本门禁、每次都 exec 全文（IF NOT EXISTS），
 * 因此新建库与存量库都会得到这两张表。
 */
const MIGRATION_TABLES = [
  'app_settings',
  'assets',
  'change_journal',
  'device_sync_state',
  'library_state',
  'metadata_dictionary_entries',
  'metadata_dictionary_state',
  'nuan5_endpoint_state',
  'nuan5_resolution',
  'paired_devices',
  'pairing_sessions',
  'resolver_candidates',
  'resources',
  'schema_migrations'
]

/**
 * 上游不写迁移、改在构造期用 `CREATE TABLE IF NOT EXISTS` 自建的表。
 *
 * 分两批入列：`organizer_deletions` 自 K8（`DeletionQueue` 构造）就在，此前本文件只钉
 * 迁移那 12 张，它一直不在视野里；后三张来自 589b932 新增的 inspiration 子系统
 * （`LocalSyncServer` 构造期无条件建库）。闭集判定把这两批一起钉住，上游再加/改名当场可见。
 */
const RUNTIME_DDL_TABLES = [
  'inspiration_sync_clock',
  'inspiration_sync_entries',
  'inspiration_sync_images',
  'organizer_deletions'
]

const BUSINESS_TABLES = [...MIGRATION_TABLES, ...RUNTIME_DDL_TABLES]

/** SQLite 因 `AUTOINCREMENT` 派生的内部对象，不是业务表但会出现在 `tableNames()` 里。 */
const DERIVED_TABLES = ['sqlite_sequence']

const UID = '10001'
let fixtureRoot = ''
let databaseFile = ''
let session: NikkiSyncRuntimeSession | undefined

/** 造一个满足上游分类器目录语义的最小夹具（文件内容任意，哈希由上游真算）。 */
function writeFixture(relative: string, bytes: Buffer): string {
  const target = path.join(fixtureRoot, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, bytes)
  return target
}

beforeAll(() => {
  if (!LINKED) return
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nikkisync-embed-'))
  databaseFile = path.join(fixtureRoot, 'userData', 'nikkisync', 'nikkisync.db')
  // 生产链路里目录由 manager 的 ensureDatabaseDirectory 建；本用例直接调门面，故先建目录
  // （node:sqlite 不会自建父目录，缺失时上游 DatabaseManager 直接报 unable to open database file）
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true })
  // JPEG 尾部长于 46 字节才会走原生参数信封解析；这里刻意用极短内容避开该分支
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4, 0xff, 0xd9])
  const mp4 = Buffer.from('000000186674797069736f6d000002006d70343269736f6d', 'hex')
  writeFixture(path.join('game', 'X6Game', 'Engine', 'keep.txt'), Buffer.from('x'))
  // 上游 valid() 要求 `X6Game` 与游戏可执行文件同时存在（`game-directory-discovery.ts:79-83`），
  // 只造目录会当“无效安装”，因此夹具必须包含 Shipping exe 占位。
  writeFixture(
    path.join('game', 'X6Game', 'Binaries', 'Win64', 'X6Game-Win64-Shipping.exe'),
    Buffer.from('MZ placeholder')
  )
  writeFixture(
    path.join(
      'game',
      'X6Game',
      'Saved',
      'GamePlayPhotos',
      UID,
      'NikkiPhotos_HighQuality',
      'Photo_1.jpg'
    ),
    jpeg
  )
  writeFixture(
    path.join(
      'game',
      'X6Game',
      'Saved',
      'GamePlayPhotos',
      UID,
      'NikkiPhotos_HighQuality',
      'Photo_2.jpg'
    ),
    jpeg
  )
  writeFixture(
    path.join(
      'game',
      'X6Game',
      'Saved',
      'GamePlayPhotos',
      UID,
      'NikkiPhotos_LowQuality',
      'Photo_1.jpg'
    ),
    jpeg
  )
  writeFixture(
    path.join('game', 'X6Game', 'Saved', 'GamePlayPhotos', UID, 'Videos', 'Photo_2_cover.jpg'),
    jpeg
  )
  writeFixture(
    path.join('game', 'X6Game', 'Saved', 'GamePlayPhotos', UID, 'Videos', 'Photo_2.mp4'),
    mp4
  )
  // K9：第二个账号（UID 20002），用于验证账号作用域真的按 UID 收窄资产查询
  writeFixture(
    path.join(
      'game',
      'X6Game',
      'Saved',
      'GamePlayPhotos',
      '20002',
      'NikkiPhotos_HighQuality',
      'Photo_3.jpg'
    ),
    jpeg
  )
})

afterAll(async () => {
  if (session) {
    await session.scanner.stop()
    session.dispose()
    session = undefined
  }
  if (fixtureRoot) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

suite('runtime-facade 链接态', () => {
  it('会话创建：库文件落在 userData 下，18 张业务表（14 迁移 + 4 运行期自建）建齐', async () => {
    session = await createRuntimeSession({
      databaseFile,
      gameRoot: path.join(fixtureRoot, 'game'),
      watcher: false,
      projectRoot
    })
    expect(fs.existsSync(databaseFile)).toBe(true)
    // 闭集判定：表集合逐名相等（含派生对象），不再用「至少包含」——旧写法只钉 12 张迁移表 +
    // `>=12`，上游 589b932 无中生有多出 3 张 inspiration 表时一条都不会转红，
    // 这正是本轮要消灭的静默欠钉（02 计划 §0.2）。
    const tables = session.tableNames()
    expect([...tables].sort()).toEqual([...BUSINESS_TABLES, ...DERIVED_TABLES].sort())
    // a49764bb：0001_initial.sql 追加的 resolver 指纹索引必须随新库一起落地。
    const indexes = session.runtime.database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>
    expect(indexes.map((row) => row.name)).toContain('idx_assets_resolver_fingerprint')
  })

  it('扫描：上游 ScannerService 发现夹具根并把静图/视频聚合入库', async () => {
    const scanner = session?.scanner
    expect(scanner).toBeDefined()
    const result = (await scanner?.fullScan()) as {
      roots: string[]
      filesObserved: number
      resourcesAccepted: number
      assetsCreated: number
      errors: string[]
    }
    expect(result.errors).toEqual([])
    expect(result.filesObserved).toBeGreaterThanOrEqual(5)
    expect(result.resourcesAccepted).toBeGreaterThanOrEqual(4)
    expect(result.assetsCreated).toBeGreaterThanOrEqual(2)
    expect(result.roots.some((root) => root.includes('GamePlayPhotos'))).toBe(true)
  })

  it('查询透传：motion_photo 同时挂静图与视频，DTO 形态来自上游 row-mappers', async () => {
    const queries = session?.queries
    expect(queries).toBeDefined()
    const page = (await queries?.listAssets({ limit: 20 })) as {
      items: Array<{
        assetId: string
        type: string
        state: string
        revision: number
        hasMotion: boolean
        hasMetadata: boolean
      }>
      libraryRevision: number
    }
    expect(page.items.length).toBeGreaterThanOrEqual(2)
    expect(page.libraryRevision).toBeGreaterThan(0)
    for (const item of page.items) {
      expect(typeof item.assetId).toBe('string')
      expect(['photo', 'motion_photo']).toContain(item.type)
      expect(item.state).toBeTruthy()
      expect(typeof item.revision).toBe('number')
      expect(typeof item.hasMotion).toBe('boolean')
      expect(typeof item.hasMetadata).toBe('boolean')
    }
    const motion = page.items.find((item) => item.type === 'motion_photo')
    expect(motion).toBeDefined()
    expect(motion?.hasMotion).toBe(true)

    const detail = (await queries?.getAssetDetail(String(motion?.assetId))) as {
      asset: {
        assetId: string
        type: string
        resources: Array<{ role: string; resourceId: string; fileName: string }>
        motion?: { stillResourceId: string; motionResourceId: string }
      }
    }
    expect(detail.asset.type).toBe('motion_photo')
    const roles = detail.asset.resources.map((resource) => resource.role)
    expect(roles).toContain('source_primary')
    expect(roles).toContain('source_motion')
    expect(detail.asset.motion?.stillResourceId).toBeTruthy()
    expect(detail.asset.motion?.motionResourceId).toBeTruthy()
    // 上游 AssetResolver 的配对结论必须落在协议 motion 段里（静图与视频同资源集）
    const still = detail.asset.resources.find((resource) => resource.role === 'source_primary')
    const moving = detail.asset.resources.find((resource) => resource.role === 'source_motion')
    expect(detail.asset.motion?.stillResourceId).toBe(still?.resourceId)
    expect(detail.asset.motion?.motionResourceId).toBe(moving?.resourceId)
  })

  it('photo 资产带高/低双规格资源（source_high_quality + source_low_quality）', async () => {
    const page = (await session?.queries.listAssets({ limit: 20, type: 'photo' })) as {
      items: Array<{ assetId: string; type: string }>
    }
    expect(page.items.length).toBeGreaterThanOrEqual(1)
    // 夹具里只有 Photo_1 同时有 HQ+LQ（Photo_2 仅 HQ），而上游按 captured_at 降序返回，
    // 因此不能拿“第一条”当双规格样本（会因 mtime 微差而飘），按文件名定位再断言角色。
    const paired = page.items.find((item) => item.type === 'photo')
    const rolesByAsset: string[][] = []
    let target: { roles: string[] } | undefined
    for (const item of page.items) {
      const detail = (await session?.queries.getAssetDetail(item.assetId)) as {
        asset: { resources: Array<{ role: string; fileName: string }> }
      }
      const roles = detail.asset.resources.map((resource) => resource.role)
      rolesByAsset.push(roles)
      if (detail.asset.resources.some((resource) => resource.fileName === 'Photo_1.jpg')) {
        target = { roles }
      }
    }
    expect(paired).toBeDefined()
    expect(target?.roles).toContain('source_high_quality')
    expect(target?.roles).toContain('source_low_quality')
    // 双规格必须属于同一资产（上游 AssetResolver 的 uid+stem 分组结论）
    expect(
      rolesByAsset.some(
        (roles) => roles.includes('source_high_quality') && roles.includes('source_low_quality')
      )
    ).toBe(true)
  })

  it('getResource：meta 返回协议资源，path 返回上游 source_path 原值', async () => {
    const page = (await session?.queries.listAssets({ limit: 5 })) as {
      items: Array<{ assetId: string }>
    }
    const detail = (await session?.queries.getAssetDetail(page.items[0]!.assetId)) as {
      asset: { resources: Array<{ resourceId: string }> }
    }
    const resourceId = detail.asset.resources[0]!.resourceId
    const meta = (await session?.queries.getResource(
      page.items[0]!.assetId,
      resourceId,
      'meta'
    )) as {
      resourceId: string
      sha256: string
      sizeBytes: number
    }
    expect(meta.resourceId).toBe(resourceId)
    expect(meta.sha256).toHaveLength(64)
    expect(meta.sizeBytes).toBeGreaterThan(0)
    const location = (await session?.queries.getResource(
      page.items[0]!.assetId,
      resourceId,
      'path'
    )) as string
    expect(path.isAbsolute(location)).toBe(true)
    expect(fs.existsSync(location)).toBe(true)
  })

  it('游标分页：limit 小于总数时给出 nextCursor，翻页不重叠', async () => {
    const first = (await session?.queries.listAssets({ limit: 1 })) as {
      items: Array<{ assetId: string }>
      nextCursor?: string
      libraryRevision: number
    }
    expect(first.items).toHaveLength(1)
    expect(typeof first.nextCursor).toBe('string')
    const second = (await session?.queries.listAssets({ limit: 1, cursor: first.nextCursor })) as {
      items: Array<{ assetId: string }>
    }
    expect(second.items).toHaveLength(1)
    expect(second.items[0]!.assetId).not.toBe(first.items[0]!.assetId)
  })

  it('资源不存在 / 资产不存在时抛可映射为 404 的错误', async () => {
    await expect(session?.queries.getAssetDetail('asset_missing')).rejects.toThrow(/not found/)
    await expect(
      session?.queries.getResource('asset_missing', 'resource_missing', 'meta')
    ).rejects.toThrow(/not found/)
  })
})

suite('完整生命周期（真上游对象，验证退出链）', () => {
  it('start → scan → query → stop 后库关闭，可再次 start 恢复（应用退出/重开同一条链）', async () => {
    const options: NikkiSyncSessionOptions = {
      databaseFile: path.join(fixtureRoot, 'userData2', 'nikkisync.db'),
      gameRoot: path.join(fixtureRoot, 'game'),
      watcher: false,
      projectRoot
    }
    const logs: string[] = []
    const manager = createRuntimeManager(
      createManagerDependencies(options, (_level, message) => logs.push(message))
    )

    const started = await manager.start(options)
    expect(started.state).toBe('running')
    expect(fs.existsSync(options.databaseFile)).toBe(true)
    expect((started.tables ?? []).length).toBe(BUSINESS_TABLES.length + DERIVED_TABLES.length)

    const scan = (await manager.scan({})) as { filesObserved: number }
    expect(scan.filesObserved).toBeGreaterThanOrEqual(5)
    const page = (await manager.listAssets({ limit: 10 })) as { items: unknown[] }
    expect(page.items.length).toBeGreaterThanOrEqual(2)

    await manager.stop()
    expect(manager.status().state).toBe('idle')
    await expect(manager.listAssets({ limit: 1 })).rejects.toThrow(/not ready/)
    // 优雅关闭的客观信号：node:sqlite 干净 close 后 -wal 要么不在、要么已 checkpoint 为空
    const wal = `${options.databaseFile}-wal`
    expect(!fs.existsSync(wal) || fs.statSync(wal).size === 0).toBe(true)

    // 错误恢复路径：停掉后重新拉起同一库（不重建目录、不丢数据）
    const restarted = await manager.start(options)
    expect(restarted.state).toBe('running')
    const again = (await manager.listAssets({ limit: 10 })) as {
      items: unknown[]
      libraryRevision: number
    }
    expect(again.items.length).toBeGreaterThanOrEqual(2)
    expect(again.libraryRevision).toBeGreaterThan(0)
    await manager.stop()
    expect(logs.some((line) => line.includes('runtime started'))).toBe(true)
  }, 30000)
})

suite('查询零转换：资产行的本机绝对路径随上游载荷透出（真上游 + 真扫描）', () => {
  it('raw 查询面确实产出两键 ⇒ 反空转取证（上游若停止产出该键，本用例先红）', async () => {
    const queries = session?.queries
    expect(queries).toBeDefined()
    const page = (await queries?.listAssets({ limit: 20 })) as {
      items: Array<Record<string, unknown>>
    }
    const withPath = page.items.filter(
      (item) => typeof item.sourcePath === 'string' && typeof item.sourceFolder === 'string'
    )
    // 夹具每条资产都有 source_primary 资源，上游 mapAssetSummary 据此必带两键；
    // 这条若红，说明上游改产/改名，则下面的裁剪用例只是空转绿 ⇒ 必须复核而不是删断言。
    expect(withPath.length).toBeGreaterThan(0)
    const first = withPath[0] as Record<string, unknown>
    const sourcePath = String(first.sourcePath)
    expect(sourcePath.length).toBeGreaterThan(0)
    // 不假设大小写与分隔符（8.3 短名/卷名差异都会改变字面形态）：只断言父子关系成立
    expect(sourcePath.startsWith(String(first.sourceFolder))).toBe(true)
    expect(sourcePath).not.toBe(first.sourceFolder)
  })

  it('manager 面同一条链的响应里保留 sourcePath 与 sourceFolder', async () => {
    const options: NikkiSyncSessionOptions = {
      databaseFile: path.join(fixtureRoot, 'userDataN4', 'nikkisync.db'),
      gameRoot: path.join(fixtureRoot, 'game'),
      watcher: false,
      projectRoot
    }
    const logs: string[] = []
    const manager = createRuntimeManager(
      createManagerDependencies(options, (_level, message) => logs.push(message))
    )
    try {
      await manager.start(options)
      const scan = (await manager.scan({})) as { filesObserved: number }
      expect(scan.filesObserved).toBeGreaterThanOrEqual(5)
      const page = await manager.listAssets({ limit: 20 })
      const items = (page as { items: Array<Record<string, unknown>> }).items
      expect(items.length).toBeGreaterThanOrEqual(2)
      const withPath = items.filter(
        (item) => typeof item.sourcePath === 'string' && typeof item.sourceFolder === 'string'
      )
      expect(withPath.length).toBe(items.length)
      expect(String(withPath[0]!.sourcePath).startsWith(String(withPath[0]!.sourceFolder))).toBe(
        true
      )
    } finally {
      await manager.stop()
    }
  }, 30000)
})

suite('K9：账号同步作用域（真上游 AccountSyncSettings）', () => {
  it('默认态全部共享；选择变更后 listAssets 收窄且 listChanges 强制全量重同步', async () => {
    const accounts = session?.accounts
    expect(accounts).toBeDefined()
    const initial = accounts!.state()
    expect(initial.all).toBe(true)
    expect(initial.accounts.map((item) => item.uid).sort()).toEqual(['10001', '20002'])
    expect(initial.accounts.every((item) => item.selected)).toBe(true)

    accounts!.setSelection(['10001'])
    expect(accounts!.state().all).toBe(false)
    const page = (await session?.queries.listAssets({ limit: 50 })) as {
      items: Array<{ uid?: string }>
    }
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.every((item) => item.uid === '10001')).toBe(true)

    const changes = (await session?.queries.listChanges(0, 1000)) as {
      fullResyncRequired: boolean
    }
    expect(changes.fullResyncRequired).toBe(true)
  })

  it('三态：[] 不同步任何账号；null 恢复全部', async () => {
    const accounts = session!.accounts!
    accounts.setSelection([])
    const none = (await session!.queries.listAssets({ limit: 50 })) as { items: unknown[] }
    expect(none.items).toHaveLength(0)

    accounts.setSelection(null)
    const all = (await session!.queries.listAssets({ limit: 50 })) as {
      items: Array<{ uid?: string }>
    }
    expect(new Set(all.items.map((item) => item.uid))).toEqual(new Set(['10001', '20002']))
  })

  it('preview：账号样例按上游优先级返回图片资源行', () => {
    const accounts = session!.accounts!
    const sample = accounts.state().accounts.find((item) => item.uid === '10001')?.samples[0]
    expect(sample).toBeTruthy()
    const row = accounts.preview(String(sample)) as Record<string, unknown> | undefined
    expect(row).toBeDefined()
    expect(String(row?.mime_type)).toMatch(/^image\//)
  })
})

suite('同一库文件二次 createRuntimeSession 重开（兼容层 C3-3：老库零迁移升级路径）', () => {
  it('重开后表清单与首次一致、schema_migrations 可读且版本为 1（零迁移执行）', async () => {
    // 证明目标：既有 {userData}/nikkisync/nikkisync.db 用户在链接从 d4ca7d7 升到 b422193 后
    // 重开应用，上游 migrations 零变化（仍仅 0001_initial.sql、schema_migrations 已登记版本 1），
    // 重开必须零迁移执行、零异常、表形不变——本仓无需任何迁移适配（02 计划 C3）。
    const reopenFile = path.join(fixtureRoot, 'userData-reopen', 'nikkisync.db')
    fs.mkdirSync(path.dirname(reopenFile), { recursive: true })
    const options: NikkiSyncSessionOptions = {
      databaseFile: reopenFile,
      gameRoot: path.join(fixtureRoot, 'game'),
      watcher: false,
      projectRoot
    }

    const first = await createRuntimeSession(options)
    const firstTables = first.tableNames().slice().sort()
    expect(firstTables).toContain('schema_migrations')
    first.dispose()

    const second = await createRuntimeSession(options)
    const secondTables = second.tableNames().slice().sort()
    expect(secondTables).toEqual(firstTables)

    const migrationRows = second.runtime.database.connection
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number; name: string }>
    expect(migrationRows).toHaveLength(1)
    expect(migrationRows[0]).toMatchObject({
      version: 1,
      name: 'initial_asset_resource_sync_schema'
    })
    second.dispose()
  }, 30000)
})

suite('旧库升级：4cb71e2 结构的 nikkisync.db 在新版启动后自动补齐 2 表 1 索引', () => {
  it('本仓零自研 DDL，上游 initialize() 重跑全文迁移即补齐；表集合与新版闭集一致', async () => {
    // 事实证明：DatabaseManager.initialize() 无 schema_migrations 版本门禁，每次都 exec
    // 0001_initial.sql 全文（IF NOT EXISTS 幂等）。因此旧库重启会自然获得新增对象，
    // 本仓不需要另写一套迁移；此用例把「旧库 → 新版」的结果钉成可判定判据。
    const upRoot = process.env.NIKKISYNC_ROOT || path.join(projectRoot, '..', 'NikkiSync')
    // ci-linux 装置只翻译 options.cwd、不翻译 args 数组（tests/mocks/ci-linux-child-process.ts）：
    // 上游根经 cwd 下传（与 -C 语义等价），真宿主与 CI 装置两侧都成立。
    const legacySql = execFileSync(
      'git',
      ['show', '4cb71e2:packages/database/migrations/0001_initial.sql'],
      { cwd: upRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )

    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikkisync-legacy-db-'))
    let upgraded: NikkiSyncRuntimeSession | undefined
    try {
      const legacyFile = path.join(legacyDir, 'nikkisync.db')
      const db = new DatabaseSync(legacyFile)
      db.exec(legacySql)
      const before = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
      expect(before.map((row) => row.name)).not.toContain('nuan5_resolution')
      db.close()

      upgraded = await createRuntimeSession({
        databaseFile: legacyFile,
        gameRoot: path.join(fixtureRoot, 'game'),
        watcher: false,
        projectRoot
      })
      const tables = upgraded.tableNames()
      expect(tables).toContain('nuan5_resolution')
      expect(tables).toContain('nuan5_endpoint_state')
      expect([...tables].sort()).toEqual([...BUSINESS_TABLES, ...DERIVED_TABLES].sort())

      const indexes = upgraded.runtime.database.connection
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as Array<{ name: string }>
      expect(indexes.map((row) => row.name)).toContain('idx_assets_resolver_fingerprint')

      const migrationRows = upgraded.runtime.database.connection
        .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
        .all() as Array<{ version: number; name: string }>
      expect(migrationRows).toHaveLength(1)
      expect(migrationRows[0]).toMatchObject({
        version: 1,
        name: 'initial_asset_resource_sync_schema'
      })
    } finally {
      upgraded?.dispose()
      // Windows 上 node:sqlite 关闭后文件句柄可能稍晚释放，重试避免 EBUSY 掩盖真实断言。
      fs.rmSync(legacyDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }, 30000)
})

describe('runtime-facade 游标纯函数（不依赖链接）', () => {
  it('与上游同格式：base64url(JSON {t,id})，可解回原值', () => {
    const cursor = encodePageCursor({ t: '2026-06-16T13:17:41.000Z', id: 'asset_1' })
    expect(cursor).not.toContain('=')
    expect(decodePageCursor(cursor)).toEqual({ t: '2026-06-16T13:17:41.000Z', id: 'asset_1' })
  })

  it('非法游标一律降级为 undefined（与上游 decodeCursor 一致）', () => {
    expect(decodePageCursor(undefined)).toBeUndefined()
    expect(decodePageCursor('')).toBeUndefined()
    expect(decodePageCursor('not-base64-json')).toBeUndefined()
    expect(
      decodePageCursor(Buffer.from(JSON.stringify({ t: 1, id: 2 })).toString('base64url'))
    ).toBeUndefined()
  })
})

suite('K3：游戏版本日历深入口的实测边界（真实产物，无出站）', () => {
  it('静态表推断：边界日/未来/早于 1.0/undefined/非法输入都按上游口径', async () => {
    const surface = await loadRuntimeSurface(projectRoot)
    const infer = surface.gameVersionCalendar.inferInfinityNikkiGameVersion
    // 历史边界按字面钉住（原实测表 b422193：1.4=2025-03-26T03:00Z、1.5=2025-04-29T03:00Z、
    // 1.0=2024-12-05T02:00Z）——已生效的边界不随上游发版变化。
    // 「最新项」自锚点 b397e0e（v1.0.27-public-beta.1，新增 tentative 的 2.11 行）起改为从产物表派生，
    // 不再硬编码版本常量：上游日历是随发版增长的数据表，钉常量会让每一次同步必红一次。
    expect(infer('2025-04-01T00:00:00.000Z')).toBe('1.4')
    expect(infer('2025-03-26T03:00:00.000Z')).toBe('1.4')
    expect(infer('2025-03-26T02:59:59.999Z')).toBe('1.3')
    expect(infer('2024-12-04T00:00:00.000Z')).toBeUndefined()
    const releases = surface.gameVersionCalendar
      .getGameVersionReleases()
      .filter(
        (row): row is { version: string; effectiveAt: string } =>
          typeof (row as { version?: unknown; effectiveAt?: unknown }).version === 'string' &&
          typeof (row as { version?: unknown; effectiveAt?: unknown }).effectiveAt === 'string'
      )
    expect(releases.length).toBeGreaterThan(0)
    const stamps = releases.map((row) => Date.parse(row.effectiveAt))
    // 上游 infer 靠「按数组顺序首个命中」工作，降序本身即装载契约的一部分；
    // 出现非有限时间戳说明表形态与已装载产物不符 ⇒ 显式红，不静默回退
    expect(stamps.every((stamp) => Number.isFinite(stamp))).toBe(true)
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a))
    const newest = releases.reduce((earlier, later) =>
      Date.parse(later.effectiveAt) > Date.parse(earlier.effectiveAt) ? later : earlier
    )
    // 未来时刻取「最新行生效之后 1 秒」而不是固定年份：上游再加版本也不会重新变红。
    // 更不可取「当下时刻」——tentative 行的 uncertainFrom..effectiveAt 区间内上游返回 undefined。
    expect(infer(new Date(Date.parse(newest.effectiveAt) + 1000).toISOString())).toBe(
      newest.version
    )
    expect(infer(undefined)).toBeUndefined()
    // 非法输入不抛错：上游判缺省（纯查询无副作用）
    expect(infer('not-a-date')).toBeUndefined()
  })

  it('会话面 resolveGameVersion：版本与生效时间成对给出，未知时刻两键缺省', async () => {
    // 库文件直接落在 os.tmpdir() 下而不是 fixtureRoot 里 ⇒ 文件级 afterAll 的 rmSync 扫不到它。
    // 装置轴 7（node:sqlite）打通之后这一支才真能建库，每轮会留一个 180KB 的 .db，所以本用例自己收。
    // 建库必须写在 try 内：`createRuntimeSession` 打开 `.db` 之后还有若干步，任一步抛错时写在它外面的
    // 收尾都不会执行——那正是「自收尾」要消灭的泄漏，漏在失败路径上也算漏。
    const k3DatabaseFile = path.join(os.tmpdir(), `nikkisync-k3-${Date.now()}.db`)
    let k3Session: NikkiSyncRuntimeSession | undefined
    try {
      k3Session = await createRuntimeSession(
        {
          databaseFile: k3DatabaseFile,
          watcher: false,
          projectRoot
        },
        await loadRuntimeSurface(projectRoot)
      )
      const hit = k3Session.resolveGameVersion('2025-04-01T00:00:00.000Z')
      expect(hit.version).toBe('1.4')
      expect(hit.effectiveAt).toBe('2025-03-26T03:00:00.000Z')
      const miss = k3Session.resolveGameVersion(undefined)
      expect('version' in miss).toBe(false)
      expect('effectiveAt' in miss).toBe(false)
    } finally {
      k3Session?.dispose()
      fs.rmSync(k3DatabaseFile, { force: true, maxRetries: 10, retryDelay: 300 })
    }
  })
})

suite('K9：目录来源标注与旋转吧大喵分组（真上游 ExtraScanDirectories）', () => {
  it('setSource 触发来源组出现/消失，并在已保存选择时推进 revision', async () => {
    // 夹具落点必须宿主绑定（路径三分法第 2 档）：本套件扫描链路经上游 dist CJS 深入口
    // 直读宿主 fs，绕过 ci-linux 装置的 fs 翻译轴（装置已知失真——外置 CJS 内部 require
    // 不经翻译）。os.tmpdir() 在装置态是 CI 形态假路径，直读链路会判成不存在目录 ⇒ 扫描
    // 0 文件假红；.cache/ 为仓库 gitignored 落点，win32 / 装置 / 真 Linux CI 三态下均为
    // 真实可写路径。装置翻译轴对非 CI 前缀的真实路径双向原样放行（tests/mocks/ci-linux-fs.ts
    // toReal/toEmulated 的默认分支），宿主面与直读面看到同一份目录。
    fs.mkdirSync(path.join(projectRoot, '.cache'), { recursive: true })
    const root = fs.mkdtempSync(path.join(projectRoot, '.cache', 'nikkisync-k9-source-'))
    const imagesDir = path.join(root, 'SpinningMomo')
    const dbFile = path.join(root, 'userData', 'nikkisync.db')
    fs.mkdirSync(imagesDir, { recursive: true })
    fs.mkdirSync(path.dirname(dbFile), { recursive: true })
    fs.writeFileSync(
      path.join(imagesDir, 'shot.jpg'),
      Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4, 0xff, 0xd9])
    )
    let k9Session: NikkiSyncRuntimeSession | undefined
    try {
      k9Session = await createRuntimeSession(
        {
          databaseFile: dbFile,
          gameRoot: path.join(fixtureRoot, 'game'),
          watcher: false,
          projectRoot,
          extraDirectoriesFile: path.join(root, 'extra-scan-directories.json')
        },
        await loadRuntimeSurface(projectRoot)
      )
      const extra = k9Session.extraDirectories
      const accounts = k9Session.accounts
      expect(extra).toBeDefined()
      expect(accounts).toBeDefined()

      const proposal = (await extra!.inspect(imagesDir, 'spinning_momo')) as { id?: string }
      expect(proposal.id).toBeTruthy()
      const addedState = (await extra!.add(String(proposal.id))) as {
        directories: Array<{ id: string; path: string; source?: string }>
      }
      const added = addedState.directories.find((directory) => directory.source === 'spinning_momo')
      expect(added).toBeDefined()

      const grouped = accounts!.state().accounts.find((item) => item.uid === 'source:spinning_momo')
      expect(grouped).toBeDefined()
      expect(grouped!.count).toBeGreaterThanOrEqual(1)
      expect(accounts!.sourceGroups()).toHaveLength(1)

      accounts!.setSelection(['10001'])
      const revisionAfterSelection = accounts!.revision()
      expect(revisionAfterSelection).toBeGreaterThan(0)

      await extra!.setSource(String(added!.id), 'other')
      expect(accounts!.sourceGroups()).toHaveLength(0)
      expect(accounts!.revision()).toBeGreaterThan(revisionAfterSelection)
      const refreshed = (await extra!.state()) as {
        directories: Array<{ id: string; source?: string }>
      }
      expect(refreshed.directories.find((directory) => directory.id === added!.id)?.source).toBe(
        'other'
      )
      expect(accounts!.state().accounts.some((item) => item.uid === 'source:spinning_momo')).toBe(
        false
      )
    } finally {
      await k9Session?.scanner.stop()
      k9Session?.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30000)
})

/**
 * 1.0.41 对齐钉（上游 860ff0f / 6bdab4b，v1.0.41-public-beta.1/2）。
 * 三个 suite 各钉一个上游新行为，推进前对 a49764bb 旧 dist 必须红：
 * A 幂等 confirm 回执（旧 add 成功即删 proposal，重复 confirm 抛 selection_expired）；
 * B APP/NIKKI 容器自动发现（旧 commonLocations 无该容器，沙箱内返回 undefined）；
 * C exportJpeg 第 4 参 maxBytes（旧签名忽略第 4 参且 layout 钉死 16MiB）。
 */
suite('1.0.41 钉 A：ExtraScanDirectories confirm 幂等回执（真上游）', () => {
  it('重复 confirm 同一提案幂等返回 state；remove 后回执作废', async () => {
    fs.mkdirSync(path.join(projectRoot, '.cache'), { recursive: true })
    const root = fs.mkdtempSync(path.join(projectRoot, '.cache', 'nikkisync-141-confirm-'))
    const imagesDir = path.join(root, 'ExtraPhotos')
    const dbFile = path.join(root, 'userData', 'nikkisync.db')
    fs.mkdirSync(imagesDir, { recursive: true })
    fs.mkdirSync(path.dirname(dbFile), { recursive: true })
    fs.writeFileSync(
      path.join(imagesDir, 'shot.jpg'),
      Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4, 0xff, 0xd9])
    )
    let confirmSession: NikkiSyncRuntimeSession | undefined
    try {
      confirmSession = await createRuntimeSession(
        {
          databaseFile: dbFile,
          gameRoot: path.join(fixtureRoot, 'game'),
          watcher: false,
          projectRoot,
          extraDirectoriesFile: path.join(root, 'extra-scan-directories.json')
        },
        await loadRuntimeSurface(projectRoot)
      )
      const extra = confirmSession.extraDirectories
      expect(extra).toBeDefined()
      const proposal = (await extra!.inspect(imagesDir)) as { id?: string }
      expect(proposal.id).toBeTruthy()
      const first = (await extra!.add(String(proposal.id))) as {
        directories: Array<{ id: string }>
      }
      expect(first.directories).toHaveLength(1)
      // 上游新语义：桌面端可能丢失首次成功响应而重发同一确认 ⇒ 幂等返回 state，不抛过期
      const retry = (await extra!.add(String(proposal.id))) as {
        directories: Array<{ id: string }>
      }
      expect(retry.directories).toHaveLength(1)
      // 守护：目录被移除后回执随之作废，再 confirm 必须拒绝
      await extra!.remove(first.directories[0].id)
      await expect(extra!.add(String(proposal.id))).rejects.toThrow(/selection_expired/)
    } finally {
      await confirmSession?.scanner.stop()
      confirmSession?.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30000)
})

/** 上游安装根发现深入口（不在桶导出内，锚定口径同 e2e/nikkisync-game-root.e2e.ts）。 */
const GAME_DISCOVERY_DEEP_ENTRY = ['game-directory-discovery.js'] as const

interface GameDirectoryDiscoveryModule {
  discoverInfinityNikkiInstallation: (options?: {
    includeDefaultPaths?: boolean
    runningExecutablePaths?: string[]
    windowsHints?: { registryPaths: string[]; shortcutPaths: string[]; driveRoots: string[] }
  }) => Promise<{ installRoot?: string; photoRoots?: string[]; source?: string } | undefined>
}

suite('1.0.41 钉 B：APP/NIKKI 容器自动发现（真上游深入口）', () => {
  it('游戏关闭且无注册表/快捷方式提示时仍能发现 APP/NIKKI 下的安装', async () => {
    fs.mkdirSync(path.join(projectRoot, '.cache'), { recursive: true })
    const sandbox = fs.mkdtempSync(path.join(projectRoot, '.cache', 'nikkisync-141-app-'))
    const installRoot = path.join(
      sandbox,
      'APP',
      'NIKKI',
      'InfinityNikki Launcher',
      'InfinityNikki'
    )
    const photos = path.join(installRoot, 'X6Game', 'Saved', 'GamePlayPhotos')
    try {
      fs.mkdirSync(photos, { recursive: true })
      // 主程序文件不能 0 字节（本机杀软实时隔离，见 e2e 同形态注释）
      fs.writeFileSync(
        path.join(installRoot, 'InfinityNikki.exe'),
        'linked-test synthetic install root marker — not a PE binary\n'
      )
      const packaging = buildPackagingContext({ isPackaged: false, projectRoot })
      const moduleRoot = resolveModuleRoot(NIKKISYNC_PACKAGES.pcCompanion, packaging)
      const discoveryUrl = resolveDeepEntryUrl(moduleRoot.root, GAME_DISCOVERY_DEEP_ENTRY)
      const discovery = (await import(
        /* @vite-ignore */ discoveryUrl
      )) as GameDirectoryDiscoveryModule
      const result = await discovery.discoverInfinityNikkiInstallation({
        includeDefaultPaths: false,
        runningExecutablePaths: [],
        windowsHints: { registryPaths: [], shortcutPaths: [], driveRoots: [sandbox] }
      })
      expect(result).toBeDefined()
      expect(fs.realpathSync(String(result?.installRoot))).toBe(fs.realpathSync(installRoot))
      expect(result?.source).toBe('common-location')
      expect(result?.photoRoots).toEqual([photos])
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true })
    }
  }, 30000)
})

interface GalleryRuntimeExportModule {
  exportJpeg: (
    input: Uint8Array,
    metadata: unknown,
    options: { exif: boolean; rotation: number; cameraName?: string },
    maxBytes?: number
  ) => Buffer
}

/** 最小 JPEG（段构造形态同上游 tools/wechat-gallery/jpeg-fixture.mjs，exportJpeg 不解码像素）。 */
function minimalJpegBytes(): Buffer {
  const segment = (marker: number, data: Buffer): Buffer => {
    const b = Buffer.alloc(data.length + 4)
    b[0] = 255
    b[1] = marker
    b.writeUInt16BE(data.length + 2, 2)
    data.copy(b, 4)
    return b
  }
  return Buffer.concat([
    Buffer.from([255, 216]),
    segment(0xc0, Buffer.from([8, 0, 64, 0, 48, 1, 1, 0x11, 0])),
    segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([9, 8, 255, 0, 7, 255, 217])
  ])
}

/** EOI 前插填充造大输入（上游 local-sync-server.test.ts 同款形态，扫描段字节不变）。 */
function largeJpegBytes(paddingBytes: number): Buffer {
  const source = minimalJpegBytes()
  const end = source.length - 2
  return Buffer.concat([
    source.subarray(0, end),
    Buffer.alloc(paddingBytes, 7),
    source.subarray(end)
  ])
}

suite('1.0.41 钉 C：GalleryRuntime exportJpeg 显式 maxBytes（真上游再生成产物）', () => {
  const loadGalleryRuntime = async (): Promise<GalleryRuntimeExportModule> => {
    const packaging = buildPackagingContext({ isPackaged: false, projectRoot })
    const moduleRoot = resolveModuleRoot(NIKKISYNC_PACKAGES.pcCompanion, packaging)
    const url = resolveDeepEntryUrl(moduleRoot.root, GALLERY_RUNTIME_DEEP_ENTRY)
    return (await import(/* @vite-ignore */ url)) as GalleryRuntimeExportModule
  }

  it('17MiB 输入在显式 128MiB 上限下导出成功且像素字节不动', async () => {
    const { exportJpeg } = await loadGalleryRuntime()
    const large = largeJpegBytes(17 * 1024 * 1024)
    const output = exportJpeg(large, {}, { exif: false, rotation: 0 }, 128 * 1024 * 1024)
    // 不做全量 toEqual（17MiB 深比较会在 vitest worker 堆里放大数倍导致 OOM）：
    // 长度 + 首尾 + 扫描段逐字节足以钉住「原样返回、像素不动」
    expect(output.length).toBe(large.length)
    expect(output.subarray(0, 64)).toEqual(large.subarray(0, 64))
    const scanMarker = Buffer.from([0xff, 0xda])
    const outputScan = output.subarray(output.indexOf(scanMarker))
    const inputScan = large.subarray(large.indexOf(scanMarker))
    expect(outputScan.length).toBe(inputScan.length)
    expect(outputScan.equals(inputScan)).toBe(true)
    const withExif = exportJpeg(
      large,
      { camera: { focalLength: 35 } },
      { exif: true, rotation: 90 },
      128 * 1024 * 1024
    )
    const exifScan = withExif.subarray(withExif.indexOf(scanMarker))
    expect(exifScan.length).toBe(inputScan.length)
    expect(exifScan.equals(inputScan)).toBe(true)
    expect(withExif.includes(Buffer.from('"focalLength":35'))).toBe(true)
  }, 30000)

  it('低于 16MiB 下界的 maxBytes 被拒绝；缺省上限仍钉 16MiB', async () => {
    const { exportJpeg } = await loadGalleryRuntime()
    const small = minimalJpegBytes()
    expect(() => exportJpeg(small, {}, { exif: false, rotation: 0 }, 8 * 1024 * 1024)).toThrow(
      /JPEG export size limit/
    )
    // 守护：不传第 4 参时旧 16MiB 边界语义不变
    expect(() =>
      exportJpeg(largeJpegBytes(17 * 1024 * 1024), {}, { exif: false, rotation: 0 })
    ).toThrow(/JPEG export size/)
  }, 30000)
})
