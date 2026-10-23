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
import type { ScannerWorkerBridge } from '../scanner/scanner-worker-bridge'
import type { MediaWorkerBridge } from '../media-worker/bridge'
import type { DbRunResult } from './worker/worker-protocol'
import { SYNC_METADATA_DDL_STATEMENTS } from './sync-metadata-repository'
import { SYNC_PAIRING_DDL_STATEMENTS } from './sync-pairing-repository'
import { ASSET_EDITS_DDL_STATEMENTS } from './asset-edits-repository'
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

/** 最近一次数据库恢复事件的完整记录（监听器回调与 getLastRecovery 共用同一结构） */
export interface DatabaseRecoveryInfo {
  success: boolean
  reason: string
  sourceBackup?: { filePath: string; filename: string }
  corruptedBackupPath?: string
  kind?: DbFailureKind
  /** true=非破坏性故障，已保留在线库未覆盖，仅提示排查 */
  nonDestructive?: boolean
  timestamp: string
}

/** 数据库恢复事件回调（由 Application 注入，用于弹窗提示用户） */
export type DatabaseRecoveryListener = (info: DatabaseRecoveryInfo) => void

/** FIX(组7-1): 判定 better-sqlite3 打开失败是否为锁类错误（暂时性，不可删除 WAL/SHM） */
function isSqliteLockError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  const text = `${typeof code === 'string' ? code : ''} ${err instanceof Error ? err.message : String(err)}`
  return /SQLITE_(BUSY|LOCKED)/i.test(text)
}

/**
 * H1：数据库初始化失败分类——决定走「破坏性备份恢复（覆盖在线库）」还是「保留现场」。
 * 仅在 CORRUPT / WAL_CORRUPT 回退时才允许用备份覆盖在线库；其余一律保留现场。
 */
export enum DbFailureKind {
  CORRUPT = 'CORRUPT',
  WAL_CORRUPT = 'WAL_CORRUPT',
  LOCKED = 'LOCKED',
  PERMISSION = 'PERMISSION',
  DISK_FULL = 'DISK_FULL',
  ABI_INCOMPATIBLE = 'ABI_INCOMPATIBLE',
  UNKNOWN = 'UNKNOWN'
}

/**
 * H1：这些失败类型绝不能用备份覆盖在线库，且连 WAL 合并恢复都无意义——直接保留现场并提示用户。
 * 覆盖会用最近一份备份（间隔 7 天，首次启动可能无备份）静默替换当前库，丢失上次备份以来的全部变更；
 * 其中 ABI 不匹配靠恢复备份无法修复（schema 相同、同 better-sqlite3 版本），权限/磁盘满/锁与"库是否损坏"无关，
 * 未知（UNKNOWN）打开失败同理——同源备份无法修复，盲目 restore 只会反复无效覆盖，故同样保留现场供排查。
 * 注意：CORRUPT / WAL_CORRUPT 不在此集合——它们会先走数据保全的 runWALRecovery（WAL checkpoint），
 * 仅当合并失败且在线库确实损坏（isLiveDatabaseIntact 门禁）时才回退破坏性备份覆盖。
 */
const NON_DESTRUCTIVE_KINDS = new Set<DbFailureKind>([
  DbFailureKind.LOCKED,
  DbFailureKind.PERMISSION,
  DbFailureKind.DISK_FULL,
  DbFailureKind.ABI_INCOMPATIBLE,
  DbFailureKind.UNKNOWN
])

/** H1：依据 better-sqlite3 抛错（err.code / 消息关键字）分类初始化失败类型 */
function classifyDbFailure(err: unknown): DbFailureKind {
  const code = (err as { code?: unknown } | null)?.code
  const message = err instanceof Error ? err.message : String(err)
  const text = `${typeof code === 'string' ? code : ''} ${message}`.toLowerCase()
  if (/sqlite_(busy|locked)/i.test(text) || isSqliteLockError(err)) return DbFailureKind.LOCKED
  if (/sqlite_perm/i.test(text) || /eacces/i.test(text) || /permission denied/i.test(message))
    return DbFailureKind.PERMISSION
  if (
    /sqlite_full/i.test(text) ||
    /enospc/i.test(text) ||
    /no space/i.test(text) ||
    /disk.*full/i.test(text)
  )
    return DbFailureKind.DISK_FULL
  if (
    /node_module_version/i.test(text) ||
    /the specified procedure could not be found/i.test(message) ||
    /cannot find module/i.test(text) ||
    /\bab(i)?\b.*(?:mismatch|incompatible|version)/i.test(text)
  )
    return DbFailureKind.ABI_INCOMPATIBLE
  // 明确的损坏信号（数据库磁盘镜像损坏 / 非数据库文件）→ 走 WAL 合并恢复优先，失败再备份恢复
  if (
    /sqlite_(corrupt|notadb)/i.test(text) ||
    /database disk image is malformed/i.test(message) ||
    /file is not a database/i.test(message)
  )
    return DbFailureKind.WAL_CORRUPT
  // 无法归类且库打不开：保守地当作「未知」——保留现场供排查，而非用备份覆盖
  return DbFailureKind.UNKNOWN
}

function errToText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
  /**
   * scanner / media worker 桥接（可选）。
   * 用于数据库自恢复（attemptRecovery）前显式停止这些持有 dbPath 连接的 worker，
   * 避免 Windows 上 rename 覆盖在线库时的 EPERM 共享冲突。不参与 close()。
   */
  private scannerWorkerBridge: ScannerWorkerBridge | null = null
  private mediaWorkerBridge: MediaWorkerBridge | null = null
  /** 数据库恢复事件监听器（由 Application 注入） */
  private recoveryListeners: DatabaseRecoveryListener[] = []
  /** 最近一次恢复记录（供 Application 在 initialize 后查询并弹窗） */
  private lastRecovery: DatabaseRecoveryInfo | null = null
  // 启动性能优化：本次 initialize 是否已同步执行过全量 integrity_check
  // （quick_check 失败场景同步处理；避免 lifecycle 阶段 8 重复入队后台复核）
  private fullIntegrityCheckedAtStartup = false

  constructor() {
    const userDataPath = app.getPath('userData')
    const dbDir = path.join(userDataPath, 'database')
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }
    this.dbPath = path.join(dbDir, 'meow_star_map.db')
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

  /** 注入 scanner worker 桥接：自恢复前需停止其 dbPath 句柄 */
  setScannerWorkerBridge(bridge: ScannerWorkerBridge | null): void {
    this.scannerWorkerBridge = bridge
  }

  /** 注入 media worker 桥接：自恢复前需停止其 dbPath 句柄 */
  setMediaWorkerBridge(bridge: MediaWorkerBridge | null): void {
    this.mediaWorkerBridge = bridge
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
          logger.warn(t('main.db.log.lockRetrySucceeded'))
        } catch (retryErr) {
          throw new Error(
            t('main.db.error.lockedByOtherProgram', {
              error: err instanceof Error ? err.message : String(err),
              retryError: retryErr instanceof Error ? retryErr.message : String(retryErr)
            })
          )
        }
      } else {
        // H1：非锁错误——先分类，绝不为非损坏失败用备份覆盖在线库（覆盖会丢失自上次备份以来的全部变更）
        const kind = classifyDbFailure(err)
        if (NON_DESTRUCTIVE_KINDS.has(kind)) {
          // 锁/权限/磁盘满/ABI 不匹配/未知：保留在线库原文件，记录恢复事件并抛清晰错误供排查
          if (this.db) {
            try {
              this.db.close()
            } catch {
              /* 忽略 */
            }
          }
          this.db = null
          this.lastRecovery = {
            success: false,
            reason: t('main.db.recovery.openFailed', { error: errToText(err) }),
            kind,
            nonDestructive: true,
            timestamp: new Date().toISOString()
          }
          this.notifyRecovery(this.lastRecovery)
          throw new Error(this.nonDestructiveErrorMessage(kind, err))
        }
        // 疑似损坏（WAL_CORRUPT 或 CORRUPT 类）：优先走数据保全的 WAL 合并恢复，失败再备份恢复。
        // 不预先删除 -wal/-shm（否则会丢弃尚未 checkpoint 的已提交事务，造成健康库丢最近写入）。
        const recovered = await this.attemptRecovery({
          reason: t('main.db.recovery.openFailed', { error: errToText(err) }),
          kind: DbFailureKind.WAL_CORRUPT
        })
        if (!recovered) {
          throw new Error(
            t('main.db.error.openFailedAfterRecovery', {
              error: errToText(err),
              retryError: errToText(err)
            })
          )
        }
        // 恢复成功后 this.db 已由 attemptRecovery 重新打开
      }
    }

    // 完整性校验分级（启动性能优化）：检测数据库逻辑/物理损坏，损坏时自动从备份恢复
    // 时机：在 PRAGMA 设置前执行，避免在损坏的库上设置 WAL 等模式导致二次问题
    // 分级策略（docs/archive/plans/startup-perf.md）：
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
        logger.error(
          t('main.db.recovery.integrityCheckFailed', { reason: integrityResult.reason ?? '' })
        )
        const recovered = await this.attemptRecovery({
          reason: t('main.db.recovery.integrityCheckFailed', {
            reason: integrityResult.reason ?? ''
          }),
          kind: DbFailureKind.CORRUPT
        })
        if (!recovered) {
          // H1：恢复失败（无可用备份或覆盖后仍打不开）→ 抛清晰错误。
          // 启动失败可诊断优于静默继续（原静默逻辑会带着可能损坏的 db 句柄继续，风险更高）。
          throw new Error(
            t('main.db.error.databaseCorrupted', { reason: integrityResult.reason ?? '' })
          )
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
      throw new Error(t('main.db.error.initFailedNullHandle'))
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
      logger.warn(t('main.db.log.autoVacuumFailed'), err)
    }

    // PRAGMA optimize：让 SQLite 自动分析索引使用统计，优化查询计划器
    // 官方推荐的轻量维护操作，毫秒级完成，不阻塞业务
    try {
      db.pragma('optimize')
    } catch (err) {
      logger.warn(t('main.db.log.pragmaOptimizeFailed'), err)
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
      void logger.fault(
        'databaseCorruption',
        new Error(t('main.db.log.integrityCheckFault', { reason })),
        {
          dbPath: this.dbPath
        }
      )
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
   * 选型见 docs/archive/plans/startup-perf.md §1.2：损坏探测信号必须在 DB 不可读时仍可用，
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
      logger.warn(t('main.db.log.writeCleanExitMarkerFailed'), err)
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
   * 自动恢复流程：H1 收窄「破坏性备份恢复」触发条件。
   * - 仅当 kind 为 CORRUPT（integrity 校验已确认损坏）或 WAL_CORRUPT 回退（WAL 合并恢复失败）时，
   *   才用最近备份覆盖在线库；
   * - 锁/权限/磁盘满/ABI 不匹配/未知等非损坏失败 → 保留在线库原文件，仅记录事件并向上抛错；
   * - WAL 损坏优先走数据保全的 runWALRecovery（WAL checkpoint 合并回主库），失败才回退备份恢复；
   * - 任何走向破坏性恢复的路径前，对在线库跑只读 integrity_check 门禁：若库完好则保留现场、不覆盖。
   * @param opts.reason 恢复触发原因（用于日志与事件通知）
   * @param opts.kind 失败分类（决定破坏性恢复与否）
   * @returns true=已成功恢复并重新打开 db；false=未恢复（非破坏性保留现场 / 无可用备份 / 恢复异常）
   */
  private async attemptRecovery(opts: { reason: string; kind: DbFailureKind }): Promise<boolean> {
    const { reason, kind } = opts

    // H1：非损坏型失败（锁/权限/磁盘满/ABI 不匹配/未知）——绝不覆盖在线库，保留现场供排查
    if (NON_DESTRUCTIVE_KINDS.has(kind)) {
      if (this.db) {
        try {
          this.db.close()
        } catch {
          /* 忽略 */
        }
      }
      this.db = null
      this.lastRecovery = {
        success: false,
        reason,
        kind,
        nonDestructive: true,
        timestamp: new Date().toISOString()
      }
      this.notifyRecovery(this.lastRecovery)
      logger.error(
        `[DB] 非破坏性数据库故障（${kind}），按 H1 保留在线库、未执行备份覆盖: ${reason}`
      )
      return false
    }

    // H1：WAL 损坏优先走数据保全的轻量 WAL 合并恢复（checkpoint 把已提交事务合并回主库）
    if (kind === DbFailureKind.WAL_CORRUPT) {
      const walRecovered = await this.runWALRecovery()
      if (walRecovered) {
        this.lastRecovery = {
          success: true,
          reason: `${reason}（WAL 合并恢复，未使用备份覆盖）`,
          kind,
          timestamp: new Date().toISOString()
        }
        this.notifyRecovery(this.lastRecovery)
        // eslint-disable-next-line no-restricted-syntax -- 诊断日志
        logger.info('[DB] WAL 合并恢复成功，已保全未 checkpoint 的已提交事务')
        return true
      }
      // WAL 合并恢复失败 → 回退破坏性备份恢复
      // eslint-disable-next-line no-restricted-syntax -- 诊断日志
      logger.warn('[DB] WAL 合并恢复失败，回退破坏性备份恢复')
    }

    // 破坏性恢复（仅 CORRUPT / WAL_CORRUPT 回退）：先对在线库做只读 integrity_check 门禁。
    // kind 为 CORRUPT（integrity 路径已确认损坏）直接走恢复；其余（WAL 回退）若库实际完好则保留现场。
    if (kind !== DbFailureKind.CORRUPT) {
      // 注意 isLiveDatabaseIntact 为异步函数，必须 await——否则 Promise 永远为真值会导致门禁失效
      if (await this.isLiveDatabaseIntact()) {
        this.lastRecovery = {
          success: false,
          reason: `${reason}（在线库 integrity_check 通过，按 H1 保留现场、不覆盖）`,
          kind,
          nonDestructive: true,
          timestamp: new Date().toISOString()
        }
        this.notifyRecovery(this.lastRecovery)
        logger.error(`[DB] 在线库 integrity_check 通过，按 H1 保留现场、不覆盖: ${reason}`)
        return false
      }
    }

    // 1. 关闭当前 db 句柄（即使已损坏也需关闭，避免文件锁阻塞 rename）
    try {
      this.db?.close()
    } catch (err) {
      logger.warn(t('main.db.log.closeCorruptedFailed'), err)
    }
    this.db = null

    // 1.5 释放所有持有 dbPath 连接的 worker 句柄（scanner / database / media 三个 utilityProcess worker）。
    // 若不先停止，Windows 上对"被其他进程打开的文件"执行 rename 会因 EPERM（共享冲突）失败，
    // 导致恢复失败且损坏库留在原地；更严重的是 rename 之后 runPostRestoreRepair 又会用
    // new Database(dbPath) 打开第三个连接，若旧 worker 句柄仍在，后续写入会落到被改名挪走的旧文件，造成数据分叉。
    // 此处仅停止进程、不置 isDisposed（stopWorkerForRestore 可逆），被停止的 worker 会在下次使用时
    // 经 ensureWorker(dbPath) 重新 fork 并打开还原后的库，即"重启 worker 重建连接"。
    // 启动期各 worker 尚未启动（worker 为 null）→ 此处为安全 no-op；同时覆盖"worker 已运行"的假设情形。
    logger.info(
      // eslint-disable-next-line no-restricted-syntax -- 诊断日志
      '[DBManager] 自恢复前停止 worker 以释放 dbPath 句柄（避免 rename 共享冲突）：' +
        `scanner=${this.scannerWorkerBridge ? 'stop' : 'n/a'}, ` +
        `database=${this.workerBridge ? 'stop' : 'n/a'}, ` +
        `media=${this.mediaWorkerBridge ? 'stop' : 'n/a'}`
    )
    await Promise.all([
      this.workerBridge?.stopWorkerForRestore(),
      this.scannerWorkerBridge?.stopWorkerForRestore(),
      this.mediaWorkerBridge?.stopWorkerForRestore()
    ])

    // 正确性边界确认：上方已 await 三个 worker 的 stopWorkerForRestore，各自在收到
    // *_DISPOSED 确认（或 2s 超时兜底 kill）后才置内部 this.worker = null。故此刻 dbPath
    // 句柄应已被所有持有它的进程释放，rename 覆盖前不应再有进程占用该文件（Windows 共享冲突 EPERM）。
    const liveWorkers = [
      this.workerBridge,
      this.scannerWorkerBridge,
      this.mediaWorkerBridge
    ].filter(
      (b) =>
        !!b &&
        typeof (b as { hasLiveWorker?: () => boolean }).hasLiveWorker === 'function' &&
        (b as { hasLiveWorker: () => boolean }).hasLiveWorker()
    )
    logger.info(
      `[DBManager] 自恢复前 worker 句柄释放确认：liveWorkers=${liveWorkers.length}（期望 0），` +
        // eslint-disable-next-line no-restricted-syntax -- 诊断日志
        'rename 覆盖 dbPath 前不应有进程持有该文件句柄'
    )
    // dev 下 fail-fast：任一 worker 仍存活（hasLiveWorker=true，即未被实际停止）则记录 fault 并抛错，
    // 使恢复进入既有失败分支（保留在线库、H1 提示），而非静默 EPERM 导致恢复失败且损坏库留原地。
    if (!app.isPackaged && liveWorkers.length > 0) {
      const err = new Error(
        `[DBManager] 自恢复并发边界被破坏：仍有 ${liveWorkers.length} 个 worker 未停止即准备 rename 覆盖 dbPath（${this.dbPath}），可能导致 Windows EPERM`
      )
      void logger.fault('databaseRestore', err, {
        dbPath: this.dbPath,
        stage: 'worker-handle-not-released',
        liveWorkerCount: liveWorkers.length
      })
      throw err
    }

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
        kind,
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
          logger.warn(t('main.db.log.restoreFailedReverted'), this.dbPath)
        }
        this.db = new (this.databaseCtor ?? (await getDatabaseImpl()))(this.dbPath)
      } catch (reopenErr) {
        logger.error(t('main.db.log.reopenAfterRestoreFailFailed'), reopenErr)
      }
      return false
    }

    // 5. 重新打开 db
    try {
      this.db = new (this.databaseCtor ?? (await getDatabaseImpl()))(this.dbPath)
    } catch (reopenErr) {
      logger.error(t('main.db.log.reopenAfterRestoreFailed'), reopenErr)
      const failureInfo = {
        success: false,
        reason: t('main.db.recovery.reopenFailed', {
          error: reopenErr instanceof Error ? reopenErr.message : String(reopenErr)
        }),
        kind,
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
      kind,
      sourceBackup: restoreResult.sourceBackup,
      corruptedBackupPath,
      timestamp: new Date().toISOString()
    }
    this.lastRecovery = successInfo
    void logger.fault(
      'databaseRestore',
      new Error(t('main.db.log.autoRestored', { message: restoreResult.message })),
      {
        dbPath: this.dbPath,
        corruptedBackupPath,
        sourceBackup: restoreResult.sourceBackup,
        stage: 'success'
      }
    )
    this.notifyRecovery(successInfo)
    return true
  }

  /**
   * H1：轻量 WAL 合并恢复——用独立连接对在线库执行 wal_checkpoint(TRUNCATE)，
   * 把已提交但尚未 checkpoint 的 WAL 事务合并回主库文件，并清理 -wal/-shm。
   * 数据保全（优于用 7 天前的备份覆盖）；仅当 WAL 损坏导致无法打开时调用。
   * @returns true=合并成功并已重新打开 db；false=合并失败（需回退破坏性备份恢复）
   */
  private async runWALRecovery(): Promise<boolean> {
    try {
      const Database = this.databaseCtor ?? (await getDatabaseImpl())
      if (this.db) {
        try {
          this.db.close()
        } catch {
          /* 忽略 */
        }
      }
      this.db = null
      // 独立连接执行 checkpoint；TRUNCATE 会把 WAL 内容写回主库并重置 WAL 文件
      const tmp = new Database(this.dbPath)
      try {
        tmp.pragma('wal_checkpoint(TRUNCATE)')
      } finally {
        try {
          tmp.close()
        } catch {
          /* 忽略 */
        }
      }
      // 重新以正常句柄打开合并后的主库
      this.db = new Database(this.dbPath)
      return true
    } catch (err) {
      // eslint-disable-next-line no-restricted-syntax -- 诊断日志
      logger.error('[DB] runWALRecovery 失败，将回退破坏性备份恢复:', err)
      if (this.db) {
        try {
          this.db.close()
        } catch {
          /* 忽略 */
        }
      }
      this.db = null
      return false
    }
  }

  /**
   * H1：对在线库做只读 integrity_check 门禁（不修改在线文件）。
   * 用于判断「疑似损坏」是否真实——库完好则不应被备份覆盖。
   * @returns true=在线库 integrity_check 通过（完好）；false=无法打开或校验未通过
   */
  private async isLiveDatabaseIntact(): Promise<boolean> {
    try {
      const Database = this.databaseCtor ?? (await getDatabaseImpl())
      const tmp = new Database(this.dbPath, { readonly: true, fileMustExist: true })
      try {
        const res = tmp.pragma('integrity_check', { simple: true })
        return res === 'ok'
      } finally {
        try {
          tmp.close()
        } catch {
          /* 忽略 */
        }
      }
    } catch {
      // 无法只读打开/校验 → 视为不完好，允许破坏性恢复
      return false
    }
  }

  /** H1：非破坏性失败的错误文案（含分类提示，供 bootstrapApplication 错误页展示） */
  private nonDestructiveErrorMessage(kind: DbFailureKind, err: unknown): string {
    const detail = errToText(err)
    switch (kind) {
      case DbFailureKind.ABI_INCOMPATIBLE:
        return t('main.db.error.abiIncompatible', { error: detail })
      case DbFailureKind.PERMISSION:
        return t('main.db.error.permissionDenied', { error: detail })
      case DbFailureKind.DISK_FULL:
        return t('main.db.error.diskFull', { error: detail })
      case DbFailureKind.LOCKED:
        return t('main.db.error.lockedByOtherProgram', { error: detail, retryError: detail })
      case DbFailureKind.UNKNOWN:
        return t('main.db.error.unknown', { error: detail })
      default:
        return t('main.db.error.openFailedAfterRecovery', { error: detail, retryError: detail })
    }
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
      logger.warn(t('main.db.log.corruptDbRenamed', { path: corruptPath }))
    } catch (_renameErr) {
      // rename 失败时尝试 copy（可能跨盘）
      try {
        fs.copyFileSync(this.dbPath, corruptPath)
        fs.unlinkSync(this.dbPath)
        logger.warn(t('main.db.log.corruptDbCopied', { path: corruptPath }))
      } catch (copyErr) {
        logger.error(t('main.db.log.corruptDbBackupFailed'), copyErr)
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
  private notifyRecovery(info: DatabaseRecoveryInfo): void {
    for (const listener of this.recoveryListeners) {
      try {
        listener(info)
      } catch (err) {
        logger.error(t('main.db.log.recoveryListenerFailed'), err)
      }
    }
  }

  /**
   * 获取最近一次恢复记录（供 Application 在 initialize 完成后查询）。
   * 注意：监听器可能在 initialize 期间还未注册，Application 通过此方法补查。
   */
  getLastRecovery(): DatabaseRecoveryInfo | null {
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
    if (!db) throw new Error(t('main.error.databaseNotInit'))

    const backupPath = this.createPreMigrationBackup()

    try {
      db.transaction(() => this.applyMigrations())()
    } catch (err) {
      await this.handleMigrationFailure(err, backupPath)
      // 向上抛出中断启动：迁移没成功就让 bootstrapApplication 弹错误页，
      // 好过带着一个 schema 不完整的库继续跑
      throw new Error(
        t('main.db.error.migrationFailedRolledBack', {
          error: err instanceof Error ? err.message : String(err)
        })
      )
    }
  }

  /** 已知的版本号迁移；任一未应用即视为"有待执行的迁移" */
  private static readonly KNOWN_MIGRATION_VERSIONS = [1, 2, 3]

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
      logger.info(t('main.db.log.preMigrationBackupCreated', { path: backupPath }))
      return backupPath
    } catch (err) {
      // 备份失败不阻塞迁移：事务回滚本身已保证原子性，备份只是额外兜底
      logger.warn(
        t('main.db.log.preMigrationBackupFailed'),
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
    logger.error(t('main.db.log.migrationFailedTxRolledBack', { message }))
    void logger.fault('databaseCorruption', err, {
      dbPath: this.dbPath,
      stage: 'migration-failed',
      backupPath
    })

    if (this.isDatabaseUsable()) return

    if (!backupPath || !fs.existsSync(backupPath)) {
      logger.error(t('main.db.log.migrationFailedNoBackup'))
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
        reason: t('main.db.error.migrationRolledBackToBackup', { filename }),
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
      const reason = t('main.db.error.rollbackToBackupFailed', {
        error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr)
      })
      const info = {
        success: false,
        reason,
        sourceBackup: { filePath: backupPath, filename },
        timestamp: new Date().toISOString()
      }
      this.lastRecovery = info
      logger.error(`[DB] ${reason}`)
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
    if (!this.db) throw new Error(t('main.error.databaseNotInit'))

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
      logger.warn(t('main.db.log.operationHistoryCleanupFailed'), err)
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
        created_at TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0
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

    // 插入默认系统分类：name 存稳定 key（people/location/...），UI 层经
    // categories.system.* 翻译；存量库的中文默认名由 migrateSystemCategoryKeys()（版本 3）迁移
    this.migrateSystemCategoryKeys()
    const defaultCategories = [
      { name: 'people', icon: 'people', color: '#FF6B6B', sort_order: 1, is_system: 1 },
      { name: 'location', icon: 'location', color: '#4ECDC4', sort_order: 2, is_system: 1 },
      { name: 'scene', icon: 'scene', color: '#45B7D1', sort_order: 3, is_system: 1 },
      { name: 'screenshot', icon: 'screenshot', color: '#96CEB4', sort_order: 4, is_system: 1 },
      { name: 'recording', icon: 'recording', color: '#FFEAA7', sort_order: 5, is_system: 1 },
      { name: 'recent', icon: 'recent', color: '#DDA0DD', sort_order: 6, is_system: 1 },
      { name: 'favorite', icon: 'favorite', color: '#FD79A8', sort_order: 7, is_system: 1 }
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
    // 迁移：delete_origin 记录软删除来源（'user' 用户主动 / 'root' 移除扫描源触发）
    this.migrateDeleteOrigin()

    // 迁移：import_roots 增加 disabled 列（指定目录"关闭但保留记录"语义）
    // 已发布库无此列，用 safeEnsureColumn 幂等 ALTER 补充；新库由建表 DDL 直接含列
    this.migrateImportRootsDisabled()

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
    // 同步集成阶段2（docs/sync-integration/02）：NikkiSync 适配层——media_files.sha256 列。
    // 协议 MediaResource.sha256 必填且资源 ETag 依赖其稳定；逐次全文件哈希对大视频
    // 不可接受，需持久缓存。nullable：NULL=未计算，由适配层首次访问时惰性计算并回写，
    // 不改动任何现有列的语义；不批量回填（阶段3可挂扫描任务渐进填充）
    this.migrateSyncSha256Column()

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
      'CREATE INDEX IF NOT EXISTS idx_media_files_scene_analysis ON media_files(scene_time, file_type, is_deleted)',
      // ===== 收藏夹示例域（对应 ipc/handlers/favorites-handler.ts 的 favorites:* 通道） =====
      // 纯新增表、CREATE TABLE IF NOT EXISTS 幂等；media_id UNIQUE 兜底"已在收藏夹"不变量
      'CREATE TABLE IF NOT EXISTS favorites (id INTEGER PRIMARY KEY AUTOINCREMENT, media_id INTEGER NOT NULL UNIQUE, created_at TEXT NOT NULL)',
      // ===== 共鸣录板块（gongeo.us-nikki-tracker 逻辑复用，MIT） =====
      // 共鸣录 6 张新表：抽卡记录 / 手动补录 / Pearpal 承接 / 进化覆盖 / 衣橱拥有项 / 卡池心愿单。
      // 纯新增表、CREATE TABLE IF NOT EXISTS 幂等，无数据回填（不需要版本标记）；
      // 表语句置于索引语句之前，走上方同一个幂等执行循环。
      "CREATE TABLE IF NOT EXISTS resonance_pulls (id INTEGER PRIMARY KEY AUTOINCREMENT, banner_id TEXT NOT NULL, item_id TEXT NOT NULL, obtained_at TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('json','manual-import')), created_at TEXT NOT NULL, UNIQUE (banner_id, obtained_at, item_id))",
      'CREATE TABLE IF NOT EXISTS resonance_edits (id INTEGER PRIMARY KEY AUTOINCREMENT, banner_id TEXT NOT NULL, item_id TEXT NOT NULL, obtained_at TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (banner_id, item_id))',
      'CREATE TABLE IF NOT EXISTS resonance_pearpal (banner_id TEXT NOT NULL, item_id TEXT NOT NULL, pool_cnt INTEGER NOT NULL, obtained_at TEXT NOT NULL, raw_json TEXT NOT NULL, UNIQUE (banner_id, item_id, pool_cnt))',
      'CREATE TABLE IF NOT EXISTS resonance_evo (banner_id TEXT NOT NULL, outfit_id TEXT NOT NULL, level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 4), updated_at TEXT NOT NULL, UNIQUE (banner_id, outfit_id))',
      "CREATE TABLE IF NOT EXISTS resonance_wardrobe_items (category TEXT NOT NULL CHECK (category IN ('item','makeup','momo','prop','eureka_color')), item_id INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (category, item_id))",
      'CREATE TABLE IF NOT EXISTS resonance_banner_wishlist (banner_id INTEGER NOT NULL, UNIQUE (banner_id))',
      'CREATE INDEX IF NOT EXISTS idx_resonance_pulls_banner ON resonance_pulls(banner_id, obtained_at)',
      'CREATE INDEX IF NOT EXISTS idx_resonance_edits_banner ON resonance_edits(banner_id)',
      'CREATE INDEX IF NOT EXISTS idx_resonance_pearpal_banner ON resonance_pearpal(banner_id)',
      // ===== 同步集成阶段2（docs/sync-integration/02）：NikkiSync 适配层元数据表 =====
      // 设备配对 / 变更日志（append-only） / 服务元数据（单行 revision 镜像+身份） /
      // 动态照片配对链接。纯新增表、CREATE TABLE IF NOT EXISTS 幂等，无数据回填
      // （不需要版本标记）；DDL 单一事实源在 sync-metadata-repository.ts 导出，
      // 仓储层测试的内存引擎按同一 schema 建表
      ...SYNC_METADATA_DDL_STATEMENTS,
      // ===== 同步集成阶段3（docs/sync-integration/03）：一次性配对令牌会话表 =====
      // 配对服务（src/main/sync/pairing-service.ts）持久化底座：只存令牌 sha256，
      // 一次性消费靠 used_at 置位。纯新增表、幂等，DDL 单一事实源在
      // sync-pairing-repository.ts 导出
      ...SYNC_PAIRING_DDL_STATEMENTS,
      // ===== 同步集成阶段4（docs/sync-integration/04-ui-bridge-plan）：资产编辑叠加层 =====
      // 纯新增表、CREATE TABLE IF NOT EXISTS 幂等、无数据回填（不需要版本标记），
      // DDL 单一事实源在 asset-edits-repository.ts 导出。用户专有编辑按 asset_id
      // 另存一层，图库以 assets 为媒体事实源后不再靠 media_files 提供这些字段。
      ...ASSET_EDITS_DDL_STATEMENTS
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
            t('main.db.error.indexCreationFailed', {
              stmt,
              error: err instanceof Error ? err.message : String(err)
            })
          )
        }
        logger.warn(t('main.db.log.indexExistsIgnored', { stmt }))
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
              t('main.db.error.v3IndexCreationFailed', {
                sql,
                error: err instanceof Error ? err.message : String(err)
              })
            )
          }
          logger.warn(t('main.db.log.v3IndexExistsIgnored', { sql }))
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
          logger.warn(t('main.db.log.fts5Unavailable'), msg)
        }
      }

      // 5. 标记迁移完成（与上面的 DDL 同属一个事务，一起提交或一起回滚）
      this.markMigrationVersionApplied(1)
      logger.info(t('main.db.log.v3MigrationDone'))
    } catch (err) {
      // 必须重新抛出：本方法跑在 runMigrations 的事务内，
      // 在这里吞掉错误会让事务照常提交，留下"部分索引已建、版本未标记"的半迁移状态
      logger.error(t('main.db.log.v3MigrationFailed'), err instanceof Error ? err.message : err)
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
      throw new Error(t('main.db.error.addColumnFailed', { tableName, columnDef, msg }))
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
          t('main.db.log.backfillApplied', {
            table: tableName,
            column: colName,
            value: defaultValue,
            rows: result.changes
          })
        )
      }
    } catch (err) {
      logger.warn(
        t('main.db.log.backfillFailed', {
          sql: `UPDATE ${tableName} SET ${colName} = ${defaultValue} WHERE ${colName} IS NULL`
        }),
        err instanceof Error ? err.message : err
      )
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
    // NOTE（i18n 暂缓项）: album_type 列默认值 '其他' 直接存中文标签。全量 key 化需同时处理
    // 三种历史形态（扫描器写入的中文标签 / 旧版英文目录名 / DDL 默认值），并联动
    // media-repository 的 WHERE 等值查询、GROUP BY 分组、ExifPanel 比较、
    // scanner/path-classifier 与 decryption 的 ALBUM_TYPE_MAP。涉及数据迁移与查询语义变更，
    // 宜作为独立任务处理，不在本次 i18n 清理范围内。
    this.safeEnsureColumn('media_files', "album_type TEXT NOT NULL DEFAULT '其他'") // eslint-disable-line no-restricted-syntax -- 存量 DDL 默认值，随上述迁移一并 key 化
  }

  /**
   * 版本 3：i18n key 化存量默认数据
   * - 系统分类名：中文默认名（人物/地点/…）→ 稳定 key（people/location/…），UI 层经 categories.system.* 翻译
   * - 默认档案：中文昵称 '默认档案' → ''（UI 层对 uid='default' 回退 t('profile.defaultProfile')）
   *
   * 仅按"仍为默认中文值"匹配，用户改过名的行不受影响。
   * 必须在 applyMigrations 的默认分类 INSERT 之前调用：旧库先改名、INSERT OR IGNORE key
   * 直接命中现有行不会产生重复；新库无旧值，均为 no-op。
   */
  private migrateSystemCategoryKeys(): void {
    if (!this.db) return
    if (this.isMigrationVersionApplied(3)) return
    try {
      const legacyCategoryNames: Array<[string, string]> = [
        // eslint-disable-next-line no-restricted-syntax -- 数据迁移匹配值（存量中文默认名，非 UI 文案）
        ['人物', 'people'],
        // eslint-disable-next-line no-restricted-syntax -- 数据迁移匹配值（存量中文默认名，非 UI 文案）
        ['地点', 'location'],
        // eslint-disable-next-line no-restricted-syntax -- 数据迁移匹配值（存量中文默认名，非 UI 文案）
        ['场景', 'scene'],
        // eslint-disable-next-line no-restricted-syntax -- 数据迁移匹配值（存量中文默认名，非 UI 文案）
        ['截图', 'screenshot'],
        // eslint-disable-next-line no-restricted-syntax -- 数据迁移匹配值（存量中文默认名，非 UI 文案）
        ['录屏', 'recording'],
        // eslint-disable-next-line no-restricted-syntax -- 数据迁移匹配值（存量中文默认名，非 UI 文案）
        ['最近', 'recent'],
        // eslint-disable-next-line no-restricted-syntax -- 数据迁移匹配值（存量中文默认名，非 UI 文案）
        ['收藏', 'favorite']
      ]
      const rename = this.db.prepare(
        'UPDATE categories SET name = ? WHERE is_system = 1 AND name = ?'
      )
      for (const [legacy, key] of legacyCategoryNames) {
        rename.run(key, legacy)
      }
      // 默认档案昵称重置独立容错：新库此时尚无 character_profiles 表（稍后才创建），UPDATE 报错直接跳过
      try {
        this.db
          .prepare(
            "UPDATE character_profiles SET nickname = '' WHERE uid = 'default' AND nickname = '默认档案'" // eslint-disable-line no-restricted-syntax -- 数据迁移匹配值（存量中文默认档案昵称，非 UI 文案）
          )
          .run()
      } catch {
        /* 表不存在（新库首次初始化路径）：跳过 */
      }
      this.markMigrationVersionApplied(3)
    } catch (err) {
      // 迁移失败不阻塞启动：UI 侧分类名格式化函数对未知值原样显示，仅损失翻译
      logger.warn(t('main.db.log.systemCategoryKeyMigrationFailed'), err)
    }
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
    // 插入默认档案（若不存在）：nickname 留空，UI 层对 uid='default' 回退到
    // t('profile.defaultProfile') 翻译；存量库的中文昵称由 migrateSystemCategoryKeys()（版本 3）迁移
    this.db
      .prepare(
        "INSERT OR IGNORE INTO character_profiles (uid, nickname, created_at) VALUES ('default', '', datetime('now'))"
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
   * 软删除来源标记（回收站语义修复：用户删除不得被重扫复活）。
   *
   * - 'user'：`media:softDelete` 触发的用户主动删除——文件保留在原路径仅打标记，
   *   重扫时**不得**把 is_deleted 复位回 0，否则表现为"删了又回来"。
   * - 'root'：`softDeleteByRootPath`（移除扫描源且清空记录）触发的整批软删，
   *   重扫重新发现后允许复位回图库，保持既有行为。
   * - NULL：存量旧记录，重扫行为与修复前一致（可复活），不引入回归。
   *
   * 无 DEFAULT 子句，NULL 即预期默认值（与 phash TEXT 同构，safeEnsureColumn 不回填）。
   */
  private migrateDeleteOrigin(): void {
    if (!this.db) return
    this.safeEnsureColumn('media_files', 'delete_origin TEXT')
  }

  /**
   * import_roots 增加 disabled 列（指定目录"关闭但保留记录"语义，L-指定目录缓存显示缺陷修复）。
   * disabled=0 表示启用（图库放行、缓存排除）；=1 表示关闭（图库与缓存均不显示，记录保留可恢复）。
   * 新建库由建表 DDL 直接含列；已发布库通过 safeEnsureColumn 幂等 ALTER 补充，列已存在时静默跳过。
   */
  private migrateImportRootsDisabled(): void {
    if (!this.db) return
    this.safeEnsureColumn('import_roots', 'disabled INTEGER NOT NULL DEFAULT 0')
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

  /**
   * 同步集成阶段2：NikkiSync 适配层的 sha256 缓存列。
   * 协议 MediaResource.sha256 必填（资源 ETag / 客户端去重依赖），而 media_files
   * 原生无哈希列、运行时逐次全文件哈希对大视频不可接受。nullable：
   * NULL=未计算，由 sync-read-repository 首次访问时惰性计算并回写（走参数绑定）。
   * safeEnsureColumn 保证幂等；无默认值 → 存量行为 NULL，不做批量回填。
   */
  private migrateSyncSha256Column(): void {
    if (!this.db) return
    this.safeEnsureColumn('media_files', 'sha256 TEXT')
  }

  private migrateSceneCategory(): void {
    if (!this.db) return

    // 1. 添加字段（safeEnsureColumn 区分"列已存在"和其他错误，R16 列已存在时补回填默认值）
    this.safeEnsureColumn('media_files', 'scene_category TEXT')
    // 子任务7：内嵌 XMP 元数据列（wxnn 命名空间 EditorData JSON）。
    // 游戏原生截图不含此元数据故恒为 NULL；列已存在时 safeEnsureColumn 静默跳过。
    this.safeEnsureColumn('media_files', 'editor_metadata TEXT')

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
        logger.info(t('main.db.log.sceneCategoryMigrated', { count: rows.length }))
      }

      // 标记迁移已完成（与回填同属外层事务，一起提交或一起回滚）
      this.markMigrationVersionApplied(2)
    } catch (error) {
      // 必须重新抛出：吞掉会让外层事务照常提交，留下"部分记录已回填、版本未标记"的状态
      logger.error(t('main.db.log.sceneCategoryMigrationFailed'), error)
      throw error
    }
  }

  query(sql: string, params?: unknown[]): unknown[] {
    if (!this.db) throw new Error(t('main.error.databaseNotInit'))
    return this.db.prepare(sql).all(params || [])
  }

  execute(sql: string, params?: unknown[]): DatabaseType.RunResult {
    if (!this.db) throw new Error(t('main.error.databaseNotInit'))
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
        logger.warn(t('main.db.log.settingTypeMismatch', { key }))
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
        logger.warn(t('main.db.log.exitOptimizeFailed'), err)
      }
      // 退出前执行 WAL checkpoint，将 WAL 日志写回主数据库文件，防止异常退出丢数据
      // 修复 A-F4/C-S6：原实现直接 close()，WAL 文件未 checkpoint，异常退出可能丢数据
      // P1-A8：wal_checkpoint(TRUNCATE) 会阻塞等待所有读者结束，万级日志下可能超 2s
      //        导致 before-quit 强制退出但 WAL 仍未合并。改用 PASSIVE 不阻塞，
      //        尽力 checkpoint 当前可 checkpoint 的页，剩余部分由下次启动时 SQLite 自动恢复
      try {
        this.db.pragma('wal_checkpoint(PASSIVE)')
      } catch (error) {
        logger.error(t('main.db.log.walCheckpointFailed'), error)
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
