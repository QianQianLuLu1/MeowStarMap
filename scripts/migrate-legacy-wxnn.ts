#!/usr/bin/env tsx
/**
 * 旧版（wxnn-photo-manager 2.3.x）数据合并到新版 MeowStarMap 数据库。
 *
 * 设计：
 * - 默认 dry-run，只统计不写入；`--apply` 才落地（落地前自动备份新库）。
 * - 逐条导入：每条记录独立 try/catch，失败写入报告，不中断整体。
 * - 合并策略：media_files 按 file_path 合并（新库已有则只补空字段；没有则插入）；
 *   categories 按 name、app_settings 按 key、import_roots 按 root_path 等自然键去重。
 * - 结束重建 media_fts。
 *
 * 用法：
 *   npx tsx scripts/migrate-legacy-wxnn.ts --old-db=<old> --new-db=<new> [--apply] [--report=<path>]
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

type Row = Record<string, unknown>
interface Issue {
  table: string
  key: string
  error: string
}
interface Counters {
  imported: number
  merged: number
  skipped: number
  errors: number
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg)
    if (m) out[m[1]] = m[2]
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const apply = process.argv.includes('--apply')
const oldPath = args['old-db'] ? path.resolve(args['old-db']) : ''
const newPath = args['new-db'] ? path.resolve(args['new-db']) : ''
if (!oldPath || !newPath) {
  console.error('缺少 --old-db / --new-db')
  process.exit(1)
}
if (!fs.existsSync(oldPath) || !fs.existsSync(newPath)) {
  console.error('旧库或新库不存在')
  process.exit(1)
}

const reportPath = args.report
  ? path.resolve(args.report)
  : path.join(path.dirname(newPath), 'legacy-migration-report.json')
const issues: Issue[] = []
const counters: Record<string, Counters> = {}
const mediaIdMap = new Map<number, number>()
const categoryIdMap = new Map<number, number>()

function counter(table: string): Counters {
  if (!counters[table]) counters[table] = { imported: 0, merged: 0, skipped: 0, errors: 0 }
  return counters[table]
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name
  )
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || value === 0
}

function recordIssue(table: string, key: string, err: unknown): void {
  counter(table).errors += 1
  issues.push({ table, key, error: err instanceof Error ? err.message : String(err) })
}

function openDb(file: string, readOnly: boolean): Database.Database {
  return new Database(file, { readonly: readOnly, fileMustExist: true })
}

const oldDb = openDb(oldPath, true)
const newDb = openDb(newPath, !apply)

function ensureBackup(): void {
  if (!apply) return
  const backup = `${newPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  // 先 checkpoint 再复制主文件，避免 WAL 未落盘导致不一致
  newDb.pragma('wal_checkpoint(TRUNCATE)')
  fs.copyFileSync(newPath, backup)
  console.log(`[migrate] 已备份新库: ${backup}`)
}

function importCategories(): void {
  const rows = oldDb.prepare('SELECT * FROM categories ORDER BY sort_order, id').all() as Row[]
  const findByName = newDb.prepare('SELECT id FROM categories WHERE name = ?')
  const findBySort = newDb.prepare(
    'SELECT id FROM categories WHERE is_system = 1 AND sort_order = ? LIMIT 1'
  )
  const insert = newDb.prepare(
    'INSERT INTO categories (name, icon, color, sort_order, parent_id, is_system, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)'
  )
  for (const row of rows) {
    const key = String(row.name)
    try {
      const byName = findByName.get(row.name) as { id: number } | undefined
      const bySort =
        byName === undefined && Number(row.is_system) === 1
          ? (findBySort.get(row.sort_order) as { id: number } | undefined)
          : undefined
      const existing = byName ?? bySort
      if (existing) {
        categoryIdMap.set(Number(row.id), Number(existing.id))
        counter('categories').skipped += 1
        continue
      }
      if (!apply) {
        categoryIdMap.set(Number(row.id), Number(row.id))
        counter('categories').imported += 1
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
      categoryIdMap.set(Number(row.id), Number(info.lastInsertRowid))
      counter('categories').imported += 1
    } catch (err) {
      recordIssue('categories', key, err)
    }
  }
  if (!apply) return
  const updateParent = newDb.prepare('UPDATE categories SET parent_id = ? WHERE id = ?')
  for (const row of rows) {
    const mappedId = categoryIdMap.get(Number(row.id))
    const mappedParent = row.parent_id === null ? null : categoryIdMap.get(Number(row.parent_id))
    if (mappedId && mappedParent) {
      try {
        updateParent.run(mappedParent, mappedId)
      } catch (err) {
        recordIssue('categories', `parent:${String(row.name)}`, err)
      }
    }
  }
}

function importSimple(
  name: string,
  oldTable: string,
  newTable: string,
  naturalKey: string,
  mapMedia = false
): void {
  const oldRows = oldDb.prepare(`SELECT * FROM ${oldTable}`).all() as Row[]
  const newCols = columns(newDb, newTable)
  const oldCols = new Set(columns(oldDb, oldTable))
  const useCols = newCols.filter((c) => c !== 'id' && oldCols.has(c))
  const findStmt = newDb.prepare(`SELECT 1 FROM ${newTable} WHERE ${naturalKey} = ? LIMIT 1`)
  const insert = newDb.prepare(
    `INSERT INTO ${newTable} (${useCols.join(', ')}) VALUES (${useCols.map(() => '?').join(', ')})`
  )
  for (const row of oldRows) {
    const key = String(row[naturalKey])
    try {
      if (findStmt.get(row[naturalKey])) {
        counter(name).skipped += 1
        continue
      }
      if (!apply) {
        counter(name).imported += 1
        continue
      }
      const values = useCols.map((c) => {
        if (mapMedia && c === 'media_id') {
          const mapped = mediaIdMap.get(Number(row[c]))
          if (!mapped) throw new Error(`media_id ${String(row[c])} 未映射`)
          return mapped
        }
        return row[c] ?? null
      })
      insert.run(...values)
      counter(name).imported += 1
    } catch (err) {
      recordIssue(name, key, err)
    }
  }
}

function importMedia(): void {
  const oldRows = oldDb.prepare('SELECT * FROM media_files ORDER BY id').all() as Row[]
  const oldCols = new Set(columns(oldDb, 'media_files'))
  const newCols = new Set(columns(newDb, 'media_files'))
  const insertCols = [...oldCols].filter((c) => c !== 'id' && newCols.has(c))
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
  ].filter((c) => oldCols.has(c) && newCols.has(c))

  for (const row of oldRows) {
    const key = String(row.file_path)
    try {
      const existing = find.get(row.file_path) as Row | undefined
      if (existing) {
        const sets: string[] = []
        const values: unknown[] = []
        for (const field of metaFields) {
          const oldVal = row[field]
          const newVal = existing[field]
          if (!isEmpty(oldVal) && isEmpty(newVal)) {
            if (field === 'category_id') {
              const mapped = categoryIdMap.get(Number(oldVal))
              if (mapped === undefined) continue
              sets.push(`${field} = ?`)
              values.push(mapped)
            } else {
              sets.push(`${field} = ?`)
              values.push(oldVal)
            }
          }
        }
        if (sets.length > 0 && apply) {
          newDb
            .prepare(`UPDATE media_files SET ${sets.join(', ')} WHERE id = ?`)
            .run(...values, existing.id)
        }
        mediaIdMap.set(Number(row.id), Number(existing.id))
        counter('media_files').merged += 1
      } else {
        const values = insertCols.map((c) => {
          if (c === 'category_id' && row[c] !== null) {
            return categoryIdMap.get(Number(row[c])) ?? null
          }
          return row[c] ?? null
        })
        if (apply) {
          const info = insert.run(...values)
          mediaIdMap.set(Number(row.id), Number(info.lastInsertRowid))
        }
        counter('media_files').imported += 1
      }
    } catch (err) {
      recordIssue('media_files', key, err)
    }
  }
}

function rebuildFts(): void {
  if (!apply) return
  try {
    newDb.prepare("INSERT INTO media_fts(media_fts) VALUES('rebuild')").run()
    console.log('[migrate] media_fts 已重建')
  } catch (err) {
    recordIssue('media_fts', 'rebuild', err)
  }
}

function main(): void {
  ensureBackup()
  if (apply) newDb.pragma('foreign_keys = OFF')

  importCategories()
  importSimple('app_settings', 'app_settings', 'app_settings', 'key')
  importSimple('import_roots', 'import_roots', 'import_roots', 'root_path')
  importSimple('filter_presets', 'filter_presets', 'filter_presets', 'name')
  importSimple('character_profiles', 'character_profiles', 'character_profiles', 'uid')
  importSimple('watermark_templates', 'watermark_templates', 'watermark_templates', 'name')
  importMedia()
  importSimple('edit_history', 'edit_history', 'edit_history', 'created_at', true)
  importSimple('operation_history', 'operation_history', 'operation_history', 'created_at', true)
  importSimple('pending_renames', 'pending_renames', 'pending_renames', 'old_path')
  importSimple('scan_history', 'scan_history', 'scan_history', 'start_time')

  rebuildFts()

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    oldDb: oldPath,
    newDb: newPath,
    finishedAt: new Date().toISOString(),
    counters,
    issues
  }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify(report, null, 2))

  newDb.close()
  oldDb.close()
  if (issues.length > 0) process.exit(2)
}

main()
