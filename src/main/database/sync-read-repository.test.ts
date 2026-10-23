import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'

/**
 * SyncReadRepository 单元测试
 *
 * 策略沿用宿主 media-repository.test.ts / resonance-repository.test.ts：
 * 内存 mock 引擎避免原生模块 ABI 依赖，按 SYNC_METADATA_DDL_STATEMENTS 建表，
 * 仅覆盖读取仓储实际发出的静态字面量语句。listAssets 为"固定基线 + 固定片段
 * 白名单"组合查询（值全部参数绑定），mock 以片段探测等价实现过滤/排序/分页。
 * 编号对应 docs/sync-integration/02-sync-repository-plan.md §9（S1–S13）。
 */

import { SyncReadRepository, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from './sync-read-repository'
import { SYNC_METADATA_DDL_STATEMENTS } from './sync-metadata-repository'

// ============================================================================
// Mock 实现：内存 SQLite（覆盖读取仓储 + 元数据仓储用到的 SQL 模板）
// ============================================================================

interface MockRow {
  [key: string]: unknown
}

interface MediaSeedRow {
  id: number
  file_path: string
  file_name: string
  file_ext: string
  file_type: string
  file_size: number
  width: number | null
  height: number | null
  duration: number | null
  created_at: string
  modified_at: string
  thumbnail: string | null
  account_uid: string
  indexed_at: string
  is_deleted: number
  deleted_at: string | null
  is_missing: number
  is_corrupted: number
  editor_metadata: string | null
  sha256: string | null
  is_duplicate: number
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

const LIST_BASE_MARKER =
  'FROM media_files m LEFT JOIN sync_motion_links ml ON ml.still_media_id = m.id LEFT JOIN sync_motion_links mlv ON mlv.motion_media_id = m.id WHERE mlv.motion_media_id IS NULL AND m.is_duplicate = 0'
const FRAG_NOT_DELETED = ' AND m.is_deleted = 0'
const FRAG_TYPE_PHOTO = " AND m.file_type = 'image' AND ml.still_media_id IS NULL"
const FRAG_TYPE_MOTION = " AND m.file_type = 'image' AND ml.still_media_id IS NOT NULL"
const FRAG_TYPE_VIDEO = " AND m.file_type = 'video'"
const FRAG_TYPE_UNKNOWN = " AND m.file_type NOT IN ('image', 'video')"
const FRAG_AFTER_MARKER = 'FROM sync_change_journal j2'
const FRAG_CURSOR_MARKER = " AND (COALESCE(NULLIF(m.modified_at, '')"

const MEDIA_COLUMNS = [
  'id',
  'file_path',
  'file_name',
  'file_type',
  'file_ext',
  'file_size',
  'width',
  'height',
  'duration',
  'created_at',
  'modified_at',
  'thumbnail',
  'account_uid',
  'indexed_at',
  'is_deleted',
  'deleted_at',
  'is_missing',
  'is_corrupted',
  'editor_metadata',
  'sha256'
] as const

const DETAIL_MARKER = 'FROM media_files m WHERE m.id = ?'

class SyncReadMockDb {
  tables = new Map<string, { rows: MockRow[] }>()
  mediaFiles: MediaSeedRow[] = []
  private nextMediaId = 100

  constructor() {
    for (const statement of SYNC_METADATA_DDL_STATEMENTS) {
      const match = normalizeSql(statement).match(/^CREATE TABLE IF NOT EXISTS (\w+) /i)
      if (match) this.tables.set(match[1]!, { rows: [] })
    }
  }

  seedMedia(overrides: Partial<MediaSeedRow> & { id: number }): MediaSeedRow {
    const row: MediaSeedRow = {
      id: overrides.id,
      file_path: `D:/lib/IMG_${overrides.id}.jpg`,
      file_name: `IMG_${overrides.id}.jpg`,
      file_ext: 'jpg',
      file_type: 'image',
      file_size: 1024,
      width: 1920,
      height: 1080,
      duration: null,
      created_at: '2026-01-01T00:00:00.000Z',
      modified_at: '2026-01-05T00:00:00.000Z',
      thumbnail: null,
      account_uid: 'default',
      indexed_at: '2026-01-03T00:00:00.000Z',
      is_deleted: 0,
      deleted_at: null,
      is_missing: 0,
      is_corrupted: 0,
      editor_metadata: null,
      sha256: null,
      is_duplicate: 0,
      ...overrides
    }
    this.mediaFiles.push(row)
    return row
  }

  seedMotionLink(stillMediaId: number, motionMediaId: number): void {
    this.tables.get('sync_motion_links')!.rows.push({
      still_media_id: stillMediaId,
      motion_media_id: motionMediaId,
      method: 'filename',
      confidence: 1,
      presentation_timestamp_us: null,
      created_at: '2026-06-01T00:00:00.000Z'
    })
  }

  seedJournal(revision: number, assetId: string): void {
    this.tables.get('sync_change_journal')!.rows.push({
      revision,
      event_type: 'asset.created',
      asset_id: assetId,
      occurred_at: '2026-06-01T00:00:00.000Z',
      payload_json: null
    })
  }

  seedServiceState(libraryRevision: number): void {
    this.tables.get('sync_service_state')!.rows.length = 0
    this.tables.get('sync_service_state')!.rows.push({
      id: 1,
      library_revision: libraryRevision,
      server_id: 'wxnn-0123456789abcdef',
      server_name: 'WXNN XiangCe',
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z'
    })
  }

  private syncRows(name: string): MockRow[] {
    return this.tables.get(name)!.rows
  }

  private journalMaxByAsset(): Map<string, number> {
    const map = new Map<string, number>()
    for (const row of this.syncRows('sync_change_journal')) {
      const assetId = String(row['asset_id'])
      const revision = Number(row['revision'])
      map.set(assetId, Math.max(map.get(assetId) ?? 0, revision))
    }
    return map
  }

  private sortKeyOf(row: MediaSeedRow): string {
    return row.modified_at !== '' ? row.modified_at : row.created_at
  }

  private projectMedia(row: MediaSeedRow): MockRow {
    const projected: MockRow = {}
    for (const col of MEDIA_COLUMNS) projected[col] = row[col]
    return projected
  }

  prepare(sql: string): {
    run: (...params: unknown[]) => { changes: number; lastInsertRowid: number }
    get: (...params: unknown[]) => MockRow | undefined
    all: (...params: unknown[]) => MockRow[]
  } {
    const normalized = normalizeSql(sql)
    return {
      run: (...params: unknown[]) => this.runStatement(normalized, params),
      get: (...params: unknown[]) => this.getStatement(normalized, params),
      all: (...params: unknown[]) => this.allStatement(normalized, params)
    }
  }

  transaction<R>(fn: () => R): () => R {
    return () => fn()
  }

  // ============ 写 ============

  private runStatement(
    normalized: string,
    params: unknown[]
  ): { changes: number; lastInsertRowid: number } {
    if (normalized === 'UPDATE media_files SET sha256 = ? WHERE id = ?') {
      const row = this.mediaFiles.find((r) => r.id === Number(params[1]))
      if (!row) return { changes: 0, lastInsertRowid: 0 }
      row.sha256 = String(params[0])
      return { changes: 1, lastInsertRowid: 0 }
    }

    const journalMatch = normalized.match(
      /^INSERT INTO sync_change_journal \(revision, event_type, asset_id, occurred_at, payload_json\) VALUES \(\(SELECT COALESCE\(MAX\(revision\), 0\) \+ 1 FROM sync_change_journal\), \?, \?, \?, \?\)$/
    )
    if (journalMatch) {
      const rows = this.syncRows('sync_change_journal')
      const maxRevision = rows.reduce((max, row) => Math.max(max, Number(row['revision'])), 0)
      rows.push({
        revision: maxRevision + 1,
        event_type: params[0],
        asset_id: params[1],
        occurred_at: params[2],
        payload_json: params[3] ?? null
      })
      return { changes: 1, lastInsertRowid: 0 }
    }

    const mirrorMatch = normalized.match(
      /^UPDATE sync_service_state SET library_revision = \(SELECT MAX\(revision\) FROM sync_change_journal\), updated_at = \? WHERE id = 1$/
    )
    if (mirrorMatch) {
      const rows = this.syncRows('sync_service_state')
      const journal = this.syncRows('sync_change_journal')
      const maxRevision = journal.reduce((max, row) => Math.max(max, Number(row['revision'])), 0)
      const row = rows.find((r) => r['id'] === 1)
      if (!row) return { changes: 0, lastInsertRowid: 0 }
      row['library_revision'] = maxRevision
      row['updated_at'] = params[0]
      return { changes: 1, lastInsertRowid: 0 }
    }

    const seedMatch = normalized.match(
      /^INSERT OR IGNORE INTO sync_service_state \(id, library_revision, server_id, server_name, created_at, updated_at\) VALUES \(1, 0, NULL, NULL, \?, \?\)$/
    )
    if (seedMatch) {
      const rows = this.syncRows('sync_service_state')
      if (!rows.some((r) => r['id'] === 1)) {
        rows.push({
          id: 1,
          library_revision: 0,
          server_id: null,
          server_name: null,
          created_at: params[0],
          updated_at: params[1]
        })
        return { changes: 1, lastInsertRowid: 0 }
      }
      return { changes: 0, lastInsertRowid: 0 }
    }

    const identityMatch = normalized.match(
      /^UPDATE sync_service_state SET server_id = \?, server_name = \?, updated_at = \? WHERE id = 1 AND \(server_id IS NULL OR server_id = ''\)$/
    )
    if (identityMatch) {
      const row = this.syncRows('sync_service_state').find((r) => r['id'] === 1)
      if (!row || row['server_id']) return { changes: 0, lastInsertRowid: 0 }
      row['server_id'] = params[0]
      row['server_name'] = params[1]
      row['updated_at'] = params[2]
      return { changes: 1, lastInsertRowid: 0 }
    }

    if (normalized === 'DELETE FROM sync_motion_links') {
      const rows = this.syncRows('sync_motion_links')
      const changes = rows.length
      rows.length = 0
      return { changes, lastInsertRowid: 0 }
    }

    const linkInsertMatch = normalized.match(
      /^INSERT INTO sync_motion_links \(still_media_id, motion_media_id, method, confidence, presentation_timestamp_us, created_at\) VALUES \(\?, \?, 'filename', 1, NULL, \?\)$/
    )
    if (linkInsertMatch) {
      this.syncRows('sync_motion_links').push({
        still_media_id: params[0],
        motion_media_id: params[1],
        method: 'filename',
        confidence: 1,
        presentation_timestamp_us: null,
        created_at: params[2]
      })
      return { changes: 1, lastInsertRowid: 0 }
    }

    const deviceUpsertMatch = normalized.match(/^INSERT OR REPLACE INTO sync_paired_devices/)
    if (deviceUpsertMatch) throw new Error('SyncReadMockDb: 设备写模板不在读取测试范围')
    if (normalized.startsWith('UPDATE sync_paired_devices')) {
      throw new Error('SyncReadMockDb: 设备写模板不在读取测试范围')
    }

    throw new Error(`SyncReadMockDb: 未覆盖的 SQL: ${normalized}`)
  }

  // ============ 读 ============

  private getStatement(normalized: string, params: unknown[]): MockRow | undefined {
    if (normalized === 'SELECT library_revision FROM sync_service_state WHERE id = 1') {
      return this.syncRows('sync_service_state').find((r) => r['id'] === 1)
    }
    if (normalized === 'SELECT MAX(revision) AS revision FROM sync_change_journal') {
      const rows = this.syncRows('sync_change_journal')
      if (rows.length === 0) return undefined
      return { revision: Math.max(...rows.map((r) => Number(r['revision']))) }
    }
    if (normalized === 'SELECT MIN(revision) AS min_revision FROM sync_change_journal') {
      const rows = this.syncRows('sync_change_journal')
      if (rows.length === 0) return undefined
      return { min_revision: Math.min(...rows.map((r) => Number(r['revision']))) }
    }
    if (normalized === 'SELECT server_id, server_name FROM sync_service_state WHERE id = 1') {
      return this.syncRows('sync_service_state').find((r) => r['id'] === 1)
    }
    if (
      normalized ===
      'SELECT id, account_uid, modified_at, editor_metadata FROM media_files WHERE id = ?'
    ) {
      const row = this.mediaFiles.find((r) => r.id === Number(params[0]))
      if (!row) return undefined
      return {
        id: row.id,
        account_uid: row.account_uid,
        modified_at: row.modified_at,
        editor_metadata: row.editor_metadata
      }
    }
    if (
      normalized ===
      'SELECT id, file_path, file_name, file_type, file_ext, file_size, width, height, duration, created_at, modified_at, thumbnail, account_uid, indexed_at, is_deleted, deleted_at, is_missing, is_corrupted, editor_metadata, sha256 FROM media_files WHERE id = ?'
    ) {
      const row = this.mediaFiles.find((r) => r.id === Number(params[0]))
      return row ? this.projectMedia(row) : undefined
    }
    if (normalized.includes(DETAIL_MARKER) && normalized.includes('AS derived_revision')) {
      const row = this.mediaFiles.find((r) => r.id === Number(params[0]))
      if (!row) return undefined
      return {
        ...this.projectMedia(row),
        derived_revision: this.journalMaxByAsset().get(String(row.id)) ?? 0
      }
    }
    if (
      normalized ===
      'SELECT still_media_id, motion_media_id, method, confidence, presentation_timestamp_us FROM sync_motion_links WHERE still_media_id = ?'
    ) {
      const row = this.syncRows('sync_motion_links').find(
        (r) => Number(r['still_media_id']) === Number(params[0])
      )
      if (!row) return undefined
      return {
        still_media_id: row['still_media_id'],
        motion_media_id: row['motion_media_id'],
        method: row['method'],
        confidence: row['confidence'],
        presentation_timestamp_us: row['presentation_timestamp_us']
      }
    }
    const allRows = this.allStatement(normalized, params)
    return allRows[0]
  }

  private allStatement(normalized: string, params: unknown[]): MockRow[] {
    if (
      normalized ===
      'SELECT revision, event_type, asset_id, occurred_at, payload_json FROM sync_change_journal WHERE revision > ? ORDER BY revision ASC LIMIT ?'
    ) {
      return this.syncRows('sync_change_journal')
        .filter((r) => Number(r['revision']) > Number(params[0]))
        .sort((a, b) => Number(a['revision']) - Number(b['revision']))
        .slice(0, Number(params[1]))
    }
    if (
      normalized ===
      'SELECT still_media_id, motion_media_id, method, confidence, presentation_timestamp_us FROM sync_motion_links'
    ) {
      return this.syncRows('sync_motion_links').map((row) => ({
        still_media_id: row['still_media_id'],
        motion_media_id: row['motion_media_id'],
        method: row['method'],
        confidence: row['confidence'],
        presentation_timestamp_us: row['presentation_timestamp_us']
      }))
    }
    if (normalized.includes(LIST_BASE_MARKER)) {
      return this.runListAssets(normalized, params)
    }
    throw new Error(`SyncReadMockDb: 未覆盖的 SQL: ${normalized}`)
  }

  /** listAssets 组合查询的等价语义实现（片段探测 → JS 过滤/排序/分页） */
  private runListAssets(normalized: string, params: unknown[]): MockRow[] {
    const includeDeleted = !normalized.includes(FRAG_NOT_DELETED)
    const typePhoto = normalized.includes(FRAG_TYPE_PHOTO)
    const typeMotion = normalized.includes(FRAG_TYPE_MOTION)
    const typeVideo = normalized.includes(FRAG_TYPE_VIDEO)
    const typeUnknown = normalized.includes(FRAG_TYPE_UNKNOWN)
    const afterPresent = normalized.includes(FRAG_AFTER_MARKER)
    const cursorPresent = normalized.includes(FRAG_CURSOR_MARKER)

    const limit = Number(params[params.length - 1])
    const afterRevision = afterPresent ? Number(params[0]) : null
    let cursorSortKey: string | null = null
    let cursorId = 0
    if (cursorPresent) {
      const base = afterPresent ? 1 : 0
      cursorSortKey = String(params[base])
      cursorId = Number(params[base + 2])
    }

    const motionByStill = new Set(
      this.syncRows('sync_motion_links').map((r) => Number(r['still_media_id']))
    )
    const linkedVideos = new Set(
      this.syncRows('sync_motion_links').map((r) => Number(r['motion_media_id']))
    )
    const journalMax = this.journalMaxByAsset()

    const candidates = this.mediaFiles.filter((row) => {
      if (row.is_duplicate === 1) return false
      if (linkedVideos.has(row.id)) return false
      if (!includeDeleted && row.is_deleted !== 0) return false
      if (typePhoto && !(row.file_type === 'image' && !motionByStill.has(row.id))) return false
      if (typeMotion && !(row.file_type === 'image' && motionByStill.has(row.id))) return false
      if (typeVideo && row.file_type !== 'video') return false
      if (typeUnknown && row.file_type === 'image') return false
      if (typeUnknown && row.file_type === 'video') return false
      return true
    })

    const projected = candidates.map((row) => ({
      row,
      sortKey: this.sortKeyOf(row),
      derivedRevision: journalMax.get(String(row.id)) ?? 0
    }))

    let filtered = projected
    if (afterRevision !== null) {
      filtered = filtered.filter((entry) => entry.derivedRevision > afterRevision)
    }
    if (cursorSortKey !== null) {
      filtered = filtered.filter((entry) => {
        if (entry.sortKey < cursorSortKey!) return true
        if (entry.sortKey === cursorSortKey) return entry.row.id < cursorId
        return false
      })
    }
    filtered.sort((a, b) => {
      if (a.sortKey !== b.sortKey) return b.sortKey.localeCompare(a.sortKey)
      return b.row.id - a.row.id
    })
    const page = filtered.slice(0, limit + 1)
    return page.map((entry) => ({
      ...this.projectMedia(entry.row),
      has_motion_link: motionByStill.has(entry.row.id) ? 1 : 0,
      derived_revision: entry.derivedRevision
    }))
  }
}

// ============================================================================
// 夹具
// ============================================================================

const T0105 = '2026-01-05T00:00:00.000Z'

function makeDb(): SyncReadMockDb {
  return new SyncReadMockDb()
}

interface Fixture {
  db: SyncReadMockDb
  repo: SyncReadRepository
  hashCalls: string[]
}

/** 标准夹具：photo×2 + motion 对 + 独立视频 + 软删 + 重复 + 损坏 + 缺失 */
function makeFixture(): Fixture {
  const db = makeDb()
  db.seedMedia({ id: 1, thumbnail: 'D:/lib/.thumbs/IMG_1.jpg', modified_at: T0105 })
  db.seedMedia({
    id: 2,
    file_path: 'D:/lib/IMG_2.png',
    file_name: 'IMG_2.png',
    file_ext: 'png',
    editor_metadata: '{"k":1}',
    modified_at: '2026-01-06T00:00:00.000Z'
  })
  db.seedMedia({
    id: 3,
    file_path: 'D:/lib/IMG_3.jpg',
    file_name: 'IMG_3.jpg',
    modified_at: '2026-01-07T00:00:00.000Z'
  })
  db.seedMedia({
    id: 4,
    file_path: 'D:/lib/IMG_3.mov',
    file_name: 'IMG_3.mov',
    file_ext: 'mov',
    file_type: 'video',
    duration: 3.5,
    modified_at: '2026-01-07T00:00:00.000Z'
  })
  db.seedMotionLink(3, 4)
  db.seedMedia({
    id: 5,
    file_path: 'D:/lib/CLIP_5.mp4',
    file_name: 'CLIP_5.mp4',
    file_ext: 'mp4',
    file_type: 'video',
    duration: 3.5,
    thumbnail: 'D:/lib/.thumbs/CLIP_5.jpg',
    modified_at: '2026-01-08T00:00:00.000Z'
  })
  db.seedMedia({
    id: 6,
    is_deleted: 1,
    deleted_at: '2026-02-01T00:00:00.000Z',
    modified_at: '2026-01-04T00:00:00.000Z'
  })
  db.seedMedia({ id: 7, is_duplicate: 1, modified_at: '2026-01-03T00:00:00.000Z' })
  db.seedMedia({ id: 8, is_corrupted: 1, modified_at: '2026-01-03T00:00:00.000Z' })
  db.seedMedia({ id: 9, is_missing: 1, modified_at: '2026-01-02T00:00:00.000Z' })

  const hashCalls: string[] = []
  const hashFile = vi.fn(async (filePath: string) => {
    hashCalls.push(filePath)
    return `sha-${filePath.split('/').pop()}`
  })
  const repo = new SyncReadRepository(db as unknown as Database.Database, null, '', { hashFile })
  return { db, repo, hashCalls }
}

const idsOf = (items: Array<{ assetId: string }>) => items.map((i) => i.assetId)

// ============================================================================
// 分页与过滤（S1–S3 / S7 / S12）
// ============================================================================

describe('listAssets 分页与过滤', () => {
  let fx: Fixture
  beforeEach(() => {
    fx = makeFixture()
  })

  it(`S1 默认 limit=${DEFAULT_PAGE_LIMIT}：排除软删/重复/链接视频，按 sortKey 降序`, () => {
    const page = fx.repo.listAssets()
    expect(page.items.map((s) => s.assetId)).toEqual(['5', '3', '2', '1', '8', '9'])
    expect(page.items).toHaveLength(6)
    expect(page.nextCursor).toBeUndefined()
    expect(page.libraryRevision).toBe(0)
  })

  it('S1b 游标分页游走取尽全部资产', () => {
    const first = fx.repo.listAssets({ limit: 3 })
    expect(idsOf(first.items)).toEqual(['5', '3', '2'])
    expect(first.nextCursor).toBeDefined()
    const second = fx.repo.listAssets({ limit: 3, cursor: first.nextCursor })
    expect(idsOf(second.items)).toEqual(['1', '8', '9'])
    expect(second.nextCursor).toBeUndefined()
  })

  it('S2 type 过滤：photo/motion_photo/video 互斥（损坏/缺失的 image 仍属 photo，state=missing）', () => {
    expect(idsOf(fx.repo.listAssets({ type: 'photo' }).items)).toEqual(['2', '1', '8', '9'])
    expect(idsOf(fx.repo.listAssets({ type: 'motion_photo' }).items)).toEqual(['3'])
    expect(idsOf(fx.repo.listAssets({ type: 'video' }).items)).toEqual(['5'])
  })

  it('S3 includeDeleted 默认排除软删；置 true 包含且 state=deleted', () => {
    expect(idsOf(fx.repo.listAssets({ includeDeleted: true }).items)).toContain('6')
    const deleted = fx.repo
      .listAssets({ includeDeleted: true })
      .items.find((s) => s.assetId === '6')
    expect(deleted?.state).toBe('deleted')
  })

  it('S7 afterRevision 过滤：仅返回日志中有更高 revision 的资产', () => {
    fx.db.seedJournal(1, '5')
    fx.db.seedServiceState(1)
    expect(idsOf(fx.repo.listAssets({ afterRevision: 0 }).items)).toEqual(['5'])
    expect(fx.repo.listAssets({ afterRevision: 1 }).items).toEqual([])
  })

  it('S12a is_duplicate 恒排除；is_corrupted 计入 state=missing 仍在列表', () => {
    const page = fx.repo.listAssets()
    expect(idsOf(page.items)).not.toContain('7')
    const corrupted = page.items.find((s) => s.assetId === '8')
    expect(corrupted?.state).toBe('missing')
  })

  it(`S9b limit 越界钳制：0 → 1；${MAX_PAGE_LIMIT} 以上封顶`, () => {
    expect(fx.repo.listAssets({ limit: 0 }).items).toHaveLength(1)
    const page = fx.repo.listAssets({ limit: MAX_PAGE_LIMIT + 1 })
    expect(page.items.length).toBeLessThanOrEqual(MAX_PAGE_LIMIT)
  })

  it('S6b summary 形状：hasMotion/hasMetadata/preview 降级/resourceId', () => {
    const page = fx.repo.listAssets()
    const motion = page.items.find((s) => s.assetId === '3')!
    expect(motion.type).toBe('motion_photo')
    expect(motion.hasMotion).toBe(true)
    expect(motion.width).toBe(1920)
    const withMeta = page.items.find((s) => s.assetId === '2')!
    expect(withMeta.hasMetadata).toBe(true)
    expect(withMeta.previewResourceId).toBe('res_2_primary')
    const withThumb = page.items.find((s) => s.assetId === '5')!
    expect(withThumb.thumbnailResourceId).toBe('res_5_thumbnail')
    expect(withThumb.previewResourceId).toBe('res_5_thumbnail')
  })
})

// ============================================================================
// 详情与惰性哈希（S4–S5 / S10）
// ============================================================================

describe('getAssetDetail', () => {
  let fx: Fixture
  beforeEach(() => {
    fx = makeFixture()
  })

  it('S4a photo：primary + thumbnail 两资源，metadata 缺省', async () => {
    const detail = await fx.repo.getAssetDetail('1')
    expect(detail).not.toBeNull()
    expect(detail!.asset.type).toBe('photo')
    expect(detail!.asset.state).toBe('ready')
    expect(detail!.asset.resources.map((r) => r.role)).toEqual([
      'source_primary',
      'derived_thumbnail'
    ])
    expect(detail!.asset.resources[0]!.sha256).toBe('sha-IMG_1.jpg')
    expect(detail!.asset.motion).toBeUndefined()
    expect(detail!.asset.metadata).toBeUndefined()
    expect(detail!.asset.revision).toBe(0)
  })

  it('S4b motion_photo：source_primary + source_motion 与 MotionAssetInfo', async () => {
    const detail = await fx.repo.getAssetDetail('3')
    expect(detail!.asset.type).toBe('motion_photo')
    expect(detail!.asset.resources.map((r) => r.role)).toEqual(['source_primary', 'source_motion'])
    const motionResource = detail!.asset.resources[1]!
    expect(motionResource.resourceId).toBe('res_4_motion')
    expect(motionResource.mimeType).toBe('video/quicktime')
    expect(motionResource.durationMs).toBe(3500)
    expect(motionResource.sha256).toBe('sha-IMG_3.mov')
    expect(detail!.asset.motion?.stillResourceId).toBe('res_3_primary')
    expect(detail!.asset.motion?.motionResourceId).toBe('res_4_motion')
    expect(detail!.asset.motion?.resolver).toEqual({ method: 'filename', confidence: 1 })
  })

  it('S4c video：单 primary 资源、durationMs 毫秒、thumbnail 资源在列', async () => {
    const detail = await fx.repo.getAssetDetail('5')
    expect(detail!.asset.type).toBe('video')
    expect(detail!.asset.resources.map((r) => r.role)).toEqual([
      'source_primary',
      'derived_thumbnail'
    ])
    expect(detail!.asset.resources[0]!.durationMs).toBe(3500)
    expect(detail!.asset.motion).toBeUndefined()
  })

  it('S4d metadata：editor_metadata 无损透传 raw；revision 取日志派生值', async () => {
    fx.db.seedJournal(4, '2')
    const detail = await fx.repo.getAssetDetail('2')
    expect(detail!.asset.metadata?.raw).toEqual({ k: 1 })
    expect(detail!.asset.metadata?.schemaVersion).toBe(1)
    expect(detail!.asset.revision).toBe(4)
  })

  it('S5 惰性 sha256：首次计算并回写缓存列；二次命中缓存不再计算（缩略图即时哈希）', async () => {
    await fx.repo.getAssetDetail('1')
    expect(fx.hashCalls).toEqual(['D:/lib/IMG_1.jpg', 'D:/lib/.thumbs/IMG_1.jpg'])
    expect(fx.db.mediaFiles.find((r) => r.id === 1)!.sha256).toBe('sha-IMG_1.jpg')
    await fx.repo.getAssetDetail('1')
    expect(fx.hashCalls).toHaveLength(3) // 源文件命中缓存，仅缩略图重算
    expect(fx.hashCalls[2]).toBe('D:/lib/.thumbs/IMG_1.jpg')
  })

  it('S10 未命中返回 null；非法 assetId 拒绝', async () => {
    expect(await fx.repo.getAssetDetail('999999')).toBeNull()
    await expect(fx.repo.getAssetDetail('abc')).rejects.toThrow()
    await expect(fx.repo.getAssetDetail('0')).rejects.toThrow()
    await expect(fx.repo.getAssetDetail('1; DROP TABLE media_files')).rejects.toThrow()
  })
})

// ============================================================================
// 元数据与资源定位（S6 / S11）
// ============================================================================

describe('getAssetMetadata / getResourceLocation / getServerInfo / getChanges', () => {
  let fx: Fixture
  beforeEach(() => {
    fx = makeFixture()
  })

  it('S6a getAssetMetadata：raw 透传 / 空值 null / 未命中 null', async () => {
    expect((await fx.repo.getAssetMetadata('2'))?.raw).toEqual({ k: 1 })
    expect(await fx.repo.getAssetMetadata('1')).toBeNull()
    expect(await fx.repo.getAssetMetadata('999999')).toBeNull()
  })

  it('S6b getResourceLocation：三类资源返回正确绝对路径与描述', async () => {
    const primary = await fx.repo.getResourceLocation('1', 'res_1_primary')
    expect(primary?.absolutePath).toBe('D:/lib/IMG_1.jpg')
    expect(primary?.resource.role).toBe('source_primary')
    const thumb = await fx.repo.getResourceLocation('1', 'res_1_thumbnail')
    expect(thumb?.absolutePath).toBe('D:/lib/.thumbs/IMG_1.jpg')
    expect(thumb?.resource.role).toBe('derived_thumbnail')
    const motion = await fx.repo.getResourceLocation('3', 'res_4_motion')
    expect(motion?.absolutePath).toBe('D:/lib/IMG_3.mov')
    expect(motion?.resource.role).toBe('source_motion')
  })

  it('S11 getResourceLocation：非法/不匹配 resourceId → null', async () => {
    expect(await fx.repo.getResourceLocation('1', 'not-a-resource')).toBeNull()
    expect(await fx.repo.getResourceLocation('1', 'res_5_primary')).toBeNull()
    expect(await fx.repo.getResourceLocation('1', 'res_1_motion')).toBeNull()
    expect(await fx.repo.getResourceLocation('999999', 'res_999999_primary')).toBeNull()
    await expect(fx.repo.getResourceLocation('abc', 'res_1_primary')).rejects.toThrow()
  })

  it('S6c getServerInfo：协议版本/身份稳定/库级 revision/capabilities', async () => {
    const info = await fx.repo.getServerInfo()
    expect(info.protocolVersion).toBe(1)
    expect(info.serverId).toMatch(/^wxnn-[0-9a-f]{16}$/)
    expect(info.name).toBe('Meow Star Map')
    expect(info.capabilities).toEqual({
      websocketEvents: true,
      rangeRequests: true,
      metadataV1: true,
      motionAssets: true
    })
    const again = await fx.repo.getServerInfo()
    expect(again.serverId).toBe(info.serverId)
  })

  it('S6d getChanges：变更列表 + libraryRevision + fullResyncRequired 判定', async () => {
    fx.db.seedJournal(5, '1')
    fx.db.seedJournal(6, '2')
    fx.db.seedServiceState(6)
    const response = await fx.repo.getChanges(0)
    expect(response.changes.map((c) => c.revision)).toEqual([5, 6])
    expect(response.libraryRevision).toBe(6)
    expect(response.fullResyncRequired).toBe(true) // after=0 < min-1=4
    const partial = await fx.repo.getChanges(5)
    expect(partial.changes.map((c) => c.revision)).toEqual([6])
    expect(partial.fullResyncRequired).toBe(false)
    expect((await fx.repo.getChanges(6)).changes).toEqual([])
  })
})

// ============================================================================
// 参数校验（S8–S9a）
// ============================================================================

describe('listAssets 参数校验', () => {
  it('S8 非法 cursor / type / limit / afterRevision → 拒绝', () => {
    const fx = makeFixture()
    expect(() => fx.repo.listAssets({ cursor: '!!!bad!!!' })).toThrow()
    expect(() => fx.repo.listAssets({ type: 'movie' as never })).toThrow()
    expect(() => fx.repo.listAssets({ limit: 1.5 })).toThrow()
    expect(() => fx.repo.listAssets({ limit: Number.NaN })).toThrow()
    expect(() => fx.repo.listAssets({ afterRevision: -1 })).toThrow()
    expect(() => fx.repo.listAssets({ afterRevision: 0.5 })).toThrow()
  })

  it('S13 同步直写：sha256 缓存列即时可见（resonance 写路径先例）', async () => {
    const fx = makeFixture()
    await fx.repo.getResourceLocation('5', 'res_5_primary')
    expect(fx.db.mediaFiles.find((r) => r.id === 5)!.sha256).toBe('sha-CLIP_5.mp4')
  })
})

// ============================================================================
// 计划登记的常量基线
// ============================================================================

describe('分页常量', () => {
  it('默认 100、上限 500（对齐上游服务端强制范围）', () => {
    expect(DEFAULT_PAGE_LIMIT).toBe(100)
    expect(MAX_PAGE_LIMIT).toBe(500)
  })
})
