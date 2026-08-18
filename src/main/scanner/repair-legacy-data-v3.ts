/**
 * 修复旧数据 V3：强制修复 NULL media_source
 *
 * 问题背景：v1/v2 迁移虽已添加 NULL 处理逻辑，但 schema_migrations 标记机制导致
 * 旧版本已运行过 v1/v2 的用户无法获得 NULL 修复（标记已存在则直接 return）。
 * 本迁移独立执行 NULL 修复，不依赖 v1/v2 是否完成。
 *
 * 幂等性：UPDATE 语句 WHERE media_source IS NULL 天然幂等，重复执行无副作用
 *
 * 可测性：抽取为独立模块，不依赖 worker-entry 的 electron/ffmpeg 上下文，便于单元测试
 */
import type DatabaseType from 'better-sqlite3'

type LogLevel = 'info' | 'warn' | 'error'

export function repairLegacyDataV3(
  db: DatabaseType.Database,
  log: (level: LogLevel, message: string, ...args: unknown[]) => void
  // FIX(组3-4): 返回是否成功——worker-entry 据此决定是否中止后续 V4 修复步骤
): boolean {
  // 检查迁移是否已应用（已应用则跳过）
  try {
    const applied = db
      .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
      .get('repair_legacy_data_v3')
    if (applied) return true
  } catch {
    // schema_migrations 表可能尚未创建，降级为每次执行
  }

  try {
    const nullCount = db
      .prepare('SELECT COUNT(*) as count FROM media_files WHERE media_source IS NULL')
      .get() as { count: number }

    if (nullCount.count > 0) {
      db.prepare("UPDATE media_files SET media_source = 'game' WHERE media_source IS NULL").run()
      log(
        'warn',
        `[Scanner] repairLegacyDataV3: 强制修复 ${nullCount.count} 条 media_source IS NULL 记录为 'game'`
      )
    }

    // 标记迁移完成（失败不阻塞，下次重复执行）
    try {
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, datetime('now'))"
      ).run('repair_legacy_data_v3')
    } catch (markErr) {
      log(
        'warn',
        '[Scanner] repairLegacyDataV3: 标记迁移状态失败:',
        markErr instanceof Error ? markErr.message : String(markErr)
      )
    }
  } catch (err) {
    log(
      'error',
      '[Scanner] repairLegacyDataV3 失败:',
      err instanceof Error ? err.message : String(err)
    )
    // FIX(组3-4): 返回失败标志，调用方中止后续修复步骤
    return false
  }
  return true
}
