// 步骤4：原生模块改为惰性加载，确保 ABI 不匹配时崩溃能被 bootstrapApplication 的 try/catch 捕获
// 而非在模块加载期静默崩溃导致白屏
import type DatabaseType from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'
import fs from 'fs'
import { detectSceneCategory } from '../../shared/scene-category'
import { logger } from '../utils/logger'
import { backupService } from '../services/backup-service'
import { diagLog } from '../utils/startup-diagnostic'
import type { DatabaseWorkerBridge } from './worker/database-worker-bridge'
import type { DbRunResult } from './worker/worker-protocol'
import { t } from '../i18n'

// 惰性加载 better-sqlite3：首次调用时才动态 import，使原生模块加载时机
// 从"模块加载期"推迟到"bootstrapApplication 的 try/catch 内"
// 使用 import() 而非 require()：import() 是 ESM 原生 API，被 Vitest vi.mock 正确拦截
let DatabaseImpl: typeof import('better-sqlite3') | null = null
async function getDatabaseImpl(): Promise<typeof import('better-sqlite3')> {
  if (!DatabaseImpl) {
    const mod = await import('better-sqlite3')
    // 真实 better-sqlite3 是 CJS 模块，import() 返回 { default: Constructor }
    // Vitest mock 也返回 { default: MockConstructor }
    DatabaseImpl = (mod.default ?? mod) as typeof import('better-sqlite3')
  }
  return DatabaseImpl
}

/** 数据库恢复事件回调（由 Application 注入，用于弹窗提示用户） */
export type DatabaseRecoveryListener = (info: {
  success: boolean
  reason: string
  sourceBackup?: { filePath: string; filename: string }
  corruptedBackupPath?: string
}) => void

/** FIX(组7-1): 判定 better-sqlite3 打开失败是否为锁类错误（暂时性，不可删除 WAL/SHM） */
function isSqliteLockError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  const text = `${typeof code === 'string' ? code : ''} ${err instanceof Error ? err.message : String(err)}`
  return /SQLITE_(BUSY|LOCKED)/i.test(text)
}

export class DatabaseManager {
  private db: DatabaseType.Database | null = null
  private dbPath: string
  // 步骤4：缓存惰性加载的 Database 构造函数，避免每次 new Database() 都 await
  private databaseCtor: typeof import('better-sqlite3') | null = null
  /**
   * 写 worker 桥接（可选）。
   * - 启动后由 Application 注入：dbManager.initialize() 完成后调用 setWorkerBridge()
   * - 注入后 MediaRepository 写操作可通过 getWorkerBridge() 走 worker 进程
   * - 未注入时（如测试场景），MediaRepository 降级为同步直写主进程 db
   */
  private workerBridge: DatabaseWorkerBridge | null = null
  /** 数据库恢复事件监听器（由 Application 注入） */
  private recoveryListeners: DatabaseRecoveryListener[] = []
  /** 最近一次恢复记录（供 Application 在 initialize 后查询并弹窗） */
  private lastRecovery: {
    success: boolean
    reason: string
    sourceBackup?: { filePath: string; filename: string }
    corruptedBackupPath?: string
    timestamp: string
  } | null = null
  // 启动性能优化：本次 initialize 是否已同步执行过全量 integrity_check
  // （quick_check 失败场景同步处理；避免 lifecycle 阶段 8 重复入队后台复核）
  private fullIntegrityCheckedAtStartup = false

  constructor() {
    const userDataPath = app.getPath('userData')
    const dbDir = path.join(userDataPath, 'database')
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }
    this.dbPath = path.join(dbDir, 'wxnn_photo_manager.db')
  }

  /**
   * 注入写 worker 桥接。
   * 必须在 initialize() 完成后调用（worker 需要打开已迁移完成的 db 文件）。
   */
  setWorkerBridge(bridge: DatabaseWorkerBridge | null): void {
    this.workerBridge = bridge
  }

  /** 获取已注入的 worker 桥接（MediaRepository 写操作使用） */
  getWorkerBridge(): DatabaseWorkerBridge | null {
    return this.workerBridge
  }

  /** 获取数据库文件路径（worker 桥接 ensureWorker 时需要） */
  getDbPath(): string {
    return this.dbPath
  }

  /**
   * 通过 worker 进程执行单条写操作（async）。
   * - 用于运行时高频写操作，避免 better-sqlite3 同步 I/O 阻塞主进程事件循环
   * - 未注入 workerBridge 时降级为同步 execute（测试场景）
   * - 返回 DbRunResult（与 Database.RunResult 结构一致，但 lastInsertRowid 已转 number）
   */
  async executeAsync(sql: string, params?: unknown[]): Promise<DbRunResult> {
    if (!this.workerBridge) {
      // 降级：未注入 bridge 时走同步 execute（测试 / 未启用 worker 场景）
      const result = this.execute(sql, params)
      return {
        changes: result.changes,
        lastInsertRowid:
          typeof result.lastInsertRowid === 'bigint'
            ? Number(result.lastInsertRowid)
            : result.lastInsertRowid
      }
    }
    return this.workerBridge.execute(this.dbPath, sql, params)
  }

  async initialize(): Promise<void> {
    // 步骤4：惰性加载 better-sqlite3 原生模块
    // 加载发生在 bootstrapApplication 的 try/catch 内，ABI 不匹配时错误会被捕获而非静默崩溃
    diagLog('DB', 'initialize() start')
    if (!this.databaseCtor) {
      diagLog('DB', 'before getDatabaseImpl()')
      this.databaseCtor = await getDatabaseImpl()
      diagLog('DB', 'after getDatabaseImpl(): OK')
    }
    const Database = this.databaseCtor
    diagLog('DB', 'Database ctor obtained, opening db at: ' + this.dbPath)

    // 启动性能优化：打开前判断是否全新库
    // better-sqlite3 打开不存在的文件会创建空库，打开后再判断恒为 true，必须在 new Database() 之前记录
    const isFreshDb = !fs.existsSync(this.dbPath)

    // 修复：数据库打开可能因文件锁/损坏失败，提供更清晰的错误信息
    try {
      this.db = new Database(this.dbPath)
    } catch (err) {
      // FIX(组7-1): 区分打开失败类型。锁类错误（SQLITE_BUSY/SQLITE_LOCKED，外部 SQLite
      // 工具/备份软件占用文件）是暂时性的，删除 -wal/-shm 会把 WAL 中尚未 checkpoint 的
      // 已提交事务直接丢弃（健康数据库也丢最近写入）——此类错误不清理 WAL、不进恢复
      // 流程，等待后重试一次；仍失败则抛出明确的占用指引。仅疑似损坏类错误才走
      // 原有"清理 WAL/SHM 重试 → 备份恢复"路径。
      if (isSqliteLockError(err)) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        try {
          this.db = new Database(this.dbPath)
          logger.warn('[DB] 数据库被外部进程短暂锁定，等待后重试打开成功') // TODO: i18n: internal log
        } catch (retryErr) {
          throw new Error(
            `数据库文件被其他程序锁定（请关闭正在占用该文件的 SQLite 工具/备份软件后重启应用）: ${
              err instanceof Error ? err.message : String(err)
            }\n` + `重试错误：${retryErr instanceof Error ? retryErr.message : String(retryErr)}` // TODO: i18n: internal error
          )
        }
      } else {
        // 检查是否 WAL/SHM 文件损坏（删除后重试一次）
        const walPath = this.dbPath + '-wal'
        const shmPath = this.dbPath + '-shm'
        try {
          if (fs.existsSync(walPath)) fs.unlinkSync(walPath)
          if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath)
          this.db = new Database(this.dbPath)
        } catch (retryErr) {
          // 仍失败：尝试从备份恢复（数据库文件可能已损坏到无法打开）
          logger.error('[DB] 数据库打开失败，尝试从备份恢复:', err) // TODO: i18n: internal log
          const recovered = await this.attemptRecovery(
            t('main.db.recovery.openFailed', {
              error: err instanceof Error ? err.message : String(err)
            })
          )
          if (!recovered) {
            // 恢复失败：抛出原始错误 + 重试错误，方便诊断
            throw new Error(
              `数据库打开失败（已尝试清理 WAL/SHM 与从备份恢复）：${
                err instanceof Error ? err.message : String(err)
              }\n` + `重试错误：${retryErr instanceof Error ? retryErr.message : String(retryErr)}` // TODO: i18n: internal error
            )
          }
          // 恢复成功后 this.db 已由 attemptRecovery 重新打开
        }
      }
    }

    // 完整性校验分级（启动性能优化）：检测数据库逻辑/物理损坏，损坏时自动从备份恢复
    // 时机：在 PRAGMA 设置前执行，避免在损坏的库上设置 WAL 等模式导致二次问题
    // 分级策略（docs/plans/startup-perf.md）：
    //   1. quick_check 快速路径（毫秒级）永远同步执行——兜底安全网，即使标志逻辑漏判也能抓住绝大多数损坏
    //   2. quick_check 失败 → 全量 integrity_check 同步执行 + attemptRecovery（保持「启动即发现损坏」）
    //   3. quick_check 通过 + 非全新库 + 上次非干净退出（clean-exit 标志缺失）→ 跳过同步，
    //      由 lifecycle 将全量自检入低优先级队列后台复核（双保险，不阻塞启动）
    //   4. quick_check 通过 + 干净退出 → 完全跳过全量（最常见的启动路径，毫秒级）
    const quickCheckOk = this.runQuickCheck()
    if (!quickCheckOk) {
      // quick_check 失败：全量自检同步执行（不 defer），恢复弹窗时序与现状一致
      this.fullIntegrityCheckedAtStartup = true
      const integrityResult = this.runFullIntegrityCheck()
      if (!integrityResult.ok) {
        logger.error(`[DB] 完整性校验失败: ${integrityResult.reason}`) // TODO: i18n: internal log
        const recovered = await this.attemptRecovery(
          t('main.db.recovery.integrityCheckFailed', { reason: integrityResult.reason ?? '' })
        )
        if (!recovered) {
          // 恢复失败：保留 db 句柄让上层继续（迁移等流程会暴露具体错误）
          // 不直接抛错，避免阻塞应用启动——用户可通过诊断包反馈
          logger.error('[DB] 自动恢复失败，应用将以可能损坏的数据库继续启动') // TODO: i18n: internal log
        }
      }
    } else if (isFreshDb) {
      // 全新库（首次启动）：刚创建必然干净，直接补写标志，避免触发一次无意义的后台全量
      this.writeCleanExitMarker()
      this.fullIntegrityCheckedAtStartup = true
    }
    // 其余情况（非全新库 + quick_check 通过）：不写标志，
    // 若上次非干净退出（标志缺失），shouldRunFullIntegrityCheck() 返回 true → lifecycle 后台全量复核

    // this.db 经上方 new Database 赋值或 attemptRecovery 重建，理论上必非空
    // 若恢复流程未成功会已 throw；此处再判一次兜底（防御性）
    const db = this.db
    if (!db) {
      throw new Error('数据库初始化失败：db 句柄为 null') // TODO: i18n: internal error
    }

    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    // PRAGMA 性能优化（修复 A-G5：原实现缺少性能相关 PRAGMA）
    // synchronous=NORMAL：WAL 模式下安全且性能更好（默认 FULL 每次提交都 fsync）
    // cache_size=-20000：20MB 内存缓存（负值表示 KB）
    // temp_store=MEMORY：临时表与排序使用内存
    // mmap_size=268435456：256MB 内存映射 I/O，加速读取
    db.pragma('synchronous = NORMAL')
    db.pragma('cache_size = -20000')
    db.pragma('temp_store = MEMORY')
    db.pragma('mmap_size = 268435456')
    // 显式设置 WAL 自动 checkpoint（1000 页 ≈ 4MB），避免 WAL 文件无限膨胀
    // 修复：原实现未设置，进程异常退出时 WAL 残留可能影响下次启动
    try {
      db.pragma('wal_autocheckpoint = 1000')
    } catch {}
    db.pragma('busy_timeout = 5000')
    await this.runMigrations()

    // 数据库性能优化（2026-07-18）：启用增量自动清理 + 查询计划统计维护
    // auto_vacuum = INCREMENTAL：删除数据时增量回收空闲页，避免文件无限膨胀
    // 注意：auto_vacuum 只能在数据库创建时设置；旧库（mode=0）标记为 INCREMENTAL 后，
    //       需未来某次手动 VACUUM 才能真正切换模式。此处不主动 VACUUM，避免阻塞启动
    try {
      const autoVacuumMode = db.pragma('auto_vacuum', { simple: true })
      if (autoVacuumMode === 0) {
        db.pragma('auto_vacuum = INCREMENTAL')
      }
    } catch (err) {
      logger.warn('[DB] auto_vacuum 设置失败（已忽略）:', err) // TODO: i18n: internal log
    }

    // PRAGMA optimize：让 SQLite 自动分析索引使用统计，优化查询计划器
    // 官方推荐的轻量维护操作，毫秒级完成，不阻塞业务
    try {
      db.pragma('optimize')
    } catch (err) {
      logger.warn('[DB] PRAGMA optimize 失败（已忽略）:', err) // TODO: i18n: internal log
    }
  }

  /**
   * 执行 PRAGMA integrity_check 全量完整性校验（同步，大库上可达数百毫秒到数秒）。
   * 返回 { ok: true } 或 { ok: false, reason }。
   * 校验失败时记录 databaseCorruption 故障日志（含堆栈上下文）。
   *
   * 调用方：
   * - initialize() 内：仅当 quick_check 失败时同步调用（启动即发现损坏）
   * - lifecycle 阶段 8：上次非干净退出时通过低优先级队列后台调用（复核）
   */
  runFullIntegrityCheck(): { ok: boolean; reason?: string } {
    if (!this.db) return { ok: false, reason: t('main.db.recovery.dbHandleNull') }
    try {
      const result = this.db.pragma('integrity_check', { simple: true })
      if (result === 'ok') return { ok: true }
      const reason = Array.isArray(result) ? result.join('; ') : String(result)
      void logger.fault('databaseCorruption', new Error(`integrity_check 失败: ${reason}`), {
        // TODO: i18n: internal log
        dbPath: this.dbPath
      })
      return { ok: false, reason }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      void logger.fault('databaseCorruption', err, { dbPath: this.dbPath })
      return { ok: false, reason }
    }
  }

  /**
   * 执行 PRAGMA quick_check 快速完整性校验（同步，毫秒级）。
   * 跳过部分深层校验（如部分索引页一致性），但速度远快于 integrity_check，
   * 作为启动快速路径的兜底安全网——即使干净退出标志逻辑漏判，仍能抓住绝大多数损坏。
   * @returns true=通过；false=未通过或校验异常
   */
  private runQuickCheck(): boolean {
    if (!this.db) return false
    try {
      return this.db.pragma('quick_check', { simple: true }) === 'ok'
    } catch {
      return false
    }
  }

  /**
   * 干净退出标志文件路径（侧车文件，{dbPath}.clean-exit）。
   * 选型见 docs/plans/startup-perf.md §1.2：损坏探测信号必须在 DB 不可读时仍可用，
   * 故不用 app_settings 表，独立于数据库文件。
   */
  private getCleanExitMarkerPath(): string {
    return `${this.dbPath}.clean-exit`
  }

  /** 写入「干净退出」标志（崩溃/强杀/断电走不到此；写入失败静默忽略，由 quick_check 兜底） */
  private writeCleanExitMarker(): void {
    try {
      fs.writeFileSync(this.getCleanExitMarkerPath(), new Date().toISOString(), 'utf8')
    } catch (err) {
      logger.warn('[DB] 写入干净退出标志失败（已忽略）:', err) // TODO: i18n: internal log
    }
  }

  /** 读取「干净退出」标志是否存在（读取异常视为不存在，静默） */
  private hasCleanExitMarker(): boolean {
    try {
      return fs.existsSync(this.getCleanExitMarkerPath())
    } catch {
      return false
    }
  }

  /**
   * 标记本次退出为干净退出（供 performCleanup 在 db.close() 成功后调用）。
   * 崩溃/强杀/超时强制退出（force-exit-timeout 的 app.exit(1)）都走不到此 →
   * 标志缺失 = 上次非干净退出 → 下次启动触发后台全量 integrity_check 复核。
   */
  markCleanExit(): void {
    this.writeCleanExitMarker()
  }

  /**
   * 是否需要在启动后执行后台全量完整性自检（lifecycle 阶段 8 判定用）。
   * - 上次非干净退出（clean-exit 标志缺失）→ true（由 lifecycle 入低优先级队列复核）
   * - 本次 initialize 已同步执行过全量（quick_check 失败场景）→ false（避免重复）
   * - 上次干净退出 → false（最常见的启动路径）
   */
  shouldRunFullIntegrityCheck(): boolean {
    return !this.hasCleanExitMarker() && !this.fullIntegrityCheckedAtStartup
  }

  /**
   * 自动恢复流程：备份损坏文件 → 从最近有效备份恢复 → 重新打开 db。
   * @param reason 恢复触发原因（用于日志与事件通知）
   * @returns true=恢复成功并已重新打开 db；false=恢复失败（无可用备份或恢复异常）
   */
  private async attemptRecovery(reason: string): Promise<boolean> {
    // 1. 关闭当前 db 句柄（即使已损坏也需关闭，避免文件锁阻塞 rename）
    try {
      this.db?.close()
    } catch (err) {
      logger.warn('[DB] 关闭损坏 db 时出错（已忽略）:', err) // TODO: i18n: internal log
    }
    this.db = null

    // 2. 兜底初始化 backupService 的 backupDir
    // 时序：DatabaseManager.initialize() 在 backupService.init() 之前调用，
    // 此时 backupService.backupDir 可能尚未设置。手动调用 ensureDefaultDir 兜底。
    backupService.ensureDefaultDir()

    // 3. 备份损坏的 db 文件（避免数据丢失，便于事后诊断）
    const corruptedBackupPath = this.backupCorruptedDb()

    // 4. 从最近有效备份恢复
    const restoreResult = await backupService.restoreLatestBackupTo(this.dbPath)
    if (!restoreResult.success) {
      // 恢复失败：记录事件 + 通知监听器
      const failureInfo = {
        success: false,
        reason: restoreResult.message,
        corruptedBackupPath,
        timestamp: new Date().toISOString()
      }
      this.lastRecovery = failureInfo
      void logger.fault('databaseRestore', new Error(restoreResult.message), {
        dbPath: this.dbPath,
        corruptedBackupPath,
        stage: 'restore-failed'
      })
      this.notifyRecovery(failureInfo)

      // 恢复失败时尝试重新打开原 db（让应用至少能启动，由上层迁移流程暴露错误）
      // FIX(组7-2): backupCorruptedDb 已把原库改名挪走，直接 new Database(dbPath) 会在
      // 原路径新建一个全新空库——用户图库被静默清空（原数据仅在 .corrupt-<ts> 副本里，
      // 无任何 UI 路径引导找回）。改为优先把挪走的原库还原回原路径再打开（回到恢复前
      // 状态）；还原或打开失败则不新建空库，由 initialize 的 db 句柄校验抛错——
      // 启动失败可诊断优于静默清空。副本路径已随上方 failureInfo 通知监听器。
      try {
        if (corruptedBackupPath && fs.existsSync(corruptedBackupPath)) {
          try {
            if (fs.existsSync(this.dbPath)) fs.unlinkSync(this.dbPath)
          } catch {}
          fs.renameSync(corruptedBackupPath, this.dbPath)
          logger.warn('[DB] 备份恢复失败，已还原原数据库文件（可能仍损坏）:', this.dbPath) // TODO: i18n: internal log
        }
        this.db = new (this.databaseCtor ?? (await getDatabaseImpl()))(this.dbPath)
      } catch (reopenErr) {
        logger.error('[DB] 恢复失败后重新打开 db 也失败:', reopenErr) // TODO: i18n: internal log
      }
      return false
    }

    // 5. 重新打开 db
    try {
      this.db = new (this.databaseCtor ?? (await getDatabaseImpl()))(this.dbPath)
    } catch (reopenErr) {
      logger.error('[DB] 恢复后重新打开 db 失败:', reopenErr) // TODO: i18n: internal log
      const failureInfo = {
        success: false,
        reason: t('main.db.recovery.reopenFailed', {
          error: reopenErr instanceof Error ? reopenErr.message : String(reopenErr)
        }),
        sourceBackup: restoreResult.sourceBackup,
        corruptedBackupPath,
        timestamp: new Date().toISOString()
      }
      this.lastRecovery = failureInfo
      void logger.fault('databaseRestore', reopenErr, {
        dbPath: this.dbPath,
        corruptedBackupPath,
        stage: 'reopen-failed'
      })
      this.notifyRecovery(failureInfo)
      return false
    }

    // 6. 恢复成功：记录事件 + 通知监听器
    const successInfo = {
      success: true,
      reason: restoreResult.message,
      sourceBackup: restoreResult.sourceBackup,
      corruptedBackupPath,
      timestamp: new Date().toISOString()
    }
    this.lastRecovery = successInfo
    void logger.fault('databaseRestore', new Error(`数据库已自动恢复：${restoreResult.message}`), {
      // TODO: i18n: internal log
      dbPath: this.dbPath,
      corruptedBackupPath,
      sourceBackup: restoreResult.sourceBackup,
      stage: 'success'
    })
    this.notifyRecovery(successInfo)
    return true
  }

  /**
   * 备份损坏的 db 文件到 .corrupt-<timestamp> 后缀文件，避免数据丢失。
   * 同时清理 WAL/SHM 残留文件。
   * @returns 损坏文件备份路径（备份失败时返回 undefined）
   */
  private backupCorruptedDb(): string | undefined {
    if (!fs.existsSync(this.dbPath)) return undefined
    const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 14)
    const corruptPath = `${this.dbPath}.corrupt-${ts}`
    try {
      fs.renameSync(this.dbPath, corruptPath)
      logger.warn(`[DB] 损坏数据库已重命名: ${corruptPath}`) // TODO: i18n: internal log
    } catch (renameErr) {
      // rename 失败时尝试 copy（可能跨盘）
      try {
        fs.copyFileSync(this.dbPath, corruptPath)
        fs.unlinkSync(this.dbPath)
        logger.warn(`[DB] 损坏数据库已复制并删除原文件: ${corruptPath}`) // TODO: i18n: internal log
      } catch (copyErr) {
        logger.error('[DB] 备份损坏数据库失败:', copyErr) // TODO: i18n: internal log
        return undefined
      }
    }
    // 清理 WAL/SHM（避免新打开的 db 读取旧 WAL 导致二次损坏）
    try {
      if (fs.existsSync(this.dbPath + '-wal')) fs.unlinkSync(this.dbPath + '-wal')
      if (fs.existsSync(this.dbPath + '-shm')) fs.unlinkSync(this.dbPath + '-shm')
    } catch {
      /* 忽略 */
    }
    return corruptPath
  }

  /** 注册数据库恢复事件监听器（Application 注入，用于弹窗提示） */
  addRecoveryListener(listener: DatabaseRecoveryListener): () => void {
    this.recoveryListeners.push(listener)
    return () => {
      this.recoveryListeners = this.recoveryListeners.filter((l) => l !== listener)
    }
  }

  /** 通知所有恢复监听器 */
  private notifyRecovery(info: {
    success: boolean
    reason: string
    sourceBackup?: { filePath: string; filename: string }
    corruptedBackupPath?: string
  }): void {
    for (const listener of this.recoveryListeners) {
      try {
        listener(info)
      } catch (err) {
        logger.error('[DB] 恢复监听器执行失败:', err) // TODO: i18n: internal log
      }
    }
  }

  /**
   * 获取最近一次恢复记录（供 Application 在 initialize 完成后查询）。
   * 注意：监听器可能在 initialize 期间还未注册，Application 通过此方法补查。
   */
  getLastRecovery(): {
    success: boolean
    reason: string
    sourceBackup?: { filePath: string; filename: string }
    corruptedBackupPath?: string
    timestamp: string
  } | null {
    return this.lastRecovery
  }

  /**
   * 执行数据库迁移（原子）。
   *
   * 整个迁移体——建表、ALTER 加列、索引、数据回填、迁移版本标记——跑在同一个事务里。
   * 任一非幂等冲突错误都会让事务整体回滚，不会留下"列加了但索引没建"这类半迁移状态；
   * 半迁移会让 media-repository 的查询引用到不存在的列，表现为图库白屏。
   *
   * 备份只能在事务外做：SQLite 禁止事务内 VACUUM
   * （实测报错 "cannot VACUUM from within a transaction"）。
   */
  private async runMigrations(): Promise<void> {
    const db = this.db
    if (!db) throw new Error('Database not initialized') // TODO: i18n: internal error

    const backupPath = this.createPreMigrationBackup()

    try {
      db.transaction(() => this.applyMigrations())()
    } catch (err) {
      await this.handleMigrationFailure(err, backupPath)
      // 向上抛出中断启动：迁移没成功就让 bootstrapApplication 弹错误页，
      // 好过带着一个 schema 不完整的库继续跑
      throw new Error(
        `数据库迁移失败，已回滚到迁移前状态：${err instanceof Error ? err.message : String(err)}` // TODO: i18n: internal error
      )
    }
  }

  /** 已知的版本号迁移；任一未应用即视为"有待执行的迁移" */
  private static readonly KNOWN_MIGRATION_VERSIONS = [1, 2]

  /**
   * 迁移前备份（VACUUM INTO 生成独立 .db 文件）。
   *
   * 必须在事务外调用。仅在"确有待执行迁移 + 库里已有用户表"时才备份，
   * 避免每次启动都全量复制数据库。
   *
   * 备份文件带完整时间戳且从不复用已有文件：回滚必须回到"本次迁移前"的状态，
   * 复用当天的旧备份会把用户在那之后新增的数据一并抹掉。
   *
   * @returns 备份路径；未备份或备份失败时返回 null（此时仅依赖事务回滚兜底）
   */
  private createPreMigrationBackup(): string | null {
    const db = this.db
    if (!db) return null
    if (!this.hasPendingMigrations() || !this.hasUserTables()) return null

    try {
      const backupDir = path.join(app.getPath('userData'), 'database')
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true })
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const backupPath = path.join(backupDir, `pre-migration-${ts}.db`)
      db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
      logger.info(`[DB] 迁移前备份已生成: ${backupPath}`) // TODO: i18n: internal log
      return backupPath
    } catch (err) {
      // 备份失败不阻塞迁移：事务回滚本身已保证原子性，备份只是额外兜底
      logger.warn(
        '[DB] 迁移前备份失败（已忽略，仍由事务回滚保证原子性）:', // TODO: i18n: internal log
        err instanceof Error ? err.message : err
      )
      return null
    }
  }

  /** 是否存在尚未应用的版本号迁移（表/列缺失时保守地视为"有"） */
  private hasPendingMigrations(): boolean {
    if (!this.db) return false
    const versions = DatabaseManager.KNOWN_MIGRATION_VERSIONS
    try {
      const placeholders = versions.map(() => '?').join(', ')
      const row = this.db
        .prepare(
          `SELECT COUNT(DISTINCT version) AS applied FROM schema_migrations WHERE version IN (${placeholders})`
        )
        .get(...versions) as { applied: number } | undefined
      return (row?.applied ?? 0) < versions.length
    } catch {
      // schema_migrations 表或 version 列不存在：老库或新库，都当作有待执行迁移
      return true
    }
  }

  /** 库里是否已有业务表（全新库没有数据可备份） */
  private hasUserTables(): boolean {
    if (!this.db) return false
    try {
      const row = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_files'")
        .get()
      return !!row
    } catch {
      return false
    }
  }

  /**
   * 迁移期可安全忽略的错误：只有"幂等重跑撞上已存在对象"这一类。
   * 其余错误（no such column / 磁盘满 / 库锁 / I-O 错误）都必须让事务回滚。
   */
  private static isIgnorableMigrationError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return /duplicate column name/i.test(msg) || /already exists/i.test(msg)
  }

  /**
   * 迁移失败善后。
   *
   * 事务已自动回滚，schema 通常已经回到迁移前状态——这种情况**不做**文件级恢复：
   * 备份是本次启动前的快照，直接覆盖会丢掉用户在备份之后产生的数据，
   * 而事务回滚已经达到了同样的一致性效果。
   * 只有当库确实已经不可用（quick_check 不过）时，才回滚到 VACUUM 备份。
   */
  private async handleMigrationFailure(err: unknown, backupPath: string | null): Promise<void> {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[DB] 迁移失败，事务已回滚: ${message}`) // TODO: i18n: internal log
    void logger.fault('databaseCorruption', err, {
      dbPath: this.dbPath,
      stage: 'migration-failed',
      backupPath
    })

    if (this.isDatabaseUsable()) return

    if (!backupPath || !fs.existsSync(backupPath)) {
      logger.error('[DB] 迁移失败且数据库已不可用，但没有可用的迁移前备份') // TODO: i18n: internal log
      return
    }
    await this.restoreFromPreMigrationBackup(backupPath)
  }

  /** 轻量可用性探测：quick_check 比 integrity_check 快，足够判断"要不要回滚到备份" */
  private isDatabaseUsable(): boolean {
    if (!this.db) return false
    try {
      return this.db.pragma('quick_check', { simple: true }) === 'ok'
    } catch {
      return false
    }
  }

  /** 用迁移前备份覆盖当前库并重新打开连接（仅在库已不可用时调用） */
  private async restoreFromPreMigrationBackup(backupPath: string): Promise<void> {
    try {
      this.db?.close()
    } catch {
      // 句柄已损坏也要继续：关不掉就带着文件占用往下走，覆盖失败会在下面被捕获
    }
    this.db = null

    const filename = path.basename(backupPath)
    try {
      fs.copyFileSync(backupPath, this.dbPath)
      // 清理 WAL/SHM，避免新连接读到属于旧库的日志
      for (const suffix of ['-wal', '-shm']) {
        const stale = this.dbPath + suffix
        if (fs.existsSync(stale)) fs.unlinkSync(stale)
      }
      const Ctor = this.databaseCtor ?? (await getDatabaseImpl())
      this.db = new Ctor(this.dbPath)

      const info = {
        success: true,
        reason: `数据库迁移失败，已回滚到迁移前备份：${filename}`, // TODO: i18n: internal log
        sourceBackup: { filePath: backupPath, filename },
        timestamp: new Date().toISOString()
      }
      this.lastRecovery = info
      void logger.fault('databaseRestore', new Error(info.reason), {
        dbPath: this.dbPath,
        backupPath,
        stage: 'migration-rollback'
      })
      this.notifyRecovery(info)
    } catch (restoreErr) {
      const reason = `回滚到迁移前备份失败：${
        restoreErr instanceof Error ? restoreErr.message : String(restoreErr)
      }` // TODO: i18n: internal log
      const info = {
        success: false,
        reason,
        sourceBackup: { filePath: backupPath, filename },
        timestamp: new Date().toISOString()
      }
      this.lastRecovery = info
      logger.error(`[DB] ${reason}`) // TODO: i18n: internal log
      void logger.fault('databaseRestore', restoreErr, {
        dbPath: this.dbPath,
        backupPath,
        stage: 'migration-rollback-failed'
      })
      this.notifyRecovery(info)
    }
  }

  /**
   * 迁移体。由 runMigrations 包在事务里调用——
   * 必须保持同步（better-sqlite3 的 transaction 不接受返回 Promise 的函数）。
   */
  private applyMigrations(): void {
    if (!this.db) throw new Error('Database not initialized') // TODO: i18n: internal error

    // P0-A2：创建 schema_migrations 表，用于跟踪命名迁移（仅执行一次的迁移）
    // 幂等创建：旧库首次升级时自动创建，已有库无影响
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `)

    // R17：添加 version 列，支持版本号模式迁移（幂等可重跑）
    // 旧库无此列时 safeEnsureColumn 自动添加；已有此列时补 NULL 行回填
    this.safeEnsureColumn('schema_migrations', 'version INTEGER')

    // R17：回填旧命名迁移到版本号（一次性，幂等）
    // version 1 = index_optimization_v3, version 2 = scene_category_backfill_v1
    try {
      this.db.exec(
        "UPDATE schema_migrations SET version = 1 WHERE name = 'index_optimization_v3' AND version IS NULL"
      )
      this.db.exec(
        "UPDATE schema_migrations SET version = 2 WHERE name = 'scene_category_backfill_v1' AND version IS NULL"
      )
    } catch {
      // 回填失败不阻塞启动（version 列可能因 safeEnsureColumn 失败而缺失）
    }

    // 创建媒体文件主表（仅含 v2.0 初始列，新增列通过 ALTER TABLE 迁移添加）
    // 修复：旧版（v2.1）数据库已有 media_files 表但缺少 is_missing/missing_count/phash 等新列，
    // 若 CREATE TABLE 中包含新列 + 立即 CREATE INDEX 引用新列，因 IF NOT EXISTS 跳过建表，
    // 索引创建会因列不存在崩溃。正确顺序：先建表（仅初始列）→ ALTER 添加新列 → 创建索引
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS media_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL,
        file_type TEXT NOT NULL,
        file_ext TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        duration REAL,
        created_at TEXT NOT NULL,
        modified_at TEXT NOT NULL,
        source_path TEXT NOT NULL,
        thumbnail TEXT,
        tags TEXT DEFAULT '[]',
        category_id INTEGER,
        rating INTEGER DEFAULT 0,
        is_favorite INTEGER DEFAULT 0,
        notes TEXT DEFAULT '',
        indexed_at TEXT NOT NULL
      );
    `)

    // 创建分类表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        icon TEXT,
        color TEXT,
        sort_order INTEGER DEFAULT 0,
        parent_id INTEGER,
        is_system INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );
      -- 修复 A-S3：parent_id 列被分类树查询使用
      CREATE INDEX IF NOT EXISTS idx_categories_parent_id ON categories(parent_id);
    `)

    // 创建扫描记录表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scan_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_type TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT,
        files_found INTEGER DEFAULT 0,
        files_new INTEGER DEFAULT 0,
        status TEXT DEFAULT 'running'
      );
    `)

    // 创建设置表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    // 滤镜预设表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS filter_presets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        params TEXT NOT NULL,
        is_builtin INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `)

    // 水印模板表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watermark_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        config TEXT NOT NULL,
        is_builtin INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `)

    // 编辑历史表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS edit_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_id INTEGER NOT NULL,
        params TEXT NOT NULL,
        thumbnail TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
      );
      -- 修复 A-S3：media_id 列被编辑历史查询使用
      CREATE INDEX IF NOT EXISTS idx_edit_history_media_id ON edit_history(media_id);
    `)

    // F-S8：全局操作历史表（用于全局撤销 Ctrl+Z）
    // 建议改#9：持久化操作记录，支持跨重启撤销
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_type TEXT NOT NULL,
        media_id INTEGER,
        payload TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operation_history_created_at ON operation_history(created_at);
      CREATE INDEX IF NOT EXISTS idx_operation_history_media_id ON operation_history(media_id);
      -- P2-J：新增 operation_type 索引，支持按类型筛选撤销历史（避免全表扫描）
      CREATE INDEX IF NOT EXISTS idx_operation_history_type ON operation_history(operation_type);
    `)
    // 建议改#9：旧库迁移——添加 description 列
    // 复用 safeEnsureColumn：同样的"列已存在则忽略并回填"语义，不再手写一份
    this.safeEnsureColumn('operation_history', "description TEXT NOT NULL DEFAULT ''")
    // F-G8：启动时清理 30 天前的操作历史记录，防止 operation_history 表无限增长
    // 原因：撤销栈过深无实际价值（用户极少回退 30 天前的操作），但表膨胀会拖慢查询与备份
    try {
      this.db.exec(`DELETE FROM operation_history WHERE created_at < datetime('now', '-30 days');`)
    } catch (err) {
      // 这里刻意保持容忍：清理的是历史数据，不改 schema，
      // 失败不会造成半迁移（不影响任何列/索引的存在性），没必要为此拦住启动
      logger.warn('[DB] F-G8 清理 operation_history 失败（已忽略）:', err) // TODO: i18n: internal log
    }

    // R2：批量重命名 DB 失败补偿表
    // 场景：磁盘已 rename，DB 事务更新失败且反向回滚磁盘也失败时，记录待重试项；
    // 启动时 retryPendingRenames 重新尝试 UPDATE，让 DB 与磁盘最终一致。
    // retry_count 上限由启动重试逻辑判定，避免无限重试。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_renames (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        old_path TEXT NOT NULL,
        new_path TEXT NOT NULL,
        new_file_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_retry_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pending_renames_created ON pending_renames(created_at);
    `)

    // 导入根表：用户手动导入的目标目录登记表
    // 语义与 app_settings.customScanPaths 区分：
    //   - customScanPaths 是"额外扫描哪些目录"的用户配置（可随时增删，不代表已入库内容归属）
    //   - import_roots 是"哪些目录下的文件属于本应用管理范围"的事实登记，
    //     供图库放行（listMedia 的 galleryHighQualityOnly）与扫描索引共同引用
    // root_path 存原始路径（保留大小写与分隔符），比较时由调用方归一化
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS import_roots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `)

    // P0-B：删除 tags + media_tags 僵尸表
    // 原因：渲染进程零调用 tag:list/add/remove IPC，实际仅使用 media_files.tags JSON 字段
    // 双存储机制存在数据不一致风险，删除僵尸表统一为 JSON 字段单存储
    // 兼容性：保留 DROP TABLE IF EXISTS 以清理已存在的旧表
    this.db.exec(`
      DROP TABLE IF EXISTS media_tags;
      DROP TABLE IF EXISTS tags;
    `)

    // 插入默认系统分类
    // TODO: i18n: 默认分类名存入 DB，需重构为存储 i18n key 并在 UI 层 t() 解析
    const defaultCategories = [
      { name: '人物', icon: 'people', color: '#FF6B6B', sort_order: 1, is_system: 1 },
      { name: '地点', icon: 'location', color: '#4ECDC4', sort_order: 2, is_system: 1 },
      { name: '场景', icon: 'scene', color: '#45B7D1', sort_order: 3, is_system: 1 },
      { name: '截图', icon: 'screenshot', color: '#96CEB4', sort_order: 4, is_system: 1 },
      { name: '录屏', icon: 'recording', color: '#FFEAA7', sort_order: 5, is_system: 1 },
      { name: '最近', icon: 'recent', color: '#DDA0DD', sort_order: 6, is_system: 1 },
      { name: '收藏', icon: 'favorite', color: '#FD79A8', sort_order: 7, is_system: 1 }
    ]

    const insertCategory = this.db.prepare(`
      INSERT OR IGNORE INTO categories (name, icon, color, sort_order, is_system, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `)

    for (const cat of defaultCategories) {
      insertCategory.run(cat.name, cat.icon, cat.color, cat.sort_order, cat.is_system)
    }

    // 迁移：确保 media_files 表包含 scene_category 字段，并为旧数据补充分类
    this.migrateSceneCategory()

    // 迁移：添加软删除字段（F-S6 回收站恢复机制）
    // is_deleted=0 表示正常，=1 表示已移入应用回收站
    // deleted_at 记录软删除时间，用于回收站排序
    this.migrateSoftDelete()

    // F-O1：游戏特色功能增强
    // scene_time：基于图像亮度直方图的场景时段分类（day/night/dawn/dusk/unknown）
    this.migrateSceneTime()
    // outfit：手动套装标注（无限暖暖套装名）
    this.migrateOutfit()
    // T02：文件完整性校验字段（is_missing + missing_count）
    this.migrateMissingStatus()
    // T05：感知哈希字段（phash），用于相似图片查找
    this.migratePhash()
    // P0-02：角色档案管理——account_uid 字段 + character_profiles 表
    this.migrateAccountUid()
    this.createCharacterProfilesTable()
    // P0-03：智能媒体分组——album_type 字段
    this.migrateAlbumType()
    // P1-01：智能去重——is_duplicate + original_id 字段
    // is_duplicate=1 表示该文件是某重复组的"非推荐保留"项；original_id 指向推荐保留的文件 id
    this.migrateDuplicateFields()
    // 区分游戏内拍摄（game）与启动器缓存（launcher）
    this.migrateMediaSource()
    // 损坏文件容错：is_corrupted 标记无法读取/解码的文件，corrupted_reason 记录失败原因
    this.migrateCorruptedStatus()
    // R8：乐观锁字段——media_files.updated_at 记录用户面向变更时间，
    // operation_history.snapshot_updated_at 捕获操作发生时的媒体状态快照
    this.migrateOptimisticLockFields()

    // 所有 ADD COLUMN 迁移完成后，统一创建索引（避免列未存在时索引创建失败）
    const indexStatements = [
      'CREATE INDEX IF NOT EXISTS idx_media_files_type ON media_files(file_type)',
      'CREATE INDEX IF NOT EXISTS idx_media_files_category ON media_files(category_id)',
      'CREATE INDEX IF NOT EXISTS idx_media_files_favorite ON media_files(is_favorite)',
      'CREATE INDEX IF NOT EXISTS idx_media_files_modified ON media_files(modified_at)',
      'CREATE INDEX IF NOT EXISTS idx_media_files_thumbnail ON media_files(thumbnail)',
      'CREATE INDEX IF NOT EXISTS idx_media_files_source_path ON media_files(source_path)',
      'CREATE INDEX IF NOT EXISTS idx_media_files_scene_category ON media_files(scene_category)',
      'CREATE INDEX IF NOT EXISTS idx_media_files_scene_time ON media_files(scene_time)',
      'CREATE INDEX IF NOT EXISTS idx_media_files_outfit ON media_files(outfit)',
      'CREATE INDEX IF NOT EXISTS idx_media_files_is_deleted ON media_files(is_deleted)',
      'CREATE INDEX IF NOT EXISTS idx_media_files_is_missing ON media_files(is_missing)',
      'CREATE INDEX IF NOT EXISTS idx_media_files_phash ON media_files(phash)',
      // P0-02：account_uid 索引，支持按角色档案快速过滤
      'CREATE INDEX IF NOT EXISTS idx_media_files_account_uid ON media_files(account_uid)',
      // P0-03：album_type 索引，支持按游戏相册类型快速分组
      'CREATE INDEX IF NOT EXISTS idx_media_files_album_type ON media_files(album_type)',
      // P1-01：is_duplicate 索引，支持图库默认隐藏重复项（WHERE is_duplicate = 0）
      'CREATE INDEX IF NOT EXISTS idx_media_files_is_duplicate ON media_files(is_duplicate)',
      // P1-01：original_id 索引，支持按推荐保留项反查同组重复
      'CREATE INDEX IF NOT EXISTS idx_media_files_original_id ON media_files(original_id)',
      // media_source 索引，支持按来源（game/launcher）快速过滤
      'CREATE INDEX IF NOT EXISTS idx_media_files_media_source ON media_files(media_source)',
      // 损坏文件索引，支持"仅看损坏"筛选器快速过滤
      'CREATE INDEX IF NOT EXISTS idx_media_files_is_corrupted ON media_files(is_corrupted)',
      // 数据库性能优化（2026-07-18）：新增 5 个联合索引，覆盖高频 WHERE 组合查询
      // 依据 media-repository.ts 中实际 SQL 模式设计，与现有单列索引共存互不冲突
      // 图库默认列表查询：is_deleted=0 AND account_uid=? AND album_type=?
      'CREATE INDEX IF NOT EXISTS idx_media_files_default_view ON media_files(is_deleted, account_uid, album_type)',
      // 角色档案统计：account_uid=? AND is_deleted=0 AND file_type=?
      'CREATE INDEX IF NOT EXISTS idx_media_files_profile_stats ON media_files(account_uid, is_deleted, file_type)',
      // 重复分组查询：is_duplicate=1 AND is_deleted=0 AND original_id IS NOT NULL
      'CREATE INDEX IF NOT EXISTS idx_media_files_duplicate_group ON media_files(is_duplicate, is_deleted, original_id)',
      // 套装聚合统计：is_deleted=0 AND outfit IS NOT NULL AND outfit != ''
      'CREATE INDEX IF NOT EXISTS idx_media_files_outfit_agg ON media_files(is_deleted, outfit)',
      // 场景时段分析：scene_time=? AND file_type=? AND is_deleted=0
      'CREATE INDEX IF NOT EXISTS idx_media_files_scene_analysis ON media_files(scene_time, file_type, is_deleted)'
    ]
    for (const stmt of indexStatements) {
      try {
        this.db.exec(stmt)
      } catch (err) {
        // 只放过"对象已存在"这类幂等冲突。
        // 其他错误（典型是 no such column——说明前面的 ADD COLUMN 没成功）必须抛出：
        // 静默跳过会留下缺索引/缺列的库，业务查询照样炸，只是把崩溃推迟到了图库页面
        if (!DatabaseManager.isIgnorableMigrationError(err)) {
          throw new Error(
            `索引创建失败: ${stmt} -> ${err instanceof Error ? err.message : String(err)}` // TODO: i18n: internal error
          )
        }
        logger.warn(`[DB] 索引已存在（已忽略）: ${stmt}`) // TODO: i18n: internal log
      }
    }

    // 性能重构 v3（2026-07-24）：新增 8 个部分索引 + FTS5 全文索引
    // 文档：docs/PERFORMANCE_REFACTOR_PLAN.md 改造项二
    // 通过命名迁移一次性应用，避免每次启动重复执行
    this.migrateIndexOptimizationV3()
  }

  /**
   * 性能重构 v3：索引优化迁移
   * - 新增 8 个部分索引（partial index）覆盖高频查询场景
   * - 删除冗余 idx_media_created_type（被新联合索引覆盖）
   * - 若 SQLite 启用 fts5 扩展，创建 media_fts 虚拟表 + 同步触发器
   *
   * 幂等保证：所有 CREATE INDEX IF NOT EXISTS；命名迁移标记只执行一次
   * 降级保证：FTS5 不可用时跳过全文索引，不影响其他索引创建
   */
  private migrateIndexOptimizationV3(): void {
    if (!this.db) return
    // R17：使用版本号检查（version=1），替代旧 name 模式
    if (this.isMigrationVersionApplied(1)) return

    try {
      // 1. 备份已上移到 runMigrations → createPreMigrationBackup（事务外执行）。
      //    原来这里的 VACUUM INTO 无法保留：迁移体现在跑在事务里，
      //    而 SQLite 禁止事务内 VACUUM（"cannot VACUUM from within a transaction"）。

      // 2. 新增部分索引（CREATE INDEX IF NOT EXISTS 幂等）
      const newIndexes = [
        // Gallery 主列表分页：account_uid + file_type + is_deleted + created_at
        `CREATE INDEX IF NOT EXISTS idx_media_gallery_uid_type ON media_files(account_uid, file_type, is_deleted, created_at DESC)`,
        // 重复文件列表：部分索引（is_duplicate=1）
        `CREATE INDEX IF NOT EXISTS idx_media_duplicate ON media_files(is_deleted, is_duplicate, created_at DESC) WHERE is_duplicate = 1`,
        // pHash 相似查询：部分索引（phash 已计算且非重复项）
        `CREATE INDEX IF NOT EXISTS idx_media_phash_pending ON media_files(id, phash) WHERE phash IS NOT NULL AND is_duplicate = 0`,
        // 缺失文件检查：部分索引（is_missing=1）
        `CREATE INDEX IF NOT EXISTS idx_media_missing ON media_files(is_missing, missing_count DESC) WHERE is_missing = 1`,
        // 按来源筛选
        `CREATE INDEX IF NOT EXISTS idx_media_source ON media_files(media_source, is_deleted, created_at DESC)`,
        // 按角色套装筛选：部分索引（outfit 非空）
        `CREATE INDEX IF NOT EXISTS idx_media_outfit ON media_files(account_uid, outfit) WHERE outfit IS NOT NULL`,
        // 收藏列表：部分索引（is_favorite=1）
        `CREATE INDEX IF NOT EXISTS idx_media_favorite ON media_files(is_favorite, created_at DESC) WHERE is_favorite = 1`,
        // 增量扫描排序：部分索引（indexed_at 非空）
        `CREATE INDEX IF NOT EXISTS idx_media_indexed_at ON media_files(indexed_at DESC) WHERE indexed_at IS NOT NULL`
      ]
      for (const sql of newIndexes) {
        try {
          this.db.exec(sql)
        } catch (err) {
          if (!DatabaseManager.isIgnorableMigrationError(err)) {
            throw new Error(
              `v3 索引创建失败: ${sql} -> ${err instanceof Error ? err.message : String(err)}` // TODO: i18n: internal error
            )
          }
          logger.warn(`[DB] v3 索引已存在（已忽略）: ${sql}`) // TODO: i18n: internal log
        }
      }

      // 3. 删除冗余旧索引（先建新再删旧，确保查询不中断）
      // idx_media_created_type 已被 idx_media_gallery_uid_type 覆盖
      this.db.exec(`DROP INDEX IF EXISTS idx_media_created_type`)

      // 4. FTS5 全文索引（仅当 SQLite 启用 fts5 扩展时创建）
      const fts5Row = this.db
        .prepare("SELECT 1 FROM pragma_compile_options() WHERE compile_options LIKE 'ENABLE_FTS5'")
        .get() as { '1': number } | undefined
      if (fts5Row) {
        try {
          this.db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(
              file_name, content='media_files', content_rowid='id', tokenize='unicode61'
            )
          `)
          // 初始填充（仅第一次创建时；IF NOT EXISTS 已存在时 rebuild 是幂等的）
          this.db.exec(`INSERT INTO media_fts(media_fts) VALUES('rebuild')`)
          // 触发器同步（INSERT/UPDATE/DELETE）
          this.db.exec(`
            CREATE TRIGGER IF NOT EXISTS media_fts_ai AFTER INSERT ON media_files BEGIN
              INSERT INTO media_fts(rowid, file_name) VALUES (new.id, new.file_name);
            END;
            CREATE TRIGGER IF NOT EXISTS media_fts_ad AFTER DELETE ON media_files BEGIN
              INSERT INTO media_fts(media_fts, rowid, file_name) VALUES('delete', old.id, old.file_name);
            END;
            CREATE TRIGGER IF NOT EXISTS media_fts_au AFTER UPDATE ON media_files BEGIN
              INSERT INTO media_fts(media_fts, rowid, file_name) VALUES('delete', old.id, old.file_name);
              INSERT INTO media_fts(rowid, file_name) VALUES (new.id, new.file_name);
            END;
          `)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          // FTS5 不可用是既定的降级路径（搜索回退 LIKE），可以放过；
          // 磁盘满、库损坏之类的错误不能吞，否则又变回静默半迁移
          if (!/fts5|no such module/i.test(msg)) throw err
          logger.warn('[DB] FTS5 不可用（已降级为 LIKE 查询）:', msg) // TODO: i18n: internal log
        }
      }

      // 5. 标记迁移完成（与上面的 DDL 同属一个事务，一起提交或一起回滚）
      this.markMigrationVersionApplied(1)
      logger.info('[DB] v3 索引优化迁移完成') // TODO: i18n: internal log
    } catch (err) {
      // 必须重新抛出：本方法跑在 runMigrations 的事务内，
      // 在这里吞掉错误会让事务照常提交，留下"部分索引已建、版本未标记"的半迁移状态
      logger.error(
        '[DB] v3 索引优化迁移失败，将回滚整个迁移事务:', // TODO: i18n: internal log
        err instanceof Error ? err.message : err
      )
      throw err
    }
  }

  /**
   * P0-A2：检查命名迁移是否已应用
   * 用于"仅执行一次"的迁移（如数据回填、全表修复），避免每次启动重复执行
   * @deprecated R17：新迁移请使用 isMigrationVersionApplied(version)
   */
  isMigrationApplied(name: string): boolean {
    if (!this.db) return true // DB 未初始化时视为已应用，避免误执行
    const row = this.db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name)
    return !!row
  }

  /**
   * P0-A2：标记命名迁移为已应用
   * 必须在迁移成功完成后调用，确保迁移只执行一次
   * @deprecated R17：新迁移请使用 markMigrationVersionApplied(version)
   */
  markMigrationApplied(name: string): void {
    if (!this.db) return
    this.db
      .prepare(
        "INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, datetime('now'))"
      )
      .run(name)
  }

  /**
   * R17：按版本号检查迁移是否已应用。
   *
   * 替代旧 name 模式：version 列为整数，唯一且有序，避免命名拼写错误导致的重复执行。
   * 迁移逻辑本身保持幂等（CREATE INDEX IF NOT EXISTS 等），即使版本标记丢失也可安全重跑。
   *
   * 向后兼容：version 列不存在（safeEnsureColumn 失败的极端场景）时回退到 name 检查。
   */
  // 旧命名迁移 → 版本号映射（仅用于向后兼容回退）
  private static readonly LEGACY_MIGRATION_NAMES: Record<number, string> = {
    1: 'index_optimization_v3',
    2: 'scene_category_backfill_v1'
  }

  isMigrationVersionApplied(version: number): boolean {
    if (!this.db) return true // DB 未初始化时视为已应用，避免误执行
    try {
      const row = this.db
        .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
        .get(version) as { '1': number } | undefined
      return !!row
    } catch {
      // version 列不存在：回退到旧 name 检查
      const name = DatabaseManager.LEGACY_MIGRATION_NAMES[version]
      if (!name) return false
      const row = this.db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name) as
        { '1': number } | undefined
      return !!row
    }
  }

  /**
   * R17：按版本号标记迁移为已应用。
   *
   * 同时写入 name（兼容旧版查询）与 version，确保新旧代码都能识别。
   * name 使用 `v{version}` 格式，便于日志追溯。
   *
   * 向后兼容：version 列不存在时回退到旧 name 模式（使用 LEGACY_MIGRATION_NAMES 映射）。
   */
  markMigrationVersionApplied(version: number): void {
    if (!this.db) return
    try {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO schema_migrations (name, version, applied_at) VALUES (?, ?, datetime('now'))"
        )
        .run(`v${version}`, version)
    } catch {
      // version 列不存在：回退到旧 name 模式
      const name = DatabaseManager.LEGACY_MIGRATION_NAMES[version] ?? `v${version}`
      this.db
        .prepare(
          "INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, datetime('now'))"
        )
        .run(name)
    }
  }

  /**
   * R16：安全添加列并确保旧记录补默认值。
   *
   * 与原 safeAddColumn 的区别：列已存在时不再静默返回，而是补执行
   * `UPDATE table SET col = DEFAULT WHERE col IS NULL`，修复旧记录字段为 NULL 的问题（L6）。
   *
   * 列不存在时：ALTER TABLE ADD COLUMN 正常执行，新列自动按 DEFAULT 填充所有行。
   * 列已存在时：捕获 "duplicate column name"，解析 columnDef 中的列名与 DEFAULT 值，
   *   对 NULL 行执行回填。无 DEFAULT 子句时跳过（NULL 是预期默认值）。
   * 其他错误（磁盘满、DB 锁）：向上抛出，由 runMigrations 的事务整体回滚。
   */
  private safeEnsureColumn(tableName: string, columnDef: string): void {
    if (!this.db) return
    try {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDef};`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // "duplicate column name" 是正常情况（列已存在），补回填 NULL 行
      if (/duplicate column name/i.test(msg)) {
        this.backfillColumnDefault(tableName, columnDef)
        return
      }
      // 其他错误（磁盘满、DB 锁、I/O 错误）必须中断迁移：
      // 之前这里只 warn，列没加上却继续往下走，后面的 CREATE INDEX 和业务查询
      // 会引用到不存在的列，最终表现为图库白屏
      throw new Error(
        `添加列失败: ALTER TABLE ${tableName} ADD COLUMN ${columnDef} -> ${msg}` // TODO: i18n: internal error
      )
    }
  }

  /**
   * R16：列已存在时回填 NULL 行为 DEFAULT 值。
   * 解析 columnDef 中的列名与 DEFAULT 子句，执行 UPDATE ... SET col = default WHERE col IS NULL。
   * 无 DEFAULT 子句时跳过（NULL 是该列的预期默认值，如 phash TEXT）。
   */
  private backfillColumnDefault(tableName: string, columnDef: string): void {
    if (!this.db) return
    // 解析列名：columnDef 格式如 "is_missing INTEGER NOT NULL DEFAULT 0" 或 "phash TEXT"
    const colNameMatch = columnDef.match(/^(\w+)/)
    if (!colNameMatch) return
    const colName = colNameMatch[1]

    // 解析 DEFAULT 值：匹配 DEFAULT 关键字后的值（引号字符串、数字、布尔）
    const defaultMatch = columnDef.match(/\bDEFAULT\s+('[^']*'|\S+)/i)
    if (!defaultMatch) return // 无 DEFAULT 子句，NULL 是预期值，无需回填
    const defaultValue = defaultMatch[1]

    try {
      const result = this.db
        .prepare(`UPDATE ${tableName} SET ${colName} = ${defaultValue} WHERE ${colName} IS NULL;`)
        .run()
      if (result.changes > 0) {
        logger.info(
          `[DB] R16 回填列默认值: ${tableName}.${colName} = ${defaultValue}，影响 ${result.changes} 行`
        ) // TODO: i18n: internal log
      }
    } catch (err) {
      logger.warn(
        `[DB] R16 回填列默认值失败: UPDATE ${tableName} SET ${colName} = ${defaultValue} WHERE ${colName} IS NULL`,
        err instanceof Error ? err.message : err
      ) // TODO: i18n: internal log
    }
  }

  /**
   * T02：添加 is_missing 和 missing_count 字段
   * is_missing=1 表示文件已被外部移动/删除；missing_count 记录连续缺失次数
   * 连续两次扫描缺失才标记为 missing，一次出现即恢复
   */
  private migrateMissingStatus(): void {
    if (!this.db) return
    this.safeEnsureColumn('media_files', 'is_missing INTEGER NOT NULL DEFAULT 0')
    this.safeEnsureColumn('media_files', 'missing_count INTEGER NOT NULL DEFAULT 0')
  }

  /**
   * T05：添加 phash 字段（感知哈希，64 字符 0/1 串）
   * 用于相似图片查找；旧数据 phash 为 NULL，扫描后异步回填
   */
  private migratePhash(): void {
    if (!this.db) return
    this.safeEnsureColumn('media_files', 'phash TEXT')
    // R7：phash 文件变更检测——存储 phash 计算时的文件 mtime/size，用于检测文件被外部编辑后 phash 失效
    // 旧数据这两个字段为 NULL，下次 phash 批处理时视为 stale 触发重算
    this.safeEnsureColumn('media_files', 'phash_mtime INTEGER')
    this.safeEnsureColumn('media_files', 'phash_file_size INTEGER')
  }

  /**
   * P0-02：添加 account_uid 字段（角色档案 UID）
   * 用于多角色档案管理，扫描时根据路径中的 UID 段自动填充
   * 旧数据 account_uid 默认为 'default'，归入默认档案
   */
  private migrateAccountUid(): void {
    if (!this.db) return
    this.safeEnsureColumn('media_files', "account_uid TEXT NOT NULL DEFAULT 'default'")
  }

  /**
   * P0-03：添加 album_type 字段（游戏相册类型）
   * 扫描时根据父文件夹名映射填充（如 ScreenShot → '游戏截图'）
   * 旧数据 album_type 默认为 '其他'，下一次扫描时按需更新
   */
  private migrateAlbumType(): void {
    if (!this.db) return
    // TODO: i18n: 默认值 '其他' 存入 DB，需重构为存储 i18n key
    this.safeEnsureColumn('media_files', "album_type TEXT NOT NULL DEFAULT '其他'")
  }

  /**
   * P1-01：添加 is_duplicate + original_id 字段（智能去重）
   * is_duplicate=1 表示该文件是某重复组的"非推荐保留"项，图库默认隐藏
   * original_id 指向同组中推荐保留的文件 id（NULL 表示独立文件或推荐保留项本身）
   * 由 markDuplicates() 在 pHash 补算后基于评分填充
   */
  private migrateDuplicateFields(): void {
    if (!this.db) return
    this.safeEnsureColumn('media_files', 'is_duplicate INTEGER NOT NULL DEFAULT 0')
    this.safeEnsureColumn('media_files', 'original_id INTEGER')
  }

  /**
   * 添加 media_source 字段：区分游戏内拍摄（game）与启动器缓存（launcher）
   * 扫描时根据路径特征填充：路径含 "Launcher\cache" 判为 launcher，其余为 game
   * 主页图库默认仅显示 game，启动器缓存单独区域展示
   */
  private migrateMediaSource(): void {
    if (!this.db) return
    this.safeEnsureColumn('media_files', "media_source TEXT NOT NULL DEFAULT 'game'")
  }

  /**
   * 损坏文件容错：添加 is_corrupted / corrupted_count / corrupted_reason 字段
   * - is_corrupted=1 表示文件存在但无法读取/解码（图片损坏、视频无法解析等）
   * - corrupted_count 记录连续损坏次数（与 missing_count 类似的防抖机制）
   * - corrupted_reason 记录最后一次失败的原因摘要（≤200字符），便于诊断
   *
   * 与 is_missing 的区别：
   * - is_missing：文件被外部移动/删除（fs.access 失败）
   * - is_corrupted：文件存在但内容损坏（sharp/ffmpeg 解码失败）
   */
  private migrateCorruptedStatus(): void {
    if (!this.db) return
    this.safeEnsureColumn('media_files', 'is_corrupted INTEGER NOT NULL DEFAULT 0')
    this.safeEnsureColumn('media_files', 'corrupted_count INTEGER NOT NULL DEFAULT 0')
    this.safeEnsureColumn('media_files', 'corrupted_reason TEXT')
  }

  /**
   * P0-02：创建角色档案表
   * 存储角色基础信息（UID、昵称、头像），拍摄统计实时从 media_files 聚合查询
   */
  private createCharacterProfilesTable(): void {
    if (!this.db) return
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS character_profiles (
        uid TEXT PRIMARY KEY,
        nickname TEXT NOT NULL DEFAULT '',
        avatar TEXT,
        created_at TEXT NOT NULL,
        last_active_at TEXT
      );
      -- F-G9：为 nickname 添加索引，支持按昵称搜索角色档案（避免全表扫描）
      CREATE INDEX IF NOT EXISTS idx_character_profiles_nickname ON character_profiles(nickname);
    `)
    // 插入默认档案（若不存在）
    // TODO: i18n: 默认档案名存入 DB，需重构为存储 i18n key
    this.db
      .prepare(
        "INSERT OR IGNORE INTO character_profiles (uid, nickname, created_at) VALUES ('default', '默认档案', datetime('now'))"
      )
      .run()
  }

  /**
   * F-O1：添加 scene_time 字段（基于图像内容的时段分类）
   */
  private migrateSceneTime(): void {
    if (!this.db) return
    this.safeEnsureColumn('media_files', "scene_time TEXT DEFAULT 'unknown'")
  }

  /**
   * F-O1：添加 outfit 字段（手动套装标注）
   */
  private migrateOutfit(): void {
    if (!this.db) return
    this.safeEnsureColumn('media_files', "outfit TEXT DEFAULT ''")
  }

  private migrateSoftDelete(): void {
    if (!this.db) return
    this.safeEnsureColumn('media_files', 'is_deleted INTEGER NOT NULL DEFAULT 0')
    this.safeEnsureColumn('media_files', 'deleted_at TEXT')
  }

  /**
   * R8：操作历史撤销乐观锁字段。
   * - media_files.updated_at：用户面向变更（rating/tags/notes/favorite/category/outfit/scene_time/soft delete/restore）时刷新
   * - operation_history.snapshot_updated_at：操作入库时捕获对应媒体的 updated_at 快照
   *
   * 撤销时比较 current updated_at 与 snapshot_updated_at：不一致说明操作发生后媒体被独立修改，需弹窗确认。
   * 旧记录字段为 NULL 时跳过冲突检测（仅对新操作生效），兼容老版本 DB。
   */
  private migrateOptimisticLockFields(): void {
    if (!this.db) return
    this.safeEnsureColumn('media_files', 'updated_at TEXT')
    this.safeEnsureColumn('operation_history', 'snapshot_updated_at TEXT')
  }

  private migrateSceneCategory(): void {
    if (!this.db) return

    // 1. 添加字段（safeEnsureColumn 区分"列已存在"和其他错误，R16 列已存在时补回填默认值）
    this.safeEnsureColumn('media_files', 'scene_category TEXT')

    // 2. 创建索引（索引创建已统一在 runMigrations 末尾处理，此处不再重复）

    // P0-A2：数据回填改为版本化一次性迁移，避免每次启动都查询 WHERE scene_category IS NULL
    // R17：使用版本号检查（version=2），替代旧 name 模式
    // 旧库首次升级时 schema_migrations 表为空，isMigrationVersionApplied 返回 false，执行一次回填
    // 之后启动直接跳过，节省每次启动的 SELECT 扫描
    if (this.isMigrationVersionApplied(2)) {
      return
    }

    try {
      // 待确认#1：为尚未写入 scene_category 的旧记录，根据路径自动检测并回填
      // 仅检测 IS NULL 的记录，避免每次启动都对 'other' 记录重复检测
      // 'other' 既是默认值也是 detectSceneCategory 的合法返回值，重复检测无意义且浪费性能
      const rows = this.db
        .prepare('SELECT id, file_path FROM media_files WHERE scene_category IS NULL')
        .all() as Array<{ id: number; file_path: string }>

      if (rows.length > 0) {
        const updateStmt = this.db.prepare('UPDATE media_files SET scene_category = ? WHERE id = ?')
        const updateMany = this.db.transaction(
          (items: Array<{ id: number; file_path: string }>) => {
            for (const row of items) {
              const category = detectSceneCategory(row.file_path)
              updateStmt.run(category, row.id)
            }
          }
        )
        updateMany(rows)
        logger.info(`[Database] 已迁移 ${rows.length} 条记录的 scene_category`) // TODO: i18n: internal log
      }

      // 标记迁移已完成（与回填同属外层事务，一起提交或一起回滚）
      this.markMigrationVersionApplied(2)
    } catch (error) {
      // 必须重新抛出：吞掉会让外层事务照常提交，留下"部分记录已回填、版本未标记"的状态
      logger.error(
        '[Database] scene_category 迁移失败，将回滚整个迁移事务:', // TODO: i18n: internal log
        error
      )
      throw error
    }
  }

  query(sql: string, params?: unknown[]): unknown[] {
    if (!this.db) throw new Error('Database not initialized') // TODO: i18n: internal error
    return this.db.prepare(sql).all(params || [])
  }

  execute(sql: string, params?: unknown[]): DatabaseType.RunResult {
    if (!this.db) throw new Error('Database not initialized') // TODO: i18n: internal error
    return this.db.prepare(sql).run(params || [])
  }

  /**
   * 读取设置项。
   * C-O14：原实现 `return JSON.parse(row.value) as T` 直接断言无运行时校验，
   * 数据库中存的 JSON 可能与 T 不匹配（如历史数据格式变化后字段类型/结构变化），
   * 调用方拿到类型不匹配的值会运行时崩溃。
   * 现在添加基础运行时校验：解析失败、类型不符时回退到 defaultValue。
   */
  getSetting<T>(key: string, defaultValue: T): T {
    if (!this.db) return defaultValue
    try {
      const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
        { value: string } | undefined
      if (!row) return defaultValue
      const parsed = JSON.parse(row.value)
      // 运行时类型校验：基于 defaultValue 的类型检查 parsed 是否兼容
      // 不做深度结构校验（避免引入 zod 等依赖），仅做基础类型守卫
      if (!this.isSettingTypeCompatible(parsed, defaultValue)) {
        logger.warn(`[Database] 设置项 "${key}" 类型不符，回退到默认值`) // TODO: i18n: internal log
        return defaultValue
      }
      return parsed as T
    } catch {
      return defaultValue
    }
  }

  /**
   * 基础类型兼容性检查：判断 parsed 是否与 defaultValue 的类型一致。
   * 仅做浅层类型守卫，不递归校验对象内部结构。
   * - null/undefined：与任何类型兼容（视为"未设置"）
   * - 基础类型（string/number/boolean）：typeof 必须一致
   * - 数组：parsed 必须是数组
   * - 对象：parsed 必须是非 null 对象且非数组
   */
  private isSettingTypeCompatible(parsed: unknown, defaultValue: unknown): boolean {
    if (parsed === null || parsed === undefined) return true
    const defaultType = typeof defaultValue
    const parsedType = typeof parsed
    // 基础类型：typeof 必须一致
    if (defaultType === 'string' || defaultType === 'number' || defaultType === 'boolean') {
      return parsedType === defaultType
    }
    // 数组
    if (Array.isArray(defaultValue)) {
      return Array.isArray(parsed)
    }
    // 对象（defaultValue 是非 null 对象且非数组）
    if (defaultType === 'object') {
      return parsedType === 'object' && !Array.isArray(parsed)
    }
    // 其他类型（如函数、symbol 等不存在的场景）放行
    return true
  }

  setSetting<T>(key: string, value: T): void {
    if (!this.db) return
    this.db
      .prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
      .run(key, JSON.stringify(value))
  }

  getDatabase(): DatabaseType.Database | null {
    return this.db
  }

  /**
   * 优雅关闭：先 dispose worker bridge（含 WAL checkpoint + close worker DB），
   * 再关闭主进程 DB（同样执行 WAL checkpoint）。
   *
   * worker bridge 是 async dispose，但 close() 是同步方法（受 before-quit 调用约束）。
   * 此处采用 fire-and-forget：发送 DB_DISPOSE 后立即关闭主进程 DB。
   * worker 进程会自行清理（500ms 内退出），主进程 close 不阻塞。
   *
   * 若调用方需要等待 worker 完全退出，应直接 await bridge.dispose() 而非依赖 close()。
   */
  close(): void {
    // 1. 通知 worker 退出（fire-and-forget，不阻塞主进程退出）
    if (this.workerBridge) {
      try {
        // dispose 是 async，但 close 是 sync；此处仅触发，不等待
        void this.workerBridge.dispose()
      } catch {
        // bridge dispose 失败不阻塞主进程 DB 关闭
      }
      this.workerBridge = null
    }

    // 2. 关闭主进程 DB（含 WAL checkpoint）
    if (this.db) {
      // 数据库性能优化（2026-07-18）：退出时再次执行 optimize，确保本次会话的统计信息落盘
      // 必须在 WAL checkpoint 之前执行，避免 optimize 触发的写入被 checkpoint 漏掉
      try {
        this.db.pragma('optimize')
      } catch (err) {
        logger.warn('[Database] 退出时 PRAGMA optimize 失败（已忽略）:', err) // TODO: i18n: internal log
      }
      // 退出前执行 WAL checkpoint，将 WAL 日志写回主数据库文件，防止异常退出丢数据
      // 修复 A-F4/C-S6：原实现直接 close()，WAL 文件未 checkpoint，异常退出可能丢数据
      // P1-A8：wal_checkpoint(TRUNCATE) 会阻塞等待所有读者结束，万级日志下可能超 2s
      //        导致 before-quit 强制退出但 WAL 仍未合并。改用 PASSIVE 不阻塞，
      //        尽力 checkpoint 当前可 checkpoint 的页，剩余部分由下次启动时 SQLite 自动恢复
      try {
        this.db.pragma('wal_checkpoint(PASSIVE)')
      } catch (error) {
        logger.error('[Database] WAL checkpoint 失败:', error) // TODO: i18n: internal log
      }
      this.db.close()
      this.db = null
    }
  }

  /**
   * P1-A8：获取 WAL 文件大小（字节），用于 before-quit 动态调整超时
   * 返回 0 表示文件不存在或读取失败（如未启用 WAL、文件已被 checkpoint）
   */
  getWalFileSize(): number {
    if (!this.dbPath) return 0
    try {
      // WAL 文件路径 = 数据库路径 + '-wal'
      const walPath = this.dbPath + '-wal'

      const stat = fs.statSync(walPath)
      return stat.size
    } catch {
      // WAL 文件不存在或不可访问
      return 0
    }
  }
}
