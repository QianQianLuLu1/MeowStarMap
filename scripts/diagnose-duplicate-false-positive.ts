/**
 * 「重复文件」误判诊断脚本（只读，绝不写库）。
 *
 * 背景：游戏/启动器用 Windows 硬链接把同一物理文件暴露在 GamePlayPhotos\<UID>\... 与
 * X6Game\Video\ / X6Game\ScreenShot\ 两个目录下，扫描器各写一条 media_files 记录；
 * 重复/相似检测假定「一行 = 一个文件」，于是把同一文件报成多份。
 *
 * 两种模式：
 * - `--baseline`：纯 SQL 统计，不依赖被测代码，用于修复前立基线。
 * - 默认（无参数）：额外 import 被测的 dedupeByPhysicalFile，用真实候选行验证去重效果。
 *
 * 用 node:sqlite 而非 better-sqlite3——后者编译为 Electron ABI
 * （NODE_MODULE_VERSION 145），纯 Node 下加载即崩。
 *
 * 用法：npx tsx scripts/diagnose-duplicate-false-positive.ts [--baseline] [dbPath]
 * 退出码：验收通过 0；验收失败 1。
 */
import { DatabaseSync } from 'node:sqlite'
import os from 'os'
import path from 'path'
import fs from 'fs'

const args = process.argv.slice(2)
const isBaseline = args.includes('--baseline')
const dbArg = args.find((a) => !a.startsWith('--'))

/** 候选行：与 MediaRepository.getDuplicateCandidates 口径一致（is_deleted = 0） */
interface CandidateRow {
  id: number
  file_path: string
  file_size: number
}

/** 相似检测候选行：与 media-worker 的 startSimilarFind SELECT 口径一致 */
interface PhashRow extends CandidateRow {
  phash: string | null
}

function resolveDbPath(): string {
  if (dbArg) return dbArg
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'meow-star-map', 'database', 'meow_star_map.db')
}

/** 按 file_size 分桶，返回组内 >1 的组（精确重复检测的第一轮口径） */
function sizeGroups(rows: CandidateRow[]): Array<CandidateRow[]> {
  const buckets = new Map<number, CandidateRow[]>()
  for (const row of rows) {
    if (!(row.file_size > 0)) continue
    const list = buckets.get(row.file_size)
    if (list) list.push(row)
    else buckets.set(row.file_size, [row])
  }
  return Array.from(buckets.values()).filter((g) => g.length > 1)
}

/** 物理文件身份：dev + ino。stat 失败返回 null（fail-open） */
function statKey(filePath: string): string | null {
  if (typeof filePath !== 'string' || filePath === '') return null
  try {
    const s = fs.statSync(filePath)
    return `${s.dev}:${s.ino}`
  } catch {
    return null
  }
}

/** 组内是否存在同一物理文件（硬链接） */
function hasSamePhysicalFile(group: CandidateRow[]): boolean {
  const keys = group.map((r) => statKey(r.file_path)).filter((k): k is string => k !== null)
  return new Set(keys).size < keys.length
}

/** 按 phash 分组，返回组内 >1 的组（相似检测的聚类口径，阈值=0 的严格等价组） */
function phashGroups(rows: PhashRow[]): Array<PhashRow[]> {
  const buckets = new Map<string, PhashRow[]>()
  for (const row of rows) {
    if (!row.phash) continue
    const list = buckets.get(row.phash)
    if (list) list.push(row)
    else buckets.set(row.phash, [row])
  }
  return Array.from(buckets.values()).filter((g) => g.length > 1)
}

async function main(): Promise<number> {
  const dbPath = resolveDbPath()
  if (!fs.existsSync(dbPath)) {
    console.error(`[DIAG] 数据库不存在: ${dbPath}`)
    return 1
  }

  const db = new DatabaseSync(dbPath, { readOnly: true })
  const rows = db
    .prepare('SELECT id, file_path, file_size FROM media_files WHERE is_deleted = 0')
    .all() as unknown as CandidateRow[]
  const total = (
    db.prepare('SELECT COUNT(*) AS c FROM media_files WHERE is_deleted = 0').get() as { c: number }
  ).c
  const missing = (
    db
      .prepare('SELECT COUNT(*) AS c FROM media_files WHERE is_deleted = 0 AND is_missing = 1')
      .get() as { c: number }
  ).c

  console.log(`[DIAG] 数据库: ${dbPath}`)
  console.log(
    `[DIAG] 候选行(未软删): ${rows.length} / 全表 ${total}，其中 is_missing=1: ${missing}`
  )

  const before = sizeGroups(rows)
  const beforeSameFile = before.filter(hasSamePhysicalFile)
  console.log(`[DIAG] 精确重复候选组(同 size 且组内>1): ${before.length}`)
  console.log(`[DIAG]   其中同一物理文件(硬链接)导致的误报组: ${beforeSameFile.length}`)

  const phRows = db
    .prepare(
      "SELECT id, file_path, file_size, phash FROM media_files WHERE is_deleted = 0 AND phash IS NOT NULL AND phash != ''"
    )
    .all() as unknown as PhashRow[]
  const beforePh = phashGroups(phRows)
  const beforePhSameFile = beforePh.filter(hasSamePhysicalFile)
  console.log(`[DIAG] 相似候选组(同 phash 且组内>1): ${beforePh.length}`)
  console.log(`[DIAG]   其中含同一物理文件(硬链接)的组: ${beforePhSameFile.length}`)

  if (isBaseline) {
    db.close()
    console.log('[DIAG] --baseline 模式：仅统计，不校验被测代码')
    return 0
  }

  // 默认模式：用被测代码去重后再统计
  const { dedupeByPhysicalFile } = await import('../src/main/utils/physical-file-key')
  const after = dedupeByPhysicalFile(rows)
  const afterGroups = sizeGroups(after)
  const afterSameFile = afterGroups.filter(hasSamePhysicalFile)

  console.log(`[DIAG] 去重后候选行: ${after.length}（剔除 ${rows.length - after.length} 行）`)
  console.log(`[DIAG] 去重后精确重复组: ${afterGroups.length}`)
  console.log(`[DIAG]   其中同一物理文件误报组: ${afterSameFile.length}`)

  const afterPh = phashGroups(dedupeByPhysicalFile(phRows))
  const afterPhSameFile = afterPh.filter(hasSamePhysicalFile)
  console.log(`[DIAG] 去重后相似组: ${afterPh.length}`)
  console.log(`[DIAG]   其中含同一物理文件(硬链接)的组: ${afterPhSameFile.length}`)

  const ok =
    afterSameFile.length === 0 &&
    afterGroups.length === before.length - beforeSameFile.length &&
    afterPhSameFile.length === 0
  console.log(
    ok ? '[DIAG] 验收通过：硬链接误报组已全部消除' : '[DIAG] 验收失败：仍存在硬链接误报组'
  )
  db.close()
  return ok ? 0 : 1
}

main().then((code) => process.exit(code))
