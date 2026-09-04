/**
 * 修复旧数据 V5：将误归为 launcher 的「游戏内截图/视频」记录重分类回 game
 *
 * 问题背景：无限暖暖标准安装树下的游戏内媒体位于
 *   InfinityNikki Launcher\InfinityNikki\X6Game\ScreenShot  （游戏内图片 → 图库）
 *   InfinityNikki Launcher\InfinityNikki\X6Game\Video       （游戏内视频 → 图库）
 * 历史版本可能因分类规则差异把这些目录下的文件标记为 media_source='launcher'，
 * 导致其进入「缓存」板块、且因图库 SQL 历史仅放行 HQ 路径而彻底不显示在「图库」。
 * 本次修复明确这两个目录属「图库」内容（见 GALLERY_PATH_CONDITION），本函数负责
 * 把存量中被误标为 launcher 的这两类目录记录重分类为 game。
 *
 * 与 V4 的区别：V4 依赖 extractMediaSourceFromPath 隐式重算（一次性迁移，可能已执行）；
 * V5 显式按路径前缀锁定这两目录，独立于 path-classifier 其它规则，确保存量数据被修正。
 *
 * 幂等性：schema_migrations 标记确保只执行一次；UPDATE 仅当当前为 launcher 且路径命中时写入。
 *
 * 可测性：抽取为独立模块，不依赖 worker-entry 的 electron/ffmpeg 上下文，便于单元测试
 */
import type DatabaseType from 'better-sqlite3'
import { t } from '../i18n/worker-safe'

type LogLevel = 'info' | 'warn' | 'error'

// 归一化后（小写 + 正斜杠）的路径前缀：X6Game/ScreenShot 与 X6Game/Video 之下的文件
const GALLERY_X6GAME_SCREENSHOT_LIKE = '%/x6game/screenshot/%'
const GALLERY_X6GAME_VIDEO_LIKE = '%/x6game/video/%'

export function repairLegacyDataV5(
  db: DatabaseType.Database,
  log: (level: LogLevel, message: string, ...args: unknown[]) => void
): boolean {
  // 检查迁移是否已应用（已应用则跳过）
  try {
    const applied = db
      .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
      .get('repair_legacy_data_v5')
    if (applied) return true
  } catch {
    // schema_migrations 表可能尚未创建，降级为每次执行
  }

  try {
    const misclassified = db
      .prepare(
        `SELECT id, file_path FROM media_files
         WHERE media_source = 'launcher'
           AND (
             LOWER(REPLACE(file_path, '\\', '/')) LIKE ?
             OR LOWER(REPLACE(file_path, '\\', '/')) LIKE ?
           )`
      )
      .all(GALLERY_X6GAME_SCREENSHOT_LIKE, GALLERY_X6GAME_VIDEO_LIKE) as Array<{
      id: number
      file_path: string
    }>

    let reclassifiedCount = 0
    if (misclassified.length > 0) {
      const updateStmt = db.prepare('UPDATE media_files SET media_source = ? WHERE id = ?')
      const updateMany = db.transaction((files: Array<{ id: number; file_path: string }>) => {
        for (const file of files) {
          // 仅当仍是 launcher 才改写（防止并发/重复执行时误覆盖人工变更）
          updateStmt.run('game', file.id)
          reclassifiedCount++
        }
      })
      updateMany(misclassified)
    }

    if (reclassifiedCount > 0) {
      log(
        'info',
        `[Scanner] repairLegacyDataV5: 重新分类 ${reclassifiedCount} 条误归 launcher 的 X6Game/ScreenShot、X6Game/Video 记录为 game`
      )
    }

    // 标记迁移完成（失败不阻塞，下次重复执行）
    try {
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, datetime('now'))"
      ).run('repair_legacy_data_v5')
    } catch (markErr) {
      log(
        'warn',
        t('main.scanner.log.markMigrationV5Failed'),
        markErr instanceof Error ? markErr.message : String(markErr)
      )
    }
  } catch (err) {
    log(
      'error',
      t('main.scanner.log.repairV5Failed'),
      err instanceof Error ? err.message : String(err)
    )
    return false
  }
  return true
}
