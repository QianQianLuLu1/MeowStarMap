/**
 * 编辑器服务（P1-M：从 index.ts 的 editor:save handler 抽取）
 *
 * 职责：
 * - 处理图片编辑后的保存（含格式转换、质量压缩）
 * - 保存前自动备份原图（独立子目录 editor-snapshots，避免污染数据库备份列表）
 * - 写入失败时从备份恢复
 * - 记录编辑历史到 edit_history 表
 * - 备份 LRU 清理（保留最近 MAX_EDITOR_SNAPSHOTS 个，超出按 mtime 升序删除）
 *
 * 设计原则：
 * - 单一职责：仅处理编辑保存逻辑，不涉及 IPC 注册
 * - 依赖注入：通过构造函数接收 dbManager 实例
 * - 健壮性：备份→写入→恢复三段式保障，写入失败自动回滚
 */
import path from 'path'
import fs from 'fs'
import sharp from 'sharp'
import type Database from 'better-sqlite3'
import { backupService } from './backup-service'
import { parseDataUrlToBuffer, getUniqueFilePath } from '../utils/file-utils'
import { getExtFromMime } from '../utils/media-constants'
import { t } from '../i18n'
import type { DatabaseManager } from '../database/connection'
import { MediaRepository } from '../database/media-repository'
import type { TaskScheduler } from '../scheduler/task-scheduler'
import type { EditorMetadata } from '../../shared/types/editor-metadata'
import {
  writeMetadataToFile,
  readMetadataFromFile,
  batchWriteMetadata,
  getAppVersion
} from './xmp-metadata-service'
import { logger } from '../utils/logger'

// P1-A6：编辑器备份 LRU 上限（原实现无清理，频繁编辑导致磁盘隐性泄漏）
const MAX_EDITOR_SNAPSHOTS = 50

export interface EditorSaveOptions {
  format?: string
  quality?: number
  params?: string
}

export interface EditorSaveResult {
  success: boolean
  message: string
  filePath?: string
}

export class EditorService {
  private dbManager: DatabaseManager | null = null
  // P1-A6：独立子目录路径缓存，init 时计算一次
  private snapshotDir: string = ''
  // 分级调度器（可选）：注入后 pruneOldSnapshots 通过低优先级队列执行，避免与用户操作争抢 IO
  private scheduler: TaskScheduler | null = null

  /** 初始化：注入 dbManager 实例（在 Application.initialize 中调用） */
  init(dbManager: DatabaseManager): void {
    this.dbManager = dbManager
    // P1-A6：编辑器备份使用独立子目录，避免污染 backupService 的数据库备份列表
    // pruneOldBackups 的正则 /^wxnn_photo_manager_.*\.db$/ 不匹配编辑器备份文件名，
    // 独立子目录让两类备份互不干扰，UI 备份列表也不会出现编辑器快照
    this.snapshotDir = path.join(backupService.getBackupDirectory(), 'editor-snapshots')
  }

  /**
   * 注入分级调度器。注入后 pruneOldSnapshots 会通过低优先级队列执行。
   * 不注入则保持原有直接执行行为（向后兼容）。
   */
  setScheduler(scheduler: TaskScheduler): void {
    this.scheduler = scheduler
  }

  private getDb(): Database.Database | null {
    return this.dbManager?.getDatabase() ?? null
  }

  /**
   * R11：构造 MediaRepository 实例，使 edit_history 写入走 worker。
   * 与 IPC handler 中 getRepo() 模式一致：每次调用动态创建（db 可能在重连时变化）。
   * workerBridge 未注入时（测试场景），MediaRepository 内部降级为同步直写 db。
   * dbManager 未初始化时返回 null。
   */
  private getRepo(): MediaRepository | null {
    const db = this.dbManager?.getDatabase() ?? null
    if (!db) return null
    return new MediaRepository(db, this.dbManager!.getWorkerBridge(), this.dbManager!.getDbPath())
  }

  /**
   * P1-A6：清理超出上限的旧编辑器快照（LRU by mtime）
   * 保存成功后调用，避免频繁编辑导致磁盘空间隐性泄漏
   * 失败时仅记录日志，不影响主流程
   *
   * 分级调度改造：若已注入 scheduler，通过低优先级队列入队，避免与用户操作争抢 IO。
   */
  private async pruneOldSnapshots(): Promise<void> {
    try {
      const entries = await fs.promises.readdir(this.snapshotDir)
      const snapshots: Array<{ name: string; mtime: number }> = []
      for (const name of entries) {
        // 仅清理本服务生成的快照文件（{mediaId}_{timestamp}.{ext} 格式）
        if (!/^\d+_\d+\.\w+$/.test(name)) continue
        const fullPath = path.join(this.snapshotDir, name)
        try {
          const stat = await fs.promises.stat(fullPath)
          snapshots.push({ name, mtime: stat.mtimeMs })
        } catch {
          // 文件已被外部删除时跳过
        }
      }
      if (snapshots.length <= MAX_EDITOR_SNAPSHOTS) return

      // 按 mtime 升序（最旧在前），删除超出上限的部分
      snapshots.sort((a, b) => a.mtime - b.mtime)
      const toDelete = snapshots.slice(0, snapshots.length - MAX_EDITOR_SNAPSHOTS)
      for (const item of toDelete) {
        try {
          await fs.promises.unlink(path.join(this.snapshotDir, item.name))
        } catch {
          // 单个删除失败不阻塞整体清理
        }
      }
      logger.info(
        t('main.editor.log.cleanupSnapshotsDone', {
          deleted: String(toDelete.length),
          remaining: String(snapshots.length - toDelete.length)
        })
      )
    } catch (err) {
      logger.warn(t('main.editor.log.cleanupSnapshotsFailed'), err)
    }
  }

  /**
   * 保存编辑后的图片
   * @param filePath 目标文件路径（必须是数据库中已索引的媒体文件）
   * @param dataUrl 编辑后的图片数据（data:image/...;base64,...）
   * @param options 格式/质量/参数
   */
  async save(
    filePath: string,
    dataUrl: string,
    options?: EditorSaveOptions
  ): Promise<EditorSaveResult> {
    const normalizedFilePath = path.resolve(filePath)
    const db = this.getDb()
    if (!db) return { success: false, message: t('main.error.databaseNotInit') }

    // 安全校验：filePath 必须是数据库中已索引的媒体文件路径，防止任意文件写入
    const mediaRow = db
      .prepare('SELECT id FROM media_files WHERE file_path = ? LIMIT 1')
      .get(normalizedFilePath) as { id: number } | undefined
    if (!mediaRow) {
      return { success: false, message: t('main.editor.error.onlyIndexedPath') }
    }

    const { buffer, mimeType } = parseDataUrlToBuffer(dataUrl)
    const format = options?.format || getExtFromMime(mimeType)
    const quality = options?.quality ?? 92

    // P1-A6：备份到独立子目录 editor-snapshots，避免污染数据库备份列表
    // F-S7 修复：原实现不校验备份完整性，磁盘满时备份可能不完整，
    // 恢复时会用不完整备份覆盖原图导致原图永久损坏。现增加备份大小校验。
    const backupName = `${mediaRow.id}_${Date.now()}${path.extname(normalizedFilePath)}`
    const backupPath = path.join(this.snapshotDir, backupName)
    let backupCreated = false
    let originalSize = 0
    try {
      await fs.promises.mkdir(this.snapshotDir, { recursive: true })
      originalSize = (await fs.promises.stat(normalizedFilePath)).size
      await fs.promises.copyFile(normalizedFilePath, backupPath)
      // 校验备份完整性：备份文件大小必须与原文件一致
      const backupSize = (await fs.promises.stat(backupPath)).size
      if (backupSize !== originalSize) {
        logger.warn(
          t('main.editor.log.backupSizeMismatch', {
            original: String(originalSize),
            backup: String(backupSize)
          })
        )
        await fs.promises.unlink(backupPath).catch(() => {})
        backupCreated = false
      } else {
        backupCreated = true
      }
    } catch (backupError) {
      logger.warn(t('main.editor.log.backupFailed'), backupError)
    }

    // 写入新文件（sharp pipeline 处理格式转换与质量压缩）
    try {
      let pipeline = sharp(buffer)
      if (format === 'jpg' || format === 'jpeg') {
        pipeline = pipeline.jpeg({ quality, progressive: true, mozjpeg: true })
      } else if (format === 'png') {
        pipeline = pipeline.png({ quality: Math.min(quality, 100) })
      } else if (format === 'webp') {
        pipeline = pipeline.webp({ quality })
      }
      await pipeline.toFile(normalizedFilePath)
    } catch (writeError) {
      // 写入失败时尝试从备份恢复（恢复前再次校验备份完整性）
      if (backupCreated) {
        try {
          const backupSize = (await fs.promises.stat(backupPath)).size
          if (backupSize !== originalSize) {
            logger.error(
              t('main.editor.log.backupSizeChanged', {
                original: String(originalSize),
                backup: String(backupSize)
              })
            )
          } else {
            await fs.promises.copyFile(backupPath, normalizedFilePath)
            logger.info(t('main.editor.log.restoredFromBackup'))
          }
        } catch (restoreError) {
          logger.error(t('main.editor.log.restoreFailed'), restoreError)
        }
      }
      throw writeError
    }

    // P1-A6：保存成功后异步清理超出上限的旧快照（不阻塞主流程）
    // 分级调度改造：通过低优先级队列入队，避免与用户操作争抢 IO
    if (this.scheduler) {
      void this.scheduler.enqueueLow(() => this.pruneOldSnapshots(), {
        id: 'editor-prune-snapshots'
      })
    } else {
      void this.pruneOldSnapshots()
    }

    // R11：记录编辑历史走 worker（MediaRepository.runWrite → workerBridge）
    // 原实现直接 db.prepare().run() 绕过 worker，与"所有写走 worker"架构不一致
    try {
      const params = options?.params || '{}'
      // Bug #09-F2：thumbnail 列名误导（实际从未被 SELECT 读取，是死字段）
      // 原实现写入 backupPath，但 backupPath 已在 backup_service 内部管理，无需在 edit_history 重复存储
      // 写入 null 避免误导未来读取者；彻底删除该列或实装真缩略图留待 v3 P2 重构
      const repo = this.getRepo()
      if (repo) {
        await repo.recordEditHistory(mediaRow.id, params)
      } else {
        // 降级路径：dbManager 未初始化时直接走 db（理论上不会到达，save 入口已校验 db）
        db.prepare(
          'INSERT INTO edit_history (media_id, params, thumbnail, created_at) VALUES (?, ?, ?, datetime("now"))'
        ).run(mediaRow.id, params, null)
      }
    } catch (historyError) {
      logger.warn(t('main.editor.log.recordHistoryFailed'), historyError)
    }

    return {
      success: true,
      message: t('main.file.message.saveSuccess'),
      filePath: normalizedFilePath
    }
  }

  /**
   * 导出含编辑参数 XMP 元数据的副本
   *
   * 行为：
   * - 绝不修改原图：从 sourcePath 读取，输出到 targetDir 下的新文件
   * - 调色参数/滤镜/LUT/水印信息写入 XMP wxnn:EditorData 字段
   * - 输出文件名默认 `{原文件名}_编辑.{$格式}`
   *
   * @param sourcePath 源图片路径
   * @param metadata 编辑器元数据
   * @param options 输出目录 + 格式/质量
   */
  async exportWithMetadata(
    sourcePath: string,
    metadata: EditorMetadata,
    options: {
      targetDir: string
      fileName?: string
      format?: 'jpg' | 'jpeg' | 'png' | 'webp'
      quality?: number
    }
  ): Promise<{ success: boolean; message: string; outputPath?: string }> {
    try {
      const normalizedSource = path.resolve(sourcePath)
      if (!fs.existsSync(normalizedSource)) {
        return { success: false, message: `源文件不存在: ${normalizedSource}` }
      }

      await fs.promises.mkdir(options.targetDir, { recursive: true })

      const ext = path.extname(normalizedSource).toLowerCase()
      const baseName = path.basename(normalizedSource, ext)
      const format = options.format ?? (ext.replace('.', '') as 'jpg' | 'jpeg' | 'png' | 'webp')
      const targetExt = format === 'jpeg' ? '.jpg' : `.${format}`
      const finalBaseName = options.fileName ?? `${baseName}_编辑`
      const targetPath = await getUniqueFilePath(options.targetDir, finalBaseName, targetExt)

      await writeMetadataToFile(normalizedSource, targetPath, metadata, {
        format,
        quality: options.quality
      })

      return {
        success: true,
        message: `已导出含参数副本: ${path.basename(targetPath)}`,
        outputPath: targetPath
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, message: `导出失败: ${msg}` }
    }
  }

  /**
   * 批量导出含编辑参数 XMP 元数据的副本
   *
   * 用于"批量应用编辑参数到选中图片"场景，每张图片写入相同的编辑参数。
   * 单张失败不阻断其他文件。
   *
   * @param sourcePaths 源图片路径列表
   * @param metadata 编辑器元数据（所有图片共用）
   * @param options 输出目录 + 格式/质量
   */
  async batchExportWithMetadata(
    sourcePaths: string[],
    metadata: EditorMetadata,
    options: {
      targetDir: string
      format?: 'jpg' | 'jpeg' | 'png' | 'webp'
      quality?: number
    }
  ): Promise<{
    success: boolean
    successCount: number
    failedCount: number
    outputPaths: string[]
    failures: Array<{ sourcePath: string; error: string }>
    message: string
  }> {
    const items = sourcePaths.map((sourcePath) => ({ sourcePath, metadata }))
    const result = await batchWriteMetadata(items, options.targetDir, {
      format: options.format,
      quality: options.quality
    })

    return {
      success: result.failedCount === 0,
      successCount: result.successCount,
      failedCount: result.failedCount,
      outputPaths: result.outputPaths,
      failures: result.failures,
      message:
        result.failedCount > 0
          ? `批量导出完成：成功 ${result.successCount} 张，失败 ${result.failedCount} 张`
          : `批量导出完成：成功 ${result.successCount} 张`
    }
  }

  /**
   * 读取图片中的编辑参数 XMP 元数据
   *
   * 用于"一键恢复编辑参数"：读取已写入的 wxnn:EditorData 字段，
   * 反序列化为 EditorMetadata，前端可直接应用到编辑器。
   *
   * @param filePath 图片路径
   * @returns 元数据（无数据返回 null，不抛错）
   */
  async readMetadata(filePath: string): Promise<EditorMetadata | null> {
    return readMetadataFromFile(filePath)
  }
}

// 单例导出
export const editorService = new EditorService()

/**
 * 构造编辑器元数据（供 IPC handler 使用，集中字段填充逻辑）
 *
 * 调用方仅需传入业务字段，schemaVersion/appVersion/exportTimestamp 由本函数填充。
 */
export function buildEditorMetadata(input: {
  params: EditorMetadata['params']
  filter: EditorMetadata['filter']
  filterIntensity: number
  watermark: EditorMetadata['watermark']
}): EditorMetadata {
  return {
    schemaVersion: 1,
    appVersion: getAppVersion(),
    exportTimestamp: new Date().toISOString(),
    params: input.params,
    filter: input.filter,
    filterIntensity: input.filterIntensity,
    watermark: input.watermark
  }
}
