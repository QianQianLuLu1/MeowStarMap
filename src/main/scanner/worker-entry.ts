/**
 * 扫描 worker 进程入口
 *
 * 由主进程通过 utilityProcess.fork() 启动，承载全部扫描核心逻辑（迁移自 ScannerManager）。
 * - 独立打开 better-sqlite3 连接（与主进程 DatabaseManager 共享同一 db 文件，WAL 模式并发）
 * - 通过 process.parentPort 与主进程通信（SCAN_START/STOP/DISPOSE → SCAN_PROGRESS/COMPLETE/LOG）
 * - 收到 SCAN_DISPOSE 时主动关闭 DB + kill 子进程 + 退出
 *
 * 改造点（相对原 ScannerManager）：
 * 1. DB 连接：worker 内部 new Database(dbPath)，配置与主进程一致的 PRAGMA + busy_timeout=5000
 * 2. EventEmitter emit('progress') → process.parentPort.postMessage({ type: 'SCAN_PROGRESS' })
 * 3. logger → workerLog（warn/error 通过 SCAN_LOG 转发到主进程，info 级别丢弃以减少 IPC 开销）
 * 4. shouldStop 改为共享中止标志（scan-abort.ts），由 SCAN_STOP 消息设置
 * 5. repairLegacyData 中 dbManager 调用改为直接查询 schema_migrations 表（worker 不持有 DatabaseManager）
 * 6. ffprobe 路径：直接 import video-probe（resolveAsarUnpackedPath 已处理路径修正）
 * 7. insertStmtCache / realpathCache 保持原缓存机制，每次 SCAN_START 时清空
 */
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
// 步骤4：原生模块改为惰性加载，使 ABI 不匹配时崩溃能被 worker 的未捕获异常处理捕获并发送 WORKER_ERROR
// 而非在模块加载期静默崩溃导致 worker 进程直接消失
import type DatabaseType from 'better-sqlite3'
import { detectSceneCategory } from '../../shared/scene-category'
// C-3：统一媒体扩展名常量（取代本文件内联定义）
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '../utils/media-constants'
import { runWithConcurrency } from '../utils/concurrency'
// 建议改#1：复用共享 ffprobe 实现（取代本文件 getVideoMetadata 私有方法）
import { probeVideoMetadata } from '../utils/video-probe'
// 修复旧数据 V1/V3：抽取为独立模块，便于单元测试（不依赖 worker 上下文）
import { repairLegacyDataV1 } from './repair-legacy-data-v1'
import { repairLegacyDataV3 } from './repair-legacy-data-v3'
import { repairLegacyDataV4 } from './repair-legacy-data-v4'
import { repairLegacyDataV5 } from './repair-legacy-data-v5'
import { repairLegacyDataV6 } from './repair-legacy-data-v6'
// T02 修复：文件完整性校验差量过滤（按本次增量扫描覆盖的根目录集合）
import { buildIntegrityRootFilter, normalizeRootPrefixForLike } from './integrity-root-filter'
// P2-2：SQLITE_BUSY 感知写入重试封装（包裹批量写入事务，吸收瞬时锁冲突）
import { executeWriteSafely, walCheckpoint } from './sqlite-retry'
import { t } from '../i18n/worker-safe'
// C-G3：共享命名常量（取代魔法数字）
// TDD 重构：路径分类纯函数抽取到独立文件，便于单元测试（无 electron/sharp/ffmpeg 依赖）
import {
  extractUidFromPath,
  extractAlbumTypeFromPath,
  extractMediaSourceFromPath,
  gateAccountUid,
  isGatedVirtualUid,
  resolveNativeThumbnailPath
} from './path-classifier'
// 子任务7：复用现有 XMP 服务读取高清图内嵌元数据（wxnn 命名空间 EditorData）。
// 游戏原生截图无此 XMP，readMetadataFromFile 返回 null；差距标注见本文件图片分支注释。
import { readMetadataFromFile } from '../services/xmp-metadata-service'
// 方案三：独立游戏目录 UID 发现机制（对齐上游 nikki_albums）
import { discoverUidsFromGameDirs } from './uid-discovery'
// 回收站语义修复：重扫复位谓词（排除用户主动软删 delete_origin='user' 的记录）
import { RESCAN_RESTORE_PREDICATE } from './rescan-restore-sql'
// P0-01：游戏目录发现函数抽取为独立模块，便于单元测试 vi.mock 桩替换（循环依赖仅调用期使用，ESM 安全）
import { findGameInstallRootsByPriority, normalizeCustomGameRoot } from './game-directory-discovery'
import { isOfficialAlbumDir } from './gameplayphotos-root'
import { resolveScanChannels } from './scan-channels'
import type { ChannelLogger } from './scan-channels'
// 扫描中止标志：独立零依赖模块（严禁反向 import worker-entry——会把 15s 心跳看门狗带进主进程）
import { abortScan, isScanAborted, resetScanAbort } from './scan-abort'

// spec 三：GamePlayPhotos 子树强制遍历豁免判定（纯函数，便于单测）。
// 返回 true 表示该根目录下的「缓存子目录跳过」与「小图过滤」均不生效，
// 强制递归遍历全部层级与文件，与 nikki_albums 遍历行为一致；
// ScreenShot 等其他来源返回 false，仍走原过滤逻辑。
// 注意：isGamePlayPhotosPath 要求尾部带分隔符（面向文件路径），而扫描根本身即
// ...\X6Game\Saved\GamePlayPhotos（无尾部分隔符），故此处同时匹配根目录与所有后代子路径。
// 豁免命中的完整路径段（归一化后，小写 + 反斜杠）。
// 两段并列：`X6Game\Saved\GamePlayPhotos`（标准）与 `X6Game\GamePlayPhotos`（需求二.2 兼容变体）。
// 仍要求 X6Game 父段，用户自建同名目录（如 C:\backup\GamePlayPhotos）不会被误豁免。
const GAMEPLAYPHOTOS_EXEMPT_SEGMENTS = [
  '\\x6game\\saved\\gameplayphotos',
  '\\x6game\\gameplayphotos'
]
export function isGamePlayPhotosScanExempt(rootPath: string): boolean {
  if (!rootPath) return false
  const normalized = rootPath.replace(/\//g, '\\').toLowerCase()
  return GAMEPLAYPHOTOS_EXEMPT_SEGMENTS.some(
    (seg) => normalized === seg || normalized.endsWith(seg) || normalized.includes(seg + '\\')
  )
}
// P2-1：复用主进程已有的 asar 解包路径修正工具，确保 worker 加载 better-sqlite3 与主进程行为一致
import { resolveAsarUnpackedPath } from '../utils/ffmpeg-paths'
// 子进程注册表：worker 退出时 kill 所有活跃的 ffmpeg/ffprobe 子进程
import { killAllProcesses } from '../utils/process-registry'
import { installFfmpegSpawnGuard } from '../utils/fluent-ffmpeg-shim'
import type {
  WorkerCommand,
  WorkerEvent,
  ScanOptions,
  ScanProgress,
  MediaFile
} from './worker-protocol'

// fluent-ffmpeg spawn 逃逸垫片：本 worker 任何 ffmpeg .run()/探测之前尽早安装（幂等）。
// 将损坏二进制导致的 spawn 同步抛错（EFTYPE）收敛为回调错误，避免 worker 进程崩溃。
installFfmpegSpawnGuard()

// ============ 常量（保持原值，禁止改值） ============

// A-S5：扫描深度限制（默认 10），防止过深递归
// 修复：原值 10 不足以扫描游戏目录的完整深度（X6Game\Plugins\PaperSDK\... 可达 12+ 层）
// 提升至 15 确保所有媒体子目录都能被递归扫描
const MAX_SCAN_DEPTH = 15
// A-S6：流式写入分批大小（每 500 条 INSERT 一次），降低峰值内存
const SCAN_BATCH_SIZE = 500

// 游戏特征文件（全盘文件名签名搜索的核心签名）
// P0修复：扫描时跳过的缓存子目录名（大小写不敏感匹配）
const CACHE_DIR_NAMES = new Set([
  'cache',
  'temp',
  'tmp',
  'thumbnail',
  'thumbnails',
  'preview',
  'previews',
  '.thumbs',
  'thumb'
])

// ============ worker 模块级状态 ============

// 惰性加载 better-sqlite3：首次调用时才 require
let DatabaseImpl: typeof import('better-sqlite3') | null = null
function getDatabaseImpl(): typeof import('better-sqlite3') {
  if (!DatabaseImpl) {
    // P2-1：显式解析 asar 解包路径，避免打包环境下 worker 加载 asar 内的原生模块失败
    // require.resolve 返回模块绝对路径（在 asar 内时为 .../app.asar/node_modules/better-sqlite3/...），
    // 通过 resolveAsarUnpackedPath 替换为 app.asar.unpacked 路径，与主进程对 ffmpeg-static 的处理保持一致
    let modulePath = 'better-sqlite3'
    try {
      modulePath = resolveAsarUnpackedPath(require.resolve('better-sqlite3'))
    } catch {
      // require.resolve 失败（如 Vitest mock 环境）时回退到直接 require('better-sqlite3')
      // 保持与原行为兼容，避免测试环境破坏
    }
    const mod = require(modulePath)
    // 真实 better-sqlite3 是 CJS 模块，require 返回构造函数本身；Vitest mock 返回 { default: ... }
    DatabaseImpl = (
      typeof mod === 'function' ? mod : mod.default
    ) as typeof import('better-sqlite3')
  }
  return DatabaseImpl
}

let db: DatabaseType.Database | null = null
let currentDbPath = ''
// R14：主进程心跳时间戳。主进程每 5s 发送 WORKER_PING，worker 每 5s 检查一次，
// 超过 15s（3 次未收到）视为父进程已退出/崩溃，立即停止扫描并清理退出。
let lastPingTime = Date.now()
let progress: ScanProgress = {
  scanned: 0,
  found: 0,
  currentPath: '',
  status: 'idle'
}
// C-G6：缓存 saveBatchToDatabase 的 prepared statement，避免每个批次都重新 prepare
// 生命周期：db 变化时置空，下次调用 saveBatchToDatabase 时重新 prepare
let insertStmtCache: DatabaseType.Statement | null = null
// 方案二：缓存 character_profiles INSERT OR IGNORE 语句，扫描时自动注册发现的 UID
// 生命周期：db 变化时置空，下次调用 autoRegisterUid 时重新 prepare
let insertProfileStmtCache: DatabaseType.Statement | null = null
// P1-A3：realpath 结果缓存，避免对同一路径重复调用 fsp.realpath（符号链接解析 IO 开销）
// 生命周期：每次 startScan 开始时清空
const realpathCache = new Map<string, string>()

// P0-02 可观测性：被虚拟 UID 闸门拦截（路径含时间戳/活动ID等虚拟段、非 'default' 来源、未命中允许集）
// 归 'default' 的累计计数。用于区分「路径本无 UID（合法）」与「虚拟段被拦截」，便于事后与 nikki_albums 核对。
// 每次 startScan 开始时归零，跨多个扫描根累计。
let gatedVirtualUidCount = 0

// ============ worker log 转发 ============

/**
 * worker 内部日志转发。
 * - info 级别在 worker 内部丢弃（避免跨进程 IPC 开销）
 * - warn / error 级别通过 SCAN_LOG 转发到主进程，由主进程 logger 统一记录
 */
export function workerLog(
  level: 'info' | 'warn' | 'error',
  message: string,
  ...args: unknown[]
): void {
  if (level === 'info') return
  try {
    const event: WorkerEvent = {
      type: 'SCAN_LOG',
      payload: { level, message, args: args.length > 0 ? args : undefined }
    }
    process.parentPort?.postMessage(event)
  } catch {
    // parentPort 不可用时丢弃日志，避免日志本身导致 worker 崩溃
  }
}

/** 发送事件到主进程 */
function sendEvent(event: WorkerEvent): void {
  try {
    process.parentPort?.postMessage(event)
  } catch {
    // parentPort 不可用时丢弃事件
  }
}

/**
 * 目录发现结论日志透传（绕过 workerLog 的 info 屏蔽）。
 * 仅用于每次扫描至多一条汇总 + N 个目录行（N 通常 < 10）的低频关键诊断信息，
 * 不改变"逐文件 info 丢弃"的性能决策。
 */
// 全链路诊断日志发送器（抽到 scan-logger 避免与 game-directory-discovery 循环依赖）
import { sendScanLogInfo, sendScanLogEntry } from './scan-logger'
import { classifyFsError } from './scan-log-store'

// ============ 进度推送（保持原 500ms 节流） ============

let lastProgressEmit = 0

function emitProgress(force = false): void {
  const now = Date.now()
  if (force || now - lastProgressEmit >= 500) {
    lastProgressEmit = now
    sendEvent({ type: 'SCAN_PROGRESS', payload: { ...progress } })
  }
}

// ============ 工具方法（迁移自 ScannerManager） ============

/**
 * P1-A3：带缓存的 realpath，避免对同一路径重复调用 fsp.realpath
 * 符号链接解析涉及系统调用，全盘搜索时同一路径可能被多个驱动器任务重复解析
 */
async function cachedRealpath(dir: string): Promise<string> {
  const cached = realpathCache.get(dir)
  if (cached) return cached
  const real = await fsp.realpath(dir)
  realpathCache.set(dir, real)
  return real
}

// ============ P0-02 虚拟 UID 闸门可观测性 ============

/**
 * 对比 gateAccountUid 的返回值与原 rawUid：命中「原非 default、但结果为 default、且允许集非空」
 * 时累加诊断计数 gatedVirtualUidCount（代表该路径含虚拟 UID 段被拦截，而非合法无 UID）。
 * @param rawUid extractUidFromPath 的原始返回值（'default' 表示路径无 UID 段）
 * @param gatedUid gateAccountUid 的闸门结果
 * @param validUids 允许集（discoverUidsFromGameDirs 发现的真实 UID）；空/未提供时闸门不生效，不计数
 */
function observeUidGate(rawUid: string, gatedUid: string, validUids?: Set<string> | null): void {
  if (isGatedVirtualUid(rawUid, gatedUid, validUids)) {
    gatedVirtualUidCount++
  }
}

/**
 * 统一构造 SCAN_COMPLETE 结果：附带 gatedVirtualUidCount，并在计数 > 0 时输出一条汇总诊断日志
 * （逐条打日志会淹没 IPC/日志，故仅在扫描结束汇总一次）。
 */
function makeScanCompleteResult(
  success: boolean,
  message: string,
  filesFound?: number
): { success: boolean; message: string; filesFound?: number; gatedVirtualUidCount?: number } {
  if (gatedVirtualUidCount > 0) {
    sendScanLogEntry({
      stage: 'uid-gate',
      level: 'info',
      kind: 'ok',
      message: `[UID-Gate] 本次扫描有 ${gatedVirtualUidCount} 个含虚拟 UID 段（时间戳/活动ID/嵌套数字目录）的路径被闸门拦截归 default`,
      detail: { gatedVirtualUidCount }
    })
  }
  return { success, message, filesFound, gatedVirtualUidCount }
}

// ============ 修复旧数据 ============

// 修复旧数据 V1（误扫描清理 + 字段重算）：抽取为独立模块 `repair-legacy-data-v1.ts`，
// 便于单元测试（不依赖 worker 上下文）。worker-entry 仅负责把 db 和 workerLog 注入。
// R10（M8）：V1 内部把"删除 + NULL 修复 + 字段重算"三步合并到同一个事务。

/**
 * 修复旧数据 V2：缓存图片分类修复
 *
 * 问题背景：P0 修复前，扫描器未跳过缓存子目录、未过滤小文件，
 * 导致缓存图片被分类为 'game' 并显示在图库默认视图中。
 *
 * 修复内容：
 * 1. 对 media_source='game' 的记录重新运行 extractMediaSourceFromPath（使用更新后的规则）
 * 2. 将 file_size < 5KB 的图片记录的 media_source 更新为 'launcher'
 *
 * 通过 schema_migrations 表的 'repair_legacy_data_v2' 标记确保只执行一次
 */
// FIX(组3-4): 返回是否成功——worker-entry 据此决定是否中止后续 V3/V4 修复步骤
function repairLegacyDataV2(): boolean {
  if (!db) return true

  // 检查迁移是否已应用
  try {
    const applied = db
      .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
      .get('repair_legacy_data_v2')
    if (applied) return true
  } catch {
    // schema_migrations 表可能尚未创建，降级为每次执行
  }

  try {
    // 1. 重新分类所有 game 记录（使用更新后的 extractMediaSourceFromPath）
    // 包含 NULL 记录（repairLegacyData 已修复为 'game'，但防御性覆盖）
    const gameFiles = db
      .prepare(
        "SELECT id, file_path FROM media_files WHERE media_source = 'game' OR media_source IS NULL"
      )
      .all() as Array<{ id: number; file_path: string }>

    let reclassifiedCount = 0
    if (gameFiles.length > 0) {
      const updateStmt = db.prepare('UPDATE media_files SET media_source = ? WHERE id = ?')
      const updateMany = db.transaction((files: Array<{ id: number; file_path: string }>) => {
        for (const file of files) {
          const newSource = extractMediaSourceFromPath(file.file_path)
          if (newSource !== 'game') {
            updateStmt.run(newSource, file.id)
            reclassifiedCount++
          }
        }
      })
      updateMany(gameFiles)
    }

    // 2. 将过小的图片文件（< 5KB）标记为 launcher
    const smallFiles = db
      .prepare(
        "SELECT id FROM media_files WHERE media_source = 'game' AND file_type = 'image' AND file_size < 5120"
      )
      .all() as Array<{ id: number }>

    if (smallFiles.length > 0) {
      const updateSmall = db.prepare(
        "UPDATE media_files SET media_source = 'launcher' WHERE id = ?"
      )
      const updateManySmall = db.transaction((ids: number[]) => {
        for (const id of ids) updateSmall.run(id)
      })
      updateManySmall(smallFiles.map((f) => f.id))
    }

    workerLog(
      'info',
      `[Scanner] repairLegacyDataV2: 重新分类 ${reclassifiedCount} 条记录，标记 ${smallFiles.length} 条小文件为 launcher`
    )

    // 标记迁移已完成
    try {
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, datetime('now'))"
      ).run('repair_legacy_data_v2')
    } catch (markErr) {
      workerLog(
        'warn',
        t('main.scanner.log.markMigrationV2Failed'),
        markErr instanceof Error ? markErr.message : String(markErr)
      )
    }
  } catch (err) {
    workerLog(
      'error',
      t('main.scanner.log.repairV2Failed'),
      err instanceof Error ? err.message : String(err)
    )
    // FIX(组3-4): 返回失败标志，调用方中止后续修复步骤
    return false
  }
  return true
}

// ============ 扫描历史记录 ============

function insertScanHistory(scanType: string): number {
  if (!db) return 0
  const result = db
    .prepare(
      "INSERT INTO scan_history (scan_type, start_time, status) VALUES (?, datetime('now'), 'running')"
    )
    .run(scanType)
  return Number(result.lastInsertRowid)
}

function updateScanHistory(id: number, status: string, filesFound: number, filesNew: number): void {
  if (!db) return
  db.prepare(
    "UPDATE scan_history SET end_time = datetime('now'), files_found = ?, files_new = ?, status = ? WHERE id = ?"
  ).run(filesFound, filesNew, status, id)
}

// ============ 文件完整性校验 ============

/**
 * T02：文件完整性校验
 * 对数据库中所有未软删除的记录检查文件是否存在
 * 连续两次缺失才标记 is_missing=1，一次出现即恢复
 *
 * C-F1 修复：原实现使用同步 fs.existsSync 逐条检查，万级文件下阻塞主进程数秒。
 * 现改为 fsp.access 异步 + runWithConcurrency(8) 并发检查，文件存在性检查不再阻塞事件循环。
 * DB 事务仍同步执行（better-sqlite3 特性），但仅在收集完结果后执行一次。
 *
 * 性能重构：原实现一次性 `SELECT id, file_path` 全表载入内存，10w+ 媒体时产生巨大内存数组
 * 且所有并发任务闭包常驻至全部完成。现改为按主键 `id` 分页流式处理——每页仅拉取 PAGE_SIZE
 * 行，构建该页任务并以 8 路并发检查，整页收齐后再跑一次事务入库；峰值内存由 O(全表) 降为
 * O(PAGE_SIZE)。逐页通过模块级 `progress` + `emitProgress` 上报完整性校验进度（已检查/缺失/
 * 总数），UI 可展示缺失文件扫描百分比；节流 500ms 避免高频 IPC。
 */
// 完整性校验分页大小：单页内存与并发任务数上限，峰值内存 ≈ PAGE_SIZE 行 + 闭包
const INTEGRITY_PAGE_SIZE = 2000
// 一致性并发：复用 C-F1 的 8 路 fs.access 并发度
const INTEGRITY_CONCURRENCY = 8

async function checkMissingFiles(roots?: string[]): Promise<void> {
  if (!db) return
  try {
    // T02 修复：增量扫描只扫变更目录，完整性校验应只校验本次覆盖的根集合，
    // 避免对全库未删除记录逐页 fsp.access（挂外部硬盘/网盘时 I/O 压力明显）。
    // roots 为 undefined 时回退到全库校验旧语义（向后兼容）；空数组则 0=1 直接跳过。
    const rootFilter = buildIntegrityRootFilter(roots)
    const rootWhere = rootFilter ? ` AND (${rootFilter.clause})` : ''
    const rootParams: unknown[] = rootFilter ? rootFilter.params : []

    const total = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM media_files WHERE is_deleted = 0${rootWhere}`)
        .get(...rootParams) as {
        c: number
      }
    ).c
    if (total === 0) return

    const selectPage = db.prepare(
      `SELECT id, file_path FROM media_files WHERE is_deleted = 0${rootWhere} AND id > ? ORDER BY id ASC LIMIT ?`
    )
    const updateMissing = db.prepare(
      'UPDATE media_files SET missing_count = missing_count + 1, is_missing = CASE WHEN missing_count + 1 >= 2 THEN 1 ELSE 0 END WHERE id = ?'
    )
    const updateFound = db.prepare(
      'UPDATE media_files SET missing_count = 0, is_missing = 0 WHERE id = ?'
    )
    const updatePage = db.transaction((missingIds: number[], foundIds: number[]) => {
      for (const id of missingIds) updateMissing.run(id)
      for (const id of foundIds) updateFound.run(id)
    })

    let lastId = 0
    let scanned = 0
    let totalMissing = 0

    // 初始化进度分母，UI 立即显示完整性校验阶段
    progress.integrityTotal = total
    progress.integrityScanned = 0
    progress.integrityMissing = 0
    emitProgress(true)

    while (scanned < total) {
      const rows = selectPage.all(...rootParams, lastId, INTEGRITY_PAGE_SIZE) as Array<{
        id: number
        file_path: string
      }>
      if (rows.length === 0) break

      // 异步并发检查文件存在性（8 路并发，避免同步 fs.existsSync 阻塞主进程事件循环）
      const missingIds: number[] = []
      const foundIds: number[] = []
      const tasks = rows.map((row) => async () => {
        try {
          await fsp.access(row.file_path, fs.constants.R_OK)
          foundIds.push(row.id)
        } catch {
          missingIds.push(row.id)
        }
      })
      await runWithConcurrency(tasks, INTEGRITY_CONCURRENCY)
      // 整页收齐后再跑一次事务入库（better-sqlite3 同步事务）
      updatePage(missingIds, foundIds)

      const pageLast = rows[rows.length - 1].id
      lastId = pageLast
      scanned += rows.length
      totalMissing += missingIds.length

      progress.integrityScanned = scanned
      progress.integrityMissing = totalMissing
      emitProgress()

      // 外部取消（SCAN_STOP）时提前退出，避免对全表无谓的 fs.access
      if (isScanAborted()) break
    }

    // 终态汇总（仅 warn/error 经 workerLog 转发；此处用 sendScanLogInfo 保证低频汇总可见）
    sendScanLogInfo(
      `[Scanner] 完整性校验完成：检查 ${scanned}/${total} 个文件，${totalMissing} 个缺失`
    )
    // 复位进度字段，避免残留到后续阶段
    progress.integrityTotal = undefined
    progress.integrityScanned = undefined
    progress.integrityMissing = undefined
  } catch (error) {
    // workerLog 对 Error 对象会用 JSON.stringify 丢失 stack，转 message 保留可读信息
    workerLog(
      'error',
      t('main.scanner.log.integrityCheckFailed'),
      error instanceof Error ? error.message : String(error)
    )
  }
}

// ============ 游戏目录查找 ============

/**
 * 查找所有游戏媒体目录（注册表快速路径 + 全盘签名深度搜索）。
 *
 * C-G4：原 findGameDirectories 与 findAllMediaDirectories 逻辑完全一致，合并为单一方法（P0-01）。
 *
 * P0-01 重构：将"自定义路径"与"自动发现"拆分为两个独立集合，修正两个历史缺陷：
 * - 缺陷 1（抑制发现）：原实现把自定义路径并入 `found`，用 `found.size > 0` 作为跳过全盘搜索的
 *   早退条件。一个存在但里面没有暖暖媒体的自定义路径会让 `found.size>0` 成立，从而抑制全盘签名搜索，
 *   最终导致只扫那 1 个错误目录、发现 0 文件（日志"扫描 1 个目录"的由来）。
 * - 缺陷 2（过滤丢弃）：原实现末尾对整个 `found` 做 `infinitynikki` 软过滤，当用户配置的不含该关键字的
 *   自定义路径与某个含 `infinitynikki` 的自动发现目录共存时，自定义路径被整体挤出结果。
 *
 * 强制对齐 nikki_albums（spec 二/三）：
 * - `customSet`：用户自定义路径，存在即加入，**恒包含于最终结果**。
 * - `registrySet`：仅来自 `findGameInstallRootsByPriority`（官方启动器 > Steam > Epic，命中即止，
 *   且每个根目录均经 validateGameRoot 校验）。不引入用户数据/AppData/全盘枚举等其它来源，
 *   避免引入 nikki_albums 不含的目录导致扫描数量不一致。
 * - 移除历史版本的软过滤（`infinitynikki` 关键字过滤）与低置信用户数据通道，完全遵循
 *   "直接访问 GamePlayPhotos 路径、忽略任何目录过滤"的规范。
 * - 最终返回去重后的 `[...customSet, ...registrySet]`。
 *
 * 流程：
 * - 优先路径：用户在设置页手动配置的游戏目录（customPaths），存在即加入结果集
 * - （已移除：用户数据 / 全盘扫描通道，仅保留三渠道游戏根目录定位）
 * - 自动发现：仅三渠道游戏根目录定位（见 game-directory-discovery），不做全盘扫描
 *
 * @param customPaths 用户在设置页手动配置的游戏目录，优先扫描；存在有效目录时恒包含
 * @param excludedPaths 用户在设置页取消勾选的目录，从最终结果中剔除（大小写不敏感精确匹配）

 * @returns 所有匹配的游戏根目录列表（去重、已排除 excludedPaths），
 *   由上层 resolveScanChannels 编排为扫描通道
 */
export async function findMediaDirectories(
  customPaths?: string[],
  excludedPaths?: string[]
): Promise<string[]> {
  // 全链路诊断：扫描启动节点
  sendScanLogEntry({
    stage: 'scan-start',
    level: 'info',
    kind: 'ok',
    message: `开始查找游戏安装目录`
  })
  // spec 二/三：仅返回用户自定义路径 + 三渠道游戏根目录，不经过目录过滤、不做全盘扫描。
  const customSet = new Set<string>()
  const registrySet = new Set<string>()

  // 0. 优先路径：用户自定义游戏目录
  // 用户在设置页手动指定的目录，存在即加入结果集；不存在则跳过（游戏可能未安装但用户预配置）。
  // 注意：自定义路径不计入自动发现集合；除用户显式 excludedPaths 外，不受发现阶段过滤。
  // 路径先经 normalizeCustomGameRoot 归一化（X6Game 目录/启动器目录 → 游戏根），
  // 避免被当游戏根双层拼出 root\X6Game\X6Game\... 导致 E002（2026-10-04 日志回归）。
  if (customPaths && customPaths.length > 0) {
    let validCount = 0
    for (const p of customPaths) {
      if (!p || typeof p !== 'string') continue
      try {
        // 必须先校验原始配置；否则不存在的 <parent>\X6Game 会被归一化为存在的 parent 并误收录。
        await fsp.access(p)
        const normalized = await normalizeCustomGameRoot(p)
        await fsp.access(normalized)
        customSet.add(normalized)
        validCount++
        if (normalized.toLowerCase() !== p.toLowerCase()) {
          // 低频关键诊断：归一化改写了用户配置的路径，透传主进程日志便于排查
          sendScanLogInfo(`[Scanner] 自定义路径归一化：${p} → ${normalized}`)
        }
      } catch {
        workerLog('warn', `[Scanner] 用户自定义路径不存在，跳过: ${p}`)
      }
    }
    if (validCount > 0) {
      workerLog('info', `[Scanner] 用户自定义路径加入 ${validCount} 个有效目录`)
    }
  }

  // 1. 快速路径（高置信）：按渠道优先级（官方启动器 > Steam > Epic，命中即不再降级）
  // 解析游戏安装根目录，再统一拼接 X6Game\Saved\GamePlayPhotos 子路径。
  for (const p of await findGameInstallRootsByPriority()) registrySet.add(p)

  // 合并：自定义路径优先 + 三渠道游戏根目录；按 Windows 路径大小写不敏感去重。
  // 不再引入用户数据 / AppData / 全盘扫描通道（spec 二：不做全盘扫描、不经目录过滤）。
  // 需求三.3：剔除用户在设置页取消勾选的目录（大小写不敏感精确匹配）。
  const excluded = new Set(
    (excludedPaths ?? [])
      .filter((p) => typeof p === 'string' && p.length > 0)
      .map((p) => p.toLowerCase())
  )
  const result = new Map<string, string>()
  for (const p of [...customSet, ...registrySet]) {
    const key = p.toLowerCase()
    if (!excluded.has(key) && !result.has(key)) result.set(key, p)
  }
  const resultDirs = Array.from(result.values())
  // T2：目录发现结论日志透传（低频关键诊断信息，绕过 workerLog 的 info 屏蔽）
  sendScanLogInfo(
    `[Scanner] findMediaDirectories 搜索结果: ${result.size} 个目录（自定义 ${customSet.size} + 三渠道 ${registrySet.size}）`
  )
  // 全链路诊断：目录遍历结果节点
  sendScanLogEntry({
    stage: 'dir-traverse',
    level: result.size > 0 ? 'info' : 'warn',
    kind: result.size > 0 ? 'ok' : 'empty',
    message: `找到游戏安装目录 ${result.size} 个（自定义 ${customSet.size} + 三渠道 ${registrySet.size}）`,
    detail: resultDirs
  })
  // 逐目录日志截断：兑现 sendScanLogInfo “低频白名单”承诺——结果目录数可能很大
  // （多盘符多签名命中时可达数十个），最多输出前 20 个目录，其余以一条汇总行带过
  const MAX_LOGGED_DIRS = 20
  for (const d of resultDirs.slice(0, MAX_LOGGED_DIRS)) sendScanLogInfo(`[Scanner]   - ${d}`)
  if (resultDirs.length > MAX_LOGGED_DIRS) {
    sendScanLogInfo(`[Scanner]   - （其余 ${resultDirs.length - MAX_LOGGED_DIRS} 个目录略）`)
  }

  return resultDirs
}

// 注：游戏目录发现逻辑（注册表/Steam/Epic/用户数据/有限盘符枚举）已抽取至 ./game-directory-discovery
// （便于单元测试用 vi.mock 桩替换，避免真实盘符/注册表 IO）。

// 注：findSteamGamePaths 已抽取至 ./game-directory-discovery

// 注：findEpicGamePaths / querySteamInstallPath / getAvailableDrives / getUserDataPaths 已抽取至 ./game-directory-discovery

// ============ 目录扫描 ============

/**
 * 需求五.2：单次目录遍历超过该阈值仍无响应即追加告警（提示用户把目录加入杀毒软件信任）。
 *
 * 刻意取舍：**只告警不中断**——不取消 readdir、不跳过该目录。安全软件实时扫描、机械盘
 * 冷启动、网络盘首访都可能超过 3 秒，若据此中断会直接丢失用户照片（比误报代价大得多）。
 */
const TRAVERSE_SLOW_MS = 3000
let traverseSlowMs = TRAVERSE_SLOW_MS

/** 仅供单元测试注入更小的阈值，生产代码不得调用 */
export function __setTraverseSlowMsForTest(ms: number): void {
  if (typeof ms === 'number' && ms > 0) traverseSlowMs = ms
}

/**
 * 读取目录首层条目，并在遍历超过阈值时追加 `traverse-timeout` 告警。
 *
 * 不取消 IO：超时后仍继续等待原 readdir 完成并返回其完整结果（成功或失败），
 * 保证扫描结果不受告警影响。
 */
async function readdirWithSlowTraverseWarning(dir: string): Promise<fs.Dirent[]> {
  const readdirPromise = fsp.readdir(dir, { withFileTypes: true })
  let slowTimer: NodeJS.Timeout | undefined
  const slowNotice = new Promise<void>((resolve) => {
    slowTimer = setTimeout(() => {
      sendScanLogEntry({
        stage: 'traverse-timeout',
        level: 'warn',
        kind: 'other',
        message: `目录遍历超过 ${traverseSlowMs}ms 无响应（可能被安全软件拦截），建议将目录加入信任：${dir}`,
        detail: { path: dir, elapsedMs: traverseSlowMs }
      })
      resolve()
    }, traverseSlowMs)
    // 不阻止 worker 进程退出
    slowTimer.unref?.()
  })
  try {
    // 竞速只用于触发告警：readdir 的失败不在此处抛出，交由下方 await 统一处理
    await Promise.race([
      readdirPromise.then(
        () => undefined,
        () => undefined
      ),
      slowNotice
    ])
  } finally {
    if (slowTimer) clearTimeout(slowTimer)
  }
  return await readdirPromise
}

export async function scanDirectory(
  rootPath: string,
  incremental?: boolean,
  // 单目录扫描（导入向导）传 false 可禁用缓存目录跳过与小图片过滤，避免用户文件被误跳过
  applyFilters = true,
  // P0-02 根因修复：真实 UID 集合（来自 discoverUidsFromGameDirs，即 GamePlayPhotos 一级纯数字子目录）。
  // 为空（null/undefined）保留旧行为；非空时，extractUidFromPath 的宽松命中若不在该集合内，
  // 视为路径中的时间戳/活动ID/嵌套数字目录等虚拟数字段，归 'default' 且不注册档案，
  // 从源头阻止虚拟 UID 写入 character_profiles（解密降级/历史修复依赖 extractUidFromPath 通用契约，不在本处收紧）。
  validUids?: Set<string> | null
): Promise<{ files: MediaFile[]; savedCount: number }> {
  const files: MediaFile[] = []
  let savedCount = 0

  // 增量扫描：获取已索引的文件路径和修改时间
  const existingFiles = new Map<string, { filePath: string; modifiedAt: string }>()
  if (incremental && db) {
    // FIX(组3-5): 仅加载本次扫描根目录下的已有记录——原无 WHERE 全表 SELECT 在单目录
    // 导入时也把整个库拉入内存（万级库每次多一次全表扫描 + Map 构建）。
    // 与 buildIntegrityRootFilter 同口径：LOWER(REPLACE(file_path,'\','/')) LIKE LOWER(?)
    // ESCAPE 转义路径中的 %/_ 防止误当通配符；LOWER 表达式实现全字符大小写一致，
    // 覆盖 Windows 路径盘符/CJK 大小写差异（stock SQLite 默认 BINARY 排序下裸 LIKE
    // 仅对 ASCII 不敏感，会漏匹配）。代价：该表达式查询无法走 file_path 唯一索引、
    // 退化为 media_files 全扫描；因仅校验增量根集合、行量小，可接受。
    const likePattern = normalizeRootPrefixForLike(rootPath, path.sep)
    const rows = db
      .prepare(
        "SELECT file_path, modified_at FROM media_files WHERE LOWER(REPLACE(file_path, '\\', '/')) LIKE LOWER(?) ESCAPE '\\'"
      )
      .all(likePattern) as Array<{
      file_path: string
      modified_at: string
    }>
    for (const row of rows) {
      existingFiles.set(row.file_path.toLowerCase(), {
        filePath: row.file_path,
        modifiedAt: row.modified_at
      })
    }
  }

  // A-S6：流式分批写入缓冲区，满 SCAN_BATCH_SIZE 条即 flush 到数据库
  let batchBuffer: MediaFile[] = []
  const flushBatch = async () => {
    if (batchBuffer.length === 0) return
    const batch = batchBuffer
    batchBuffer = []
    savedCount += await saveBatchToDatabase(batch)
  }
  const addFile = async (file: MediaFile) => {
    files.push(file)
    batchBuffer.push(file)
    if (batchBuffer.length >= SCAN_BATCH_SIZE) {
      await flushBatch()
    }
  }

  // 收集待处理视频路径，扫描结束后批量并发读取元数据
  const pendingVideos: Array<{
    fullPath: string
    ext: string
    entryName: string
    stats: fs.Stats
  }> = []

  // A-S5：符号链接环检测——记录已访问目录的真实路径
  const visitedRealPaths = new Set<string>()
  // spec 三 + 需求一：GamePlayPhotos 子树强制遍历豁免——忽略 HIDDEN/SYSTEM 属性，
  // 不跳过任何子目录层级、不过滤任何文件（含缓存子目录与小图），与 nikki_albums 一致。
  // 双判据：
  // 1) 同步路径段命中（X6Game\Saved\GamePlayPhotos 或其无 Saved 变体）；
  // 2) 异步目录指纹命中（手动直选 / 副本目录含 NikkiPhotos_HighQuality|LowQuality，
  //    或目录名 GamePlayPhotos 且含 UID 子目录）——覆盖用户手动选择与迁移副本场景。
  // 该豁免仅对确认为官方相册根的路径生效；ScreenShot 等其他来源仍走原过滤逻辑。
  const exemptGamePlayPhotos =
    isGamePlayPhotosScanExempt(rootPath) || (await isOfficialAlbumDir(rootPath))
  // F-G1：进度更新改为时间节流（每 500ms emit 一次），小目录也能及时反馈
  lastProgressEmit = 0

  const scan = async (dir: string, depth: number) => {
    if (isScanAborted()) return
    // A-S5：深度限制，防止过深递归
    if (depth > MAX_SCAN_DEPTH) {
      workerLog('warn', `[Scanner] 超过最大扫描深度 ${MAX_SCAN_DEPTH}，跳过: ${dir}`)
      return
    }

    try {
      // A-S5：符号链接环检测——解析真实路径，若已访问则跳过
      const realDir = await cachedRealpath(dir)
      if (visitedRealPaths.has(realDir)) {
        workerLog('warn', `[Scanner] 检测到符号链接环，跳过: ${dir} -> ${realDir}`)
        return
      }
      visitedRealPaths.add(realDir)

      const entries = await readdirWithSlowTraverseWarning(dir)
      for (const entry of entries) {
        if (isScanAborted()) return

        const fullPath = path.join(dir, entry.name)
        progress.scanned++
        progress.currentPath = fullPath

        // F-G1：进度更新改为时间节流（每 500ms emit 一次），保证小目录也有反馈
        emitProgress()

        if (entry.isDirectory()) {
          // A-S5：跳过符号链接目录，避免环（realpath 检测在递归入口处理）
          if (entry.isSymbolicLink()) continue
          // P0修复：跳过缓存子目录（Cache/Temp/Thumbnail/Preview 等），避免缓存图片入库
          // 单目录扫描（applyFilters=false）时不跳过，保留用户自命名的同名子目录
          if (
            applyFilters &&
            !exemptGamePlayPhotos &&
            CACHE_DIR_NAMES.has(entry.name.toLowerCase())
          )
            continue
          await scan(fullPath, depth + 1)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase()
          if (IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext)) {
            // 需求五.1 E005：文件读取失败必须带错误码与失败路径上报，不静默跳过
            let stats: fs.Stats
            try {
              stats = await fsp.stat(fullPath)
            } catch (statErr) {
              sendScanLogEntry({
                stage: 'file-read',
                level: 'error',
                kind: classifyFsError(statErr) === 'permission' ? 'permission' : 'other',
                code: 'E005',
                message: `读取文件信息失败（E005）：${fullPath}`,
                detail: {
                  path: fullPath,
                  errorType:
                    (statErr as { code?: string } | null)?.code ??
                    (statErr instanceof Error ? statErr.name : 'UNKNOWN')
                }
              })
              continue
            }
            // P0修复：过滤过小的图片文件（缓存缩略图通常 < 5KB，游戏照片通常 > 200KB）
            // 单目录扫描（applyFilters=false）时不过滤，保留用户导入的小图片
            if (
              applyFilters &&
              !exemptGamePlayPhotos &&
              !VIDEO_EXTENSIONS.has(ext) &&
              stats.size < 5 * 1024
            ) {
              continue
            }

            // 增量扫描：跳过未修改的文件；修改文件沿用数据库中的原路径大小写，
            // 避免 SQLite 的 BINARY 唯一键把同一 Windows 文件写成重复记录。
            // F-G5：mtime 比较容忍 1 秒精度差，避免 ISO 字符串毫秒精度丢失导致重复处理
            const existingFile = incremental ? existingFiles.get(fullPath.toLowerCase()) : undefined
            if (
              existingFile &&
              Math.abs(new Date(existingFile.modifiedAt).getTime() - stats.mtime.getTime()) <= 1000
            ) {
              continue
            }
            const databasePath = existingFile?.filePath ?? fullPath

            if (VIDEO_EXTENSIONS.has(ext)) {
              pendingVideos.push({ fullPath, ext, entryName: entry.name, stats })
            } else {
              // P0-02：根据路径识别角色档案 UID
              // 根因修复闸门：extractUidFromPath 用宽松正则 /[\\/](\d+)[\\/]/ 可能命中
              // 路径中任意数字段（时间戳/活动ID/嵌套数字目录），形成虚拟 UID。
              // gateAccountUid 仅当命中真实 UID 集合（discoverUidsFromGameDirs 发现，
              // 即 GamePlayPhotos 一级纯数字子目录）或为 'default' 时采用；否则归 'default'
              // 且不注册档案，从源头阻断虚拟档案写入。
              const rawUid = extractUidFromPath(fullPath)
              const discoveredUid = gateAccountUid(rawUid, validUids)
              observeUidGate(rawUid, discoveredUid, validUids)
              if (discoveredUid !== 'default') autoRegisterUid(discoveredUid)
              // 扫描入库关联游戏原生缩略图：HQ 图片可推导出同名 LQ 低清文件，
              // 存在且可读时直接填充 thumbnail（不再触发缩略图生成）；
              // access 失败仅记 warn 日志、不填（保持现状走常规生成），不中断扫描。
              // 视频分支不填（LQ 目录仅含同名图片）。
              let nativeThumbnail: string | undefined
              const nativeThumbPath = resolveNativeThumbnailPath(fullPath)
              if (nativeThumbPath) {
                try {
                  await fsp.access(nativeThumbPath, fs.constants.R_OK)
                  nativeThumbnail = nativeThumbPath
                } catch (thumbErr) {
                  workerLog(
                    'warn',
                    `[Scanner] 原生低清缩略图不可访问，跳过缩略图关联: ${nativeThumbPath}`,
                    thumbErr instanceof Error ? thumbErr.message : String(thumbErr)
                  )
                }
              }
              // 子任务7：复用现有 XMP 服务读取高清图内嵌元数据（wxnn 命名空间 EditorData）。
              // 游戏原生截图不含此 XMP，readMetadataFromFile 返回 null，editor_metadata 恒为 NULL。
              // 差距标注：游戏原生 nuan5_params（相机参数/世界坐标/搭配）解码为独立任务，
              // 不在本次复刻范围（待 nikki_albums 运行时对比后移植 Rust 解码器），不臆造。
              let editorMetadata: string | null | undefined
              try {
                const meta = await readMetadataFromFile(fullPath)
                editorMetadata = meta ? JSON.stringify(meta) : null
              } catch (metaErr) {
                // 元数据读取失败（无 XMP / 解析异常）不中断扫描；thumbnail 走常规生成兜底
                workerLog(
                  'warn',
                  `[Scanner] 读取内嵌元数据失败，跳过: ${fullPath}`,
                  metaErr instanceof Error ? metaErr.message : String(metaErr)
                )
                // E005：图片/元数据读取失败，带失败路径与错误类型上报
                sendScanLogEntry({
                  stage: 'file-read',
                  level: 'error',
                  kind: 'other',
                  code: 'E005',
                  message: `读取内嵌元数据失败（E005）：${fullPath}`,
                  detail: {
                    path: fullPath,
                    errorType:
                      (metaErr as { code?: string } | null)?.code ??
                      (metaErr instanceof Error ? metaErr.name : 'UNKNOWN')
                  }
                })
                editorMetadata = null
              }

              await addFile({
                file_path: databasePath,
                file_name: entry.name,
                file_type: 'image',
                file_ext: ext,
                file_size: stats.size,
                width: undefined,
                height: undefined,
                duration: undefined,
                created_at: stats.birthtime.toISOString(),
                modified_at: stats.mtime.toISOString(),
                source_path: rootPath,
                indexed_at: new Date().toISOString(),
                scene_category: detectSceneCategory(fullPath),
                // F-O1：扫描时不分析亮度（避免 I/O 阻塞），默认 unknown，后续可手动触发批量分析
                scene_time: 'unknown',
                outfit: '',
                account_uid: discoveredUid,
                // P0-03：根据父文件夹名映射相册类型
                album_type: extractAlbumTypeFromPath(fullPath),
                // 区分游戏内拍摄与启动器缓存
                media_source: extractMediaSourceFromPath(fullPath),
                // 游戏原生缩略图（LQ 同名文件，仅当存在且可读时填充）
                thumbnail: nativeThumbnail,
                // 内嵌 XMP 元数据（wxnn 命名空间 EditorData JSON），游戏原生截图为 NULL
                editor_metadata: editorMetadata
              })
              progress.found++
            }
          }
        }
      }
    } catch (err) {
      // FIX(组3-1): 数据库批量写入失败（SQL 约束/DB 锁/磁盘满）是系统性故障，
      // 不能按"跳过目录"降级吞掉——整批已收集文件会静默丢失且扫描仍报成功。
      // 识别后 rethrow，让 startScan 的 catch 以 SCAN_COMPLETE success=false 上报失败
      if (err instanceof ScanBatchWriteError) {
        workerLog('error', `[Scanner] 批量写入失败，终止扫描: ${dir}`, err.message)
        throw err
      }
      // 修复 F2：原 catch 块静默吞错，违反"错误必须被处理，不能静默失败"硬约束
      // 加日志输出，使扫描跳过的目录可诊断化（权限不足/目录不存在/I/O 错误/符号链接环等）
      workerLog(
        'warn',
        `[Scanner] 跳过目录: ${dir}`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  await scan(rootPath, 0)

  // 批量并发读取视频元数据（限制 4 并发），读取后流式写入数据库
  const videoTasks = pendingVideos.map(({ fullPath, ext, entryName, stats }) => async () => {
    const databasePath = existingFiles.get(fullPath.toLowerCase())?.filePath ?? fullPath
    // C-G10：probeVideoMetadata 现在会 reject，单个视频失败不应中断整个扫描
    // 15 秒超时：ffprobe 二进制不可用时不会 reject 而永久挂起，会卡死整个扫描流程
    let meta: { width?: number; height?: number; duration?: number } = {}
    let videoCorrupted = false
    let videoCorruptedReason = ''
    try {
      meta = await probeVideoMetadata(fullPath, 15000)
    } catch (err) {
      // 损坏文件容错：单个视频元数据读取失败不中断整个扫描，标记为损坏后继续
      videoCorrupted = true
      videoCorruptedReason = err instanceof Error ? err.message : String(err)
      workerLog('error', `[Scanner] 跳过视频元数据读取失败: ${fullPath}`, videoCorruptedReason)
    }
    // P0-02：根据路径识别角色档案 UID
    // 根因修复闸门（同图片分支）：复用 gateAccountUid 仅当命中真实 UID 集合或为 'default' 时采用
    const rawUid = extractUidFromPath(fullPath)
    const discoveredUid = gateAccountUid(rawUid, validUids)
    observeUidGate(rawUid, discoveredUid, validUids)
    if (discoveredUid !== 'default') autoRegisterUid(discoveredUid)
    await addFile({
      file_path: databasePath,
      file_name: entryName,
      file_type: 'video',
      file_ext: ext,
      file_size: stats.size,
      width: meta.width,
      height: meta.height,
      duration: meta.duration,
      created_at: stats.birthtime.toISOString(),
      modified_at: stats.mtime.toISOString(),
      source_path: rootPath,
      indexed_at: new Date().toISOString(),
      scene_category: detectSceneCategory(fullPath),
      scene_time: 'unknown',
      outfit: '',
      account_uid: discoveredUid,
      // P0-03：根据父文件夹名映射相册类型
      album_type: extractAlbumTypeFromPath(fullPath),
      // 区分游戏内拍摄与启动器缓存
      media_source: extractMediaSourceFromPath(fullPath)
    })
    progress.found++

    // 损坏文件容错：写入数据库后再标记为损坏（确保记录已存在）
    // 单个文件标记失败不应影响其他文件的扫描
    if (videoCorrupted) {
      try {
        markCorruptedByPath(databasePath, `视频元数据读取失败: ${videoCorruptedReason}`)
      } catch (markErr) {
        workerLog(
          'warn',
          `[Scanner] 标记损坏状态失败: ${fullPath}`,
          markErr instanceof Error ? markErr.message : String(markErr)
        )
      }
    }
  })
  await runWithConcurrency(videoTasks, 4)

  // A-S6：刷新剩余未满批次的记录
  await flushBatch()

  emitProgress(true)
  return { files, savedCount }
}

// ============ 损坏文件标记（worker 内直写 DB） ============

/**
 * 损坏文件容错：根据 file_path 标记记录为损坏。
 *
 * 在 worker 进程内直接 UPDATE 主进程共享的 db 文件（WAL 模式支持并发读写），
 * 避免通过 IPC 回主进程标记，保证扫描批量任务的连续性。
 *
 * 设计要点：
 * - 文件不在库中（如未扫描完成时）静默忽略，不抛错
 * - reason 截断为 200 字符，避免过长错误信息占用存储
 * - 失败仅记录日志，不抛出未捕获异常，确保不影响其他文件扫描
 * - 与 MediaRepository.markCorrupted 行为一致：累加 corrupted_count + 写入 corrupted_reason
 */
function markCorruptedByPath(filePath: string, reason: string): void {
  if (!db) {
    workerLog('warn', `[Scanner] markCorruptedByPath 跳过：数据库未连接: ${filePath}`)
    return
  }
  try {
    const truncatedReason = reason.slice(0, 200)
    db.prepare(
      'UPDATE media_files SET is_corrupted = 1, corrupted_count = corrupted_count + 1, corrupted_reason = ? WHERE file_path = ?'
    ).run(truncatedReason, filePath)
  } catch (err) {
    workerLog(
      'warn',
      `[Scanner] markCorruptedByPath SQL 失败: ${filePath}`,
      err instanceof Error ? err.message : String(err)
    )
  }
}

// ============ UID 自动注册（worker 内直写 DB） ============

/**
 * 方案二：扫描时自动将路径中发现的 UID 注册到 character_profiles 表。
 *
 * 用户未手动添加角色档案时，扫描阶段从文件路径提取的 UID 会被自动注册，
 * 后续解密即可从角色档案表获取 UID，无需用户手动操作。
 *
 * 设计要点：
 * - INSERT OR IGNORE 确保已有 UID 不重复插入
 * - nickname 使用 "账号 {uid}" 作为默认名称，用户后续可在设置页修改
 * - 失败仅记录日志，不抛出未捕获异常，确保不影响文件扫描
 */
function autoRegisterUid(uid: string): void {
  if (uid === 'default' || !db) return
  try {
    if (!insertProfileStmtCache) {
      insertProfileStmtCache = db.prepare(
        `INSERT OR IGNORE INTO character_profiles (uid, nickname, created_at)
         VALUES (?, ?, datetime('now'))`
      )
    }
    insertProfileStmtCache.run(uid, `账号 ${uid}`)
  } catch (err) {
    workerLog(
      'warn',
      `[Scanner] autoRegisterUid 失败: ${uid}`,
      err instanceof Error ? err.message : String(err)
    )
  }
}

// ============ 流式写入数据库 ============

/**
 * FIX(组3-1): 数据库批量写入失败的标记错误。
 * 原先 insertMany(batch) 抛错会冒泡到 scan 递归的 catch，被降级为
 * workerLog('warn', '跳过目录')——整批最多 500 条已收集文件静默丢弃且扫描仍报成功。
 * saveBatchToDatabase 把 prepare/事务执行错误包装为本类型，
 * scan 的 catch 识别后 rethrow，最终由 startScan 以 SCAN_COMPLETE success=false 上报。
 */
class ScanBatchWriteError extends Error {
  constructor(batchSize: number, cause: string) {
    super(`数据库批量写入失败（本批 ${batchSize} 个文件未落库）: ${cause}`)
    this.name = 'ScanBatchWriteError'
  }
}

async function saveBatchToDatabase(batch: MediaFile[]): Promise<number> {
  if (!db || batch.length === 0) {
    if (!db) workerLog('info', `[Scanner] 数据库未连接，跳过保存 ${batch.length} 个文件`)
    return 0
  }

  // C-G6：复用缓存的 prepared statement，避免每批次重新 prepare
  // 性能评估（2026-07-18）：已具备事务包裹 + 批次 500 + 缓存 statement 三项优化
  // 联合索引新增后，INSERT 路径会多更新 5 个索引，但 WAL 模式下影响可忽略
  // 如未来索引数量超过 20 个，需重新评估写入性能
  // FIX(组3-1): prepare 与事务执行抛错均包装为 ScanBatchWriteError 向上传播
  try {
    if (!insertStmtCache) {
      insertStmtCache = db.prepare(`
      INSERT INTO media_files
      (file_path, file_name, file_type, file_ext, file_size, width, height, duration, created_at, modified_at, source_path, indexed_at, tags, category_id, rating, is_favorite, notes, scene_category, scene_time, outfit, account_uid, album_type, media_source, thumbnail, editor_metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, 0, 0, '', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        file_name = excluded.file_name,
        file_type = excluded.file_type,
        file_ext = excluded.file_ext,
        file_size = excluded.file_size,
        width = excluded.width,
        height = excluded.height,
        duration = excluded.duration,
        created_at = excluded.created_at,
        modified_at = excluded.modified_at,
        source_path = excluded.source_path,
        indexed_at = excluded.indexed_at,
        scene_category = excluded.scene_category,
        account_uid = excluded.account_uid,
        album_type = excluded.album_type,
        media_source = excluded.media_source,
        -- 游戏原生缩略图：本批未关联到原生缩略图（NULL）时保留已有值，
        -- 避免增量重扫时把已关联/已生成的缩略图覆盖回 NULL；
        -- 存量未关联的 HQ 记录由 repairLegacyDataV6 迁移补回填。
        thumbnail = COALESCE(excluded.thumbnail, media_files.thumbnail),
        -- 子任务7：内嵌 XMP 元数据随扫描刷新（无则 NULL）
        editor_metadata = excluded.editor_metadata,
        -- FIX(组3-2): 扫描刚物理确认文件存在，缺失计数与标记必须归零——ON CONFLICT 不重置该列时，
        -- 记录删除重建/外部移动后扫回/DB 迁移残留的旧 missing_count 会让下次完整性校验
        -- 首次 access 失败即置 is_missing=1，跳过"连续两次缺失"防抖缓冲
        missing_count = 0,
        is_missing = 0,
        -- FIX(图库修复): 重扫物理确认文件仍存在时，若记录此前被软删除（如移除扫描源触发
        -- softDeleteByRootPath 整批软删了自动发现的游戏媒体），对位于游戏目录树（GamePlayPhotos/
        -- X6Game）下的记录复位 is_deleted=0，使其随重扫回到图库；导入根（用户自定义目录）媒体路径
        -- 不匹配本模式，仍尊重其软删除状态，避免"游戏照片被删后重扫也无法恢复"的卡死。
        -- 回收站语义修复：谓词追加 COALESCE(delete_origin,'') <> 'user'——用户主动软删
        -- （软删除已不再搬动文件，文件留在原路径）不得被重扫复位，否则表现为"删了又回来"。
        is_deleted = CASE WHEN ${RESCAN_RESTORE_PREDICATE} THEN 0 ELSE is_deleted END,
        deleted_at = CASE WHEN ${RESCAN_RESTORE_PREDICATE} THEN NULL ELSE deleted_at END
      -- F-O1：scene_time 和 outfit 不在 ON CONFLICT 更新列表中，避免覆盖用户手动设置
      -- P0-02：account_uid 在 ON CONFLICT 时更新（路径变更可能导致 UID 变化）
      -- P0-03：album_type 在 ON CONFLICT 时更新（父目录变更可能导致相册类型变化）
      -- media_source 在 ON CONFLICT 时更新（路径变更可能导致来源变化）
      -- 损坏标记不在 ON CONFLICT 更新列表中：扫描时若文件仍损坏，由 markCorrupted 重置；
      --                       若文件已修复，由下次缩略图生成成功后 clearCorrupted 清除
    `)
    }
    const insertStmt = insertStmtCache

    const insertMany = db.transaction((mediaFiles: MediaFile[]) => {
      for (const file of mediaFiles) {
        insertStmt.run(
          file.file_path,
          file.file_name,
          file.file_type,
          file.file_ext,
          file.file_size,
          file.width ?? null,
          file.height ?? null,
          file.duration ?? null,
          file.created_at,
          file.modified_at,
          file.source_path,
          file.indexed_at,
          file.scene_category,
          // F-O1：仅 INSERT 时写入，冲突时保留已有值
          file.scene_time ?? 'unknown',
          file.outfit ?? '',
          // P0-02：角色档案 UID
          file.account_uid,
          // P0-03：游戏相册类型
          file.album_type,
          // 媒体来源：game 或 launcher
          file.media_source,
          // 游戏原生缩略图路径（未关联时为 NULL，走常规缩略图生成）
          file.thumbnail ?? null,
          // 内嵌 XMP 元数据（无则为 NULL）
          file.editor_metadata ?? null
        )
      }
    })

    // P2-2：better-sqlite3 事务已内置 busy_timeout=5000 重试；此处再包裹 SQLITE_BUSY 感知
    // 退避重试，专门吸收"5 秒内持续冲突"的尾部场景。仅锁错误重试，非锁错误（约束/磁盘满）
    // 由 executeWriteSafely 立即 rethrow，仍被外层包成 ScanBatchWriteError → 扫描中止。
    await executeWriteSafely(() => insertMany(batch), {
      log: (m) => workerLog('warn', m)
    })
  } catch (err) {
    throw new ScanBatchWriteError(batch.length, err instanceof Error ? err.message : String(err))
  }
  workerLog('info', `[Scanner] 流式写入批次：${batch.length} 个文件`)
  return batch.length
}

// ============ 主扫描入口 ============

/**
 * 打开数据库连接（如未打开或路径变化）。
 * 配置与主进程 DatabaseManager 一致的 PRAGMA，并额外设置 busy_timeout=5000
 * 以处理与主进程业务 IPC 的偶发写入冲突。
 */
function openDatabaseIfNeeded(dbPath: string): void {
  if (db && currentDbPath === dbPath) return

  // 路径变化时关闭旧连接
  if (db) {
    try {
      db.pragma('wal_checkpoint(PASSIVE)')
      db.close()
    } catch {}
    db = null
    insertStmtCache = null
    insertProfileStmtCache = null
  }

  db = new (getDatabaseImpl())(dbPath)
  // 与主进程 DatabaseManager 一致的 PRAGMA
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('cache_size = -20000')
  db.pragma('temp_store = MEMORY')
  db.pragma('mmap_size = 268435456')
  db.pragma('wal_autocheckpoint = 1000')
  // worker 独有：处理与主进程业务 IPC 的偶发写入冲突
  db.pragma('busy_timeout = 5000')
  currentDbPath = dbPath
}

/**
 * 扫描收尾 WAL 检查点：在所有写入阶段完全结束后收缩 WAL 文件。
 *
 * 时机约束（关键）：绝不在扫描进行中、worker 仍在写入时调用。
 * 此处扫描器自身已停止写入，TRUNCATE 只会短暂等待主进程（用户删改）写锁
 * （通常子秒级）后完成，属可接受行为；若仍失败仅记 warn，不影响扫描结果。
 * 不改动 openDatabaseIfNeeded 关闭旧连接时的 PASSIVE 检查点（扫描中路径）。
 */
async function finalizeScanCheckpoint(): Promise<void> {
  if (!db) return
  try {
    // P2-2：扫描写入已结束，用 TRUNCATE 收缩 WAL 文件（仅在收尾、连接空闲时调用）
    walCheckpoint(db, 'TRUNCATE')
  } catch (err) {
    workerLog(
      'warn',
      // eslint-disable-next-line no-restricted-syntax -- 诊断日志，worker 进程早于 i18n 初始化，日志仍须可读
      '[Scanner] 扫描收尾 WAL checkpoint(TRUNCATE) 失败（不影响扫描结果）',
      err instanceof Error ? err.message : String(err)
    )
  }
}

/**
 * 扫描入口（迁移自 ScannerManager.startScan）。
 * 接收 SCAN_START 消息后调用，执行完整扫描流程并通过 SCAN_PROGRESS/SCAN_COMPLETE 推送结果。
 */
async function startScan(
  dbPath: string,
  options: ScanOptions
): Promise<{
  success: boolean
  message: string
  filesFound?: number
  gatedVirtualUidCount?: number
}> {
  // 0. 重置虚拟 UID 闸门诊断计数（必须在最早返回路径之前，避免带入上一次扫描的残留值）
  gatedVirtualUidCount = 0

  // 1. 打开 DB（如未打开或路径变化）
  try {
    openDatabaseIfNeeded(dbPath)
  } catch (err) {
    return makeScanCompleteResult(
      false,
      `数据库打开失败: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // 2. 重置状态
  resetScanAbort()
  progress = { scanned: 0, found: 0, currentPath: '', status: 'running' }
  // P1-A3：每次扫描开始时清空 realpath 缓存
  realpathCache.clear()

  // 2.5 D3：进入目录发现阶段前先发一条初始进度事件。
  // findMediaDirectories（多盘符 depth-6 签名搜索）慢机器可达数十秒，期间无任何 SCAN_PROGRESS
  // 会导致渲染端浮窗不出现、task:getActive 快照为 null——右下角在发现阶段完全无反馈
  try {
    sendEvent({
      type: 'SCAN_PROGRESS',
      // eslint-disable-next-line no-restricted-syntax -- 初始阶段暂无真实路径，状态占位文案（渲染端原样展示当前路径，不翻译）
      payload: { scanned: 0, found: 0, currentPath: '正在搜索游戏目录…', status: 'running' }
    })
  } catch (err) {
    // 进度事件属于尽力而为，发送失败仅记日志，不中断扫描主流程
    workerLog(
      'warn',
      // eslint-disable-next-line no-restricted-syntax -- 诊断日志，worker 进程早于 i18n 初始化，日志仍须可读
      '[Scanner] 发送初始进度事件失败',
      err instanceof Error ? err.message : String(err)
    )
  }

  // 3. 记录扫描历史
  const scanType = options?.fullScan ? 'full_scan' : options?.incremental ? 'incremental' : 'full'
  const scanId = insertScanHistory(scanType)

  // 4. 修复旧数据：删除误扫描的非游戏目录文件 + 重新计算 media_source='unknown' 记录的字段
  // R10：repairLegacyDataV1 内部把三步合并到单事务，避免步骤间崩溃导致部分提交
  // FIX(组3-4): 四个修复步骤改为"前置失败即中止后续"——V1 失败（内部事务已回滚、数据仍是
  // 未清理的脏状态）时继续执行 V2/V3/V4 会在脏数据上做二次修改，留下半迁移状态；
  // 各步内部已含事务与幂等迁移标记，被跳过的步骤下次扫描会重跑
  let repairOk = true
  if (db) repairOk = repairLegacyDataV1(db, workerLog)
  // 修复旧数据 V2：重新分类缓存图片（P0 修复前的误分类记录）
  if (repairOk) repairOk = repairLegacyDataV2()
  // 修复旧数据 V3：强制修复 NULL media_source（绕过 v1/v2 标记锁死）
  if (repairOk && db) repairOk = repairLegacyDataV3(db, workerLog)
  // 修复旧数据 V4：用更新后的 path-classifier 重新分类所有 media_source='launcher' 的记录
  if (repairOk && db) repairLegacyDataV4(db, workerLog)
  // 修复旧数据 V5：将误归 launcher 的 X6Game/ScreenShot、X6Game/Video 游戏媒体重分类为 game（图库）
  if (repairOk && db) repairOk = repairLegacyDataV5(db, workerLog)
  // 修复旧数据 V6：为存量 HQ 记录回填游戏原生低清缩略图（thumbnail → 同名 LQ 文件）
  if (repairOk && db) repairOk = await repairLegacyDataV6(db, workerLog)

  /**
   * 双通道扫描（需求二）：先扫官方相册通道（GamePlayPhotos，强制豁免 + 原生 LQ 缩略图），
   * 再扫次级通道（X6Game\ScreenShot / X6Game\Saved\ScreenShot / X6Game\Video，保留原有过滤
   * 与缩略图生成）。两条通道用同一份 UID 闸门，避免截图目录下的时间戳被误判为账号 UID。
   *
   * @returns 扫描结果；两条通道均为空时返回 null，由调用方走失败/兜底分支
   */
  const runScanChannels = async (
    gameDirs: string[]
  ): Promise<{
    totalFiles: number
    totalSaved: number
    officialAlbum: string[]
    secondary: string[]
  } | null> => {
    // workerLog 的 level 联合集为 info/warn/error（不含 debug），此处做一次归一后透传
    const channelLogger: ChannelLogger = (level, message) =>
      workerLog(level === 'debug' ? 'info' : level, message)
    const channelSet = await resolveScanChannels(gameDirs, channelLogger)
    const { officialAlbum, secondary } = channelSet
    // E001：未找到任何可扫描目录（未定位到游戏根目录，或定位到但两条通道均为空）
    // E002：官方相册解析失败的根 —— 两者均在 resolveScanChannels 内埋点（含探测轨迹与子目录列表）
    if (officialAlbum.length === 0 && secondary.length === 0) return null

    // 方案三：从 GamePlayPhotos 目录独立发现 UID 并注册到 character_profiles 表
    const discoveredUids = discoverUidsFromGameDirs(officialAlbum, workerLog)
    for (const uid of discoveredUids) autoRegisterUid(uid)
    // 方案 B（防御纵深）：发现为空时显式传 null 而非空 Set，让 gate 走「无闸门」分支
    const uidGate = discoveredUids.length > 0 ? new Set(discoveredUids) : null

    let totalFiles = 0
    let totalSaved = 0
    for (const dir of officialAlbum) {
      if (isScanAborted()) break
      progress.currentPath = dir
      const { files, savedCount } = await scanDirectory(dir, options?.incremental, true, uidGate)
      totalFiles += files.length
      totalSaved += savedCount
    }
    for (const dir of secondary) {
      if (isScanAborted()) break
      progress.currentPath = dir
      const { files, savedCount } = await scanDirectory(dir, options?.incremental, true, uidGate)
      totalFiles += files.length
      totalSaved += savedCount
    }

    // T02：扫描完成后执行文件完整性校验
    // 全量扫描刚扫完文件必然存在，仅增量扫描需检查文件是否被外部移动/删除
    if (options?.incremental) {
      await checkMissingFiles([...officialAlbum, ...secondary])
    }
    return { totalFiles, totalSaved, officialAlbum, secondary }
  }

  try {
    // 全盘扫描模式：仍依赖自动发现（注册表/Steam/Epic/盘符模板）定位游戏目录，
    // 不执行全盘签名搜索——与 nikki_albums 一致，命中即停、不做全盘递归。
    if (options?.fullScan && !options?.path) {
      const mediaDirs = await findMediaDirectories(
        options?.customKnownPaths,
        options?.excludedPaths
      )
      const result = await runScanChannels(mediaDirs)
      if (!result) {
        progress.status = 'failed'
        updateScanHistory(scanId, 'failed', 0, 0)
        return makeScanCompleteResult(false, t('main.scanner.error.noMediaDirFound'))
      }

      const { totalFiles, totalSaved, officialAlbum, secondary } = result
      const scanRoots = [...officialAlbum, ...secondary]
      progress.status = 'completed'
      updateScanHistory(scanId, 'completed', totalFiles, totalSaved)
      // 全链路诊断：文件扫描汇总节点
      sendScanLogEntry({
        stage: 'file-scan',
        level: 'info',
        kind: 'ok',
        message: `共扫描 ${scanRoots.length} 个目录（官方相册 ${officialAlbum.length} + 次级 ${secondary.length}），发现 ${totalFiles} 个媒体文件，新增 ${totalSaved} 个`,
        detail: { officialAlbum, secondary, totalFiles, totalSaved }
      })

      // P2-2：扫描写入已结束，收缩 WAL 文件（绝不放在批量写入循环中）
      await finalizeScanCheckpoint()
      return makeScanCompleteResult(
        true,
        `全盘扫描完成，扫描 ${scanRoots.length} 个目录，发现 ${totalFiles} 个媒体文件，新增 ${totalSaved} 个`,
        totalFiles
      )
    }

    let targetPath: string | null | undefined = options?.path

    if (!targetPath) {
      // F-O1：优先使用用户自定义路径，回退到自动发现
      const gameDirs = await findMediaDirectories(options?.customKnownPaths, options?.excludedPaths)
      const result = await runScanChannels(gameDirs)
      if (result) {
        const { totalFiles, totalSaved, officialAlbum, secondary } = result
        progress.status = 'completed'
        updateScanHistory(scanId, 'completed', totalFiles, totalSaved)
        sendScanLogEntry({
          stage: 'file-scan',
          level: 'info',
          kind: 'ok',
          message: `共扫描 ${officialAlbum.length + secondary.length} 个目录（官方相册 ${officialAlbum.length} + 次级 ${secondary.length}），发现 ${totalFiles} 个媒体文件，新增 ${totalSaved} 个`,
          detail: { officialAlbum, secondary, totalFiles, totalSaved }
        })

        // P2-2：扫描写入已结束，收缩 WAL 文件（绝不放在批量写入循环中）
        await finalizeScanCheckpoint()
        return makeScanCompleteResult(
          true,
          `扫描完成，扫描 ${officialAlbum.length + secondary.length} 个目录，发现 ${totalFiles} 个媒体文件，新增 ${totalSaved} 个`,
          totalFiles
        )
      }
      targetPath = null
    }

    if (!targetPath) {
      progress.status = 'failed'
      updateScanHistory(scanId, 'failed', 0, 0)
      return makeScanCompleteResult(false, t('main.scanner.error.gameDirNotFound'))
    }

    // 单目录扫描（导入向导）：禁用缓存目录跳过与小图片过滤，避免用户导入的文件被误跳过
    const { files, savedCount } = await scanDirectory(targetPath, options?.incremental, false)

    // T02：扫描完成后执行文件完整性校验
    // 全量扫描刚扫完文件必然存在，仅增量扫描需检查文件是否被外部移动/删除
    if (options?.incremental) {
      // T02 修复：仅校验本次单目录导入覆盖的根，避免全库磁盘访问
      await checkMissingFiles([targetPath])
    }

    progress.status = 'completed'
    updateScanHistory(scanId, 'completed', files.length, savedCount)

    // P2-2：扫描写入已结束，收缩 WAL 文件（绝不放在批量写入循环中）
    await finalizeScanCheckpoint()
    return makeScanCompleteResult(
      true,
      `扫描完成，发现 ${files.length} 个媒体文件，新增 ${savedCount} 个`,
      files.length
    )
  } catch (error) {
    progress.status = 'failed'
    updateScanHistory(scanId, 'failed', progress.found, 0)
    return makeScanCompleteResult(
      false,
      `扫描失败: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

// ============ 资源清理与退出 ============

/**
 * worker 退出前清理：关闭 DB + kill 所有子进程 + 退出。
 * 必须使用同步操作，避免异步 I/O 延迟进程退出。
 */
// FIX(组3-6): 重入保护——dispose 的 SCAN_DISPOSE、心跳超时兜底与 'exit' 事件监听
// 都可能先后触发本函数：db 已 close 后重复 close 抛错虽被 try 吞掉，但日志混乱；
// 置位后其余调用直接返回（process.exit 本身幂等，此处只为清理动作只执行一次）
let isExiting = false
function cleanupAndExit(graceful = false): void {
  if (isExiting) return
  isExiting = true
  // 停止心跳定时器，避免清理过程中（dispose 停发 ping 导致超时）再次触发本函数
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  try {
    if (db) {
      try {
        db.pragma('wal_checkpoint(PASSIVE)')
      } catch {}
      db.close()
      db = null
    }
  } catch {}
  // kill 所有 worker 启动的 ffprobe 子进程（process-registry 在 worker 内是独立实例）
  try {
    killAllProcesses('SIGKILL')
  } catch {}
  if (graceful) {
    // 新增：DISPOSE 正常退出——先回发确认表示 DB 句柄已释放，主进程据此可安全 rename 还原。
    // 用 setImmediate 延迟 process.exit，确保 IPC 消息在事件循环中被写出，避免同步 process.exit 截断未发送的消息。
    try {
      sendEvent({ type: 'WORKER_DISPOSED' })
    } catch {}
    setImmediate(() => process.exit(0))
  } else {
    process.exit(0)
  }
}

// ============ 消息处理 ============

// utilityProcess 中 parentPort 推送的 'message' 事件参数是 Node.js 的 MessageEvent（仅含 data 字段），
// 但 lib.dom.d.ts 也声明了 MessageEvent（含 lastEventId/origin/source 等），两者冲突。
// 此处用最小结构类型 { data: unknown } 避免冲突，运行时只读 data 字段
process.parentPort?.on('message', async (event: { data: unknown }) => {
  const msg = event.data as WorkerCommand
  if (msg.type === 'SCAN_START') {
    try {
      const result = await startScan(msg.payload.dbPath, msg.payload.options)
      sendEvent({ type: 'SCAN_COMPLETE', payload: result })
    } catch (err) {
      sendEvent({
        type: 'SCAN_COMPLETE',
        payload: {
          success: false,
          message: `扫描异常: ${err instanceof Error ? err.message : String(err)}`
        }
      })
    }
  } else if (msg.type === 'SCAN_STOP') {
    abortScan()
  } else if (msg.type === 'SCAN_DISPOSE') {
    cleanupAndExit(true)
  } else if (msg.type === 'WORKER_PING') {
    // R14：收到主进程心跳，刷新时间戳
    lastPingTime = Date.now()
  }
})

// ============ R14 心跳检测 ============

/**
 * 每 5s 检查一次主进程心跳。超过 HEARTBEAT_TIMEOUT_MS（15s，3 次未收到 ping）
 * 视为父进程已崩溃/退出，立即停止扫描并清理退出，避免 worker 成为孤儿继续写入 DB。
 *
 * 仅在真实 utilityProcess 环境启动：本文件是 worker 入口，模块顶层副作用必须以
 * process.parentPort 存在为前提——若被主进程 chunk 误引用（无 parentPort、永远收不到
 * WORKER_PING），看门狗会在启动 15s 后以 process.exit(0) 静默杀死主进程
 * （2026-08-29 打包版闪退根因，取证报告见提交历史）。
 */
const HEARTBEAT_INTERVAL_MS = 5000
const HEARTBEAT_TIMEOUT_MS = 15000
const heartbeatTimer: NodeJS.Timeout | null = process.parentPort
  ? setInterval(() => {
      if (Date.now() - lastPingTime > HEARTBEAT_TIMEOUT_MS) {
        workerLog('error', t('main.scanner.log.heartbeatTimeout'))
        abortScan()
        cleanupAndExit()
      }
    }, HEARTBEAT_INTERVAL_MS)
  : null
// unref：心跳定时器不阻止进程退出（dispose 时 cleanupAndExit 调用 process.exit 能立即生效）
heartbeatTimer?.unref?.()

// ============ 兜底清理 ============

// 以下进程级兜底（exit / uncaughtException / unhandledRejection → cleanupAndExit →
// process.exit）仅应在真实 worker 进程注册：若在主进程注册，任何主进程退出/未捕获
// 异常都会被 worker 的 process.exit(0) 抢先接管，绕过主进程自身的清理与诊断链。
if (process.parentPort) {
  // process.exit 触发时清理（Node.js 原生事件，一定会触发）
  process.on('exit', cleanupAndExit)

  // 未捕获异常：扫描中先补发失败的 SCAN_COMPLETE 再清理退出
  process.on('uncaughtException', (err) => {
    // FIX(组3-3): 直接 cleanupAndExit 会跳过终态事件——主进程只能依赖 exit 合成的通用
    // "扫描进程异常退出"兜底（丢失具体错误信息），且 WORKER_ERROR 与 exit 几乎同时到达
    // 存在时序竞争。扫描进行中时主动补发携带真实错误消息的 SCAN_COMPLETE。
    if (progress.status === 'running') {
      sendEvent({
        type: 'SCAN_COMPLETE',
        payload: { success: false, message: `扫描进程异常退出: ${err.message}` }
      })
    }
    sendEvent({
      type: 'WORKER_ERROR',
      payload: { message: err.message, stack: err.stack }
    })
    cleanupAndExit()
  })

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    // FIX(组3-3): 同 uncaughtException——扫描中先补发失败终态再退出
    if (progress.status === 'running') {
      sendEvent({
        type: 'SCAN_COMPLETE',
        payload: { success: false, message: `扫描进程异常退出: ${err.message}` }
      })
    }
    sendEvent({
      type: 'WORKER_ERROR',
      payload: { message: err.message, stack: err.stack }
    })
    cleanupAndExit()
  })
}

// ============ 启动完成通知 ============

// 向主进程发送 WORKER_READY，表示 worker 已就绪可接收 SCAN_START
sendEvent({ type: 'WORKER_READY' })
