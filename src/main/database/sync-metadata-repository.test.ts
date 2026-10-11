import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'

/**
 * SyncMetadataRepository 单元测试
 *
 * 策略沿用宿主 media-repository.test.ts / resonance-repository.test.ts：
 * 内存 mock 引擎避免原生模块 ABI 依赖，按 SYNC_METADATA_DDL_STATEMENTS 的同一
 * schema 建表，仅覆盖本仓储实际发出的静态字面量语句（未覆盖模板直接抛错）。
 * 编号对应 docs/sync-integration/02-sync-repository-plan.md §9（R1–R13）。
 */

import {
  SYNC_METADATA_DDL_STATEMENTS,
  SyncMetadataRepository,
  computeMotionLinks,
  DEFAULT_SERVER_NAME,
  type SyncPairedDeviceRow
} from './sync-metadata-repository'
import type { MotionLinkRow } from './sync-row-mappers'

// ============================================================================
// Mock 实现：内存 SQLite（仅覆盖 SyncMetadataRepository 用到的 SQL 模板）
// ============================================================================

interface MockRow {
  [key: string]: unknown
}

interface MockTable {
  columns: string[]
  rows: MockRow[]
  uniqueKeys: string[][]
  pk?: string[]
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

class SyncMockDb {
  tables = new Map<string, MockTable>()
  mediaFiles: Array<{
    id: number
    file_path: string
    file_name: string
    file_ext: string
    file_type: string
    is_deleted: number
  }> = []

  /** 应用本仓储导出的 DDL（CREATE TABLE 建表，索引语句忽略） */
  applyDdl(statements: readonly string[]): void {
    for (const statement of statements) {
      const match = normalizeSql(statement).match(/^CREATE TABLE IF NOT EXISTS (\w+) \((.*)\)$/i)
      if (!match) continue // CREATE INDEX 等语句由真实 SQLite 处理，内存引擎忽略
      const name = match[1]!
      const body = match[2]!
      const columns: string[] = []
      const uniqueKeys: string[][] = []
      let pk: string[] | undefined
      let depth = 0
      let current = ''
      const parts: string[] = []
      for (const ch of body) {
        if (ch === '(') depth++
        if (ch === ')') depth--
        if (ch === ',' && depth === 0) {
          parts.push(current.trim())
          current = ''
        } else {
          current += ch
        }
      }
      if (current.trim()) parts.push(current.trim())
      for (const part of parts) {
        const upper = part.toUpperCase()
        if (upper.startsWith('UNIQUE')) {
          const keyMatch = part.match(/\(([^)]+)\)/)
          if (keyMatch) uniqueKeys.push(keyMatch[1]!.split(',').map((c) => c.trim()))
          continue
        }
        if (upper.startsWith('PRIMARY KEY')) {
          const keyMatch = part.match(/\(([^)]+)\)/)
          if (keyMatch) pk = keyMatch[1]!.split(',').map((c) => c.trim())
          continue
        }
        const colName = part.split(/\s+/)[0]!
        columns.push(colName)
        if (upper.includes('PRIMARY KEY') && !upper.startsWith('CHECK')) {
          pk = [colName]
        }
        if (/\bUNIQUE\b/.test(upper)) {
          uniqueKeys.push([colName])
        }
      }
      this.tables.set(name, { columns, rows: [], uniqueKeys, pk })
    }
  }

  /** 测试夹具：直接播种 media_files 候选行 */
  seedMediaFiles(
    rows: Array<{
      id: number
      file_path: string
      file_name: string
      file_ext: string
      file_type: string
      is_deleted?: number
    }>
  ): void {
    this.mediaFiles.push(...rows.map((r) => ({ ...r, is_deleted: r.is_deleted ?? 0 })))
  }

  prepare(sql: string): {
    run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint }
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
    // 简化事务：同步执行；fn 抛错时异常向上传播（等价回滚——中间态对外不可见）
    return () => fn()
  }

  private table(name: string): MockTable {
    const table = this.tables.get(name)
    if (!table) throw new Error(`no such table: ${name}`)
    return table
  }

  private findUniqueViolation(table: MockTable, candidate: MockRow): boolean {
    const keySets = [...table.uniqueKeys]
    if (table.pk) keySets.push(table.pk)
    return keySets.some((keys) =>
      table.rows.some((row) => keys.every((k) => row[k] === candidate[k]))
    )
  }

  /** 解析 VALUES 项：数字/NULL/字符串字面量/占位符 */
  private parseValues(itemsText: string, params: unknown[]): unknown[] {
    const items = itemsText.split(',').map((s) => s.trim())
    let paramIndex = 0
    return items.map((item) => {
      if (item === '?') return params[paramIndex++]
      if (/^NULL$/i.test(item)) return null
      if (/^-?\d+(\.\d+)?$/.test(item)) return Number(item)
      const str = item.match(/^'(.*)'$/)
      if (str) return str[1]
      throw new Error(`SyncMockDb: 未支持的 VALUES 字面量: ${item}`)
    })
  }

  private runStatement(
    normalized: string,
    params: unknown[]
  ): { changes: number; lastInsertRowid: number } {
    // ---- 变更日志：revision 原子分配（标量子查询模板） ----
    const journalMatch = normalized.match(
      /^INSERT INTO sync_change_journal \(revision, event_type, asset_id, occurred_at, payload_json\) VALUES \(\(SELECT COALESCE\(MAX\(revision\), 0\) \+ 1 FROM sync_change_journal\), \?, \?, \?, \?\)$/
    )
    if (journalMatch) {
      const table = this.table('sync_change_journal')
      const maxRevision = table.rows.reduce((max, row) => Math.max(max, Number(row['revision'])), 0)
      const row: MockRow = {
        revision: maxRevision + 1,
        event_type: params[0],
        asset_id: params[1],
        occurred_at: params[2],
        payload_json: params[3] ?? null
      }
      table.rows.push(row)
      return { changes: 1, lastInsertRowid: 0 }
    }

    // ---- 服务状态：revision 镜像更新 ----
    const mirrorMatch = normalized.match(
      /^UPDATE sync_service_state SET library_revision = \(SELECT MAX\(revision\) FROM sync_change_journal\), updated_at = \? WHERE id = 1$/
    )
    if (mirrorMatch) {
      const table = this.table('sync_service_state')
      const journal = this.table('sync_change_journal')
      const maxRevision = journal.rows.reduce(
        (max, row) => Math.max(max, Number(row['revision'])),
        0
      )
      const row = table.rows.find((r) => r['id'] === 1)
      if (!row) return { changes: 0, lastInsertRowid: 0 }
      row['library_revision'] = maxRevision
      row['updated_at'] = params[0]
      return { changes: 1, lastInsertRowid: 0 }
    }

    // ---- 设备：touch / ack（单调守卫）/ revoke ----
    const touchMatch = normalized.match(
      /^UPDATE sync_paired_devices SET last_seen_at = \? WHERE device_id = \?$/
    )
    if (touchMatch) {
      const table = this.table('sync_paired_devices')
      const row = table.rows.find((r) => r['device_id'] === params[1])
      if (!row) return { changes: 0, lastInsertRowid: 0 }
      row['last_seen_at'] = params[0]
      return { changes: 1, lastInsertRowid: 0 }
    }

    const ackMatch = normalized.match(
      /^UPDATE sync_paired_devices SET last_ack_revision = \? WHERE device_id = \? AND last_ack_revision < \?$/
    )
    if (ackMatch) {
      const table = this.table('sync_paired_devices')
      const row = table.rows.find((r) => r['device_id'] === params[1])
      if (!row || Number(row['last_ack_revision']) >= Number(params[0])) {
        return { changes: 0, lastInsertRowid: 0 }
      }
      row['last_ack_revision'] = params[0]
      return { changes: 1, lastInsertRowid: 0 }
    }

    const revokeMatch = normalized.match(
      /^UPDATE sync_paired_devices SET revoked_at = \? WHERE device_id = \? AND revoked_at IS NULL$/
    )
    if (revokeMatch) {
      const table = this.table('sync_paired_devices')
      const row = table.rows.find((r) => r['device_id'] === params[1])
      if (!row || row['revoked_at'] !== null) return { changes: 0, lastInsertRowid: 0 }
      row['revoked_at'] = params[0]
      return { changes: 1, lastInsertRowid: 0 }
    }

    // ---- 服务身份：首次生成（仅当 server_id 为空时写入） ----
    const identityMatch = normalized.match(
      /^UPDATE sync_service_state SET server_id = \?, server_name = \?, updated_at = \? WHERE id = 1 AND \(server_id IS NULL OR server_id = ''\)$/
    )
    if (identityMatch) {
      const table = this.table('sync_service_state')
      const row = table.rows.find((r) => r['id'] === 1)
      if (!row || row['server_id']) return { changes: 0, lastInsertRowid: 0 }
      row['server_id'] = params[0]
      row['server_name'] = params[1]
      row['updated_at'] = params[2]
      return { changes: 1, lastInsertRowid: 0 }
    }

    // ---- motion links 全量重建 ----
    if (normalized === 'DELETE FROM sync_motion_links') {
      const table = this.table('sync_motion_links')
      const changes = table.rows.length
      table.rows = []
      return { changes, lastInsertRowid: 0 }
    }

    // ---- 通用 INSERT（支持 OR IGNORE / OR REPLACE 与字面量 VALUES） ----
    const insertMatch = normalized.match(
      /^INSERT (OR IGNORE |OR REPLACE )?INTO (\w+) \(([^)]+)\) VALUES \(([^)]*)\)$/
    )
    if (insertMatch) {
      const mode = (insertMatch[1] ?? '').trim()
      const table = this.table(insertMatch[2]!)
      const cols = insertMatch[3]!.split(',').map((c) => c.trim())
      const values = this.parseValues(insertMatch[4]!, params)
      const row: MockRow = {}
      cols.forEach((col, i) => {
        row[col] = values[i] ?? null
      })
      const conflict = this.findUniqueViolation(table, row)
      if (conflict) {
        if (mode === 'OR IGNORE') return { changes: 0, lastInsertRowid: 0 }
        if (mode === 'OR REPLACE') {
          const keySets = [...table.uniqueKeys]
          if (table.pk) keySets.push(table.pk)
          table.rows = table.rows.filter(
            (existing) => !keySets.some((keys) => keys.every((k) => existing[k] === row[k]))
          )
        } else {
          throw new Error('UNIQUE constraint failed')
        }
      }
      table.rows.push(row)
      return { changes: 1, lastInsertRowid: 0 }
    }

    throw new Error(`SyncMockDb: 未覆盖的 SQL: ${normalized}`)
  }

  private getStatement(normalized: string, params: unknown[]): MockRow | undefined {
    if (normalized === 'SELECT library_revision FROM sync_service_state WHERE id = 1') {
      return this.table('sync_service_state').rows.find((r) => r['id'] === 1)
    }
    if (normalized === 'SELECT MAX(revision) AS revision FROM sync_change_journal') {
      const rows = this.table('sync_change_journal').rows
      const max = rows.reduce((max, r) => Math.max(max, Number(r['revision'])), 0)
      return rows.length > 0 ? { revision: max } : undefined
    }
    if (normalized === 'SELECT MIN(revision) AS min_revision FROM sync_change_journal') {
      const rows = this.table('sync_change_journal').rows
      if (rows.length === 0) return undefined
      return { min_revision: Math.min(...rows.map((r) => Number(r['revision']))) }
    }
    if (normalized === 'SELECT server_id, server_name FROM sync_service_state WHERE id = 1') {
      return this.table('sync_service_state').rows.find((r) => r['id'] === 1)
    }
    if (
      normalized.startsWith(
        'SELECT device_id, device_name, platform, public_key, credential_hash, app_version, paired_at, last_seen_at, last_ack_revision, revoked_at FROM sync_paired_devices WHERE device_id = ?'
      )
    ) {
      return this.table('sync_paired_devices').rows.find((r) => r['device_id'] === params[0])
    }
    if (
      normalized ===
      'SELECT still_media_id, motion_media_id, method, confidence, presentation_timestamp_us FROM sync_motion_links WHERE still_media_id = ?'
    ) {
      const row = this.table('sync_motion_links').rows.find(
        (r) => r['still_media_id'] === params[0]
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
      return this.table('sync_change_journal')
        .rows.filter((r) => Number(r['revision']) > Number(params[0]))
        .sort((a, b) => Number(a['revision']) - Number(b['revision']))
        .slice(0, Number(params[1]))
    }
    if (
      normalized.startsWith(
        'SELECT device_id, device_name, platform, public_key, credential_hash, app_version, paired_at, last_seen_at, last_ack_revision, revoked_at FROM sync_paired_devices ORDER BY paired_at DESC'
      )
    ) {
      return [...this.table('sync_paired_devices').rows].sort((a, b) =>
        String(b['paired_at']).localeCompare(String(a['paired_at']))
      )
    }
    if (
      normalized.startsWith(
        'SELECT device_id, device_name, platform, public_key, credential_hash, app_version, paired_at, last_seen_at, last_ack_revision, revoked_at FROM sync_paired_devices WHERE revoked_at IS NULL'
      )
    ) {
      return [...this.table('sync_paired_devices').rows]
        .filter((r) => r['revoked_at'] === null)
        .sort((a, b) => String(b['paired_at']).localeCompare(String(a['paired_at'])))
    }
    if (
      normalized ===
      'SELECT still_media_id, motion_media_id, method, confidence, presentation_timestamp_us FROM sync_motion_links'
    ) {
      return this.table('sync_motion_links').rows.map((row) => ({
        still_media_id: row['still_media_id'],
        motion_media_id: row['motion_media_id'],
        method: row['method'],
        confidence: row['confidence'],
        presentation_timestamp_us: row['presentation_timestamp_us']
      }))
    }
    if (
      normalized ===
      "SELECT id, file_path, file_name, file_ext, file_type FROM media_files WHERE is_deleted = 0 AND file_type IN ('image', 'video')"
    ) {
      return this.mediaFiles.filter((r) => r.is_deleted === 0)
    }
    throw new Error(`SyncMockDb: 未覆盖的 SQL: ${normalized}`)
  }
}

// ============================================================================
// 夹具
// ============================================================================

function makeDb(): SyncMockDb {
  const db = new SyncMockDb()
  db.applyDdl(SYNC_METADATA_DDL_STATEMENTS)
  return db
}

function makeRepo(db: SyncMockDb): SyncMetadataRepository {
  return new SyncMetadataRepository(db as unknown as Database.Database)
}

const ISO = '2026-06-01T12:00:00.000Z'

function seedStillVideoPair(db: SyncMockDb, dir = 'D:/lib', base = 'IMG_0001'): void {
  db.seedMediaFiles([
    {
      id: 1,
      file_path: `${dir}/${base}.jpg`,
      file_name: `${base}.jpg`,
      file_ext: 'jpg',
      file_type: 'image'
    },
    {
      id: 2,
      file_path: `${dir}/${base}.mov`,
      file_name: `${base}.mov`,
      file_ext: 'mov',
      file_type: 'video'
    }
  ])
}

// ============================================================================
// DDL 与纯函数
// ============================================================================

describe('SYNC_METADATA_DDL_STATEMENTS', () => {
  it('R0a 7 条语句全部为可识别的 CREATE（4 表 + 3 索引）且可被内存引擎执行', () => {
    expect(SYNC_METADATA_DDL_STATEMENTS).toHaveLength(7)
    expect(() => makeDb()).not.toThrow()
    const db = makeDb()
    for (const name of [
      'sync_paired_devices',
      'sync_change_journal',
      'sync_service_state',
      'sync_motion_links'
    ]) {
      expect(db.tables.has(name)).toBe(true)
    }
  })
})

describe('computeMotionLinks（同名配对纯函数）', () => {
  it('R7a 同目录同名 jpg+mov → 一对一建链', () => {
    const links = computeMotionLinks([
      {
        id: 1,
        file_path: 'D:/lib/IMG_0001.jpg',
        file_name: 'IMG_0001.jpg',
        file_ext: 'jpg',
        file_type: 'image'
      },
      {
        id: 2,
        file_path: 'D:/lib/IMG_0001.mov',
        file_name: 'IMG_0001.mov',
        file_ext: 'mov',
        file_type: 'video'
      }
    ])
    expect(links).toEqual([{ still_media_id: 1, motion_media_id: 2 }])
  })
  it('R12a 一图两视频（同名不同扩展名）→ 歧义跳过', () => {
    const links = computeMotionLinks([
      {
        id: 1,
        file_path: 'D:/lib/IMG_0001.jpg',
        file_name: 'IMG_0001.jpg',
        file_ext: 'jpg',
        file_type: 'image'
      },
      {
        id: 2,
        file_path: 'D:/lib/IMG_0001.mov',
        file_name: 'IMG_0001.mov',
        file_ext: 'mov',
        file_type: 'video'
      },
      {
        id: 3,
        file_path: 'D:/lib/IMG_0001.mp4',
        file_name: 'IMG_0001.mp4',
        file_ext: 'mp4',
        file_type: 'video'
      }
    ])
    expect(links).toEqual([])
  })
  it('R12b 两图一视频 → 歧义跳过', () => {
    const links = computeMotionLinks([
      {
        id: 1,
        file_path: 'D:/lib/IMG_0001.jpg',
        file_name: 'IMG_0001.jpg',
        file_ext: 'jpg',
        file_type: 'image'
      },
      {
        id: 2,
        file_path: 'D:/lib/IMG_0001.png',
        file_name: 'IMG_0001.png',
        file_ext: 'png',
        file_type: 'image'
      },
      {
        id: 3,
        file_path: 'D:/lib/IMG_0001.mov',
        file_name: 'IMG_0001.mov',
        file_ext: 'mov',
        file_type: 'video'
      }
    ])
    expect(links).toEqual([])
  })
  it('R12c 同名不同目录 → 不建链', () => {
    const links = computeMotionLinks([
      {
        id: 1,
        file_path: 'D:/lib/IMG_0001.jpg',
        file_name: 'IMG_0001.jpg',
        file_ext: 'jpg',
        file_type: 'image'
      },
      {
        id: 2,
        file_path: 'E:/other/IMG_0001.mov',
        file_name: 'IMG_0001.mov',
        file_ext: 'mov',
        file_type: 'video'
      }
    ])
    expect(links).toEqual([])
  })
  it('R12d basename 大小写不敏感；Windows 反斜杠路径可配对', () => {
    const links = computeMotionLinks([
      {
        id: 1,
        file_path: 'D:\\lib\\img_0001.JPG',
        file_name: 'img_0001.JPG',
        file_ext: 'JPG',
        file_type: 'image'
      },
      {
        id: 2,
        file_path: 'D:\\LIB\\IMG_0001.mov',
        file_name: 'IMG_0001.mov',
        file_ext: 'mov',
        file_type: 'video'
      }
    ])
    expect(links).toEqual([{ still_media_id: 1, motion_media_id: 2 }])
  })
})

// ============================================================================
// 变更日志与 revision（正常 R1–R4）
// ============================================================================

describe('recordAssetChange / revision', () => {
  let db: SyncMockDb
  let repo: SyncMetadataRepository

  beforeEach(() => {
    db = makeDb()
    repo = makeRepo(db)
  })

  it('R1 三连发 revision 单调递增 1→2→3，library_revision 镜像一致', async () => {
    const r1 = await repo.recordAssetChange({
      eventType: 'asset.created',
      assetId: '7',
      occurredAt: ISO
    })
    const r2 = await repo.recordAssetChange({
      eventType: 'asset.updated',
      assetId: '7',
      occurredAt: ISO
    })
    const r3 = await repo.recordAssetChange({
      eventType: 'asset.deleted',
      assetId: '8',
      occurredAt: ISO
    })
    expect([r1.revision, r2.revision, r3.revision]).toEqual([1, 2, 3])
    expect(repo.getCurrentRevision()).toBe(3)
    expect(db.table('sync_change_journal').rows[0]['payload_json']).toBeNull()
  })

  it('R1b payload 对象序列化为 JSON 落库', async () => {
    await repo.recordAssetChange({
      eventType: 'asset.updated',
      assetId: '7',
      occurredAt: ISO,
      payload: { reason: 'rating' }
    })
    expect(db.table('sync_change_journal').rows[0]['payload_json']).toBe('{"reason":"rating"}')
  })

  it('R2 空库 getCurrentRevision 为 0', () => {
    expect(repo.getCurrentRevision()).toBe(0)
  })

  it('R3 listChangesAfter 过滤、升序与 limit 截断', async () => {
    for (let i = 1; i <= 4; i++) {
      await repo.recordAssetChange({
        eventType: 'asset.created',
        assetId: String(i),
        occurredAt: ISO
      })
    }
    const all = repo.listChangesAfter(0)
    expect(all.map((c) => c.revision)).toEqual([1, 2, 3, 4])
    expect(all[0]).toEqual({ revision: 1, type: 'asset.created', assetId: '1', occurredAt: ISO })
    expect(repo.listChangesAfter(1).map((c) => c.revision)).toEqual([2, 3, 4])
    expect(repo.listChangesAfter(0, 2).map((c) => c.revision)).toEqual([1, 2])
  })

  it('R4 getMinimumJournalRevision：空表 null；有值取 MIN', async () => {
    expect(repo.getMinimumJournalRevision()).toBeNull()
    await repo.recordAssetChange({ eventType: 'asset.created', assetId: '7', occurredAt: ISO })
    await repo.recordAssetChange({ eventType: 'asset.created', assetId: '8', occurredAt: ISO })
    expect(repo.getMinimumJournalRevision()).toBe(1)
  })
})

describe('recordAssetChanges 批量', () => {
  let db: SyncMockDb
  let repo: SyncMetadataRepository

  beforeEach(() => {
    db = makeDb()
    repo = makeRepo(db)
  })

  it('B1 单事务批量写入：逐行 revision 单调、镜像一致、与单条写入衔接', async () => {
    const written = await repo.recordAssetChanges([
      { eventType: 'asset.created', assetId: '1', occurredAt: ISO },
      { eventType: 'asset.created', assetId: '2', occurredAt: ISO },
      { eventType: 'asset.updated', assetId: '1', occurredAt: ISO }
    ])
    expect(written).toBe(3)
    const afterBatch = repo.listChangesAfter(0).map((c) => c.revision)
    expect(afterBatch).toEqual([1, 2, 3])
    expect(repo.getCurrentRevision()).toBe(3)
    // 与单条写入衔接：批量之后单条继续 MAX+1
    const single = await repo.recordAssetChange({
      eventType: 'asset.deleted',
      assetId: '2',
      occurredAt: ISO
    })
    expect(single.revision).toBe(4)
    expect(repo.getCurrentRevision()).toBe(4)
  })

  it('B2 空数组直接返回 0，不写任何行', async () => {
    expect(await repo.recordAssetChanges([])).toBe(0)
    expect(db.table('sync_change_journal').rows).toHaveLength(0)
  })

  it('B3 任一条非法整体回滚（不产生半批状态）', async () => {
    await repo.recordAssetChange({ eventType: 'asset.created', assetId: '9', occurredAt: ISO })
    await expect(
      repo.recordAssetChanges([
        { eventType: 'asset.updated', assetId: '1', occurredAt: ISO },
        { eventType: 'asset.exploded' as 'asset.updated', assetId: '2', occurredAt: ISO }
      ])
    ).rejects.toThrow('invalid eventType')
    // 回滚后：journal 无新增，revision 不动；后续写入从 2 继续
    expect(db.table('sync_change_journal').rows).toHaveLength(1)
    expect(repo.getCurrentRevision()).toBe(1)
    const next = await repo.recordAssetChange({
      eventType: 'asset.updated',
      assetId: '1',
      occurredAt: ISO
    })
    expect(next.revision).toBe(2)
  })
})

// ============================================================================
// 参数校验（异常 R8–R9）
// ============================================================================

describe('recordAssetChange / listChangesAfter 校验', () => {
  let db: SyncMockDb
  let repo: SyncMetadataRepository

  beforeEach(() => {
    db = makeDb()
    repo = makeRepo(db)
  })

  it('R8a 非法 eventType → 拒绝且无残留', async () => {
    await expect(
      repo.recordAssetChange({
        eventType: 'asset.exploded' as never,
        assetId: '7',
        occurredAt: ISO
      })
    ).rejects.toThrow()
    expect(repo.getCurrentRevision()).toBe(0)
    expect(db.tables.get('sync_change_journal')!.rows).toHaveLength(0)
  })

  it('R8b 空 assetId → 拒绝', async () => {
    await expect(
      repo.recordAssetChange({ eventType: 'asset.created', assetId: '', occurredAt: ISO })
    ).rejects.toThrow()
  })

  it('R8c 非法 occurredAt → 拒绝', async () => {
    await expect(
      repo.recordAssetChange({ eventType: 'asset.created', assetId: '7', occurredAt: 'not-a-date' })
    ).rejects.toThrow()
  })

  it('R9a listChangesAfter 负数 after → 拒绝', () => {
    expect(() => repo.listChangesAfter(-1)).toThrow()
  })

  it('R9b listChangesAfter limit 0 / 非整数 → 拒绝', () => {
    expect(() => repo.listChangesAfter(0, 0)).toThrow()
    expect(() => repo.listChangesAfter(0, 1.5)).toThrow()
  })

  it('R9c occurredAt 缺省自动填充（合法 ISO）', async () => {
    const { revision } = await repo.recordAssetChange({ eventType: 'asset.created', assetId: '7' })
    expect(revision).toBe(1)
    const occurredAt = db.table('sync_change_journal').rows[0]['occurred_at']
    expect(Number.isFinite(Date.parse(String(occurredAt)))).toBe(true)
  })
})

// ============================================================================
// 设备配对（正常 R5 / 边界 R10–R11）
// ============================================================================

describe('设备配对', () => {
  let db: SyncMockDb
  let repo: SyncMetadataRepository

  beforeEach(() => {
    db = makeDb()
    repo = makeRepo(db)
  })

  it('R5a upsert + get/list/touch 全链路', async () => {
    await repo.upsertPairDevice({
      deviceId: 'dev-1',
      deviceName: 'iPhone 15',
      platform: 'ios',
      publicKey: 'pk-abc',
      credentialHash: 'hash-abc',
      appVersion: '1.0.0',
      pairedAt: ISO
    })
    const device = repo.getPairedDevice('dev-1')
    expect(device).not.toBeNull()
    expect(device?.device_name).toBe('iPhone 15')
    expect(device?.platform).toBe('ios')
    expect(device?.last_ack_revision).toBe(0)
    expect(device?.revoked_at).toBeNull()
    expect(repo.listPairedDevices()).toHaveLength(1)
    await repo.touchDevice('dev-1', '2026-06-02T00:00:00.000Z')
    expect(repo.getPairedDevice('dev-1')?.last_seen_at).toBe('2026-06-02T00:00:00.000Z')
  })

  it('R5b 重复 upsert 更新字段并重置配对态', async () => {
    await repo.upsertPairDevice({
      deviceId: 'dev-1',
      deviceName: 'iPhone 15',
      platform: 'ios',
      publicKey: 'pk-1',
      credentialHash: 'h1',
      pairedAt: ISO
    })
    await repo.acknowledgeRevision('dev-1', 9)
    await repo.upsertPairDevice({
      deviceId: 'dev-1',
      deviceName: 'iPhone 16',
      platform: 'ios',
      publicKey: 'pk-2',
      credentialHash: 'h2',
      pairedAt: '2026-07-01T00:00:00.000Z'
    })
    const device = repo.getPairedDevice('dev-1')
    expect(device?.device_name).toBe('iPhone 16')
    expect(device?.credential_hash).toBe('h2')
    expect(device?.last_ack_revision).toBe(0)
  })

  it('R5c 非法 platform / 缺失必填字段 → 拒绝', async () => {
    await expect(
      repo.upsertPairDevice({
        deviceId: 'dev-1',
        deviceName: 'X',
        platform: 'windows' as never,
        publicKey: 'pk',
        credentialHash: 'h'
      })
    ).rejects.toThrow()
    await expect(
      repo.upsertPairDevice({
        deviceId: '',
        deviceName: 'X',
        platform: 'ios',
        publicKey: 'pk',
        credentialHash: 'h'
      })
    ).rejects.toThrow()
    expect(repo.listPairedDevices()).toHaveLength(0)
  })

  it('R10 acknowledgeRevision 单调：低 revision ack 不回退；未知设备 no-op', async () => {
    await repo.upsertPairDevice({
      deviceId: 'dev-1',
      deviceName: 'iPhone',
      platform: 'ios',
      publicKey: 'pk',
      credentialHash: 'h',
      pairedAt: ISO
    })
    await repo.acknowledgeRevision('dev-1', 5)
    await repo.acknowledgeRevision('dev-1', 3)
    expect(repo.getPairedDevice('dev-1')?.last_ack_revision).toBe(5)
    await repo.acknowledgeRevision('dev-unknown', 99)
    await expect(repo.acknowledgeRevision('dev-1', -1)).rejects.toThrow()
    await expect(repo.acknowledgeRevision('dev-1', 1.5)).rejects.toThrow()
  })

  it('R11 revoke 置 revoked_at 且保留行；二次 revoke no-op', async () => {
    await repo.upsertPairDevice({
      deviceId: 'dev-1',
      deviceName: 'iPhone',
      platform: 'android',
      publicKey: 'pk',
      credentialHash: 'h',
      pairedAt: ISO
    })
    await repo.revokeDevice('dev-1', '2026-06-03T00:00:00.000Z')
    const revoked = repo.getPairedDevice('dev-1') as SyncPairedDeviceRow
    expect(revoked.revoked_at).toBe('2026-06-03T00:00:00.000Z')
    expect(repo.listPairedDevices()).toHaveLength(1)
    await repo.revokeDevice('dev-1', '2026-06-04T00:00:00.000Z')
    expect(repo.getPairedDevice('dev-1')?.revoked_at).toBe('2026-06-03T00:00:00.000Z')
  })

  it('R11b(阶段5) listActivePairedDevices 只返回未撤销设备', async () => {
    await repo.upsertPairDevice({
      deviceId: 'dev-1',
      deviceName: 'iPhone',
      platform: 'ios',
      publicKey: 'pk',
      credentialHash: 'h',
      pairedAt: ISO
    })
    await repo.upsertPairDevice({
      deviceId: 'dev-2',
      deviceName: 'Pixel',
      platform: 'android',
      publicKey: 'pk2',
      credentialHash: 'h2',
      pairedAt: '2026-06-02T00:00:00.000Z'
    })
    await repo.revokeDevice('dev-1', '2026-06-03T00:00:00.000Z')
    const active = repo.listActivePairedDevices()
    expect(active.map((d) => d.device_id)).toEqual(['dev-2'])
    // 全量列表仍包含已撤销行（撤销=软删保留记录）
    expect(repo.listPairedDevices()).toHaveLength(2)
  })
})

// ============================================================================
// 服务身份（R6）
// ============================================================================

describe('ensureServerIdentity', () => {
  it('R6 首次生成 wxnn-<16hex>，二次调用稳定；默认名持久化', async () => {
    const db = makeDb()
    const repo = makeRepo(db)
    const first = await repo.ensureServerIdentity()
    expect(first.serverId).toMatch(/^wxnn-[0-9a-f]{16}$/)
    expect(first.serverName).toBe(DEFAULT_SERVER_NAME)
    const second = await repo.ensureServerIdentity()
    expect(second.serverId).toBe(first.serverId)
    expect(second.serverName).toBe(DEFAULT_SERVER_NAME)
  })
})

// ============================================================================
// motion links 仓储与幂等重建（R7 / R12）
// ============================================================================

describe('rebuildMotionLinks', () => {
  let db: SyncMockDb
  let repo: SyncMetadataRepository

  beforeEach(() => {
    db = makeDb()
    repo = makeRepo(db)
  })

  it('R7 同目录同名对 → 建链且重复执行幂等', async () => {
    seedStillVideoPair(db)
    const first = await repo.rebuildMotionLinks({ rebuiltAt: ISO })
    expect(first.paired).toBe(1)
    const link: MotionLinkRow | null = repo.getMotionLinkByStill(1)
    expect(link).toEqual({
      still_media_id: 1,
      motion_media_id: 2,
      method: 'filename',
      confidence: 1,
      presentation_timestamp_us: null
    })
    expect(repo.listMotionLinks()).toHaveLength(1)
    const second = await repo.rebuildMotionLinks({ rebuiltAt: ISO })
    expect(second.paired).toBe(1)
    expect(repo.listMotionLinks()).toHaveLength(1)
  })

  it('R12e 歧义与软删行不建链', async () => {
    db.seedMediaFiles([
      { id: 1, file_path: 'D:/lib/A.jpg', file_name: 'A.jpg', file_ext: 'jpg', file_type: 'image' },
      { id: 2, file_path: 'D:/lib/A.mov', file_name: 'A.mov', file_ext: 'mov', file_type: 'video' },
      { id: 3, file_path: 'D:/lib/A.mp4', file_name: 'A.mp4', file_ext: 'mp4', file_type: 'video' },
      { id: 4, file_path: 'D:/lib/B.jpg', file_name: 'B.jpg', file_ext: 'jpg', file_type: 'image' },
      {
        id: 5,
        file_path: 'D:/lib/B.mov',
        file_name: 'B.mov',
        file_ext: 'mov',
        file_type: 'video',
        is_deleted: 1
      }
    ])
    const { paired } = await repo.rebuildMotionLinks({ rebuiltAt: ISO })
    expect(paired).toBe(0)
    expect(repo.listMotionLinks()).toHaveLength(0)
  })

  it('R7c 无视频候选 → paired 0', async () => {
    db.seedMediaFiles([
      { id: 1, file_path: 'D:/lib/C.jpg', file_name: 'C.jpg', file_ext: 'jpg', file_type: 'image' }
    ])
    const { paired } = await repo.rebuildMotionLinks({ rebuiltAt: ISO })
    expect(paired).toBe(0)
  })
})

// ============================================================================
// 写路径（R13：同步直写 + async 签名——resonance 同款先例）
// ============================================================================

describe('写路径：同步直写 + 保留 bridge 形参', () => {
  it('R13a 未注入 bridge 时写操作同步落库，revision 即读可见', async () => {
    const db = makeDb()
    const repo = makeRepo(db)
    const { revision } = await repo.recordAssetChange({
      eventType: 'asset.created',
      assetId: '7',
      occurredAt: ISO
    })
    expect(revision).toBe(1)
    expect(repo.getCurrentRevision()).toBe(1)
    expect(db.tables.get('sync_change_journal')!.rows).toHaveLength(1)
  })

  it('R13b 构造函数保留 workerBridge/dbPath 形参（切回 worker 桥接时调用方零改动）', async () => {
    const db = makeDb()
    const repo = new SyncMetadataRepository(
      db as unknown as Database.Database,
      {} as never,
      'D:/mock/wxnn.db'
    )
    const { revision } = await repo.recordAssetChange({
      eventType: 'asset.created',
      assetId: '7',
      occurredAt: ISO
    })
    expect(revision).toBe(1)
  })
})
