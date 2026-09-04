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
 * 性能（2026-08-25 优化）：
 * - 候选查询仅按 thumbnail 列条件收窄（IS NULL / 前缀 LIKE），避免在 file_path 上做
 *   LOWER(REPLACE(...)) 全表函数变换，无法命中索引导致全表扫描；路径特征判断下沉 JS 层，
 *   仅对少量命中行做正则过滤。
 * - LQ 文件存在性校验由同步 fs.existsSync 改为异步 fs.promises.access，候选按批
 *   （BATCH_SIZE）切片并发校验，避免在大库（10 万+）启动时同步阻塞事件循环。
 *
 * 安全性：逐行异步校验 LQ 文件真实存在才回填，避免指向失效路径。
 *
 * 可测性：抽取为独立模块，不依赖 worker-entry 的 electron/ffmpeg 上下文，便于单元测试
 */
import fs from 'fs'
import type DatabaseType from 'better-sqlite3'
import { resolveNativeThumbnailPath } from './path-classifier'
// P2-2：SQLITE_BUSY 感知写入重试封装（与 saveBatchToDatabase 同源，吸收瞬时锁冲突）
import { executeWriteSafely } from './sqlite-retry'

type LogLevel = 'info' | 'warn' | 'error'

// JS 层路径命中条件（评审收紧：完整游戏目录特征）：
// ...\X6Game\Saved\GamePlayPhotos\{任意中间段（如数字 UID）}\NikkiPhotos_HighQuality\...
// 下沉到 JS 层，避免对 file_path 做 LOWER(REPLACE(...)) 全表函数变换而无法命中索引。
const HQ_GALLERY_RE = /\/x6game\/saved\/gameplayphotos\/.*\/nikkiphotos_highquality\//i

// 异步文件存在性校验：仅当 LQ 文件真实存在才回填，避免指向失效路径。
async function lqFileExists(lqPath: string): Promise<boolean> {
  try {
    await fs.promises.access(lqPath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

// 候选按批切片，避免一次性 Promise.all 海量候选导致并发风暴。
const BATCH_SIZE = 1000

export async function repairLegacyDataV6(
  db: DatabaseType.Database,
  log: (level: LogLevel, message: string, ...args: unknown[]) => void
): Promise<boolean> {
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
    // 候选：仅按 thumbnail 列条件收窄（IS NULL / 前缀 LIKE）。
    // 两列条件均可利用 thumbnail 列前缀/索引，避免对 file_path 做函数变换全表扫描。
    const candidates = db
      .prepare(
        `SELECT id, file_path FROM media_files
         WHERE (thumbnail IS NULL OR thumbnail LIKE '%thumbnails%')`
      )
      .all() as Array<{ id: number; file_path: string }>

    // JS 层路径过滤：仅保留真正命中 HQ 游戏目录特征的行（替代 SQL 全表函数变换 LIKE）。
    // 归一化反斜杠为斜杠，保持与原 SQL `LOWER(REPLACE(file_path,'\\','/'))` 一致的路径口径。
    const hqCandidates = candidates.filter((c) =>
      HQ_GALLERY_RE.test(c.file_path.replace(/\\/g, '/'))
    )

    let repairedCount = 0
    if (hqCandidates.length > 0) {
      const updateStmt = db.prepare('UPDATE media_files SET thumbnail = ? WHERE id = ?')
      // 分批：每批内并发校验 LQ 存在性，命中收集后一次性事务批量 UPDATE。
      for (let i = 0; i < hqCandidates.length; i += BATCH_SIZE) {
        const batch = hqCandidates.slice(i, i + BATCH_SIZE)
        const exists = await Promise.all(
          batch.map(async (file) => {
            const lqPath = resolveNativeThumbnailPath(file.file_path)
            if (!lqPath) return null
            return (await lqFileExists(lqPath)) ? { id: file.id, thumbnail: lqPath } : null
          })
        )
        const toUpdate = exists.filter((e): e is { id: number; thumbnail: string } => e !== null)
        if (toUpdate.length === 0) continue
        const updateMany = db.transaction((files: Array<{ id: number; thumbnail: string }>) => {
          for (const file of files) {
            updateStmt.run(file.thumbnail, file.id)
          }
        })
        // P2-2：用 executeWriteSafely 包裹事务，吸收与用户删改的瞬时锁冲突（非锁错误立即 rethrow）
        await executeWriteSafely(() => updateMany(toUpdate), {
          log: (m) => log('warn', m)
        })
        repairedCount += toUpdate.length
      }
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
