import { app } from 'electron'
import path from 'path'
import type { AppContext } from './app-context'
import { backupService } from '../services/backup-service'
import { logger } from '../utils/logger'
import {
  resolveCustomDir,
  ensureDir,
  migrateDirFiles,
  MIGRATE_PATTERNS,
  SETTING_KEYS
} from '../utils/dir-manager'
import { logStartupError } from '../utils/startup-diagnostic'
import { unifyForensicsDirs } from './forensics-migrate'
import { t } from '../i18n'

/**
 * 目录初始化：backupDir / thumbnailCacheDir 保留自定义（通用迁移流程）；
 * logDir / crashDir 属「问题取证清单」，强制统一到取证根（unifyForensicsDirs：
 * 历史残留归集迁移 + 清键 + setLogDirectory / crashDumps / setCrashDirectory 接线）。
 * 必须在 initLogger / crashReporter.start / backupService.init / ThumbnailGenerator 初始化前调用。
 *
 * P1-A10：抽取 applyCustomDir 辅助函数消除重复 try/catch + migrateDirFiles 模板
 */
export async function applyCustomDirectories(ctx: AppContext): Promise<void> {
  // P1-A10：通用迁移流程抽取为辅助函数，每个目录仅 1 行调用 + postSetup 回调
  await applyCustomDir(
    ctx,
    'backupDir',
    'backups',
    MIGRATE_PATTERNS.backupDir,
    t('main.customDirs.label.backupFiles'),
    (dir) => backupService.setDir(dir)
  )

  await applyCustomDir(
    ctx,
    'thumbnailCacheDir',
    'thumbnails',
    /metadata\.json$/i,
    t('main.customDirs.label.thumbnailMetadata'),
    (dir) => {
      ctx.thumbnailGen.setDir(dir)
      // 恢复自定义缓存上限（如有）
      const savedLimit = ctx.dbManager.getSetting<number>('thumbnailCacheLimitBytes', 0)
      if (savedLimit && savedLimit >= 100 * 1024 * 1024) {
        ctx.thumbnailGen.setCacheLimitBytes(savedLimit)
      }
    }
  )

  // 取证目录统一：不走通用 applyCustomDir——其「setSetting 持久化解析结果」与
  // 「失败回退 userData 子目录」语义对统一目录都是错的（会重新引入分散存储）
  await unifyForensicsDirs(ctx)
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
