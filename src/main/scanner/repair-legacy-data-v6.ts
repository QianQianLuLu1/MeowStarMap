/**
 * 修复旧数据 V6：为存量游戏拍照（HQ）记录回填游戏原生低清缩略图路径
 *
 * 问题背景：游戏目录 ...\X6Game\Saved\GamePlayPhotos\{UID}\ 下，
 *   NikkiPhotos_HighQuality  （高清原图）
 *   NikkiPhotos_LowQuality   （游戏原生低清缩略图，与 HQ 同名一一对应）
 * 历史扫描入库未关联原生缩略图（thumbnail 为 NULL）或指向了生成的缩略图目录
 * （thumbnail LIKE '%thumbnails%'），导致展示时仍需/已走缩略图生成流程。
 * 本迁移把这类 HQ 记录的 thumbnail 直接指向同名 LQ 文件路径（不触发缩略图生成）。
 *
 * 与扫描入库（子任务 2）的分工：扫描时新入库记录已在 saveBatchToDatabase 直接填充
 * thumbnail；本函数只负责存量数据补齐，二者共用 path-classifier 的
 * resolveNativeThumbnailPath 推导规则，保证口径一致。
 *
 * 幂等性：
 * - schema_migrations 标记 'repair_legacy_data_v6' 确保只执行一次；
 * - 候选条件 (thumbnail IS NULL OR thumbnail LIKE '%thumbnails%') 天然收敛——
 *   回填后 thumbnail 指向 LowQuality 路径，不再命中候选条件。
 *
 * 安全性：逐行 fs.existsSync 校验 LQ 文件真实存在才回填，避免指向失效路径。
 *
 * 可测性：抽取为独立模块，不依赖 worker-entry 的 electron/ffmpeg 上下文，便于单元测试
 */
import fs from 'fs'
import type DatabaseType from 'better-sqlite3'
import { resolveNativeThumbnailPath } from './path-classifier'

type LogLevel = 'info' | 'warn' | 'error'

// 归一化后（小写 + 正斜杠）的 HQ 路径命中条件：
// ...\GamePlayPhotos\{任意中间段（如数字 UID）}\NikkiPhotos_HighQuality\...
const HQ_GALLERY_LIKE = '%/gameplayphotos/%/nikkiphotos_highquality/%'

export function repairLegacyDataV6(
  db: DatabaseType.Database,
  log: (level: LogLevel, message: string, ...args: unknown[]) => void
): boolean {
  // 检查迁移是否已应用（已应用则跳过）
  try {
    const applied = db
      .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
      .get('repair_legacy_data_v6')
    if (applied) return true
  } catch {
    // schema_migrations 表可能尚未创建，降级为每次执行
  }

  try {
    // 候选：未关联缩略图（NULL）或仍指向生成缩略图目录（%thumbnails%）的 HQ 记录
    const candidates = db
      .prepare(
        `SELECT id, file_path FROM media_files
         WHERE (thumbnail IS NULL OR thumbnail LIKE '%thumbnails%')
           AND LOWER(REPLACE(file_path, '\\', '/')) LIKE ?`
      )
      .all(HQ_GALLERY_LIKE) as Array<{ id: number; file_path: string }>

    let repairedCount = 0
    if (candidates.length > 0) {
      const updateStmt = db.prepare('UPDATE media_files SET thumbnail = ? WHERE id = ?')
      const updateMany = db.transaction((files: Array<{ id: number; file_path: string }>) => {
        for (const file of files) {
          const lqPath = resolveNativeThumbnailPath(file.file_path)
          if (!lqPath) continue
          // 仅当同名 LQ 文件真实存在才回填，避免指向失效路径
          if (!fs.existsSync(lqPath)) continue
          updateStmt.run(lqPath, file.id)
          repairedCount++
        }
      })
      updateMany(candidates)
    }

    if (repairedCount > 0) {
      log(
        'info',
        `[Scanner] repairLegacyDataV6: 为 ${repairedCount} 条 HQ 记录回填游戏原生低清缩略图`
      )
    }

    // 标记迁移完成（失败不阻塞，下次重复执行）
    try {
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, datetime('now'))"
      ).run('repair_legacy_data_v6')
    } catch (markErr) {
      log(
        'warn',
        // eslint-disable-next-line no-restricted-syntax -- worker 进程早于 i18n 初始化，诊断日志仍须可读（与 worker-entry 内联日志口径一致）
        '[Scanner] repairLegacyDataV6: 标记迁移状态失败，下次扫描将重试',
        markErr instanceof Error ? markErr.message : String(markErr)
      )
    }
  } catch (err) {
    log(
      'error',
      // eslint-disable-next-line no-restricted-syntax -- worker 进程早于 i18n 初始化，诊断日志仍须可读（与 worker-entry 内联日志口径一致）
      '[Scanner] repairLegacyDataV6 失败',
      err instanceof Error ? err.message : String(err)
    )
    return false
  }
  return true
}
