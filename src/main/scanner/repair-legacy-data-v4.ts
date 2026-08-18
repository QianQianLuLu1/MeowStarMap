/**
 * 修复旧数据 V4：重新分类误标记为 launcher 的历史记录
 *
 * 问题背景：path-classifier.ts 修复前，extractMediaSourceFromPath 会因 \cache\ 等
 * 通用关键词将游戏内截图误判为 launcher。path-classifier 已修正（改为 launcher\cache
 * 精确匹配），但历史数据中已被误分类为 launcher 的记录需要用新规则重新分类。
 *
 * 幂等性：schema_migrations 标记确保只执行一次；UPDATE 仅在新分类与当前不同时写入。
 *
 * 可测性：抽取为独立模块，不依赖 worker-entry 的 electron/ffmpeg 上下文，便于单元测试
 */
import type DatabaseType from 'better-sqlite3'
import { extractMediaSourceFromPath } from './path-classifier'

type LogLevel = 'info' | 'warn' | 'error'

export function repairLegacyDataV4(
  db: DatabaseType.Database,
  log: (level: LogLevel, message: string, ...args: unknown[]) => void
  // FIX(组3-4): 返回是否成功——worker-entry 据此决定是否中止后续修复步骤
): boolean {
  // 检查迁移是否已应用（已应用则跳过）
  try {
    const applied = db
      .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
      .get('repair_legacy_data_v4')
    if (applied) return true
  } catch {
    // schema_migrations 表可能尚未创建，降级为每次执行
  }

  try {
    const launcherFiles = db
      .prepare("SELECT id, file_path FROM media_files WHERE media_source = 'launcher'")
      .all() as Array<{ id: number; file_path: string }>

    let reclassifiedCount = 0
    if (launcherFiles.length > 0) {
      const updateStmt = db.prepare('UPDATE media_files SET media_source = ? WHERE id = ?')
      const updateMany = db.transaction((files: Array<{ id: number; file_path: string }>) => {
        for (const file of files) {
          const newSource = extractMediaSourceFromPath(file.file_path)
          if (newSource !== 'launcher') {
            updateStmt.run(newSource, file.id)
            reclassifiedCount++
          }
        }
      })
      updateMany(launcherFiles)
    }

    if (reclassifiedCount > 0) {
      log(
        'info',
        `[Scanner] repairLegacyDataV4: 重新分类 ${reclassifiedCount} 条误标记为 launcher 的记录`
      )
    }

    // 标记迁移完成（失败不阻塞，下次重复执行）
    try {
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, datetime('now'))"
      ).run('repair_legacy_data_v4')
    } catch (markErr) {
      log(
        'warn',
        '[Scanner] repairLegacyDataV4: 标记迁移状态失败:',
        markErr instanceof Error ? markErr.message : String(markErr)
      )
    }
  } catch (err) {
    log(
      'error',
      '[Scanner] repairLegacyDataV4 失败:',
      err instanceof Error ? err.message : String(err)
    )
    // FIX(组3-4): 返回失败标志，调用方中止后续修复步骤
    return false
  }
  return true
}
