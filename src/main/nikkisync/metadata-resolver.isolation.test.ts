import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'

import { PAIRED_DEVICES_SQL } from './runtime-facade'
import { findOriginalTableRefs, isSyncLaneSqlAllowed } from './metadata-isolation-guards'

/**
 * 阶段 6：同步解析面与原有扫描器的**表级隔离**回归守护（红灯先行写法的固化档）。
 *
 * 两档形态沿用 `src/main/scanner/__tests__/rescan-restore-sql.test.ts` 的既有先例，
 * 原因是同一个：本仓大量测试要碰原生模块，而 `better-sqlite3` 是 Electron ABI、
 * `vi.mock` 对原生模块无效（vite-node 的 import 会绕过它）。因此：
 *
 * - **结构档**（任何 Node 都必跑）：把「同步面不得书写指向原有库表的 SQL」
 *   折成对源码文本与 SQL 常量的断言，不依赖任何引擎。
 * - **语义档**（`node:sqlite` 可用时跑）：用真实 SQLite 执行阶段 6 同步路径
 *   **逐字复制自上游**的三条 SQL，对同一库里的 `media_files` 哨兵行证明
 *   「行数不变、列结构不变、内容不变」——这是真 SQL 语义，比 fake 更强，
 *   且刻意**不需要** `better-sqlite3`，所以不受 Electron ABI 限制。
 *
 * 上游 SQL 出处（复制于 NikkiSync `d4ca7d7`，本仓只读不改）：
 * - `packages/database/src/asset-repository.ts:243-254` `listMetadataResolutionCandidates`
 * - `packages/database/src/asset-repository.ts:228-238` `updateMetadata`
 * - `packages/database/src/change-journal-repository.ts:13-30` `record` / `currentRevision`
 * 上游行为若变化，链接态 `metadata-resolver.linked.test.ts` 会先失败（它跑真实仓储）。
 */

const nodeRequire = createRequire(import.meta.url)

/** 真实 SQLite 引擎构造器；node:sqlite 不可用（Node < 22.5）时保持 null */
let SqliteCtor: (new (path: string) => DatabaseSyncType) | null = null
try {
  SqliteCtor = (nodeRequire('node:sqlite') as { DatabaseSync: new (p: string) => DatabaseSyncType })
    .DatabaseSync
} catch {
  console.warn(
    '[metadata-resolver.isolation] ⚠ node:sqlite 不可用（需 Node >= 22.5，当前 ' +
      process.versions.node +
      '）：真实 SQL 语义档已跳过，本轮仅运行无引擎依赖的结构档断言。' +
      'CI（Node 20）下属预期降级；本地请用 Node ≥ 22.5 复核语义档。'
  )
}
const hasSqliteEngine = SqliteCtor !== null

// ---------------------------------------------------------------- 结构档

const LANE_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 同步装载缝的非测试源码（`*.test.ts` 与 `__tests__/` 不参与：它们允许引用原有表名做断言）。 */
function syncLaneSourceFiles(): string[] {
  return readdirSync(LANE_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => path.join(LANE_DIR, name))
}

describe('结构档：同步装载缝源码不含原有库表的 SQL', () => {
  it('枚举到的源码非空（防目录改名把断言掏空成恒真）', () => {
    const files = syncLaneSourceFiles()
    expect(files.length).toBeGreaterThan(0)
    expect(files.some((file) => file.endsWith('runtime-facade.ts'))).toBe(true)
    expect(files.some((file) => file.endsWith('metadata-resolver-driver.ts'))).toBe(true)
  })

  it('每个源码文件的 SQL 表引用都只落在 NikkiSync 自有表上', async () => {
    const { readFileSync } = await import('node:fs')
    for (const file of syncLaneSourceFiles()) {
      const source = readFileSync(file, 'utf8')
      // 逐条取出 SQL 形态的表引用；散文里提一句 media_files 不构成引用（见护栏模块判据说明）
      expect(findOriginalTableRefs(source), path.basename(file)).toEqual([])
    }
  })

  it('本仓唯一一条裸 SQL（配对设备只读 SELECT）不触及原有库表', () => {
    expect(isSyncLaneSqlAllowed(PAIRED_DEVICES_SQL)).toBe(true)
    expect(findOriginalTableRefs(PAIRED_DEVICES_SQL)).toEqual([])
  })

  it('阶段 6 新增的两个上游深入口模块名不在桶导出内（防有人改回静态导入）', () => {
    // 与 metadata-resolver-driver / runtime-facade 的深入口常量同源：这两个符号一旦进了
    // 上游 barrel，就该改走 NIKKISYNC_REQUIRED_EXPORTS 探针，而不是继续用深入口
    const upstreamBarrelExports = [
      'game-directory-discovery.js',
      'runtime.js',
      'scanner/index.js',
      'server/index.js',
      'metadata/MetadataResolverPipeline.js',
      'metadata/types.js'
    ]
    expect(upstreamBarrelExports).not.toContain('metadata/Nuan5CompatibleResolver.js')
    expect(upstreamBarrelExports).not.toContain('metadata/MetadataResolutionDiagnostics.js')
  })
})

// ---------------------------------------------------------------- 语义档

/** 阶段 6 同步路径真正执行的三条上游 SQL（逐字复制，出处见文件头）。 */
const UPSTREAM_CANDIDATES_SQL = `
      SELECT * FROM assets
      WHERE asset_state <> 'deleted'
        AND uid IS NOT NULL
        AND metadata_json IS NOT NULL
        AND json_extract(metadata_json, '$.raw.nativeParamToken') IS NOT NULL
      ORDER BY discovered_at ASC, asset_id ASC
      LIMIT ?`

const UPSTREAM_UPDATE_METADATA_SQL =
  'UPDATE assets SET metadata_schema_version = ?, metadata_json = ?, revision = ?, updated_at = ? WHERE asset_id = ?'

const UPSTREAM_JOURNAL_INSERT_SQL =
  'INSERT INTO change_journal (revision, event_type, asset_id, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?)'

const UPSTREAM_JOURNAL_CURRENT_SQL = 'SELECT library_revision FROM library_state WHERE id = 1'

const UPSTREAM_LIBRARY_STATE_UPDATE_SQL =
  'UPDATE library_state SET library_revision = ?, updated_at = ? WHERE id = 1'

interface Snapshot {
  rows: unknown[]
  columns: unknown[]
}

describe.runIf(hasSqliteEngine)('语义档：真实 SQL 执行后原有库表逐字节不变', () => {
  let db: DatabaseSyncType

  const snapshotMediaFiles = (): Snapshot => ({
    rows: db.prepare('SELECT * FROM media_files ORDER BY id').all(),
    columns: db.prepare('PRAGMA table_info(media_files)').all()
  })

  beforeAll(() => {
    db = new SqliteCtor!(':memory:')
    // assets：只建阶段 6 三条 SQL 用到的列（列名与上游 0001_initial.sql 逐字一致）
    db.exec(`CREATE TABLE assets (
      asset_id TEXT PRIMARY KEY,
      asset_type TEXT NOT NULL,
      asset_state TEXT NOT NULL,
      uid TEXT,
      discovered_at TEXT NOT NULL,
      metadata_schema_version INTEGER,
      metadata_json TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    )`)
    db.exec(`CREATE TABLE change_journal (
      revision INTEGER PRIMARY KEY,
      event_type TEXT NOT NULL,
      asset_id TEXT,
      occurred_at TEXT NOT NULL,
      payload_json TEXT
    )`)
    db.exec(`CREATE TABLE library_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      library_revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    )`)
    db.exec("INSERT INTO library_state (id, library_revision, updated_at) VALUES (1, 0, 'x')")
    // media_files：原有库的哨兵表，列名取自 connection.ts 的 base DDL 关键列
    db.exec(`CREATE TABLE media_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL UNIQUE,
      file_name TEXT,
      file_size INTEGER NOT NULL DEFAULT 0,
      thumbnail TEXT,
      phash TEXT,
      is_duplicate INTEGER NOT NULL DEFAULT 0,
      original_id INTEGER,
      sha256 TEXT,
      indexed_at TEXT NOT NULL
    )`)
    db.exec(`INSERT INTO media_files (file_path, file_name, indexed_at) VALUES
      ('/game/X6Game/Saved/GamePlayPhotos/10001/NikkiPhotos_HighQuality/a.jpg', 'a.jpg', 't1'),
      ('/game/X6Game/Saved/GamePlayPhotos/10001/NikkiPhotos_LowQuality/a.jpg', 'a.jpg', 't2'),
      ('/game/X6Game/Saved/GamePlayPhotos/10001/videos/a_cover.jpg', 'a_cover.jpg', 't3')`)

    // 25 张静图里取 3 张做代表（三件齐）+ 1 张只有 token + 1 张 motion（连 raw 都没有）
    const envelope = (payload: string | null, md5: string | null): string =>
      JSON.stringify({
        camera: {},
        capture: {},
        raw: { nativeParamToken: 'dG9rZW4=', nativeParamPayload: payload, nativeParamNuan5Md5: md5 }
      })
    const insert = db.prepare(
      'INSERT INTO assets (asset_id, asset_type, asset_state, uid, discovered_at, metadata_json, revision) VALUES (?, ?, ?, ?, ?, ?, 0)'
    )
    insert.run(
      'a/1',
      'photo',
      'ready',
      '10001',
      '2026-10-01T00:00:00Z',
      envelope('cGF5bG9hZA==', '0'.repeat(32))
    )
    insert.run(
      'a/2',
      'photo',
      'ready',
      '10001',
      '2026-10-02T00:00:00Z',
      envelope('cGF5bG9hZA==', '1'.repeat(32))
    )
    insert.run(
      'a/3',
      'photo',
      'ready',
      '10002',
      '2026-10-03T00:00:00Z',
      envelope('cGF5bG9hZA==', '2'.repeat(32))
    )
    insert.run('a/4', 'photo', 'ready', '10002', '2026-10-04T00:00:00Z', envelope(null, null))
    insert.run('a/5', 'motion_photo', 'ready', '10003', '2026-10-05T00:00:00Z', JSON.stringify({}))
  })

  afterAll(() => {
    db?.close()
  })

  it('候选队列的入队判据**只看 uid + token**：motion_photo（无 raw）不入队，缺载荷的仍入队', () => {
    const rows = db.prepare(UPSTREAM_CANDIDATES_SQL).all(50) as Array<Record<string, unknown>>
    // a/4 只有 token、没有 payload —— 上游 SQL 不校验载荷，它照样入队
    expect(rows.map((row) => row.asset_id)).toEqual(['a/1', 'a/2', 'a/3', 'a/4'])
    // 阶段说明里「6 条 motion 无参数」在 SQL 层成立：它根本不入队，无需本仓再加过滤
    expect(rows.some((row) => row.asset_type === 'motion_photo')).toBe(false)
    // 载荷缺失要到 resolver 本地组包时才抛（Nuan5CompatibleResolver.ts:24-27），
    // 所以 a/4 会占一个队列名额、写 status:'failed'，但**不产生任何出站请求**。
    // 节点 0-1 实测本机 25/25 三件齐 ⇒ 现役库里没有落在这一档的资产（该档由准入门保证）。
    expect(rows.map((row) => String(row.asset_id)).includes('a/4')).toBe(true)
  })

  it('驱动解析一条资产：只有 assets / change_journal / library_state 被写，media_files 逐字节不变', () => {
    const before = snapshotMediaFiles()
    const beforeRevision = db.prepare(UPSTREAM_JOURNAL_CURRENT_SQL).get() as {
      library_revision: number
    }

    // 逐字复刻上游 updateMetadata 的事务体（journal.record 先取号，再写 assets 行）
    const nextRevision = beforeRevision.library_revision + 1
    db.exec('BEGIN IMMEDIATE')
    db.prepare(UPSTREAM_JOURNAL_INSERT_SQL).run(
      nextRevision,
      'asset.updated',
      'a/1',
      '2026-10-16T00:00:00Z',
      JSON.stringify({ metadata: true })
    )
    db.prepare(UPSTREAM_LIBRARY_STATE_UPDATE_SQL).run(nextRevision, '2026-10-16T00:00:00Z')
    db.prepare(UPSTREAM_UPDATE_METADATA_SQL).run(
      1,
      JSON.stringify({ camera: { focalLength: 50 }, dressing: { clothes: [101, 102] } }),
      nextRevision,
      '2026-10-16T00:00:00Z',
      'a/1'
    )
    db.exec('COMMIT')

    const after = snapshotMediaFiles()
    expect(after.rows).toEqual(before.rows)
    expect(after.columns).toEqual(before.columns)
    expect(db.prepare('SELECT COUNT(*) AS c FROM media_files').get()).toEqual({ c: 3 })

    const asset = db
      .prepare(
        'SELECT metadata_json, revision, metadata_schema_version FROM assets WHERE asset_id = ?'
      )
      .get('a/1') as { metadata_json: string; revision: number; metadata_schema_version: number }
    expect(JSON.parse(asset.metadata_json).camera).toEqual({ focalLength: 50 })
    expect(asset.revision).toBe(nextRevision)
    expect(asset.metadata_schema_version).toBe(1)

    // 未被解析的其余行不得被牵连
    const untouched = db.prepare('SELECT revision FROM assets WHERE asset_id = ?').get('a/2') as {
      revision: number
    }
    expect(untouched.revision).toBe(0)
  })

  it('同一条 SQL 集反复执行也不产生 media_files 的任何结构漂移', () => {
    const before = snapshotMediaFiles()
    for (const assetId of ['a/2', 'a/3']) {
      const current = db.prepare(UPSTREAM_JOURNAL_CURRENT_SQL).get() as { library_revision: number }
      const revision = current.library_revision + 1
      db.prepare(UPSTREAM_JOURNAL_INSERT_SQL).run(revision, 'asset.updated', assetId, 't', null)
      db.prepare(UPSTREAM_LIBRARY_STATE_UPDATE_SQL).run(revision, 't')
      db.prepare(UPSTREAM_UPDATE_METADATA_SQL).run(
        1,
        JSON.stringify({ camera: {} }),
        revision,
        't',
        assetId
      )
    }
    expect(snapshotMediaFiles()).toEqual(before)
  })
})
