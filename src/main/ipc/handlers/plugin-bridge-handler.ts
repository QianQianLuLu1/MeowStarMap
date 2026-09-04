/**
 * 插件系统 IPC handler：能力桥
 *
 * 设计目标：
 * - 提供能力桥 IPC（plugin:media.read / write / delete / plugin:db.query /
 *   plugin:fs.read / write / plugin:watermark.apply / plugin:task.progress）
 * - 所有能力桥 handler 在调用业务逻辑前，先经 permission-guard 校验权限
 *
 * 兼容性：不修改任何现有 IPC 通道，所有插件相关通道以 `plugin:` 前缀
 *
 * 复用：
 * - wrapHandlerRaw 统一包装器
 * - pathGuard 路径白名单
 * - FileService / WatermarkService / TaskScheduler / MediaRepository 现有能力
 */
import { ipcMain } from 'electron'
import fsp from 'fs/promises'
import path from 'path'
import type { HandlerContext } from '../handler-context'
import { wrapHandlerRaw, pathGuard } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { assertPluginPermission, inferPluginName } from '../../plugins/permission-guard'
import { MediaRepository } from '../../database/media-repository'
import { ProgressThrottle } from '../../utils/progress-throttle'
import type { TaskProgress } from '../../../shared/types/progress'
import { t } from '../../i18n'

/**
 * 注册插件能力桥所有 IPC handler
 *
 * 在 Application.setupIPC() 末尾紧随插件管理 handler 调用
 */
export function registerPluginBridgeHandlers(ctx: HandlerContext): void {
  registerMediaBridge(ctx)
  registerDbBridge(ctx)
  registerFsBridge(ctx)
  registerWatermarkBridge(ctx)
  registerTaskBridge(ctx)
}

/**
 * 媒体能力桥
 *
 * - plugin:media.read    读取单个媒体文件元数据
 * - plugin:media.list    列出媒体文件
 * - plugin:media.write   写入/导出媒体文件到指定目录
 * - plugin:media.delete  删除媒体文件（走回收站）
 */
function registerMediaBridge(ctx: HandlerContext): void {
  const getRepo = (): MediaRepository => {
    const db = ctx.dbManager.getDatabase()
    if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
    return new MediaRepository(db, ctx.dbManager.getWorkerBridge(), ctx.dbManager.getDbPath())
  }

  ipcMain.handle(
    'plugin:media.read',
    wrapHandlerRaw(ctx, async (rawArgs, _ctx, event) => {
      assertPluginPermission(event, 'media:read')
      const [filePath] = rawArgs as [string]
      if (typeof filePath !== 'string' || !filePath) {
        throw AppError.validation(t('main.plugin.error.filePathInvalid'))
      }
      assertPathRead(filePath)
      const repo = getRepo()
      const rows = repo.searchByFileName(path.basename(filePath), 1)
      return rows[0] ?? null
    })
  )

  ipcMain.handle(
    'plugin:media.list',
    wrapHandlerRaw(ctx, async (rawArgs, _ctx, event) => {
      assertPluginPermission(event, 'media:read')
      const filter = (rawArgs[0] ?? {}) as {
        accountUid?: string
        albumType?: string
        limit?: number
        offset?: number
      }
      const repo = getRepo()
      const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000)
      const offset = Math.max(filter.offset ?? 0, 0)
      // 复用 MediaRepository.listMedia（白名单查询，仅 page/pageSize 分页）
      const page = Math.floor(offset / limit) + 1
      const result = repo.listMedia({
        page,
        pageSize: limit,
        accountUid: filter.accountUid,
        albumType: filter.albumType
      })
      return result.rows
    })
  )

  ipcMain.handle(
    'plugin:media.write',
    wrapHandlerRaw(ctx, async (rawArgs, _ctx, event) => {
      assertPluginPermission(event, 'media:write')
      const [targetDir, data, fileName] = rawArgs as [string, ArrayBuffer | string, string]
      if (typeof targetDir !== 'string' || !targetDir) {
        throw AppError.validation(t('main.plugin.error.targetDirInvalid'))
      }
      if (typeof fileName !== 'string' || !fileName) {
        throw AppError.validation(t('main.plugin.error.fileNameInvalid'))
      }
      assertPathWrite(targetDir)
      await fsp.mkdir(targetDir, { recursive: true })
      const targetPath = path.resolve(targetDir, fileName)
      assertPathWrite(targetPath)
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data)
      await fsp.writeFile(targetPath, buf)
      return targetPath
    })
  )

  ipcMain.handle(
    'plugin:media.delete',
    wrapHandlerRaw(ctx, async (rawArgs, _ctx, event) => {
      assertPluginPermission(event, 'media:delete')
      const [filePaths] = rawArgs as [string[]]
      if (!Array.isArray(filePaths) || filePaths.length === 0) {
        throw AppError.validation(t('main.plugin.error.filePathsInvalid'))
      }
      for (const p of filePaths) assertPathRead(p)
      await _ctx.fileService.moveToRecycleBin(filePaths)
      _ctx.notifyMediaUpdated()
      return { deleted: filePaths.length }
    })
  )
}

/**
 * 数据库能力桥
 *
 * - plugin:db.query  受限 SELECT 查询（表名在白名单内）
 */
function registerDbBridge(ctx: HandlerContext): void {
  // 允许插件查询的表白名单
  const ALLOWED_TABLES = new Set([
    'media_files',
    'character_profiles',
    'categories',
    'tags',
    'scan_history'
  ])
  // FIX(组6-2): 应用内全部非白名单表 + SQLite 内部表——plugin:db.query 的 SQL 中
  // 出现任一该集合表名（含子查询引用）即拒绝，堵住"外层含白名单表名即可通过校验、
  // 子查询实际读取 settings/operation_history 等非白名单表"的绕过
  const PROTECTED_TABLES = new Set([
    'app_settings',
    'edit_history',
    'filter_presets',
    'import_roots',
    'operation_history',
    'pending_renames',
    'schema_migrations',
    'watermark_templates',
    'sqlite_master',
    'sqlite_sequence'
  ])

  ipcMain.handle(
    'plugin:db.query',
    wrapHandlerRaw(ctx, async (rawArgs, _ctx, event) => {
      assertPluginPermission(event, 'db:query')
      const [sql, params] = rawArgs as [string, unknown[] | undefined]
      if (typeof sql !== 'string' || !sql) {
        throw AppError.validation(t('main.plugin.error.sqlInvalid'))
      }
      // 仅允许 SELECT，禁止任何写操作
      const normalized = sql.trim().toLowerCase()
      if (!normalized.startsWith('select')) {
        throw AppError.forbidden(t('main.plugin.error.selectOnly'))
      }
      // FIX(组6-2): 表名白名单校验从"包含至少一个白名单表"收紧为
      // "SQL 中出现的所有已知表名都必须 ∈ 白名单"——先剥离单引号字符串字面量
      // （避免 WHERE x = 'settings' 的普通查询被误伤），再按词边界扫描全部已知表名，
      // 子查询引用非白名单表（含 sqlite_master 等 SQLite 内部表）即拒绝
      const sqlNoLiterals = sql.replace(/'(?:[^']|'')*'/g, '')
      const referencedAllowed = [...ALLOWED_TABLES].some((tName) =>
        new RegExp(`\\b${tName}\\b`, 'i').test(sqlNoLiterals)
      )
      const referencedProtected = [...PROTECTED_TABLES].some((tName) =>
        new RegExp(`\\b${tName}\\b`, 'i').test(sqlNoLiterals)
      )
      if (!referencedAllowed || referencedProtected) {
        throw AppError.forbidden(t('main.plugin.error.tableNotInWhitelist'))
      }
      const db = _ctx.dbManager.getDatabase()
      if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
      const stmt = db.prepare(sql)
      const result = params && params.length > 0 ? stmt.all(...params) : stmt.all()
      return result
    })
  )
}

/**
 * 文件系统能力桥
 *
 * - plugin:fs.read   受 pathGuard 约束的文件读取
 * - plugin:fs.write  受 pathGuard 约束的文件写入
 */
function registerFsBridge(_ctx: HandlerContext): void {
  ipcMain.handle(
    'plugin:fs.read',
    wrapHandlerRaw(_ctx, async (rawArgs, _ctx, event) => {
      assertPluginPermission(event, 'fs:read')
      const [filePath] = rawArgs as [string]
      if (typeof filePath !== 'string' || !filePath) {
        throw AppError.validation(t('main.plugin.error.filePathInvalid'))
      }
      assertPathRead(filePath)
      const buf = await fsp.readFile(filePath)
      // 返回 ArrayBuffer，符合 pluginAPI 接口契约
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    })
  )

  ipcMain.handle(
    'plugin:fs.write',
    wrapHandlerRaw(_ctx, async (rawArgs, _ctx, event) => {
      assertPluginPermission(event, 'fs:write')
      const [filePath, data] = rawArgs as [string, ArrayBuffer | string]
      if (typeof filePath !== 'string' || !filePath) {
        throw AppError.validation(t('main.plugin.error.filePathInvalid'))
      }
      assertPathWrite(filePath)
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data)
      await fsp.writeFile(filePath, buf)
      return { written: buf.length }
    })
  )
}

/**
 * 水印能力桥
 *
 * - plugin:watermark.apply  应用水印到指定文件列表
 */
function registerWatermarkBridge(ctx: HandlerContext): void {
  ipcMain.handle(
    'plugin:watermark.apply',
    wrapHandlerRaw(ctx, async (rawArgs, _ctx, event) => {
      assertPluginPermission(event, 'watermark:apply')
      const [config, filePaths, targetDir] = rawArgs as [unknown, string[], string]
      if (!config || typeof config !== 'object') {
        throw AppError.validation(t('main.plugin.error.configInvalid'))
      }
      if (!Array.isArray(filePaths) || filePaths.length === 0) {
        throw AppError.validation(t('main.plugin.error.filePathsInvalid'))
      }
      if (typeof targetDir !== 'string' || !targetDir) {
        throw AppError.validation(t('main.plugin.error.targetDirInvalid'))
      }
      for (const p of filePaths) assertPathRead(p)
      assertPathWrite(targetDir)
      const result = await _ctx.watermarkService.applyBatch(config as never, filePaths, targetDir)
      return {
        success: result.success,
        processed: result.processed,
        failed: filePaths.length - result.processed,
        message: result.message
      }
    })
  )
}

/**
 * 任务进度能力桥
 *
 * - plugin:task.progress  上报任务进度（通过 ProgressThrottle 推送 task:progress 事件）
 *
 * 设计：复用现有 task:progress 统一进度通道，让 UI 能通过同一监听器接收插件进度
 */
function registerTaskBridge(ctx: HandlerContext): void {
  // 每个插件 taskId 维护独立的 throttle 实例，避免相互干扰
  const throttles = new Map<string, ProgressThrottle>()

  ipcMain.handle(
    'plugin:task.progress',
    wrapHandlerRaw(ctx, async (rawArgs, _ctx, event) => {
      assertPluginPermission(event, 'task:progress')
      const [taskId, current, total, phase] = rawArgs as [
        string,
        number,
        number,
        string | undefined
      ]
      if (typeof taskId !== 'string' || !taskId) {
        throw AppError.validation(t('main.plugin.error.taskIdInvalid'))
      }
      if (typeof current !== 'number' || typeof total !== 'number') {
        throw AppError.validation(t('main.plugin.error.currentTotalInvalid'))
      }
      const pluginName = inferPluginName(event) ?? 'unknown-plugin'
      let throttle = throttles.get(taskId)
      if (!throttle) {
        throttle = new ProgressThrottle(200)
        throttles.set(taskId, throttle)
      }
      const progress: TaskProgress = {
        taskId,
        // 复用 batch 类型，通过 message 区分插件来源（不扩展 TaskType 联合类型）
        taskType: 'batch',
        phase:
          phase === 'done' || phase === 'cancelled' || phase === 'error'
            ? (phase as 'done' | 'cancelled' | 'error')
            : 'processing',
        current,
        total,
        percent: total > 0 ? Math.min(100, Math.floor((current / total) * 100)) : 0,
        message: `[plugin:${pluginName}] ${current}/${total}`,
        startedAt: Date.now(),
        canCancel: false
      }
      throttle.push(progress)
      // 任务完成时清理 throttle
      if (current >= total) {
        throttle.dispose()
        throttles.delete(taskId)
      }
      return { reported: true }
    })
  )
}

// ============ 辅助函数 ============

function assertPathRead(p: string): void {
  pathGuard.assertAllowed(p, 'read')
}

function assertPathWrite(p: string): void {
  pathGuard.assertAllowed(p, 'write')
}
