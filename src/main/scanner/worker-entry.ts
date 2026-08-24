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
 * 4. shouldStop 改为模块级变量，由 SCAN_STOP 消息设置
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
import { t } from '../i18n/worker-safe'
// C-G3：共享命名常量（取代魔法数字）
// TDD 重构：路径分类纯函数抽取到独立文件，便于单元测试（无 electron/sharp/ffmpeg 依赖）
import {
  extractUidFromPath,
  extractAlbumTypeFromPath,
  extractMediaSourceFromPath
} from './path-classifier'
// 方案三：独立游戏目录 UID 发现机制（对齐上游 nikki_albums）
import { discoverUidsFromGameDirs } from './uid-discovery'
// P0-01：游戏目录发现函数抽取为独立模块，便于单元测试 vi.mock 桩替换（循环依赖仅调用期使用，ESM 安全）
import {
  searchBySignatureShallow,
  searchByMediaFolderSignatureShallow,
  searchByInstallTreeSignatureShallow,
  findSteamGamePaths,
  findEpicGamePaths,
  getAvailableDrives,
  getUserDataPaths
} from './game-directory-discovery'
// P2-1：复用主进程已有的 asar 解包路径修正工具，确保 worker 加载 better-sqlite3 与主进程行为一致
import { resolveAsarUnpackedPath } from '../utils/ffmpeg-paths'
// 子进程注册表：worker 退出时 kill 所有活跃的 ffmpeg/ffprobe 子进程
import { killAllProcesses } from '../utils/process-registry'
import type {
  WorkerCommand,
  WorkerEvent,
  ScanOptions,
  ScanProgress,
  MediaFile
} from './worker-protocol'

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

// P0-01：全盘文件名签名搜索的并发盘符数限制
const DRIVE_SCAN_CONCURRENCY = 4

// 全盘签名搜索的最大深度。
// 6 → 覆盖 Steam/Epic 标准安装路径（steamapps/common/InfinityNikki 最深 5 层 + 媒体 2-3 层）；
// 8 → 额外覆盖官网/WeGame 启动器非标准安装树 `InfinityNikki Launcher\InfinityNikki\X6Game\Saved\GamePlayPhotos\$uid$`
// （从盘符根出发已达 7-8 层）。tinyglobby 的 fdir maxDepth 为 C 层一次性遍历，8 相对 6 仅线性增加少量目录 IO。
const SIGNATURE_SEARCH_DEPTH = 8

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
export let shouldStop = false
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
function sendScanLogInfo(message: string): void {
  try {
    process.parentPort?.postMessage({ type: 'SCAN_LOG', payload: { level: 'info', message } })
  } catch {
    // parentPort 不可用时丢弃日志，避免日志本身导致 worker 崩溃
  }
}

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
 */
async function checkMissingFiles(): Promise<void> {
  if (!db) return
  try {
    const rows = db
      .prepare('SELECT id, file_path FROM media_files WHERE is_deleted = 0')
      .all() as Array<{ id: number; file_path: string }>

    if (rows.length === 0) return

    const updateMissing = db.prepare(
      'UPDATE media_files SET missing_count = missing_count + 1, is_missing = CASE WHEN missing_count + 1 >= 2 THEN 1 ELSE 0 END WHERE id = ?'
    )
    const updateFound = db.prepare(
      'UPDATE media_files SET missing_count = 0, is_missing = 0 WHERE id = ?'
    )
    const updateAll = db.transaction((missingIds: number[], foundIds: number[]) => {
      for (const id of missingIds) updateMissing.run(id)
      for (const id of foundIds) updateFound.run(id)
    })

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
    await runWithConcurrency(tasks, 8)
    updateAll(missingIds, foundIds)

    if (missingIds.length > 0) {
      workerLog(
        'info',
        `[Scanner] 完整性校验：${missingIds.length} 个文件缺失，${foundIds.length} 个文件存在`
      )
    }
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
 * 修复策略（批次A R1+R2 更新）：
 * - `customSet`：自定义路径，存在即加入，**恒包含于最终结果**（不会被早退或软过滤剔除）。
 * - 快速路径按置信度分组：`registrySet`（Steam/Epic 注册表命中，高置信——注册表项就是
 *   InfinityNikki 的安装路径）与 `lowConfidenceSet`（getUserDataPaths 命中，低置信——可能
 *   只是 launcher 缓存而非游戏本体目录）。软过滤（`infinitynikki` 关键字）只作用于二者并集
 *   （与历史版本对快速路径的处理一致），自定义路径永不被挤出。
 * - `signatureSet`：全盘签名搜索命中。专属媒体文件夹签名（MEDIA_FOLDER_SIGNATURES，含
 *   NikkiPhotos_HighQuality 等）已足够精确，恒包含于最终结果、不参与软过滤——旧实现对合并后
 *   的集合软过滤，launcher 缓存（含 infinitynikki）命中时会把签名搜索发现的中文安装路径等
 *   非 infinitynikki 目录误剔除，使 forceSignatureSearch 在非 Steam/Epic 标准路径场景失效（R1）。
 * - forceSignatureSearch 早退规则（R2）：非 force 时快速路径并集非空即早退（与历史行为
 *   完全一致）；force 时仅 `registrySet`（高置信）非空才早退，低置信命中不早退，避免
 *   Steam/Epic 首装全盘扫描在注册表已命中时仍做数十秒零收益的 depth-6 搜索。
 * - 最终返回去重后的 `[...customSet, ...filteredQuick, ...signatureSet]`。
 *
 * 流程：
 * - 优先路径：用户在设置页手动配置的游戏目录（customPaths），存在即加入结果集
 * - 快速路径：Steam/Epic 注册表查询 + 用户数据目录（AppData 下游戏数据）
 * - 签名搜索：对所有可用盘符执行 depth=6 深度优先搜索（仅当自动发现为空时执行）
 * - 并发扫描多个盘符（并发限制 4），提升搜索速度
 *
 * @param customPaths 用户在设置页手动配置的游戏目录，优先扫描；存在有效目录时恒包含（不抑制全盘搜索）
 * @param opts.forceSignatureSearch 全盘扫描强制执行签名搜索（高置信注册表命中仍早退，低置信命中不早退）
 * @returns 所有匹配的媒体目录列表（去重）
 */
export async function findMediaDirectories(
  customPaths?: string[],
  opts?: { forceSignatureSearch?: boolean }
): Promise<string[]> {
  // 自定义路径与自动发现分离：自定义路径恒包含，自动发现用独立计数判断是否跳过全盘搜索
  const customSet = new Set<string>()
  // 快速路径按置信度分组（批次A R2）：registrySet 高置信（注册表项即安装路径），
  // lowConfidenceSet 低置信（可能是 launcher 缓存而非游戏本体目录）
  const registrySet = new Set<string>()
  const lowConfidenceSet = new Set<string>()
  // 签名搜索命中（批次A R1）：专属签名足够精确，恒包含、不参与软过滤
  const signatureSet = new Set<string>()

  // 0. 优先路径：用户自定义游戏目录
  // 用户在设置页手动指定的目录，存在即加入结果集；不存在则跳过（游戏可能未安装但用户预配置）。
  // 注意：自定义路径不计入快速路径集合，因此不会触发下方“跳过全盘签名搜索”的早退，也不会被软过滤剔除。
  if (customPaths && customPaths.length > 0) {
    let validCount = 0
    for (const p of customPaths) {
      if (!p || typeof p !== 'string') continue
      try {
        await fsp.access(p)
        customSet.add(p)
        validCount++
      } catch {
        workerLog('warn', `[Scanner] 用户自定义路径不存在，跳过: ${p}`)
      }
    }
    if (validCount > 0) {
      workerLog('info', `[Scanner] 用户自定义路径加入 ${validCount} 个有效目录`)
    }
  }

  // 1. 快速路径（高置信）：Steam + Epic 注册表查询
  for (const p of await findSteamGamePaths()) registrySet.add(p)
  for (const p of await findEpicGamePaths()) registrySet.add(p)

  // 2. 快速路径（低置信）：用户数据目录（AppData 下的游戏数据）
  // SYSTEM_DIRS_TO_SKIP 跳过 appdata，全盘签名搜索无法进入，必须显式检查
  for (const p of await getUserDataPaths()) lowConfidenceSet.add(p)

  const quickSet = new Set<string>([...registrySet, ...lowConfidenceSet])

  // P1-A3 + 批次A R2：快速路径早退——
  // - 非 force：quickSet（注册表 ∪ 用户数据目录）非空即早退，与历史行为完全一致；
  // - force：仅 registrySet（高置信，注册表项就是 InfinityNikki 安装路径）非空才早退；
  //   lowConfidenceSet 命中（可能只是 launcher 缓存，T1 场景）不早退，仍执行全盘签名搜索。
  if (registrySet.size > 0 || (quickSet.size > 0 && !opts?.forceSignatureSearch)) {
    sendScanLogInfo(
      opts?.forceSignatureSearch
        ? `[Scanner] 注册表高置信已找到 ${registrySet.size} 个目录，跳过全盘签名搜索`
        : `[Scanner] 快速路径已找到 ${quickSet.size} 个目录，跳过全盘签名搜索`
    )
  } else {
    // T2：进入签名搜索分支时透传结论日志，便于打包版 main.log 诊断目录发现过程
    sendScanLogInfo(`[Scanner] 全盘签名搜索开始（快速路径已命中 ${quickSet.size} 个目录）`)
    // 3. 签名搜索（depth 8，覆盖常见安装路径 + 非标准安装树深层媒体目录）
    // Steam 安装路径 steamapps/common/InfinityNikki 最深 5 层，媒体文件夹在游戏目录下 2-3 层；
    // 官网/WeGame 启动器安装路径 `InfinityNikki Launcher\InfinityNikki\X6Game\Saved\GamePlayPhotos\$uid$`
    // 从盘符根出发已达 7-8 层，depth 6 常因边界漏扫。上调至 8 覆盖该非标准安装树，
    // tinyglobby 的 fdir maxDepth 在 C 层一次性遍历，depth 8 相比 6 仅线性增加少量目录系统调用。
    const drives = await getAvailableDrives()
    const driveTasks = drives.map((drive) => async () => {
      if (shouldStop) return
      // 优先搜索媒体文件夹（精确），找到就不搜索游戏 exe（避免扫描整个游戏目录）
      const mediaDirs = await searchByMediaFolderSignatureShallow(drive, SIGNATURE_SEARCH_DEPTH)
      if (mediaDirs.length > 0) {
        for (const d of mediaDirs) signatureSet.add(d)
      } else {
        // 媒体文件夹没找到，搜索游戏 exe
        const gameDir = await searchBySignatureShallow(drive, SIGNATURE_SEARCH_DEPTH)
        if (gameDir) signatureSet.add(gameDir)
      }
      // 安装树锚点签名：独立补充，不依赖媒体/ exe 命中结果——
      // 专门覆盖非标准安装树（InfinityNikki Launcher\InfinityNikki\X6Game），
      // 该场景下既没有 exe 签名、媒体目录又常因 depth 边界被媒体签名漏掉，必须单独兜底。
      // 命中后返回安装树根（如 `...\InfinityNikki`），scanDirectory 从其递归即可覆盖全部媒体。
      const treeRoots = await searchByInstallTreeSignatureShallow(drive, SIGNATURE_SEARCH_DEPTH)
      for (const r of treeRoots) signatureSet.add(r)
    })
    await runWithConcurrency(driveTasks, DRIVE_SCAN_CONCURRENCY)
  } // end of else（全盘签名搜索）

  // 软过滤（批次A R1）：仅作用于快速路径集合（registrySet ∪ lowConfidenceSet），与历史版本对
  // 快速路径的处理保持一致（infinitynikki 优先保留，避免其他游戏的目录混入快速结果）。
  // 签名搜索命中（signatureSet）不参与软过滤——专属签名（含 NikkiPhotos_HighQuality 等）已足够
  // 精确；旧实现对合并后的集合过滤，launcher 缓存（含 infinitynikki）命中时会把签名搜索发现的
  // 中文安装路径等非 infinitynikki 目录误剔除（forceSignatureSearch 的目标场景完全落空）。
  // test_media 测试目录与 War Thunder 等其他游戏的 ScreenShot 目录过滤，依赖
  // searchByMediaFolderSignatureShallow 内的 screenshot 上下文校验与后续 repairLegacyData 白名单清理。
  const infinityNikkiDirs = Array.from(quickSet).filter((p) =>
    p.toLowerCase().includes('infinitynikki')
  )
  const filteredQuick = infinityNikkiDirs.length > 0 ? infinityNikkiDirs : Array.from(quickSet)

  if (infinityNikkiDirs.length === 0 && quickSet.size > 0) {
    workerLog(
      'warn',
      `[Scanner] 快速路径未找到含 'infinitynikki' 的路径，回退使用全部 ${quickSet.size} 个快速路径目录`
    )
  }

  // 合并（批次A R1）：自定义路径与签名命中恒包含；快速路径按软过滤结果并入；整体去重。
  const result = new Set<string>([...customSet, ...filteredQuick, ...signatureSet])
  // T2：目录发现结论日志透传（低频关键诊断信息，绕过 workerLog 的 info 屏蔽）
  sendScanLogInfo(
    `[Scanner] findMediaDirectories 搜索结果: ${result.size} 个目录（自定义 ${customSet.size} + 快速路径过滤后 ${filteredQuick.length} + 签名命中 ${signatureSet.size}）`
  )
  // 逐目录日志截断：兑现 sendScanLogInfo “低频白名单”承诺——结果目录数可能很大
  // （多盘符多签名命中时可达数十个），最多输出前 20 个目录，其余以一条汇总行带过
  const MAX_LOGGED_DIRS = 20
  const resultDirs = Array.from(result)
  for (const d of resultDirs.slice(0, MAX_LOGGED_DIRS)) sendScanLogInfo(`[Scanner]   - ${d}`)
  if (resultDirs.length > MAX_LOGGED_DIRS) {
    sendScanLogInfo(`[Scanner]   - （其余 ${resultDirs.length - MAX_LOGGED_DIRS} 个目录略）`)
  }

  return resultDirs
}

// 注：searchBySignatureShallow / searchByMediaFolderSignatureShallow 已抽取至 ./game-directory-discovery
// （便于单元测试用 vi.mock 桩替换，避免真实盘符/注册表 IO）。

// 注：findSteamGamePaths 已抽取至 ./game-directory-discovery

// 注：findEpicGamePaths / querySteamInstallPath / getAvailableDrives / getUserDataPaths 已抽取至 ./game-directory-discovery

// ============ 目录扫描 ============

export async function scanDirectory(
  rootPath: string,
  incremental?: boolean,
  // 单目录扫描（导入向导）传 false 可禁用缓存目录跳过与小图片过滤，避免用户文件被误跳过
  applyFilters = true
): Promise<{ files: MediaFile[]; savedCount: number }> {
  const files: MediaFile[] = []
  let savedCount = 0

  // 增量扫描：获取已索引的文件路径和修改时间
  const existingFiles = new Map<string, string>()
  if (incremental && db) {
    // FIX(组3-5): 仅加载本次扫描根目录下的已有记录——原无 WHERE 全表 SELECT 在单目录
    // 导入时也把整个库拉入内存（万级库每次多一次全表扫描 + Map 构建）。
    // LIKE 前缀可走 file_path 唯一索引；ESCAPE 转义路径中的 \/%/_ 防止误当通配符，
    // LIKE 对 ASCII 不区分大小写，兼容 Windows 路径盘符大小写差异
    const prefix = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep
    const likePattern = prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`) + '%'
    const rows = db
      .prepare("SELECT file_path, modified_at FROM media_files WHERE file_path LIKE ? ESCAPE '\\'")
      .all(likePattern) as Array<{
      file_path: string
      modified_at: string
    }>
    for (const row of rows) {
      existingFiles.set(row.file_path, row.modified_at)
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
  // F-G1：进度更新改为时间节流（每 500ms emit 一次），小目录也能及时反馈
  lastProgressEmit = 0

  const scan = async (dir: string, depth: number) => {
    if (shouldStop) return
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

      const entries = await fsp.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (shouldStop) return

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
          if (applyFilters && CACHE_DIR_NAMES.has(entry.name.toLowerCase())) continue
          await scan(fullPath, depth + 1)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase()
          if (IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext)) {
            const stats = await fsp.stat(fullPath)
            // P0修复：过滤过小的图片文件（缓存缩略图通常 < 5KB，游戏照片通常 > 200KB）
            // 单目录扫描（applyFilters=false）时不过滤，保留用户导入的小图片
            if (applyFilters && !VIDEO_EXTENSIONS.has(ext) && stats.size < 5 * 1024) {
              continue
            }

            // 增量扫描：跳过未修改的文件
            // F-G5：mtime 比较容忍 1 秒精度差，避免 ISO 字符串毫秒精度丢失导致重复处理
            if (incremental) {
              const existingMtime = existingFiles.get(fullPath)
              if (
                existingMtime &&
                Math.abs(new Date(existingMtime).getTime() - stats.mtime.getTime()) <= 1000
              ) {
                continue
              }
            }

            if (VIDEO_EXTENSIONS.has(ext)) {
              pendingVideos.push({ fullPath, ext, entryName: entry.name, stats })
            } else {
              // P0-02：根据路径识别角色档案 UID
              // 方案二：自动注册发现的 UID 到 character_profiles 表
              const discoveredUid = extractUidFromPath(fullPath)
              autoRegisterUid(discoveredUid)
              await addFile({
                file_path: fullPath,
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
                media_source: extractMediaSourceFromPath(fullPath)
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
    // 方案二：自动注册发现的 UID 到 character_profiles 表
    const discoveredUid = extractUidFromPath(fullPath)
    autoRegisterUid(discoveredUid)
    await addFile({
      file_path: fullPath,
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
        markCorruptedByPath(fullPath, `视频元数据读取失败: ${videoCorruptedReason}`)
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
      (file_path, file_name, file_type, file_ext, file_size, width, height, duration, created_at, modified_at, source_path, indexed_at, tags, category_id, rating, is_favorite, notes, scene_category, scene_time, outfit, account_uid, album_type, media_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, 0, 0, '', ?, ?, ?, ?, ?, ?)
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
        -- FIX(组3-2): 扫描刚物理确认文件存在，缺失计数与标记必须归零——ON CONFLICT 不重置该列时，
        -- 记录删除重建/外部移动后扫回/DB 迁移残留的旧 missing_count 会让下次完整性校验
        -- 首次 access 失败即置 is_missing=1，跳过"连续两次缺失"防抖缓冲
        missing_count = 0,
        is_missing = 0
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
          file.media_source
        )
      }
    })

    insertMany(batch)
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
 * 扫描入口（迁移自 ScannerManager.startScan）。
 * 接收 SCAN_START 消息后调用，执行完整扫描流程并通过 SCAN_PROGRESS/SCAN_COMPLETE 推送结果。
 */
async function startScan(
  dbPath: string,
  options: ScanOptions
): Promise<{ success: boolean; message: string; filesFound?: number }> {
  // 1. 打开 DB（如未打开或路径变化）
  try {
    openDatabaseIfNeeded(dbPath)
  } catch (err) {
    return {
      success: false,
      message: `数据库打开失败: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // 2. 重置状态
  shouldStop = false
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

  try {
    // 全盘扫描模式：直接全盘搜索媒体特征文件夹，不依赖游戏目录查找
    // 修复：原"全量重扫"只是 incremental:false，仍依赖 findGameDirectory 找单个目录
    // 全盘扫描遍历所有盘符查找含媒体特征文件夹的目录并全部扫描，覆盖所有安装场景
    if (options?.fullScan && !options?.path) {
      // T1：全盘扫描强制执行签名搜索——快速路径的 launcher 缓存命中不能当作"游戏目录已找到"，
      // 游戏装在非 Steam/Epic 标准路径时仍需全盘签名搜索兜底
      const mediaDirs = await findMediaDirectories(options?.customKnownPaths, {
        forceSignatureSearch: true
      })
      if (mediaDirs.length === 0) {
        progress.status = 'failed'
        updateScanHistory(scanId, 'failed', 0, 0)
        return { success: false, message: t('main.scanner.error.noMediaDirFound') }
      }

      // 方案三：从游戏目录独立发现 UID 并注册到 character_profiles 表
      const discoveredUids = discoverUidsFromGameDirs(mediaDirs, workerLog)
      for (const uid of discoveredUids) autoRegisterUid(uid)

      let totalFiles = 0
      let totalSaved = 0
      for (const dir of mediaDirs) {
        if (shouldStop) break
        progress.currentPath = dir
        const { files, savedCount } = await scanDirectory(dir, options?.incremental)
        totalFiles += files.length
        totalSaved += savedCount
      }

      // T02：扫描完成后执行文件完整性校验
      // 全量扫描刚扫完文件必然存在，仅增量扫描需检查文件是否被外部移动/删除
      if (options?.incremental) {
        await checkMissingFiles()
      }

      progress.status = 'completed'
      updateScanHistory(scanId, 'completed', totalFiles, totalSaved)

      return {
        success: true,
        message: `全盘扫描完成，扫描 ${mediaDirs.length} 个目录，发现 ${totalFiles} 个媒体文件，新增 ${totalSaved} 个`,
        filesFound: totalFiles
      }
    }

    let targetPath: string | null | undefined = options?.path

    if (!targetPath) {
      // F-O1：优先使用用户自定义路径，回退到默认 KNOWN_PATHS
      // 修复：findGameDirectory 改为 findMediaDirectories 返回所有匹配目录
      const gameDirs = await findMediaDirectories(options?.customKnownPaths)
      if (gameDirs.length > 0) {
        // 方案三：从游戏目录独立发现 UID 并注册到 character_profiles 表
        const discoveredUids = discoverUidsFromGameDirs(gameDirs, workerLog)
        for (const uid of discoveredUids) autoRegisterUid(uid)

        // 扫描所有找到的游戏目录（修复：原版只扫描第一个）
        let totalFiles = 0
        let totalSaved = 0
        for (const dir of gameDirs) {
          if (shouldStop) break
          progress.currentPath = dir
          const { files, savedCount } = await scanDirectory(dir, options?.incremental)
          totalFiles += files.length
          totalSaved += savedCount
        }

        // 全量扫描刚扫完文件必然存在，仅增量扫描需检查文件是否被外部移动/删除
        if (options?.incremental) {
          await checkMissingFiles()
        }
        progress.status = 'completed'
        updateScanHistory(scanId, 'completed', totalFiles, totalSaved)

        return {
          success: true,
          message: `扫描完成，扫描 ${gameDirs.length} 个目录，发现 ${totalFiles} 个媒体文件，新增 ${totalSaved} 个`,
          filesFound: totalFiles
        }
      }
      targetPath = null
    }

    if (!targetPath) {
      progress.status = 'failed'
      updateScanHistory(scanId, 'failed', 0, 0)
      return { success: false, message: t('main.scanner.error.gameDirNotFound') }
    }

    // 单目录扫描（导入向导）：禁用缓存目录跳过与小图片过滤，避免用户导入的文件被误跳过
    const { files, savedCount } = await scanDirectory(targetPath, options?.incremental, false)

    // T02：扫描完成后执行文件完整性校验
    // 全量扫描刚扫完文件必然存在，仅增量扫描需检查文件是否被外部移动/删除
    if (options?.incremental) {
      await checkMissingFiles()
    }

    progress.status = 'completed'
    updateScanHistory(scanId, 'completed', files.length, savedCount)

    return {
      success: true,
      message: `扫描完成，发现 ${files.length} 个媒体文件，新增 ${savedCount} 个`,
      filesFound: files.length
    }
  } catch (error) {
    progress.status = 'failed'
    updateScanHistory(scanId, 'failed', progress.found, 0)
    return {
      success: false,
      message: `扫描失败: ${error instanceof Error ? error.message : String(error)}`
    }
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
function cleanupAndExit(): void {
  if (isExiting) return
  isExiting = true
  // 停止心跳定时器，避免清理过程中（dispose 停发 ping 导致超时）再次触发本函数
  clearInterval(heartbeatTimer)
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
  process.exit(0)
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
    shouldStop = true
  } else if (msg.type === 'SCAN_DISPOSE') {
    cleanupAndExit()
  } else if (msg.type === 'WORKER_PING') {
    // R14：收到主进程心跳，刷新时间戳
    lastPingTime = Date.now()
  }
})

// ============ R14 心跳检测 ============

/**
 * 每 5s 检查一次主进程心跳。超过 HEARTBEAT_TIMEOUT_MS（15s，3 次未收到 ping）
 * 视为父进程已崩溃/退出，立即停止扫描并清理退出，避免 worker 成为孤儿继续写入 DB。
 */
const HEARTBEAT_INTERVAL_MS = 5000
const HEARTBEAT_TIMEOUT_MS = 15000
const heartbeatTimer = setInterval(() => {
  if (Date.now() - lastPingTime > HEARTBEAT_TIMEOUT_MS) {
    workerLog('error', t('main.scanner.log.heartbeatTimeout'))
    shouldStop = true
    cleanupAndExit()
  }
}, HEARTBEAT_INTERVAL_MS)
// unref：心跳定时器不阻止进程退出（dispose 时 cleanupAndExit 调用 process.exit 能立即生效）
heartbeatTimer.unref?.()

// ============ 兜底清理 ============

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

// ============ 启动完成通知 ============

// 向主进程发送 WORKER_READY，表示 worker 已就绪可接收 SCAN_START
sendEvent({ type: 'WORKER_READY' })
