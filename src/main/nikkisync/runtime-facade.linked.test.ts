import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { hasNikkiSyncLink } from './runtime-loader'
import {
  createManagerDependencies,
  createRuntimeSession,
  decodePageCursor,
  encodePageCursor,
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

/** 上游 `0001_initial.sql` 的 12 张业务表（sqlite_sequence 为派生对象，不参与断言）。 */
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
})

afterAll(async () => {
  if (session) {
    await session.scanner.stop()
    session.dispose()
    session = undefined
  }
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true })
})

suite('runtime-facade 链接态', () => {
  it('会话创建：库文件落在 userData 下，12 张业务表由上游 migration 建齐', async () => {
    session = await createRuntimeSession({
      databaseFile,
      gameRoot: path.join(fixtureRoot, 'game'),
      watcher: false,
      projectRoot
    })
    expect(fs.existsSync(databaseFile)).toBe(true)
    const tables = session.tableNames()
    for (const table of BUSINESS_TABLES) expect(tables).toContain(table)
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
    expect((started.tables ?? []).length).toBeGreaterThanOrEqual(12)

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
    const session = await createRuntimeSession(
      {
        databaseFile: path.join(os.tmpdir(), `nikkisync-k3-${Date.now()}.db`),
        watcher: false,
        projectRoot
      },
      await loadRuntimeSurface(projectRoot)
    )
    try {
      const hit = session.resolveGameVersion('2025-04-01T00:00:00.000Z')
      expect(hit.version).toBe('1.4')
      expect(hit.effectiveAt).toBe('2025-03-26T03:00:00.000Z')
      const miss = session.resolveGameVersion(undefined)
      expect('version' in miss).toBe(false)
      expect('effectiveAt' in miss).toBe(false)
    } finally {
      session.dispose()
    }
  })
})
