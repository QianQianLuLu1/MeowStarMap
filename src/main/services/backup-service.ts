// @core-change: 项目更名为喵星图，数据库与备份文件名前缀链改为 meow_star_map
// 步骤4：原生模块改为惰性加载，使 ABI 不匹配时崩溃能被 bootstrapApplication 的 try/catch 捕获
import type DatabaseType from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { promises as fsp } from 'fs'
import { app } from 'electron'
import type { DatabaseManager } from '../database/connection'
import type { TaskScheduler } from '../scheduler/task-scheduler'
import { logger } from '../utils/logger'
import { t } from '../i18n'
// 目录越界（路径穿越）校验原语：断言解析后路径仍位于某目录内，Windows 大小写不敏感
import { isPathUnderDir } from '../utils/ipc-validate'
// 注意：此处不 import media-repository 的 MEDIA_COUNT_STALE_KEY 常量，避免跨模块循环依赖导致
// 命名绑定在测试环境下求值异常。与 media-repository 的 app_settings KV key 保持字面量一致：
// 'media_count_stale'（1=缓存过期需重算，0/缺失=缓存可用）。

// 惰性加载 better-sqlite3：首次调用时才动态 import，使原生模块加载时机推迟到 bootstrapApplication 的 try/catch 内
// 使用 import() 而非 require()：import() 是 ESM 原生 API，被 Vitest vi.mock 正确拦截
let DatabaseImpl: typeof import('better-sqlite3') | null = null
async function getDatabaseImpl(): Promise<typeof import('better-sqlite3')> {
  if (!DatabaseImpl) {
    const mod = await import('better-sqlite3')
    DatabaseImpl = (mod.default ?? mod) as typeof import('better-sqlite3')
  }
  return DatabaseImpl
}

// 备份保留份数上限
const MAX_BACKUPS = 5
// 启动后延迟备份的毫秒数（避开启动高峰）
const STARTUP_BACKUP_DELAY_MS = 5000
// 自动备份最小间隔（7 天，避免频繁备份）
const AUTO_BACKUP_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

export interface BackupRecord {
  filename: string
  filePath: string
  size: number
  createdAt: string // ISO 时间戳
}

export class BackupService {
  private dbManager: DatabaseManager | null = null
  private backupDir: string = ''
  // 修复：保存启动备份定时器引用，退出时清理，避免定时器回调访问已关闭的数据库
  private startupBackupTimer: NodeJS.Timeout | null = null
  // 分级调度器（可选）：注入后启动备份通过低优先级队列执行，避免与用户操作争抢 IO
  private scheduler: TaskScheduler | null = null

  init(dbManager: DatabaseManager): void {
    this.dbManager = dbManager
    // 自定义目录：applyCustomDirectories 已调用 setDir 设置最终路径
    // 此处仅作兜底——若 setDir 未被调用，回退到默认 userData/backups
    if (!this.backupDir) {
      this.backupDir = path.join(app.getPath('userData'), 'backups')
    }
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true })
    }
  }

  /**
   * 自定义目录支持：设置备份目录路径
   * 必须在 init() 之前调用（由 applyCustomDirectories 触发）
   */
  setDir(dir: string): void {
    this.backupDir = dir
  }

  /**
   * 兜底初始化 backupDir 到默认路径。
   * 用于 DatabaseManager.initialize() 在 backupService.init() 之前需要恢复的场景。
   * 若 backupDir 已设置（init 或 setDir 已调用），此方法无副作用。
   */
  ensureDefaultDir(): void {
    if (this.backupDir) return
    this.backupDir = path.join(app.getPath('userData'), 'backups')
    if (!fs.existsSync(this.backupDir)) {
      try {
        fs.mkdirSync(this.backupDir, { recursive: true })
      } catch {
        /* 目录创建失败由后续 restoreLatestBackupTo 的访问校验暴露 */
      }
    }
  }

  /**
   * 注入分级调度器。注入后启动备份会通过低优先级队列执行。
   * 不注入则保持原有直接执行行为（向后兼容）。
   */
  setScheduler(scheduler: TaskScheduler): void {
    this.scheduler = scheduler
  }

  // 启动后自动备份（延迟执行 + 间隔检查）
  // 分级调度改造：若已注入 scheduler，通过 enqueueLow 入队，等空闲时执行
  scheduleStartupBackup(): void {
    if (this.startupBackupTimer) clearTimeout(this.startupBackupTimer)
    this.startupBackupTimer = setTimeout(() => {
      this.startupBackupTimer = null
      const runBackup = async (): Promise<void> => {
        try {
          await this.autoBackupIfNeeded()
        } catch (err) {
          logger.error(t('main.backup.log.startupAutoBackupFailed'), err)
        }
      }
      if (this.scheduler) {
        void this.scheduler.enqueueLow(runBackup, { id: 'startup-backup' })
      } else {
        runBackup().catch(() => {})
      }
    }, STARTUP_BACKUP_DELAY_MS)
  }

  /** 退出时清理定时器，防止回调访问已关闭的数据库 */
  dispose(): void {
    if (this.startupBackupTimer) {
      clearTimeout(this.startupBackupTimer)
      this.startupBackupTimer = null
    }
  }

  // 检查是否需要自动备份（距上次备份超过 7 天才执行）
  private async autoBackupIfNeeded(): Promise<void> {
    const records = await this.listBackups()
    if (records.length > 0) {
      const latest = records[0] // listBackups 按时间倒序，第一条是最新的
      const elapsed = Date.now() - new Date(latest.createdAt).getTime()
      if (elapsed < AUTO_BACKUP_MIN_INTERVAL_MS) {
        logger.info(
          t('main.backup.log.skipAutoBackup', { days: String(Math.floor(elapsed / 86400000)) })
        )
        return
      }
    }
    logger.info(t('main.backup.log.runningStartupAutoBackup'))
    await this.createBackup()
  }

  // 创建数据库备份（使用 better-sqlite3 的 Online Backup API）
  // P1-04：accountUid 可选，提供时文件名加入 UID 后缀以便识别（整库备份，不丢失其他档案数据）
  async createBackup(
    accountUid?: string
  ): Promise<{ success: boolean; backup?: BackupRecord; message?: string }> {
    if (!this.dbManager) {
      return { success: false, message: t('main.error.databaseNotInit') }
    }
    const db = this.dbManager.getDatabase()
    if (!db) {
      return { success: false, message: t('main.backup.error.dbUnavailable') }
    }

    try {
      const timestamp = this.formatTimestamp(new Date())
      // P1-04：按档案备份时文件名加入 _{uid} 后缀
      const uidSuffix = accountUid ? `_${accountUid}` : ''
      const filename = `meow_star_map_${timestamp}${uidSuffix}.db`
      const backupPath = path.join(this.backupDir, filename)

      // better-sqlite3 的 backup 方法：将当前数据库在线备份到目标文件
      // 在线备份不会阻塞读写操作，WAL 模式下安全
      await this.backupDatabase(db, backupPath)

      const stats = await fsp.stat(backupPath)
      const record: BackupRecord = {
        filename,
        filePath: backupPath,
        size: stats.size,
        createdAt: stats.mtime.toISOString()
      }

      logger.info(
        t('main.backup.log.createSuccess', { filename, size: this.formatSize(stats.size) })
      )

      // 清理超出上限的旧备份
      await this.pruneOldBackups()

      return { success: true, backup: record }
    } catch (error) {
      logger.error(t('main.backup.log.createFailed'), error)
      return { success: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  // better-sqlite3 的 backup API 封装
  private backupDatabase(db: DatabaseType.Database, targetPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // better-sqlite3 的 db.backup() 返回 promise（async 接口）
        db.backup(targetPath)
          .then(() => resolve())
          .catch((err) => reject(err))
      } catch (err) {
        reject(err)
      }
    })
  }

  // 列出所有备份（按时间倒序）
  // P1-A10：改为 fsp 异步 API，避免同步 statSync 阻塞主进程
  async listBackups(): Promise<BackupRecord[]> {
    try {
      await fsp.access(this.backupDir)
    } catch {
      return []
    }

    const records: BackupRecord[] = []
    const files = await fsp.readdir(this.backupDir)

    for (const file of files) {
      if (!file.startsWith('meow_star_map_') || !file.endsWith('.db')) continue
      const filePath = path.join(this.backupDir, file)
      try {
        const stats = await fsp.stat(filePath)
        records.push({
          filename: file,
          filePath,
          size: stats.size,
          createdAt: stats.mtime.toISOString()
        })
      } catch {
        // 跳过无法读取的文件
      }
    }

    // 按时间倒序（最新在前）
    records.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return records
  }

  /**
   * 获取全部有效备份（含完整性校验），按时间倒序（最新在前）。
   * 用于数据库自恢复流程：遍历所有未损坏的备份，按时间从新到旧逐个尝试还原（IO 回退）。
   * @returns 通过 integrity_check 的备份记录数组（可能为空）
   */
  private async getValidBackups(): Promise<BackupRecord[]> {
    const records = await this.listBackups()
    const valid: BackupRecord[] = []
    for (const record of records) {
      const check = await this.verifyBackupIntegrity(record.filePath)
      if (check.valid) {
        valid.push(record)
      } else {
        logger.warn(`[Backup] 备份已损坏，跳过: ${record.filename} - ${check.reason}`)
      }
    }
    return valid
  }

  /**
   * 获取最近一份有效备份（含完整性校验）。
   * 用于需要"单个最新有效备份"的场景（如用户主动 restoreBackup）。
   * 自恢复流程改用 getValidBackups + 遍历（见 restoreLatestBackupTo）以支持 IO 回退。
   * @returns { filePath, filename } 或 null（无可用备份）
   */
  async getLatestValidBackup(): Promise<{ filePath: string; filename: string } | null> {
    const valid = await this.getValidBackups()
    return valid.length > 0 ? { filePath: valid[0].filePath, filename: valid[0].filename } : null
  }

  /**
   * 尝试从单个备份还原到目标路径（不重启应用）。
   *
   * IO 回退设计：本方法对"写盘前复检不通过（backup-unavailable）"与"写盘阶段 IO 失败
   * （restore-failed）"均返回结构化失败（不向上抛），由 restoreLatestBackupTo 决定是否
   * 继续尝试下一个有效候选。无论何种失败，在线库 targetPath 都不会被损坏内容触碰
   * （H1 非破坏性优先）。
   *
   * @returns 成功 { success:true, sourceBackup }；失败 { success:false, reason, message }
   */
  private async attemptRestoreFrom(
    targetPath: string,
    record: BackupRecord
  ): Promise<
    | { success: true; sourceBackup: { filePath: string; filename: string } }
    | { success: false; reason: 'backup-unavailable' | 'restore-failed'; message: string }
  > {
    // 恢复点二次确认：在 copy 前对选定备份做一次轻量 quick_check，防御 getValidBackups
    // 到 copy 之间备份被外部改动、或所选备份与在线库同源损坏的场景（用户建议的"快速校验"）。
    // 此分支同样在任何写盘之前，在线库文件不被触碰，满足 H1"非破坏性优先"。
    const recheck = await this.verifyBackupIntegrity(record.filePath, 'quick')
    if (!recheck.valid) {
      logger.warn(
        `[Backup] 恢复点复检不可用，按 H1 保留在线库、跳过覆盖: ${record.filename} - ${recheck.reason ?? ''}`
      )
      void logger.fault('databaseRestore', new Error('backup-unavailable'), {
        stage: 'restore-backup-unavailable',
        dbPath: targetPath,
        filename: record.filename
      })
      return {
        success: false,
        reason: 'backup-unavailable',
        message: t('main.backup.error.backupCorrupted', { reason: recheck.reason ?? '' })
      }
    }

    const tmpPath = `${targetPath}.restoring`
    try {
      await fsp.copyFile(record.filePath, tmpPath)
      // 清理旧的 WAL/SHM，避免旧事务日志干扰新数据库
      const walPath = `${targetPath}-wal`
      const shmPath = `${targetPath}-shm`
      try {
        await fsp.unlink(walPath)
      } catch {
        /* WAL 可能不存在 */
      }
      try {
        await fsp.unlink(shmPath)
      } catch {
        /* SHM 可能不存在 */
      }
      // 同盘 rename 是原子操作。句柄可能仍被 OS 短暂持有（即便 worker 已确认释放 DB 句柄），
      // 故对 EPERM/EBUSY 做有限重试兜底，避免时序抖动误报失败。
      await this.renameWithRetry(tmpPath, targetPath)
    } catch (err) {
      // 清理临时文件
      try {
        await fsp.unlink(tmpPath)
      } catch {
        /* 忽略 */
      }
      const reason = err instanceof Error ? err.message : String(err)
      logger.error(t('main.backup.log.restoreToFailed', { reason }))
      // 诊断增强：Windows 上目标文件被其他进程（database/scanner/media worker）占用时会以 EPERM
      // 失败。还原前已由 DatabaseManager.attemptRecovery 显式停止这些 worker 释放句柄；此处给出明确提示，
      // 便于"手动恢复"等其它触发路径在失败时能定位到根因，而非仅记日志吞掉。
      const isShareViolation = /EPERM|EBUSY|share|in use|占用|being used/i.test(reason)
      const hint = isShareViolation
        ? // eslint-disable-next-line no-restricted-syntax -- 诊断日志
          '（目标文件被其他进程占用，恢复前请先停止数据库/扫描/媒体 worker 以释放句柄）'
        : ''
      return {
        success: false,
        reason: 'restore-failed',
        message: t('main.backup.error.restoreFailedPlain', { reason }) + hint
      }
    }

    // R9：rename 成功后写入后置修复标志。失败不阻塞恢复（rename 已完成，下次启动仍可正常使用）
    await this.markRestoredFlags(targetPath)

    logger.info(t('main.backup.log.restoredToDb', { filename: record.filename }))
    return {
      success: true,
      sourceBackup: { filePath: record.filePath, filename: record.filename }
    }
  }

  /**
   * 数据库自恢复：将有效备份复制到目标路径（不重启应用）。
   *
   * 调用方（DatabaseManager）职责：
   * 1. 关闭当前数据库连接
   * 2. 备份损坏的 db 文件（重命名为 .corrupt-<timestamp>）
   * 3. 调用本方法恢复
   * 4. 重新打开数据库 + 重新注入 worker bridge
   *
   * 本方法职责：
   * - 遍历全部有效备份，逐个尝试"复制备份 → 原子 rename 覆盖目标路径"（IO 回退）
   * - 首个 copy/rename 成功的候选即返回；某候选 IO 失败时记录告警并继续更早的候选
   * - 清理残留的 WAL/SHM
   * - 不重启应用（与 restoreBackup 不同，后者面向用户主动恢复场景）
   *
   * R9：恢复后在目标 DB 写入"后置修复标志"（need_phash_recheck / need_duplicate_recheck /
   * restored_at / media_count_stale），下次启动由 runPostRestoreRepair 消费并触发重算。
   *
   * @param targetPath 目标数据库文件路径（即 dbManager.dbPath）
   * @returns { success, message, sourceBackup? } 失败时 message 含原因
   */
  async restoreLatestBackupTo(targetPath: string): Promise<{
    success: boolean
    message: string
    sourceBackup?: { filePath: string; filename: string }
    /**
     * 结构化失败原因（向后兼容，调用方仅判 success）：
     * - 'no-valid-backup'：无任何可用备份（保留在线库，不覆盖）
     * - 'backup-unavailable'：恢复点 quick_check 复检不可用（保留在线库，不覆盖）
     * - 'restore-failed'：全部有效候选 copy/rename 等 IO 均失败（在线库未被损坏内容写入）
     */
    reason?: 'no-valid-backup' | 'backup-unavailable' | 'restore-failed'
  }> {
    const candidates = await this.getValidBackups()
    if (candidates.length === 0) {
      // H1：无任何可用有效备份——绝不用损坏数据覆盖在线库，保留现场并显式告警。
      // 此分支在任何写盘之前，在线库文件不被触碰；上层 attemptRecovery 会据此把 .corrupt
      // 副本还原回原路径重新打开，天然"保留在线库"。
      // eslint-disable-next-line no-restricted-syntax -- 诊断日志
      logger.warn('[Backup] 无可用有效备份，按 H1 保留在线库、跳过恢复')
      void logger.fault('databaseRestore', new Error('no-valid-backup'), {
        stage: 'restore-no-valid-backup',
        dbPath: targetPath
      })
      return {
        success: false,
        reason: 'no-valid-backup',
        message: t('main.backup.error.noBackupToRestore')
      }
    }

    // IO 回退：按时间倒序遍历全部有效候选，逐个尝试还原，首个成功即返回；
    // 某候选在写盘前复检不通过或写盘阶段 IO 失败时记录告警并继续下一候选。
    // 无论成败，在线库 targetPath 都不会被损坏内容触碰（H1 非破坏性优先）。
    const failedReasons: string[] = []
    // 区分两类失败以维持精确语义（与单候选时代一致，避免误报）：
    // - 候选在写盘前 quick 复检不通过 → backup-unavailable
    // - 候选在 copy/rename 写盘阶段 IO 失败 → restore-failed
    // 只要出现过任一候选的 IO 失败（restore-failed），最终即归为 restore-failed；
    // 仅当全部候选都卡在写盘前复检时，才归为 backup-unavailable。
    let sawRestoreFailed = false
    for (const candidate of candidates) {
      const result = await this.attemptRestoreFrom(targetPath, candidate)
      if (result.success) {
        return {
          success: true,
          message: t('main.backup.message.restoredFrom', {
            filename: result.sourceBackup.filename
          }),
          sourceBackup: result.sourceBackup
        }
      }
      if (result.reason === 'restore-failed') {
        sawRestoreFailed = true
      }
      logger.warn(
        `[Backup] 候选备份还原失败，尝试更早备份: ${candidate.filename} - ${result.message}`
      )
      failedReasons.push(`${candidate.filename}: ${result.message}`)
    }

    // 全部有效候选均失败：根据失败类型聚合返回，且在线库未被任何损坏内容覆盖（H1 不变）。
    const aggregated = failedReasons.join('; ')
    const finalReason: 'backup-unavailable' | 'restore-failed' = sawRestoreFailed
      ? 'restore-failed'
      : 'backup-unavailable'
    logger.error(t('main.backup.log.restoreToFailed', { reason: aggregated }))
    void logger.fault('databaseRestore', new Error('all-candidates-restore-failed'), {
      stage: 'restore-all-candidates-failed',
      dbPath: targetPath,
      candidateCount: candidates.length,
      finalReason
    })
    return {
      success: false,
      reason: finalReason,
      message: t('main.backup.error.restoreFailedPlain', { reason: aggregated })
    }
  }

  /**
   * 原子 rename 覆盖目标库；句柄可能仍被 OS 短暂持有（即便 worker 已确认释放 DB 句柄），
   * 故对 EPERM/EBUSY 做有限重试兜底，避免时序抖动导致的恢复误报失败。
   *
   * 前置条件（调用方须保证）：rename 覆盖 targetPath（即在线库 dbPath）前，所有持有该文件句柄的
   * utilityProcess worker（scanner / database / media）均已 stopWorkerForRestore 并释放句柄，
   * 且主进程 db 连接已 close。否则 Windows 上"目标文件被其他进程打开"会导致 EPERM 共享冲突，
   * 有限重试仍可能失败。该前置条件由 DatabaseManager.attemptRecovery 在调用本函数前 await 三 worker
   * stopWorkerForRestore（并已 await 到 *_DISPOSED 确认）来保证。
   */
  private async renameWithRetry(tmpPath: string, targetPath: string): Promise<void> {
    const retries = 3
    const delayMs = 100
    let lastErr: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await fsp.rename(tmpPath, targetPath)
        return
      } catch (err) {
        lastErr = err
        const code = (err as { code?: unknown } | null)?.code
        const shareViolation =
          code === 'EPERM' ||
          code === 'EBUSY' ||
          /EPERM|EBUSY|share|in use|占用|being used/i.test(
            err instanceof Error ? err.message : String(err)
          )
        // 非共享冲突，或已耗尽重试次数：不再重试，上报原错误由调用方给出提示
        if (!shareViolation || attempt === retries) break
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
    throw lastErr
  }

  /**
   * 将外部传入的 filename 组合到备份目录并校验其解析后是否仍位于备份目录内，
   * 防止路径穿越（如 "../../something.db"）访问/读取/覆盖任意文件。
   * @param filename 外部传入的备份文件名
   * @returns 校验通过返回解析后的绝对路径；越界则携带错误信息拒绝
   */
  private resolveSafeBackupPath(
    filename: string
  ): { ok: true; path: string } | { ok: false; message: string } {
    const resolved = path.resolve(this.backupDir, filename)
    if (!isPathUnderDir(resolved, this.backupDir)) {
      const message = t('main.backup.error.pathTraversalDenied', { filename })
      logger.warn(`[backup] 拒绝越界备份路径: ${filename} -> ${resolved}`)
      return { ok: false, message }
    }
    return { ok: true, path: resolved }
  }

  // 从备份恢复数据库（恢复后自动重启应用）
  // P0-A2：改为「先复制到临时文件 → 原子 rename 覆盖」三步式，避免中途失败导致数据损坏
  // P0-A3：恢复前用 better-sqlite3 只读打开备份文件执行 PRAGMA integrity_check 校验完整性
  // P1-A6：恢复成功后立即 app.relaunch() + app.exit()，避免 dbManager 处于关闭状态时 IPC 调用全部失败
  async restoreBackup(filename: string): Promise<{ success: boolean; message?: string }> {
    if (!this.dbManager) {
      return { success: false, message: t('main.error.databaseNotInit') }
    }

    const safe = this.resolveSafeBackupPath(filename)
    if (!safe.ok) {
      return { success: false, message: safe.message }
    }
    const backupPath = safe.path
    if (!fs.existsSync(backupPath)) {
      return { success: false, message: t('main.backup.error.backupNotExist', { filename }) }
    }

    // FIX(组18-1): 记录失败点是否已过 dbManager.close()——close 之后任一步失败
    // （WAL/SHM unlink 权限错误、rename 被占用、磁盘满等）时应用停留在数据库已
    // 关闭状态，依赖 DB 的 IPC 全部失败直到用户手动重启，与行 317 注释声明的
    // P1-A6 意图（"避免 dbManager 处于关闭状态时 IPC 调用全部失败"）相悖——
    // 该保障原先只在成功路径生效
    let dbClosed = false
    try {
      // 获取当前数据库路径
      const dbPath = path.join(app.getPath('userData'), 'database', 'meow_star_map.db')

      // P0-A3：恢复前校验备份文件完整性
      // 用 better-sqlite3 以只读模式临时打开备份文件，执行 PRAGMA integrity_check
      // 若备份文件损坏（磁盘错误、不完整写入等），提前给出明确提示，避免恢复后应用无法启动
      const integrityCheck = await this.verifyBackupIntegrity(backupPath)
      if (!integrityCheck.valid) {
        return {
          success: false,
          message: t('main.backup.error.backupCorrupted', { reason: integrityCheck.reason })
        }
      }

      // 关闭当前数据库连接
      this.dbManager.close()
      dbClosed = true

      // P0-A2：原子化恢复——先复制到临时文件，再 rename 覆盖
      // 同盘 rename 是原子操作，即使中途失败也不会影响原数据库
      const tmpPath = `${dbPath}.restoring`
      try {
        fs.copyFileSync(backupPath, tmpPath)
        // 删除旧的 WAL 和 SHM 文件，避免旧的 WAL 日志干扰
        const walPath = `${dbPath}-wal`
        const shmPath = `${dbPath}-shm`
        if (fs.existsSync(walPath)) fs.unlinkSync(walPath)
        if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath)
        // 原子 rename 覆盖目标数据库
        fs.renameSync(tmpPath, dbPath)
      } catch (restoreErr) {
        // 恢复失败时清理临时文件，原数据库不受影响
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
        } catch {
          /* 忽略清理失败 */
        }
        throw restoreErr
      }

      // R9：rename 成功后写入后置修复标志。失败不阻塞恢复（rename 已完成，relaunch 后下次启动消费标志）
      await this.markRestoredFlags(dbPath)

      logger.info(t('main.backup.log.restoreSuccessRelaunching', { filename }))
      // P1-A6：恢复成功后立即重启应用，避免 dbManager 处于关闭状态时 IPC 调用全部失败
      // app.relaunch 会启动新实例，app.exit 触发 before-quit 清理流程（释放单实例锁）
      try {
        app.relaunch()
        app.exit(0)
      } catch (relaunchErr) {
        logger.error(t('main.backup.log.relaunchFailed'), relaunchErr)
        return { success: true, message: t('main.backup.message.restoredButRelaunchFailed') }
      }
      // 理论上 app.exit(0) 后不会执行到这里，保留兜底返回
      return { success: true, message: t('main.backup.message.restoredRelaunching') }
    } catch (error) {
      logger.error(t('main.backup.log.restoreFailed'), error)
      // FIX(组18-1): 失败点在 dbManager.close() 之后——应用已处于无数据库状态，
      // 同样 relaunch 重启回到可用状态（P0-A2 原子性保证 rename 失败时原库未受影响，
      // 重启后正常打开原库），不再让用户停留在一个所有 DB IPC 都失败的应用里
      if (dbClosed) {
        try {
          app.relaunch()
          app.exit(1)
        } catch (relaunchErr) {
          logger.error(t('main.backup.log.relaunchAfterFailureFailed'), relaunchErr)
        }
        return {
          success: false,
          message: t('main.backup.error.restoreFailedRelaunch', {
            reason: error instanceof Error ? error.message : String(error)
          })
        }
      }
      return { success: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * P0-A3：校验备份文件完整性
   * 用 better-sqlite3 以只读模式临时打开备份文件，执行 PRAGMA integrity_check
   * 返回 { valid: true } 或 { valid: false, reason: string }
   */
  /**
   * P0-A3：校验备份文件完整性
   * 用 better-sqlite3 以只读模式临时打开备份文件，执行 PRAGMA 完整性校验。
   * - mode='full'（默认）：PRAGMA integrity_check，全量深度校验（getLatestValidBackup / restoreBackup 使用）
   * - mode='quick'：PRAGMA quick_check，毫秒级轻量校验，用于恢复点二次确认（不放大启动自愈 IO）
   * 返回 { valid: true } 或 { valid: false, reason: string }
   */
  private async verifyBackupIntegrity(
    backupPath: string,
    mode: 'quick' | 'full' = 'full'
  ): Promise<{ valid: boolean; reason?: string }> {
    let probe: DatabaseType.Database | null = null
    try {
      // 以只读模式打开，避免修改备份文件
      const Database = await getDatabaseImpl()
      probe = new Database(backupPath, { readonly: true, fileMustExist: true })
      const pragmaName = mode === 'quick' ? 'quick_check' : 'integrity_check'
      const result = probe.pragma(pragmaName, { simple: true })
      // 两种校验均返回 'ok' 字符串表示通过，返回数组表示有错误
      if (result === 'ok') {
        return { valid: true }
      }
      const reason = Array.isArray(result) ? result.join('; ') : String(result)
      logger.error(`[Backup] 备份文件完整性校验失败(${mode}): ${backupPath} - ${reason}`)
      return { valid: false, reason }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logger.error(`[Backup] 备份文件无法打开或已损坏(${mode}): ${backupPath} - ${reason}`)
      return { valid: false, reason }
    } finally {
      // 确保关闭临时连接，避免文件句柄泄漏
      if (probe) {
        try {
          probe.close()
        } catch {
          /* 忽略关闭失败 */
        }
      }
    }
  }

  /**
   * R9：恢复后在目标 DB 写入"后置修复标志"，下次启动由 runPostRestoreRepair 消费。
   *
   * 写入 4 个 app_settings key（单事务原子提交）：
   * - need_phash_recheck = 1：触发 phash 重算（R7 的 mtime 检测会自动识别 stale 记录）
   * - need_duplicate_recheck = 1：触发 markDuplicates 重新标记重复文件
   * - restored_at = ISO 时间戳：供 UI 显示"已从备份恢复"
   * - media_count_stale = 1：复用 R5 失效机制，强制下次 listMedia 走真实 COUNT
   *
   * 设计要点：
   * - 调用时机：dbManager 已关闭、目标 DB 文件已 atomic rename 完成后
   * - 用临时 better-sqlite3 连接读写，写完即关，不持有句柄
   * - 失败仅 logger.warn，不抛错——rename 已完成，应用下次启动仍可正常使用，
   *   只是后置修复不会触发（用户可手动触发扫描/重复检测兜底）
   * - app_settings 表在所有版本 DB 中均存在，无需 safeAddColumn
   */
  private async markRestoredFlags(dbPath: string): Promise<void> {
    let probe: DatabaseType.Database | null = null
    try {
      const Database = await getDatabaseImpl()
      probe = new Database(dbPath, { fileMustExist: true })
      const insertStmt = probe.prepare(
        'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)'
      )
      const now = new Date().toISOString()
      // 单事务原子提交，避免部分写入
      probe.transaction(() => {
        insertStmt.run('need_phash_recheck', JSON.stringify(1))
        insertStmt.run('need_duplicate_recheck', JSON.stringify(1))
        insertStmt.run('restored_at', JSON.stringify(now))
        insertStmt.run('media_count_stale', JSON.stringify(1))
      })()
      logger.info(t('main.backup.log.repairFlagWritten', { path: dbPath }))
    } catch (err) {
      // 失败不阻塞恢复流程，仅记录日志
      logger.warn(t('main.backup.log.repairFlagWriteFailed'), err)
    } finally {
      if (probe) {
        try {
          probe.close()
        } catch {
          /* 忽略关闭失败 */
        }
      }
    }
  }

  // 删除指定备份
  // P1-A10：改为 fsp 异步 API
  async deleteBackup(filename: string): Promise<{ success: boolean; message?: string }> {
    const safe = this.resolveSafeBackupPath(filename)
    if (!safe.ok) {
      return { success: false, message: safe.message }
    }
    const backupPath = safe.path
    try {
      await fsp.access(backupPath)
    } catch {
      return { success: false, message: t('main.backup.error.backupNotExist', { filename }) }
    }
    try {
      await fsp.unlink(backupPath)
      logger.info(t('main.backup.log.deleted', { filename }))
      return { success: true }
    } catch (error) {
      logger.error(t('main.backup.log.deleteFailed'), error)
      return { success: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  // 清理超出上限的旧备份
  // P1-A10：改为 fsp 异步 API
  private async pruneOldBackups(): Promise<void> {
    const records = await this.listBackups()
    if (records.length <= MAX_BACKUPS) return

    const toDelete = records.slice(MAX_BACKUPS)
    for (const record of toDelete) {
      try {
        await fsp.unlink(record.filePath)
        logger.info(t('main.backup.log.prunedOld', { filename: record.filename }))
      } catch {
        // 跳过删除失败的文件
      }
    }
  }

  getBackupDirectory(): string {
    return this.backupDir
  }

  private formatTimestamp(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  }

  private formatSize(bytes: number): string {
    if (bytes === 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`
  }
}

export const backupService = new BackupService()
