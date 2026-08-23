/**
 * 修复旧数据 V1：误扫描清理 + 字段重算
 *
 * 问题背景：P0-02/P0-03/media_source 功能添加前写入的旧记录，account_uid='default'、
 * album_type='其他'、media_source='unknown'。增量扫描因 mtime 匹配跳过这些文件，
 * 字段从未被更新。同时，ScreenShot 签名误匹配导致非游戏目录图片被扫描入库。
 * 另外，MallPic 商城图最初被识别为 'game'，应归为 'launcher'（非用户拍摄）。
 *
 * 修复内容：
 * 1. 删除 file_path 不含 'InfinityNikki' 的误扫描记录（Trae skills、War Thunder、test_media 等）
 * 2. 修复 NULL media_source（safeAddColumn 可能因列已存在而跳过 NOT NULL DEFAULT）
 * 3. 对 media_source='unknown' 或误识别为 game 的 MallPic 记录，重新计算 media_source/account_uid/album_type
 *
 * R10（M8）：三步合并到同一个 db.transaction()，避免步骤 1 提交后步骤 2 崩溃导致已删记录无法恢复。
 * 迁移标记仍独立于事务外（标记失败不阻塞，修复逻辑幂等可重跑）。
 *
 * 可测性：抽取为独立模块，不依赖 worker-entry 的 electron/ffmpeg 上下文，便于单元测试。
 */
import type DatabaseType from 'better-sqlite3'
import {
  extractMediaSourceFromPath,
  extractUidFromPath,
  extractAlbumTypeFromPath
} from './path-classifier'
import { ImportRootRepository, normalizeRootPath } from '../database/import-root-repository'
import { t } from '../i18n/worker-safe'

type LogLevel = 'info' | 'warn' | 'error'

/**
 * 读取导入根用于豁免判断。表缺失或查询失败时降级为无豁免，保持原有删除语义。
 */
function readImportRootsSafe(db: DatabaseType.Database): string[] {
  try {
    return new ImportRootRepository(db).listImportRoots()
  } catch {
    return []
  }
}

/**
 * 导入根前缀归一化：小写 + 反斜杠转正斜杠 + 去尾分隔符 + 补尾分隔符，
 * 用于判断 file_path 是否以某导入根开头（Windows 路径大小写不敏感）。
 */
function buildExemptPrefixes(roots: string[]): string[] {
  const prefixes: string[] = []
  for (const root of roots) {
    const normalized = normalizeRootPath(root).toLowerCase()
    if (normalized.length > 0) {
      prefixes.push(`${normalized}/`)
    }
  }
  return prefixes
}

/** file_path 是否落在任一导入根前缀下（归一化后比较） */
function isUnderImportRoot(filePath: string, prefixes: string[]): boolean {
  const lp = filePath.toLowerCase().replace(/\\/g, '/')
  return prefixes.some((prefix) => lp.startsWith(prefix))
}

export function repairLegacyDataV1(
  db: DatabaseType.Database,
  log: (level: LogLevel, message: string, ...args: unknown[]) => void
  // FIX(组3-4): 返回是否成功——worker-entry 据此决定是否中止后续 V2/V3/V4 修复步骤
): boolean {
  // 检查迁移是否已应用（已应用则跳过）
  try {
    const applied = db
      .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
      .get('repair_legacy_data_v1')
    if (applied) return true
  } catch {
    // schema_migrations 表可能尚未创建（极旧版本数据库），降级为每次执行
  }

  try {
    // R10：把"删除 + NULL 修复 + 字段重算"三步合并到同一个事务，
    // 三步对同一张 media_files 表操作，单事务保证要么全部生效要么全部回滚。
    // 迁移标记仍独立于事务外（保持原容错逻辑：标记失败不阻塞修复，修复幂等可重跑）。
    // A4：读取导入根用于豁免判断（表缺失或查询失败降级为无豁免，保持原删除语义）
    const exemptPrefixes = buildExemptPrefixes(readImportRootsSafe(db))

    const summary = db.transaction(() => {
      // 1. 删除误扫描的非游戏目录文件
      // 判定标准（白名单保护）：原逻辑"路径不含 infinitynikki"会误伤中文路径等合法安装，
      // 现仅删除明确属于其他应用（War Thunder 等其他游戏）或测试/临时目录的记录。
      // A4：剔除导入根下的记录——导入根是用户显式纳入管理的目录，其照片为资产，禁止被清理。
      const nonGameFiles = db
        .prepare(
          "SELECT id, file_path FROM media_files WHERE LOWER(file_path) NOT LIKE '%infinitynikki%' " +
            "AND (LOWER(file_path) LIKE '%warthunder%' " +
            "OR LOWER(file_path) LIKE '%test_media%' " +
            // FIX(组4-1): 原 LIKE '%\\\\temp\\\\%'（TS 转义后运行时为 \\temp\\ 双反斜杠）
            // 对 DB 中单反斜杠的 Windows 路径永假，temp 目录清理从未生效；
            // 与下方步骤 3 的 mallpic 条件同为两反斜杠写法（运行时单反斜杠）。
            // 排除 cloudphotos\temp：该目录由步骤 3 重分类保留，不能被当作误扫描删除
            "(LOWER(file_path) LIKE '%\\temp\\%' AND LOWER(file_path) NOT LIKE '%\\cloudphotos\\temp\\%') " +
            "OR LOWER(file_path) LIKE '%/temp/%')"
        )
        .all() as Array<{ id: number; file_path: string }>

      const deletable =
        exemptPrefixes.length > 0
          ? nonGameFiles.filter((f) => !isUnderImportRoot(f.file_path, exemptPrefixes))
          : nonGameFiles

      if (deletable.length > 0) {
        const deleteStmt = db.prepare('DELETE FROM media_files WHERE id = ?')
        for (const f of deletable) {
          deleteStmt.run(f.id)
        }
      }

      // 2. 修复 NULL media_source 记录
      const nullSourceFiles = db
        .prepare('SELECT COUNT(*) as count FROM media_files WHERE media_source IS NULL')
        .get() as { count: number }
      if (nullSourceFiles.count > 0) {
        db.prepare("UPDATE media_files SET media_source = 'game' WHERE media_source IS NULL").run()
      }

      // 3. 重新计算需要修复的记录字段
      // 触发条件：
      //   a) media_source='unknown'（功能上线前写入的旧记录）
      //   b) media_source='game' 但路径属于非用户拍摄类别：
      //      - MallPic 商城图
      //      - X6Game\ScreenShot 游戏截图
      //      - CloudPhotos\Temp 云照片临时缓存
      const legacyFiles = db
        .prepare(
          "SELECT id, file_path FROM media_files WHERE media_source = 'unknown' " +
            "OR (media_source = 'game' AND (LOWER(file_path) LIKE '%\\mallpic\\%' " +
            "OR LOWER(file_path) LIKE '%\\x6game\\screenshot\\%' " +
            "OR LOWER(file_path) LIKE '%\\cloudphotos\\temp\\%'))"
        )
        .all() as Array<{ id: number; file_path: string }>

      if (legacyFiles.length > 0) {
        const updateStmt = db.prepare(
          'UPDATE media_files SET media_source = ?, account_uid = ?, album_type = ? WHERE id = ?'
        )
        for (const file of legacyFiles) {
          updateStmt.run(
            extractMediaSourceFromPath(file.file_path),
            extractUidFromPath(file.file_path),
            extractAlbumTypeFromPath(file.file_path),
            file.id
          )
        }
      }

      // 返回统计供事务外输出日志（事务内的 log 会阻塞事务且事务回滚时日志已输出造成混淆）
      return { deletable, nullSourceCount: nullSourceFiles.count, legacyFiles }
    })()

    // 事务提交后统一输出日志
    if (summary.deletable.length > 0) {
      log(
        'info',
        `[Scanner] repairLegacyData: 清理 ${summary.deletable.length} 条误扫描记录（其他应用/测试/临时目录）`
      )
      for (const f of summary.deletable) {
        log('info', `[Scanner]   - ${f.file_path}`)
      }
    }
    if (summary.nullSourceCount > 0) {
      log(
        'info',
        `[Scanner] repairLegacyData: 修复 ${summary.nullSourceCount} 条 media_source IS NULL 记录为 'game'`
      )
    }
    if (summary.legacyFiles.length > 0) {
      log(
        'info',
        `[Scanner] repairLegacyData: 更新 ${summary.legacyFiles.length} 条旧记录的 media_source/account_uid/album_type 字段`
      )
    }

    // 标记迁移已完成（独立于数据修复事务：标记失败不阻塞，修复逻辑幂等可重跑）
    try {
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, datetime('now'))"
      ).run('repair_legacy_data_v1')
    } catch (markErr) {
      log(
        'warn',
        t('main.scanner.log.markMigrationV1FailedRetry'),
        markErr instanceof Error ? markErr.message : String(markErr)
      )
    }
  } catch (err) {
    // 修复失败不阻塞扫描，仅记录错误
    // 事务已回滚，三步修改均不生效，下次启动会重新执行（幂等）
    log(
      'error',
      t('main.scanner.log.repairV1Failed'),
      err instanceof Error ? err.message : String(err)
    )
    // FIX(组3-4): 返回失败标志，调用方中止后续修复步骤
    return false
  }
  return true
}
