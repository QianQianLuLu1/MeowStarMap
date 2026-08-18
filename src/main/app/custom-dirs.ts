import { app } from 'electron'
import path from 'path'
import type { AppContext } from './app-context'
import { backupService } from '../services/backup-service'
import { setLogDirectory, logger } from '../utils/logger'
import { setCrashDirectory } from '../services/crash-service'
import {
  resolveCustomDir,
  ensureDir,
  migrateDirFiles,
  MIGRATE_PATTERNS,
  SETTING_KEYS
} from '../utils/dir-manager'
import { logStartupError } from '../utils/startup-diagnostic'

/**
 * 4 个自定义目录（backupDir / thumbnailCacheDir / logDir / crashDir）的解析、迁移、副作用初始化。
 * 必须在 initLogger / crashReporter.start / backupService.init / ThumbnailGenerator 初始化前调用。
 * - backupDir：数据库备份目录
 * - thumbnailCacheDir：缩略图缓存目录
 * - logDir：日志目录
 * - crashDir：崩溃 dump 目录（必须通过 app.setPath('crashDumps', ...) 设置，crashReporter 才会写入）
 *
 * P1-A10：抽取 applyCustomDir 辅助函数消除 4 段重复 try/catch + migrateDirFiles 模板
 */
export async function applyCustomDirectories(ctx: AppContext): Promise<void> {
  // P1-A10：通用迁移流程抽取为辅助函数，每个目录仅 1 行调用 + postSetup 回调
  await applyCustomDir(ctx, 'backupDir', 'backups', MIGRATE_PATTERNS.backupDir, '备份文件', (dir) =>
    backupService.setDir(dir)
  )

  await applyCustomDir(
    ctx,
    'thumbnailCacheDir',
    'thumbnails',
    /metadata\.json$/i,
    '缩略图元数据',
    (dir) => {
      ctx.thumbnailGen.setDir(dir)
      // 恢复自定义缓存上限（如有）
      const savedLimit = ctx.dbManager.getSetting<number>('thumbnailCacheLimitBytes', 0)
      if (savedLimit && savedLimit >= 100 * 1024 * 1024) {
        ctx.thumbnailGen.setCacheLimitBytes(savedLimit)
      }
    }
  )

  await applyCustomDir(ctx, 'logDir', 'logs', MIGRATE_PATTERNS.logDir, '日志文件', (dir) =>
    setLogDirectory(dir)
  )

  // crashDir 必须在 crashReporter.start() 之前调用 app.setPath，crashpad 子进程才能正确写入
  await applyCustomDir(
    ctx,
    'crashDir',
    'crashes',
    MIGRATE_PATTERNS.crashDir,
    '崩溃 dump',
    (dir) => {
      app.setPath('crashDumps', dir)
      setCrashDirectory(dir)
    }
  )
}

/**
 * P1-A10：单个自定义目录的通用迁移流程
 * 1. resolveCustomDir 解析实际目录（优先自定义，回退默认）
 * 2. ensureDir 确保目录存在
 * 3. 若与默认目录不同，migrateDirFiles 迁移老数据
 * 4. setSetting 持久化目录路径
 * 5. postSetup 回调执行目录相关的副作用（如 setDir / setPath）
 *
 * P1-C6：migrateDirFiles 已改为 async，避免 GB 级文件迁移阻塞主进程
 */
async function applyCustomDir(
  ctx: AppContext,
  key: keyof typeof SETTING_KEYS,
  defaultDirName: string,
  migratePattern: RegExp,
  logLabel: string,
  postSetup: (dir: string) => void
): Promise<void> {
  const userData = app.getPath('userData')
  try {
    const dir = resolveCustomDir(ctx.dbManager, key)
    ensureDir(dir)
    const defaultDir = path.join(userData, defaultDirName)
    if (dir !== defaultDir) {
      const r = await migrateDirFiles(defaultDir, dir, migratePattern)
      if (r.moved > 0) logger.info(`[Dir] 迁移${logLabel} ${r.moved} 个到 ${dir}`)
    }
    ctx.dbManager.setSetting(SETTING_KEYS[key], dir)
    postSetup(dir)
  } catch (err) {
    logStartupError(`applyCustomDirectories.${defaultDirName}`, err)
    // P2-A12：自定义目录失败时回退到默认目录，确保 postSetup 至少用默认目录初始化对应服务，
    // 避免自定义目录解析失败导致 backupService/thumbnailGen/logger/crash 等服务未初始化
    try {
      const fallbackDir = path.join(app.getPath('userData'), defaultDirName)
      ensureDir(fallbackDir)
      postSetup(fallbackDir)
    } catch (fallbackErr) {
      logStartupError(`applyCustomDirectories.${defaultDirName}.fallback`, fallbackErr)
    }
  }
}
