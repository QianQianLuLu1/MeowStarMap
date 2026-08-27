import path from 'path'
import fs from 'fs'
import fsp from 'fs/promises'
import { app } from 'electron'
import type { DatabaseManager } from '../database/connection'
import { logger } from './logger'
import { getUserFacingDiagDir } from './user-diag-path'

// 自定义目录设置项 key（统一 camelCase 命名规范）
export const SETTING_KEYS = {
  backupDir: 'backupDir',
  thumbnailCacheDir: 'thumbnailCacheDir',
  logDir: 'logDir',
  crashDir: 'crashDir'
} as const

// 默认子目录名（位于 userData 下）
const DEFAULT_SUBDIRS = {
  backupDir: 'backups',
  thumbnailCacheDir: 'thumbnails',
  logDir: 'logs',
  crashDir: 'crashes'
} as const

/**
 * 解析功能的实际目录：优先使用自定义路径，否则回退到 userData 子目录
 * 自定义路径无效（不存在 / 不是目录 / 不可写）时回退到默认值
 */
export function resolveCustomDir(
  dbManager: DatabaseManager,
  key: keyof typeof SETTING_KEYS
): string {
  const custom = dbManager.getSetting<string>(SETTING_KEYS[key], '')
  if (custom && isValidDir(custom)) {
    return custom
  }
  // 崩溃转储默认输出到用户友好目录（文档/NikkiGallery/Diagnostics），避免藏在 AppData；
  // 与 index.ts 早期 app.setPath('crashDumps', ...) 及 crash-service.initCrashDir 对齐
  if (key === 'crashDir') {
    return getUserFacingDiagDir()
  }
  return path.join(app.getPath('userData'), DEFAULT_SUBDIRS[key])
}

// 校验目录可写：存在、是目录、可写
// P2-C10：原实现仅校验存在性和 isDirectory，注释承诺"校验可写"未兑现，导致只读目录被误认为有效
export function isValidDir(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) return false
    if (!fs.statSync(dir).isDirectory()) return false
    // P2-C10：补充 W_OK 可写校验，只读目录（如部分光盘挂载/受保护路径）会被正确拒绝
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

// 确保目录存在
export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * 迁移老目录中的文件到新目录
 * - 同路径跳过
 * - 仅迁移匹配 filePattern 的文件
 * - 同盘用 rename（快），跨盘降级为 copy + unlink
 * - 失败的文件不阻塞流程
 * - 不删除老目录本身（避免误删用户其他文件）
 *
 * P1-C6：全部改用 fs.promises 异步 API，避免 GB 级文件迁移阻塞主进程事件循环
 * P1-C7：copy 后校验 dst.size === src.size，一致才 unlink；不一致删除 dst 保留 src 供下次重试
 */
export async function migrateDirFiles(
  oldDir: string,
  newDir: string,
  filePattern: RegExp
): Promise<{ moved: number; failed: number }> {
  if (oldDir === newDir) return { moved: 0, failed: 0 }
  try {
    await fsp.access(oldDir)
  } catch {
    return { moved: 0, failed: 0 }
  }

  ensureDir(newDir)

  let moved = 0
  let failed = 0
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(oldDir, { withFileTypes: true })
  } catch {
    return { moved: 0, failed: 0 }
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!filePattern.test(entry.name)) continue

    const srcPath = path.join(oldDir, entry.name)
    const dstPath = path.join(newDir, entry.name)
    try {
      await fsp.rename(srcPath, dstPath)
      moved++
    } catch (err) {
      // A9：仅对跨盘（EXDEV）降级为 copy + 校验 + unlink
      // 其他错误（权限拒绝、文件被占用等）复制也无济于事，记录后跳过，避免掩盖真实问题
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'EXDEV') {
        logger.warn(`[Dir] rename 失败（非跨盘，跳过）: ${srcPath}`, err)
        failed++
        continue
      }
      try {
        await fsp.copyFile(srcPath, dstPath)
        // P1-C7：copy 后校验大小一致，避免崩溃导致的不完整 dst 覆盖完整 src
        const [srcStat, dstStat] = await Promise.all([fsp.stat(srcPath), fsp.stat(dstPath)])
        if (srcStat.size !== dstStat.size) {
          // dst 不完整：删除 dst 保留 src，下次重试可恢复
          await fsp.unlink(dstPath).catch(() => {
            /* dst 可能未创建 */
          })
          throw new Error(`copy 校验失败：源 ${srcStat.size}B 与目标 ${dstStat.size}B 大小不一致`)
        }
        // 一致才删除源文件；unlink 失败仅 warn 不视作迁移失败（dst 已完整）
        await fsp.unlink(srcPath).catch((e) => {
          logger.warn(`[Dir] unlink 源文件失败（dst 已完整，可手动删除）: ${srcPath}`, e)
        })
        moved++
      } catch {
        failed++
        // 单文件失败不阻塞，继续迁移其他文件
      }
    }
  }

  return { moved, failed }
}

// 各功能的文件名匹配模式（用于迁移时筛选）
export const MIGRATE_PATTERNS = {
  backupDir: /^wxnn_photo_manager_.*\.db$/,
  thumbnailCacheDir: /\.(jpg|jpeg|png|webp)$/i,
  logDir: /\.(log|jsonl)$/,
  crashDir: /\.(dmp|dump|crash)$/
} as const
