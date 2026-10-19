import { describe, expect, it } from 'vitest'

import {
  ORIGINAL_ONLY_TABLES,
  findOriginalTableRefs,
  isSyncLaneSqlAllowed,
  sqlTableReferences
} from './metadata-isolation-guards'

/**
 * 阶段 6：表级隔离谓词单测（零依赖、零引擎，CI 必跑）。
 *
 * 正常 — 阶段 6 同步面真正执行的上游 SQL 全部放行
 * 异常 — 指向原有库表的读写一律拦下
 * 边界 — 同名歧义表不误报、大小写与跨行写法不放过、中文散文不误伤
 */

describe('findOriginalTableRefs 放行同步面真正执行的 SQL', () => {
  it('上游候选队列 SELECT（阶段 6 驱动每轮都读它）', () => {
    const sql = `SELECT * FROM assets
      WHERE asset_state <> 'deleted' AND uid IS NOT NULL
        AND json_extract(metadata_json, '$.raw.nativeParamToken') IS NOT NULL
      ORDER BY discovered_at ASC, asset_id ASC LIMIT ?`
    expect(sqlTableReferences(sql)).toEqual(['assets'])
    expect(isSyncLaneSqlAllowed(sql)).toBe(true)
  })

  it('上游 updateMetadata 的 UPDATE 与日志面的 INSERT / UPDATE', () => {
    expect(
      isSyncLaneSqlAllowed(
        'UPDATE assets SET metadata_schema_version = ?, metadata_json = ?, revision = ?, updated_at = ? WHERE asset_id = ?'
      )
    ).toBe(true)
    expect(
      isSyncLaneSqlAllowed(
        'INSERT INTO change_journal (revision, event_type, asset_id, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?)'
      )
    ).toBe(true)
    expect(
      isSyncLaneSqlAllowed(
        'UPDATE library_state SET library_revision = ?, updated_at = ? WHERE id = 1'
      )
    ).toBe(true)
    expect(
      isSyncLaneSqlAllowed(
        'SELECT device_id, device_name FROM paired_devices WHERE revoked_at IS NULL ORDER BY paired_at DESC'
      )
    ).toBe(true)
  })
})

describe('findOriginalTableRefs 拦下指向原有库的读写', () => {
  it('异常：同步侧写 media_files（阶段 2 的 sha256 回填形态）必须命中', () => {
    expect(findOriginalTableRefs('UPDATE media_files SET sha256 = ? WHERE id = ?')).toEqual([
      'media_files'
    ])
    expect(isSyncLaneSqlAllowed('UPDATE media_files SET sha256 = ? WHERE id = ?')).toBe(false)
  })

  it('异常：SELECT 原表、跨行 INSERT、大小写混写都不放过', () => {
    expect(findOriginalTableRefs('SELECT id FROM media_files WHERE is_deleted = 0')).toEqual([
      'media_files'
    ])
    expect(findOriginalTableRefs('INSERT INTO\n  scan_history (scan_type) VALUES (?)')).toEqual([
      'scan_history'
    ])
    expect(findOriginalTableRefs('DELETE from MEDIA_FILES WHERE id = ?')).toEqual(['MEDIA_FILES'])
    expect(findOriginalTableRefs('SELECT * FROM asset_edits')).toEqual(['asset_edits'])
  })
})

describe('findOriginalTableRefs 的边界', () => {
  it('边界：同名歧义表不得列入禁用集（否则护栏恒真）', () => {
    // app_settings / schema_migrations 在 NikkiSync 自有库里同样存在，
    // 列进来会让同步面每次正常读写自身同名表都误报 ⇒ 明确断言它们不在清单里
    expect(ORIGINAL_ONLY_TABLES).not.toContain('app_settings')
    expect(ORIGINAL_ONLY_TABLES).not.toContain('schema_migrations')
    expect(isSyncLaneSqlAllowed('SELECT value FROM app_settings WHERE key = ?')).toBe(true)
  })

  it('边界：中文散文里提到表名不构成 SQL 引用（不误伤注释）', () => {
    expect(
      isSyncLaneSqlAllowed('// 原图库口径只认本 App 自己的 media_files 表，同步面不得写入该表')
    ).toBe(true)
    expect(findOriginalTableRefs('把 media_files 作为展示口径')).toEqual([])
  })

  it('边界：无表引用的空文本返回空集', () => {
    expect(sqlTableReferences('')).toEqual([])
    expect(findOriginalTableRefs('')).toEqual([])
  })

  it('边界：同一 SQL 内多次引用只记一次（去重便于断言）', () => {
    expect(
      findOriginalTableRefs('SELECT a.id FROM media_files a JOIN media_files b ON a.id = b.id')
    ).toEqual(['media_files'])
  })
})
