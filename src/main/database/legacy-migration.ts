// @core-change: 新增旧版 wxnn-photo-manager 数据合并（安装器写入标记后首启执行）
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import { logger } from '../utils/logger'
import { t } from '../i18n'

export interface LegacyMigrationIssue {
  table: string
  key: string
  error: string
}

export interface LegacyMigrationResult {
  imported: number
  merged: number
  skipped: number
  errors: LegacyMigrationIssue[]
  reportPath: string
}

interface Counters {
  imported: number
  merged: number
  skipped: number
  errors: number
}

const MARKER = 'legacy-migration-pending.json'

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (item) => item.name
  )
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || value === 0
}

/**
 * 读取安装器写入的迁移标记，把旧库逐条合并进新版数据库。
 * 无标记时直接返回 null；有标记则执行并写报告，成功后删除标记。
 */
export function runLegacyMigrationIfPending(): LegacyMigrationResult | null {
  const userData = app.getPath('userData')
  const markerPath = path.join(userData, MARKER)
  if (!fs.existsSync(markerPath)) {
    return null
  }
  const stagedDb = path.join(userData, 'legacy', 'wxnn_photo_manager.db')
  const newDbPath = path.join(userData, 'database', 'meow_star_map.db')
  const reportPath = path.join(userData, 'logs', 'legacy-migration-report.json')
  if (!fs.existsSync(stagedDb) || !fs.existsSync(newDbPath)) {
    logger.warn(t('main.legacyMigration.markerMissing'))
    return null
  }

  const counters: Record<string, Counters> = {}
  const issues: LegacyMigrationIssue[] = []
  const categoryMap = new Map<number, number>()
  const mediaMap = new Map<number, number>()

  const counter = (table: string): Counters => {
    counters[table] ??= { imported: 0, merged: 0, skipped: 0, errors: 0 }
    return counters[table]
  }
  const issue = (table: string, key: string, err: unknown): void => {
    counter(table).errors += 1
    issues.push({
      table,
      key,
      error: err instanceof Error ? err.message : String(err)
    })
  }

  let oldDb: Database.Database | null = null
  let newDb: Database.Database | null = null
  try {
    oldDb = new Database(stagedDb, { readonly: true, fileMustExist: true })
    newDb = new Database(newDbPath)

    // 备份新库（checkpoint 后复制主文件，避免 WAL 未落盘）
    newDb.pragma('wal_checkpoint(TRUNCATE)')
    const backup = `${newDbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    fs.copyFileSync(newDbPath, backup)

    importCategories(oldDb, newDb, categoryMap, counter, issue)
    importSimple(oldDb, newDb, 'app_settings', 'key', counter, issue)
    importSimple(oldDb, newDb, 'import_roots', 'root_path', counter, issue)
    importSimple(oldDb, newDb, 'filter_presets', 'name', counter, issue)
    importSimple(oldDb, newDb, 'character_profiles', 'uid', counter, issue)
    importSimple(oldDb, newDb, 'watermark_templates', 'name', counter, issue)
    importMedia(oldDb, newDb, categoryMap, mediaMap, counter, issue)
    importSimple(oldDb, newDb, 'edit_history', 'created_at', counter, issue, mediaMap)
    importSimple(oldDb, newDb, 'operation_history', 'created_at', counter, issue, mediaMap)
    importSimple(oldDb, newDb, 'pending_renames', 'old_path', counter, issue)
    importSimple(oldDb, newDb, 'scan_history', 'start_time', counter, issue)
    newDb.prepare("INSERT INTO media_fts(media_fts) VALUES('rebuild')").run()

    const totals = Object.values(counters).reduce(
      (acc, item) => ({
        imported: acc.imported + item.imported,
        merged: acc.merged + item.merged,
        skipped: acc.skipped + item.skipped,
        errors: acc.errors + item.errors
      }),
      { imported: 0, merged: 0, skipped: 0, errors: 0 }
    )
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          migratedAt: new Date().toISOString(),
          stagedDb,
          newDbPath,
          counters,
          totals,
          issues
        },
        null,
        2
      ),
      'utf8'
    )
    fs.rmSync(markerPath, { force: true })
    logger.info(`[legacy-migration] 完成: ${JSON.stringify(totals)}`)
    return { ...totals, errors: issues, reportPath }
  } catch (err) {
    logger.error(t('main.legacyMigration.failed'), err)
    return {
      imported: 0,
      merged: 0,
      skipped: 0,
      errors: [
        { table: '*', key: 'fatal', error: err instanceof Error ? err.message : String(err) }
      ],
      reportPath
    }
  } finally {
    oldDb?.close()
    newDb?.close()
  }
}

function importCategories(
  oldDb: Database.Database,
  newDb: Database.Database,
  map: Map<number, number>,
  counter: (table: string) => Counters,
  issue: (table: string, key: string, err: unknown) => void
): void {
  const rows = oldDb.prepare('SELECT * FROM categories ORDER BY sort_order, id').all() as Array<
    Record<string, unknown>
  >
  const findByName = newDb.prepare('SELECT id FROM categories WHERE name = ?')
  const findBySort = newDb.prepare(
    'SELECT id FROM categories WHERE is_system = 1 AND sort_order = ? LIMIT 1'
  )
  const insert = newDb.prepare(
    'INSERT INTO categories (name, icon, color, sort_order, parent_id, is_system, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)'
  )
  for (const row of rows) {
    try {
      const byName = findByName.get(row.name) as { id: number } | undefined
      const bySort =
        byName === undefined && Number(row.is_system) === 1
          ? (findBySort.get(row.sort_order) as { id: number } | undefined)
          : undefined
      const existing = byName ?? bySort
      if (existing) {
        map.set(Number(row.id), Number(existing.id))
        counter('categories').skipped += 1
        continue
      }
      const info = insert.run(
        row.name,
        row.icon,
        row.color,
        row.sort_order,
        row.is_system,
        row.created_at
      )
      map.set(Number(row.id), Number(info.lastInsertRowid))
      counter('categories').imported += 1
    } catch (err) {
      issue('categories', String(row.name), err)
    }
  }
}

function importSimple(
  oldDb: Database.Database,
  newDb: Database.Database,
  table: string,
  naturalKey: string,
  counter: (table: string) => Counters,
  issue: (table: string, key: string, err: unknown) => void,
  mediaMap?: Map<number, number>
): void {
  const oldRows = oldDb.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>
  const oldCols = new Set(columns(oldDb, table))
  const newCols = columns(newDb, table).filter(
    (col) => col !== 'id' && oldCols.has(col) && (!mediaMap || col !== 'media_id' || true)
  )
  const find = newDb.prepare(`SELECT 1 FROM ${table} WHERE ${naturalKey} = ? LIMIT 1`)
  const insert = newDb.prepare(
    `INSERT INTO ${table} (${newCols.join(', ')}) VALUES (${newCols.map(() => '?').join(', ')})`
  )
  for (const row of oldRows) {
    try {
      if (find.get(row[naturalKey]) !== undefined) {
        counter(table).skipped += 1
        continue
      }
      const values = newCols.map((col) => {
        if (mediaMap && col === 'media_id') {
          const mapped = mediaMap.get(Number(row[col]))
          if (!mapped) throw new Error(`media_id ${String(row[col])} 未映射`)
          return mapped
        }
        return row[col] ?? null
      })
      insert.run(...values)
      counter(table).imported += 1
    } catch (err) {
      issue(table, String(row[naturalKey]), err)
    }
  }
}

function importMedia(
  oldDb: Database.Database,
  newDb: Database.Database,
  categoryMap: Map<number, number>,
  mediaMap: Map<number, number>,
  counter: (table: string) => Counters,
  issue: (table: string, key: string, err: unknown) => void
): void {
  const oldRows = oldDb.prepare('SELECT * FROM media_files ORDER BY id').all() as Array<
    Record<string, unknown>
  >
  const oldCols = new Set(columns(oldDb, 'media_files'))
  const newCols = new Set(columns(newDb, 'media_files'))
  const insertCols = [...oldCols].filter((col) => col !== 'id' && newCols.has(col))
  const insert = newDb.prepare(
    `INSERT INTO media_files (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')})`
  )
  const find = newDb.prepare('SELECT * FROM media_files WHERE file_path = ? LIMIT 1')
  const metaFields = [
    'tags',
    'rating',
    'is_favorite',
    'category_id',
    'notes',
    'scene_category',
    'outfit',
    'created_at',
    'modified_at',
    'source_path',
    'width',
    'height',
    'duration',
    'phash',
    'phash_mtime',
    'phash_file_size',
    'account_uid',
    'album_type',
    'media_source',
    'is_duplicate',
    'original_id',
    'is_missing',
    'missing_count',
    'is_corrupted',
    'corrupted_count',
    'corrupted_reason',
    'updated_at'
  ].filter((col) => oldCols.has(col) && newCols.has(col))

  for (const row of oldRows) {
    try {
      const existing = find.get(row.file_path) as Record<string, unknown> | undefined
      if (existing) {
        const sets: string[] = []
        const values: unknown[] = []
        for (const field of metaFields) {
          if (!isEmpty(row[field]) && isEmpty(existing[field])) {
            if (field === 'category_id') {
              const mapped = categoryMap.get(Number(row[field]))
              if (mapped === undefined) continue
              sets.push(`${field} = ?`)
              values.push(mapped)
            } else {
              sets.push(`${field} = ?`)
              values.push(row[field])
            }
          }
        }
        if (sets.length > 0) {
          newDb
            .prepare(`UPDATE media_files SET ${sets.join(', ')} WHERE id = ?`)
            .run(...values, existing.id)
        }
        mediaMap.set(Number(row.id), Number(existing.id))
        counter('media_files').merged += 1
      } else {
        const values = insertCols.map((col) => {
          if (col === 'category_id' && row[col] !== null) {
            return categoryMap.get(Number(row[col])) ?? null
          }
          return row[col] ?? null
        })
        const info = insert.run(...values)
        mediaMap.set(Number(row.id), Number(info.lastInsertRowid))
        counter('media_files').imported += 1
      }
    } catch (err) {
      issue('media_files', String(row.file_path), err)
    }
  }
}
