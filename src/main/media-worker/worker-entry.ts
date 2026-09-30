/**
 * 缩略图 / pHash / 重复检测 worker 进程入口
 *
 * 由主进程通过 utilityProcess.fork() 启动，承载三类批量任务的 CPU 密集计算：
 * 1. 缩略图批量生成（同时补算缺 phash 的图片，保持 processThumbnailForRow 三路并行）
 * 2. pHash 批量补算（完成后自动链式 markDuplicates）
 * 3. 重复标记（O(n²) Union-Find 聚类）
 *
 * 改造点（相对原 thumbnail-phash-service.ts）：
 * 1. DB 连接：worker 内部 new Database(dbPath)，配置与主进程一致的 PRAGMA + busy_timeout=5000
 * 2. console.log → workerLog（warn/error 通过 MEDIA_WORKER_LOG 转发，info 丢弃）
 * 3. ctx.thumbnailGen.generate → 内部轻量版 generateThumbnailInWorker（不依赖主进程 ThumbnailGenerator 类）
 * 4. ctx.getMainWindow()?.webContents.send → 通过 parentPort 推送 *_PROGRESS / *_COMPLETE
 * 5. 三个独立的 shouldStop 标志，互不影响
 *
 * 兼容性：功能输出与原 thumbnail-phash-service.ts 完全一致
 * - 缩略图文件路径：<cacheDir>/<contentHash>.jpg（与主进程 ThumbnailGenerator 相同算法）
 * - media_files 字段更新：thumbnail / width / height / phash / is_duplicate / original_id
 */
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import sharp from 'sharp'
import ffmpeg from 'fluent-ffmpeg'
// 步骤4：原生模块改为惰性加载，使 ABI 不匹配时崩溃能被 worker 的未捕获异常处理捕获并发送 MEDIA_WORKER_ERROR
import type DatabaseType from 'better-sqlite3'
// C-3：统一文件存在检查与视频扩展名判定
import { pathExists } from '../utils/file-utils'
import { isVideoExt } from '../utils/media-constants'
import { t } from '../i18n/worker-safe'
// P1-A7：统一 ffmpeg 路径解析（asar unpacked 路径自动修正）
import { ffmpegPath as ffmpegBinaryPath } from '../utils/ffmpeg-paths'
import { trackFfmpegCommand, untrackFfmpegCommand } from '../utils/process-registry'
import { killAllProcesses } from '../utils/process-registry'
import { runWithConcurrency } from '../utils/concurrency'
import { THUMBNAIL_CONCURRENCY } from '../utils/constants'
// 纯色帧判定（修复视频缩略图纯白）：无 i18n / logger 依赖，主进程与 media worker 共用
import { isBlankImageFile, isBlankCachedThumbnail } from '../utils/video-frame'
// N2 原子落盘：临时文件 + rename 替换，消除 media:// 半截读取（裂图）与双写者竞态
import { writeFileAtomic, tempSiblingPath, removeTempFileQuietly } from '../utils/atomic-file'
import { calculatePHash, hammingDistance } from '../utils/phash'
import { pickBestId } from '../utils/duplicate-scoring'
import { buildAndSearch } from './bktree-index'
import type {
  MediaWorkerCommand,
  MediaWorkerEvent,
  ThumbnailQuality,
  SimilarRowMeta
} from './worker-protocol'
import { installFfmpegSpawnGuard } from '../utils/fluent-ffmpeg-shim'

// fluent-ffmpeg spawn 逃逸垫片：本 worker 任何 ffmpeg 抽帧 .run() 之前尽早安装（幂等）。
// 将损坏二进制导致的 spawn 同步抛错（EFTYPE）收敛为回调错误，避免视频缩略图链路崩溃。
installFfmpegSpawnGuard()

// ============ 常量（与主进程 ThumbnailGenerator 保持一致，确保文件名/质量相同） ============

// A-S8：内容 hash 读取文件前 1MB，兼顾唯一性与性能
const CONTENT_HASH_READ_SIZE = 1024 * 1024
// 缩略图档位参数（与主进程 ThumbnailGenerator 完全一致）
const STANDARD_MAX_WIDTH = 320
const STANDARD_MAX_HEIGHT = 320
const STANDARD_QUALITY = 85
const LOW_MAX_WIDTH = 64
const LOW_MAX_HEIGHT = 64
const LOW_QUALITY = 30
// pHash 重复标记阈值（与原 markDuplicates 完全一致）
const MARK_THRESHOLD = 2

// 单文件处理超时兜底（先例：autoAnalyzeSceneTime 的 SCENE_PER_IMAGE_TIMEOUT_MS + unref 定时器）
// sharp/ffmpeg 无取消 API，超时后不再 await 其结果（结果丢弃），释放 runWithConcurrency 并发槽位，
// 避免单张坏文件（损坏/超大/网络盘）让整个批次永久挂起，导致 *_COMPLETE 永不发送。
// 返回 null 表示"超时或失败，跳过该文件，不写 DB"；返回原始结果表示"正常处理完成"。
export function withFileTimeout<T>(
  task: () => Promise<T>,
  ms: number,
  filePath: string,
  stage: string
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      workerLog('warn', `[${stage}] 单文件处理超时(>${ms}ms)，跳过: ${filePath}`)
      resolve(null)
    }, ms)
    timer.unref?.() // 后台 worker 不应因超时定时器持有 event loop
    Promise.resolve()
      .then(task)
      .then((v) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      })
      .catch((err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        workerLog('warn', `[${stage}] 单文件处理失败，跳过: ${filePath}`, err)
        resolve(null)
      })
  })
}

// 缩略图单文件超时：需兼容 extractVideoFrame 的 30s 内部上限，取 30s；正常视频抽帧 1~3s 不受影响
const THUMBNAIL_PER_FILE_TIMEOUT_MS = 30_000
// pHash 单文件超时：纯 DCT-II 计算，对齐 SCENE_PER_IMAGE_TIMEOUT_MS 取 10s
const PHASH_PER_FILE_TIMEOUT_MS = 10_000

// ============ worker 模块级状态 ============

// 惰性加载 better-sqlite3：首次调用时才 require
let DatabaseImpl: typeof import('better-sqlite3') | null = null
function getDatabaseImpl(): typeof import('better-sqlite3') {
  if (!DatabaseImpl) {
    const mod = require('better-sqlite3')
    // 真实 better-sqlite3 是 CJS 模块，require 返回构造函数本身；Vitest mock 返回 { default: ... }
    DatabaseImpl = (
      typeof mod === 'function' ? mod : mod.default
    ) as typeof import('better-sqlite3')
  }
  return DatabaseImpl
}

let db: DatabaseType.Database | null = null
let currentDbPath = ''

// 三个独立的取消标志（互不影响）
let shouldStopThumbnail = false
let shouldStopPhash = false
let shouldStopDuplicate = false
// 相似检测独立取消标志
let shouldStopSimilar = false

// 进度推送节流（500ms，与 scanner worker 一致）
let lastThumbnailProgressEmit = 0
let lastPhashProgressEmit = 0
let lastDuplicateProgressEmit = 0

// ============ worker log 转发 ============

/**
 * worker 内部日志转发。
 * - info 级别在 worker 内部丢弃（避免跨进程 IPC 开销）
 * - warn / error 级别通过 MEDIA_WORKER_LOG 转发到主进程
 */
function workerLog(level: 'info' | 'warn' | 'error', message: string, ...args: unknown[]): void {
  if (level === 'info') return
  try {
    const event: MediaWorkerEvent = {
      type: 'MEDIA_WORKER_LOG',
      payload: { level, message, args: args.length > 0 ? args : undefined }
    }
    process.parentPort?.postMessage(event)
  } catch {
    // parentPort 不可用时丢弃日志
  }
}

/** 发送事件到主进程 */
function sendEvent(event: MediaWorkerEvent): void {
  try {
    process.parentPort?.postMessage(event)
  } catch {
    // parentPort 不可用时丢弃事件
  }
}

// ============ DB 连接管理 ============

/**
 * 惰性打开 DB 连接（路径变化时关闭旧连接）。
 * 与主进程 DatabaseManager 共享同一 db 文件，WAL 模式 + busy_timeout=5000 保证多连接并发安全。
 */
function openDatabaseIfNeeded(dbPath: string): DatabaseType.Database {
  if (db && currentDbPath === dbPath) return db
  if (db) {
    try {
      db.close()
    } catch {}
  }
  const newDb = new (getDatabaseImpl())(dbPath)
  // PRAGMA 与主进程 DatabaseManager 一致（WAL 多连接并发安全保证）
  newDb.pragma('journal_mode = WAL')
  newDb.pragma('foreign_keys = ON')
  newDb.pragma('synchronous = NORMAL')
  newDb.pragma('cache_size = -20000')
  newDb.pragma('temp_store = MEMORY')
  newDb.pragma('mmap_size = 268435456')
  newDb.pragma('wal_autocheckpoint = 1000')
  // busy_timeout：WAL 模式下多连接并发写入冲突时自动重试 5 秒
  newDb.pragma('busy_timeout = 5000')
  db = newDb
  currentDbPath = dbPath
  return newDb
}

// ============ 缩略图生成（worker 内部轻量版，与主进程 ThumbnailGenerator 算法一致） ============

/**
 * 计算文件内容 hash（前 1MB sha256，取前 16 字符）。
 * 与主进程 ThumbnailGenerator.getFileHash 完全一致，确保文件名相同。
 */
async function getFileHash(filePath: string, stats: fs.Stats): Promise<string> {
  const mtime = stats.mtime.getTime()
  const size = stats.size
  try {
    const hash = crypto.createHash('sha256')
    const handle = await fsp.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(CONTENT_HASH_READ_SIZE)
      const { bytesRead } = await handle.read(buffer, 0, CONTENT_HASH_READ_SIZE, 0)
      hash.update(buffer.subarray(0, bytesRead))
    } finally {
      await handle.close()
    }
    return hash.digest('hex').slice(0, 16)
  } catch (err) {
    // 读取失败时降级为路径+mtime hash，保证功能可用
    workerLog('warn', `[Thumbnail] 内容 hash 计算失败，降级为路径 hash: ${filePath}`, err)
    return crypto
      .createHash('sha256')
      .update(`${filePath}:${mtime}:${size}`)
      .digest('hex')
      .slice(0, 16)
  }
}

// 视频抽帧最大可寻址秒数（参数校验上限），避免传入异常 seek 值
const VIDEO_SEEK_MAX_SECONDS = 60
// 0s 抽帧失败后的重试位置（秒）
const VIDEO_RETRY_SEEK_SECONDS = 1
// 取帧阶梯的第三个位点（秒）：0s / 1s 均为纯色帧时继续向后取帧
const VIDEO_THIRD_SEEK_SECONDS = 3

// 历史缓存自愈：已重建过的纯白视频缩略图 hash。
// 进程内单次守卫，确保真正纯色的视频不会在每次访问时都重试重建。
const blankHealedHashes: Set<string> = new Set()

/**
 * 在 seek 阶梯 [0s, 1s, 3s] 上依次抽帧，采用第一个「非纯色」的帧。
 * （与主进程 ThumbnailGenerator.extractVideoFrame 同构）
 *
 * 背景：片头存在白闪 / 淡入 / 装饰帧的视频，0s 首帧是一张完全平坦的纯白 JPEG
 * （实测 320×180 仅 600~900 字节，正常帧 10~40 KB）。该帧能被正常解码，因此
 * 既不报错也不触发「ffmpeg 失败才重试」的旧逻辑，会作为缩略图永久命中缓存。
 *
 * 规则：
 * - ffmpeg 失败（error / 超时 / 0 字节）→ 记 warn 后进下一位点；全部失败抛末次错误
 * - ffmpeg 成功但判定为纯色 → 非末位则进下一位点；末位仍纯色则保留该帧返回
 *   （降级优于失败，不标损坏）
 * - 首帧有内容时只跑一次，正常视频零额外开销
 */
async function extractVideoFrame(videoPath: string, outputPath: string): Promise<void> {
  const ladder = [0, VIDEO_RETRY_SEEK_SECONDS, VIDEO_THIRD_SEEK_SECONDS]
  let lastError: unknown = null
  // N4 短视频兜底：是否已有成功落盘的帧
  let haveFrame = false

  for (let i = 0; i < ladder.length; i++) {
    const seek = ladder[i]
    try {
      await extractVideoFrameAtSeek(videoPath, outputPath, seek)
      haveFrame = true
    } catch (err) {
      lastError = err
      if (i === ladder.length - 1 && haveFrame) {
        // 末位点（3s）失败但此前已有成功帧：时长 <3s 的视频 seek 3s 会空输出抛错，
        // 若据此判失败会让该行 thumbnail 恒 NULL、每轮批量反复重试。
        // 降级优于失败——保留末次成功帧返回（可能是纯色帧，交给白帧自愈后续处理）。
        workerLog(
          'warn',
          `[Thumbnail] 末位抽帧失败但已保留 ${ladder[i - 1]}s 成功帧 (path: ${videoPath})`
        )
        return
      }
      if (i < ladder.length - 1) {
        workerLog(
          'warn',
          `[Thumbnail] ffmpeg 抽帧 ${seek}s 失败 (${(err as Error)?.message}); 重试 ${
            ladder[i + 1]
          }s (path: ${videoPath})`
        )
      }
      continue
    }

    // 末位点无论是否纯色都保留（不重试、不报错）
    if (i === ladder.length - 1) return
    if (!(await isBlankImageFile(outputPath))) return
    workerLog(
      'warn',
      `[Thumbnail] 抽帧 ${seek}s 为纯色帧，继续尝试 ${ladder[i + 1]}s (path: ${videoPath})`
    )
  }

  if (lastError !== null) throw lastError
}

/**
 * 从标准档位缩略图生成低清副本（64px, q30）：缺失时才生成，失败不阻断主流程。
 * 与主进程 ThumbnailGenerator.doGenerate 一致：从刚生成的标准缩略图缩放。
 */
async function writeLowFromStandard(thumbnailPath: string, lowPath: string): Promise<void> {
  if (await pathExists(lowPath)) return
  try {
    await writeFileAtomic(lowPath, (tmp) =>
      sharp(thumbnailPath)
        .resize(LOW_MAX_WIDTH, LOW_MAX_HEIGHT, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: LOW_QUALITY })
        .toFile(tmp)
    )
  } catch {
    // 低质量生成失败不影响标准缩略图返回
  }
}

function extractVideoFrameAtSeek(
  videoPath: string,
  outputPath: string,
  seekSeconds: number
): Promise<void> {
  // --- 参数校验 ---
  if (!videoPath || typeof videoPath !== 'string') {
    return Promise.reject(new Error(t('main.thumbnail.error.videoPathRequired')))
  }
  if (!outputPath || typeof outputPath !== 'string') {
    return Promise.reject(new Error(t('main.thumbnail.error.outputPathRequired')))
  }
  if (!Number.isFinite(seekSeconds) || seekSeconds < 0 || seekSeconds > VIDEO_SEEK_MAX_SECONDS) {
    return Promise.reject(
      new Error(`extractVideoFrame: seekSeconds 超出 [0, ${VIDEO_SEEK_MAX_SECONDS}]`)
    )
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    // N2 原子落盘：ffmpeg 输出到同目录临时文件，校验通过后 rename 替换最终路径
    const tmpOutputPath = tempSiblingPath(outputPath)
    const cleanup = (cmd: ReturnType<typeof ffmpeg>): void => {
      clearTimeout(timeout)
      untrackFfmpegCommand(cmd)
    }
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      command.kill('SIGKILL')
      cleanup(command)
      void removeTempFileQuietly(tmpOutputPath)
      reject(new Error(t('main.thumbnail.error.ffmpegFrameTimeout')))
    }, 30000)

    const command = ffmpeg(videoPath)
      .setFfmpegPath(ffmpegBinaryPath)
      .seekInput(seekSeconds)
      .frames(1)
      .output(tmpOutputPath)
      .outputOptions(
        '-vf',
        `scale=${STANDARD_MAX_WIDTH}:${STANDARD_MAX_HEIGHT}:force_original_aspect_ratio=decrease`,
        '-f',
        'image2',
        '-update',
        '1'
      )
      .on('end', async () => {
        if (settled) return
        settled = true
        cleanup(command)
        // --- 输出校验：临时文件必须存在且非空，通过后原子替换最终路径 ---
        try {
          const stat = await fsp.stat(tmpOutputPath)
          if (!stat.isFile() || stat.size <= 0) {
            throw new Error(t('main.thumbnail.error.ffmpegEmptyOutput'))
          }
          await fsp.rename(tmpOutputPath, outputPath)
          resolve()
        } catch (statErr) {
          await removeTempFileQuietly(tmpOutputPath)
          reject(statErr instanceof Error ? statErr : new Error(String(statErr)))
        }
      })
      .on('error', (err) => {
        if (settled) return
        settled = true
        cleanup(command)
        void removeTempFileQuietly(tmpOutputPath)
        reject(err)
      })

    trackFfmpegCommand(command)
    command.run()
  })
}

/**
 * worker 内部轻量版缩略图生成（不维护 LRU / accessTimes / contentHashCache）。
 * 与主进程 ThumbnailGenerator.doGenerate 算法一致，确保：
 * 1. 文件命名：${fileHash}.jpg + ${fileHash}_low.jpg（标准档位自动生成低质量版本）
 * 2. sharp 参数：resize(maxWidth, maxHeight, fit=inside, withoutEnlargement=true) + jpeg(quality=85, progressive=true)
 * 3. 视频文件走 ffmpeg 抽帧
 *
 * @returns 缩略图文件路径；生成失败返回 null
 */
async function generateThumbnailInWorker(
  filePath: string,
  cacheDir: string,
  _quality: ThumbnailQuality
): Promise<string | null> {
  try {
    // 确保 cacheDir 存在（主进程已创建，此处兜底）
    if (!(await pathExists(cacheDir))) {
      await fsp.mkdir(cacheDir, { recursive: true })
    }
    if (!(await pathExists(filePath))) {
      workerLog('warn', `[Thumbnail] 文件不存在: ${filePath}`)
      return null
    }

    const stats = await fsp.stat(filePath)
    const fileHash = await getFileHash(filePath, stats)
    const thumbnailPath = path.join(cacheDir, `${fileHash}.jpg`)
    const lowPath = path.join(cacheDir, `${fileHash}_low.jpg`)

    // 扩展名判定上移：缓存命中分支的视频纯白自愈依赖该判定
    const ext = path.extname(filePath).toLowerCase()
    const isVideo = isVideoExt(ext)

    if (await pathExists(thumbnailPath)) {
      // 历史缓存自愈：旧版抽帧逻辑会把片头纯白帧当作缩略图落盘（含其 _low 副本），
      // 命中即返回会让白图永久留存。此处对视频做一次纯色自检并重建，让存量白图自动修复。
      if (
        isVideo &&
        !blankHealedHashes.has(fileHash) &&
        (await isBlankCachedThumbnail(thumbnailPath))
      ) {
        blankHealedHashes.add(fileHash)
        try {
          await extractVideoFrame(filePath, thumbnailPath)
          // 丢弃同源的白色低清副本并重建：网格优先展示 _low，只修标准档位仍会显示白图
          await fsp.rm(lowPath, { force: true })
          await writeLowFromStandard(thumbnailPath, lowPath)
        } catch (healErr) {
          // 自愈失败保留旧图：绝不因自愈失败让本次生成返回 null
          workerLog('warn', `[Thumbnail] 纯白缩略图自愈失败，保留原图: ${filePath}`, healErr)
        }
      }
      return thumbnailPath
    }

    if (isVideo) {
      await extractVideoFrame(filePath, thumbnailPath)
    } else {
      await writeFileAtomic(thumbnailPath, (tmp) =>
        sharp(filePath)
          .resize(STANDARD_MAX_WIDTH, STANDARD_MAX_HEIGHT, {
            fit: 'inside',
            withoutEnlargement: true
          })
          .jpeg({ quality: STANDARD_QUALITY, progressive: true })
          .toFile(tmp)
      )
    }

    // 同步生成低质量版本（64px, q30），失败不阻断主流程
    // 与主进程 ThumbnailGenerator.doGenerate 一致：从刚生成的标准缩略图缩放
    await writeLowFromStandard(thumbnailPath, lowPath)

    return thumbnailPath
  } catch (error) {
    workerLog('error', `[Thumbnail] 缩略图生成失败: ${filePath}`, error)
    return null
  }
}

// ============ 任务 A：缩略图批量生成 ============

/**
 * 为缺缩略图/尺寸/phash 的记录生成缩略图并补算 phash。
 * 完整复刻原 thumbnail-phash-service.ts 的 processThumbnailForRow + generateThumbnailsForUnprocessed 逻辑。
 *
 * 改造点：
 * - ctx.thumbnailGen.generate → generateThumbnailInWorker
 * - ctx.getMainWindow()?.webContents.send → 通过 parentPort 推送 *_PROGRESS / *_COMPLETE
 */
async function startThumbnailBatch(
  dbPath: string,
  cacheDir: string,
  thumbnailQuality: ThumbnailQuality
): Promise<{ success: boolean; message: string; processed: number; total: number }> {
  shouldStopThumbnail = false
  const database = openDatabaseIfNeeded(dbPath)

  try {
    // GamePlayPhotos 豁免（仅图片）：该目录下的游戏图片已有游戏原生低清缩略图（同名文件位于兄弟目录
    // NikkiPhotos_LowQuality），扫描入库时 thumbnail 列已直接指向原生路径，永不触发缩略图生成。
    // 评审收紧：完整游戏目录特征 \X6Game\Saved\GamePlayPhotos\，防止同名用户目录误伤。
    // 需求二.2：追加无 Saved 的兼容变体 \X6Game\GamePlayPhotos\（两者互斥，需并列排除）。
    // 视频例外（fix-gameplayphotos-video-thumbnail-null 节点3）：Videos/ 子树的视频没有原生低清
    // 缩略图，历史上被本豁免一并排除导致 thumbnail 永远为 NULL（「缓存/重复文件」板块纯白占位），
    // 必须放行进入本批次走 seek 阶梯抽帧补算。口径与 startup-tasks.ts THUMB_QUERY 保持一致。
    // 归一化口径与 media-repository.ts NORMALIZED_PATH_EXPR 完全一致（小写 + 正斜杠子串匹配）。
    // SQLite 字符串字面量不处理反斜杠，'\' 即单个反斜杠。
    const rows = database
      .prepare(
        "SELECT id, file_path, file_type FROM media_files WHERE (thumbnail IS NULL OR width IS NULL OR height IS NULL) AND (LOWER(REPLACE(file_path, '\\', '/')) NOT LIKE '%/x6game/saved/gameplayphotos/%' OR file_type = 'video') AND (LOWER(REPLACE(file_path, '\\', '/')) NOT LIKE '%/x6game/gameplayphotos/%' OR file_type = 'video')"
      )
      .all() as Array<{ id: number; file_path: string; file_type: string }>

    // 尺寸补读阶段（评审修复：豁免不得连带放弃尺寸回填）：
    // 生成阶段将游戏图片排除后，其 width/height 会永久为 NULL，导致瀑布流/按尺寸排序降级。
    // 此处仅对游戏图片行补读尺寸：sharp metadata 读宽高后 UPDATE，不动 thumbnail、
    // 不算 phash、不写缓存；视频行不处理（视频尺寸扫描时已由 ffprobe 写入）。
    // 条件与上方排除条件同口径取并集（标准布局 + 无 Saved 变体）。
    const dimRows = database
      .prepare(
        "SELECT id, file_path FROM media_files WHERE file_type = 'image' AND (width IS NULL OR height IS NULL) AND (LOWER(REPLACE(file_path, '\\', '/')) LIKE '%/x6game/saved/gameplayphotos/%' OR LOWER(REPLACE(file_path, '\\', '/')) LIKE '%/x6game/gameplayphotos/%')"
      )
      .all() as Array<{ id: number; file_path: string }>

    const total = rows.length + dimRows.length
    if (total === 0) {
      return {
        success: true,
        message: t('main.mediaWorker.message.nothingToGenerate'),
        processed: 0,
        total: 0
      }
    }

    // N3 防覆写：COALESCE(?, col)——本批只选「thumbnail/width/height 缺失」的行，
    // 生成部分失败（如 thumbnailPath=null 但 metadata 成功）时，NULL 入参回退为列现值，
    // 不得把库中已有的有效 thumbnail/phash 覆写为 NULL（数据自伤）
    const updateStmt = database.prepare(
      'UPDATE media_files SET width = COALESCE(?, width), height = COALESCE(?, height), thumbnail = COALESCE(?, thumbnail), phash = COALESCE(?, phash), phash_mtime = COALESCE(?, phash_mtime), phash_file_size = COALESCE(?, phash_file_size) WHERE id = ?'
    )

    let processed = 0
    let lastProgressProcessed = 0

    const tasks = rows.map((row) => async () => {
      if (shouldStopThumbnail) return

      // 单文件加超时兜底：超时/失败返回 null → 跳过该行，不写 DB、不计数，由下次批次重试
      const result = await withFileTimeout(
        async (): Promise<{
          width: number | null
          height: number | null
          thumbnailPath: string | null
          phash: string | null
          phashMtime: number | null
          phashFileSize: number | null
        }> => {
          let width: number | null = null
          let height: number | null = null
          let thumbnailPath: string | null = null
          let phash: string | null = null
          // R7：phash 计算时的文件 mtime/size，用于后续 stale 检测
          let phashMtime: number | null = null
          let phashFileSize: number | null = null

          if (row.file_type === 'image') {
            // C-G7：原实现 sharp 加载原图 3 次（metadata/generate/phash）串行执行
            // 优化为 Promise.all 并行执行，总耗时 = max(三操作) 而非 sum
            const [metadata, thumbResult, phashResult, statResult] = await Promise.all([
              sharp(row.file_path)
                .metadata()
                .catch(() => null),
              generateThumbnailInWorker(row.file_path, cacheDir, thumbnailQuality),
              calculatePHash(row.file_path),
              fsp.stat(row.file_path).catch(() => null)
            ])
            width = metadata?.width ?? null
            height = metadata?.height ?? null
            thumbnailPath = thumbResult
            phash = phashResult
            // R7：stat 失败时 phashMtime/phashFileSize 保持 null，下次 phash 批处理仍会重算
            if (statResult) {
              phashMtime = Math.floor(statResult.mtimeMs)
              phashFileSize = statResult.size
            }
          } else if (row.file_type === 'video') {
            thumbnailPath = await generateThumbnailInWorker(
              row.file_path,
              cacheDir,
              thumbnailQuality
            )
          }

          return { width, height, thumbnailPath, phash, phashMtime, phashFileSize }
        },
        THUMBNAIL_PER_FILE_TIMEOUT_MS,
        row.file_path,
        'Thumbnail'
      )

      if (result) {
        updateStmt.run(
          result.width,
          result.height,
          result.thumbnailPath,
          result.phash,
          result.phashMtime,
          result.phashFileSize,
          row.id
        )
        processed++
      }

      // 节流推送进度（500ms）
      const now = Date.now()
      if (now - lastThumbnailProgressEmit >= 500 || processed - lastProgressProcessed >= 10) {
        lastThumbnailProgressEmit = now
        lastProgressProcessed = processed
        sendEvent({
          type: 'THUMBNAIL_PROGRESS',
          payload: { processed, total, currentFile: row.file_path }
        })
      }
    })

    await runWithConcurrency(tasks, THUMBNAIL_CONCURRENCY)

    // --- 尺寸补读阶段：串行逐行补读游戏图片尺寸，单行失败跳过不中断，进度并入 total ---
    if (dimRows.length > 0) {
      const dimUpdateStmt = database.prepare(
        'UPDATE media_files SET width = ?, height = ? WHERE id = ?'
      )
      for (const row of dimRows) {
        if (shouldStopThumbnail) break
        try {
          const metadata = await sharp(row.file_path).metadata()
          if (metadata?.width && metadata?.height) {
            dimUpdateStmt.run(metadata.width, metadata.height, row.id)
            processed++
          }
        } catch (err) {
          // 单行补读失败（文件损坏/不可读等）：跳过不中断批次，下次仍可重试
          workerLog('warn', `[Thumbnail] 游戏图片尺寸补读失败: ${row.file_path}`, err)
        }
      }
    }

    const message = shouldStopThumbnail
      ? t('main.mediaWorker.message.workerTaskCancelled')
      : t('main.mediaWorker.message.workerTaskDone')
    return { success: true, message, processed, total }
  } catch (error) {
    workerLog('error', t('main.mediaWorker.log.thumbnailBatchFailed'), error)
    return {
      success: false,
      message: t('main.mediaWorker.message.batchGenerateFailed', {
        reason: error instanceof Error ? error.message : String(error)
      }),
      processed: 0,
      total: 0
    }
  }
}

// ============ 任务 B：pHash 批量补算 + 链式 markDuplicates ============

/**
 * 为缺 phash 的图片补算 pHash，完成后自动链式 markDuplicates。
 * 完整复刻原 thumbnail-phash-service.ts 的 generatePhashForUnprocessed + markDuplicates 逻辑。
 *
 * R7：phash 文件变更检测——除"phash IS NULL"的初始补算外，还检测 phash_mtime/phash_file_size
 * 与当前文件不一致的 stale 记录并重算。文件被外部编辑后 phash 不会再长期污染相似检测。
 */
async function startPhashBatch(dbPath: string): Promise<{
  success: boolean
  message: string
  processed: number
  total: number
  duplicatesResult?: { markedDuplicates: number; totalGroups: number }
}> {
  shouldStopPhash = false
  const database = openDatabaseIfNeeded(dbPath)

  try {
    // R7：查询所有未软删除图片行（含已有 phash 的），由 worker stat 后决定是否需要（重）算
    // 旧实现仅查 phash IS NULL，无法发现文件被外部编辑后的 stale phash
    const rows = database
      .prepare(
        `SELECT id, file_path, phash, phash_mtime, phash_file_size
         FROM media_files
         WHERE file_type = 'image' AND is_deleted = 0`
      )
      .all() as Array<{
      id: number
      file_path: string
      phash: string | null
      phash_mtime: number | null
      phash_file_size: number | null
    }>

    const total = rows.length
    if (total === 0) {
      // 没有图片记录，但仍触发一次重复标记（基于已有 pHash，可能是空库）
      const duplicatesResult = await markDuplicatesInWorker(database)
      return {
        success: true,
        message: t('main.mediaWorker.message.nothingToPhash'),
        processed: 0,
        total: 0,
        duplicatesResult
      }
    }

    workerLog('info', `[pHash] 待检测 ${total} 张图片`)

    // R7：UPDATE 语句同时写入 phash + phash_mtime + phash_file_size，确保下次 stale 检测有基线
    const updateStmt = database.prepare(
      'UPDATE media_files SET phash = ?, phash_mtime = ?, phash_file_size = ? WHERE id = ?'
    )
    let processed = 0
    let lastProgressProcessed = 0

    const tasks = rows.map((row) => async () => {
      if (shouldStopPhash) return

      // 单文件加超时兜底：超时/失败返回 null → 跳过该行（mtime/size 基线未更新，下次批次会重算）
      const recomputed = await withFileTimeout(
        async (): Promise<boolean> => {
          try {
            const stat = await fsp.stat(row.file_path)
            const currentMtime = Math.floor(stat.mtimeMs)
            const currentSize = stat.size
            // R7：缓存命中——phash 已存在且 mtime/size 与当前文件一致，跳过昂贵的 phash 计算
            if (
              row.phash &&
              row.phash_mtime === currentMtime &&
              row.phash_file_size === currentSize
            ) {
              return false
            }
            // 缓存未命中：phash 为 NULL / 首次回填 mtime / 文件被外部编辑后 mtime 或 size 变化
            const hash = await calculatePHash(row.file_path)
            if (hash) {
              updateStmt.run(hash, currentMtime, currentSize, row.id)
              return true
            }
            return false
          } catch (err) {
            // stat 失败：文件可能已被删除/移动，由 is_missing 流程单独处理，此处跳过不阻塞批处理
            workerLog('warn', `[pHash] stat 失败，跳过 ${row.file_path}`, err)
            return false
          }
        },
        PHASH_PER_FILE_TIMEOUT_MS,
        row.file_path,
        'pHash'
      )

      if (recomputed === true) {
        processed++
      }

      // 节流推送进度（500ms）
      const now = Date.now()
      if (now - lastPhashProgressEmit >= 500 || processed - lastProgressProcessed >= 10) {
        lastPhashProgressEmit = now
        lastProgressProcessed = processed
        sendEvent({
          type: 'PHASH_PROGRESS',
          payload: { processed, total, currentFile: row.file_path }
        })
      }
    })

    await runWithConcurrency(tasks, THUMBNAIL_CONCURRENCY)
    workerLog('info', `[pHash] 检测完成，重算 ${processed} 张`)

    // P1-01：pHash 补算完成后触发重复标记（保持原有链式行为）
    // 若已被取消则跳过 markDuplicates，避免在 phash 未完整时基于部分数据聚类
    const duplicatesResult = shouldStopPhash ? undefined : await markDuplicatesInWorker(database)

    const message = shouldStopPhash
      ? t('main.mediaWorker.message.workerTaskCancelled')
      : t('main.mediaWorker.message.workerTaskDone')
    return { success: true, message, processed, total, duplicatesResult }
  } catch (error) {
    workerLog('error', t('main.mediaWorker.log.phashBatchFailed'), error)
    return {
      success: false,
      message: t('main.mediaWorker.message.phashBatchFailed', {
        reason: error instanceof Error ? error.message : String(error)
      }),
      processed: 0,
      total: 0
    }
  }
}

// ============ 任务 C：重复标记 ============

/**
 * 基于 pHash 极严格阈值（≤2）聚类，评分标记重复文件。
 * 完整复刻原 thumbnail-phash-service.ts 的 markDuplicates 逻辑。
 */
async function startDuplicateMark(
  dbPath: string
): Promise<{ success: boolean; message: string; markedDuplicates: number; totalGroups: number }> {
  shouldStopDuplicate = false
  const database = openDatabaseIfNeeded(dbPath)

  try {
    const result = await markDuplicatesInWorker(database)
    return {
      success: true,
      message: shouldStopDuplicate
        ? t('main.mediaWorker.message.workerTaskCancelled')
        : t('main.mediaWorker.message.workerTaskDone'),
      ...result
    }
  } catch (error) {
    workerLog('error', t('main.mediaWorker.log.duplicateMarkFailed'), error)
    return {
      success: false,
      message: t('main.mediaWorker.message.markFailed', {
        reason: error instanceof Error ? error.message : String(error)
      }),
      markedDuplicates: 0,
      totalGroups: 0
    }
  }
}

/**
 * 重复标记核心实现（含 O(n²) 进度推送）。
 * 与原 markDuplicates 算法完全一致，仅增加 shouldStopDuplicate 检查与进度推送。
 */
async function markDuplicatesInWorker(
  database: DatabaseType.Database
): Promise<{ markedDuplicates: number; totalGroups: number }> {
  const rows = database
    .prepare(
      `SELECT id, file_size, width, height, modified_at, is_favorite, rating, phash
       FROM media_files
       WHERE is_deleted = 0 AND file_type = 'image' AND phash IS NOT NULL AND phash != ''`
    )
    .all() as Array<{
    id: number
    file_size: number
    width: number | null
    height: number | null
    modified_at: string
    is_favorite: number
    rating: number
    phash: string
  }>

  if (rows.length < 2) {
    // 单文件或无文件：清空所有重复标记
    database.prepare('UPDATE media_files SET is_duplicate = 0, original_id = NULL').run()
    return { markedDuplicates: 0, totalGroups: 0 }
  }

  // Union-Find 聚类
  const parent = new Int32Array(rows.length)
  for (let i = 0; i < rows.length; i++) parent[i] = i
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  // O(n²) 两两比较 + 进度推送
  const totalPairs = (rows.length * (rows.length - 1)) / 2
  let compared = 0
  let lastCompared = 0

  for (let i = 0; i < rows.length; i++) {
    if (shouldStopDuplicate) break
    for (let j = i + 1; j < rows.length; j++) {
      const dist = hammingDistance(rows[i].phash, rows[j].phash)
      if (dist >= 0 && dist <= MARK_THRESHOLD) {
        union(i, j)
      }
      compared++
    }
    // 每 1000 次比较或 500ms 推送一次进度
    const now = Date.now()
    if (now - lastDuplicateProgressEmit >= 500 || compared - lastCompared >= 1000) {
      lastDuplicateProgressEmit = now
      lastCompared = compared
      sendEvent({
        type: 'DUPLICATE_PROGRESS',
        payload: { compared, totalPairs }
      })
    }
  }

  // 按 root 分组
  const groupMap = new Map<number, number[]>()
  for (let i = 0; i < rows.length; i++) {
    const root = find(i)
    if (!groupMap.has(root)) groupMap.set(root, [])
    groupMap.get(root)!.push(i)
  }

  // 仅长度 >= 2 的组参与重复标记
  const duplicateGroups: number[][] = []
  for (const indices of groupMap.values()) {
    if (indices.length >= 2) duplicateGroups.push(indices)
  }

  // 先清空所有重复标记（删除/移动文件后旧标记会失效）
  database.prepare('UPDATE media_files SET is_duplicate = 0, original_id = NULL').run()

  if (duplicateGroups.length === 0) {
    workerLog('info', t('main.mediaWorker.log.duplicateNoGroups'))
    return { markedDuplicates: 0, totalGroups: 0 }
  }

  // 对每组评分，最佳项 id 设为 originalId，其余标记 is_duplicate=1
  const updateStmt = database.prepare(
    'UPDATE media_files SET is_duplicate = ?, original_id = ? WHERE id = ?'
  )
  let markedDuplicates = 0
  const updateMany = database.transaction(() => {
    for (const indices of duplicateGroups) {
      const groupItems = indices.map((i) => ({
        id: rows[i].id,
        file_size: rows[i].file_size,
        width: rows[i].width,
        height: rows[i].height,
        modified_at: rows[i].modified_at,
        is_favorite: rows[i].is_favorite === 1,
        rating: rows[i].rating
      }))
      const bestId = pickBestId(groupItems)
      if (bestId === null) continue
      for (const item of groupItems) {
        if (item.id === bestId) {
          // 推荐保留项：保持 is_duplicate=0
          updateStmt.run(0, null, item.id)
        } else {
          updateStmt.run(1, bestId, item.id)
          markedDuplicates++
        }
      }
    }
  })
  updateMany()

  workerLog(
    'info',
    `[Duplicate] 标记完成：${duplicateGroups.length} 组，${markedDuplicates} 个重复文件`
  )
  return { markedDuplicates, totalGroups: duplicateGroups.length }
}

// ============ 任务 D：相似检测（BK-tree 半径检索） ============

/**
 * 相似检测：worker 内建 BK-tree，对每条 pHash 做半径检索，回传候选边 + 元数据。
 * 不重标记 is_duplicate（那是 markDuplicates 职责），仅产出候选供主进程 Union-Find 聚类。
 */
async function startSimilarFind(dbPath: string, threshold: number): Promise<void> {
  shouldStopSimilar = false
  const database = openDatabaseIfNeeded(dbPath)

  try {
    const rows = database
      .prepare(
        `SELECT id, file_path, file_name, file_type, file_size, modified_at, width, height, is_favorite, rating, thumbnail, phash
         FROM media_files
         WHERE is_deleted = 0 AND phash IS NOT NULL AND phash != ''`
      )
      .all() as Array<SimilarRowMeta & { phash: string }>

    const total = rows.length
    if (total < 2) {
      // 不足两张：无候选，直接回传空分组结构
      sendEvent({
        type: 'SIMILAR_COMPLETE',
        payload: {
          success: true,
          message: t('main.mediaWorker.message.nothingToDetect'),
          rows,
          totalCandidates: 0,
          totalRows: total
        }
      })
      return
    }

    const result = buildAndSearch({
      rows,
      threshold,
      shouldStop: () => shouldStopSimilar,
      onCandidates: (batch) => sendEvent({ type: 'SIMILAR_CANDIDATES', payload: { batch } }),
      onProgress: (scanned, t, candidates) =>
        sendEvent({ type: 'SIMILAR_PROGRESS', payload: { scanned, total: t, candidates } })
    })

    // 回传元数据（剥离 phash 本体，控制体积）
    const metaRows: SimilarRowMeta[] = rows.map(({ phash: _phash, ...meta }) => meta)
    sendEvent({
      type: 'SIMILAR_COMPLETE',
      payload: {
        success: true,
        message: result.cancelled
          ? t('main.mediaWorker.message.workerTaskCancelled')
          : t('main.mediaWorker.message.workerTaskDone'),
        rows: metaRows,
        totalCandidates: result.totalCandidates,
        totalRows: total,
        cancelled: result.cancelled
      }
    })
  } catch (error) {
    workerLog('error', t('main.mediaWorker.log.similarFindFailed'), error)
    sendEvent({
      type: 'SIMILAR_COMPLETE',
      payload: {
        success: false,
        message: `相似检测异常: ${error instanceof Error ? error.message : String(error)}`,
        rows: [],
        totalCandidates: 0,
        totalRows: 0
      }
    })
  }
}

// ============ 资源清理与退出 ============

/** 纯资源清理（不退出进程）：'exit' 事件期间不得调用 process.exit */
function cleanupDb(): void {
  try {
    if (db) {
      try {
        db.pragma('wal_checkpoint(PASSIVE)')
      } catch {}
      db.close()
      db = null
    }
  } catch {}
}

/**
 * worker 退出前清理：关闭 DB + kill 所有子进程 + 退出。
 * 必须使用同步操作，避免异步 I/O 延迟进程退出。
 * FIX(组11-2): bridge 以 `code !== 0` 判定崩溃并触发自动重启与崩溃通知，
 * 致命路径（uncaughtException / unhandledRejection，如 sharp native 崩溃）必须以
 * 非零码退出——原先固定 exit(0) 使 isCrash 恒为 false，attemptAutoRestart 与
 * workerCrash fault 日志永不触发。MEDIA_WORKER_DISPOSE 正常退出保持 exit 0。
 */
function cleanupAndExit(exitCode = 0, graceful = false): void {
  cleanupDb()
  // kill 所有 worker 启动的 ffmpeg 子进程（process-registry 在 worker 内是独立实例）
  try {
    killAllProcesses('SIGKILL')
  } catch {}
  if (graceful) {
    // 新增：MEDIA_WORKER_DISPOSE 正常退出——先回发确认表示 DB 句柄已释放，主进程据此可安全 rename 还原。
    // 用 setImmediate 延迟 process.exit，确保 IPC 消息在事件循环中被写出，避免同步 process.exit 截断未发送的消息。
    try {
      sendEvent({ type: 'MEDIA_WORKER_DISPOSED' })
    } catch {}
    setImmediate(() => process.exit(exitCode))
  } else {
    process.exit(exitCode)
  }
}

// ============ 消息处理 ============

// utilityProcess 中 parentPort 推送的 'message' 事件参数是 Node.js 的 MessageEvent（仅含 data 字段），
// 但 lib.dom.d.ts 也声明了 MessageEvent（含 lastEventId/origin/source 等），两者冲突。
// 此处用最小结构类型 { data: unknown } 避免冲突，运行时只读 data 字段
process.parentPort?.on('message', async (event: { data: unknown }) => {
  const msg = event.data as MediaWorkerCommand
  switch (msg.type) {
    case 'THUMBNAIL_BATCH_START': {
      try {
        const result = await startThumbnailBatch(
          msg.payload.dbPath,
          msg.payload.cacheDir,
          msg.payload.thumbnailQuality
        )
        sendEvent({ type: 'THUMBNAIL_COMPLETE', payload: result })
      } catch (err) {
        sendEvent({
          type: 'THUMBNAIL_COMPLETE',
          payload: {
            success: false,
            message: `缩略图批量生成异常: ${err instanceof Error ? err.message : String(err)}`,
            processed: 0,
            total: 0
          }
        })
      }
      break
    }
    case 'PHASH_BATCH_START': {
      try {
        const result = await startPhashBatch(msg.payload.dbPath)
        sendEvent({ type: 'PHASH_COMPLETE', payload: result })
      } catch (err) {
        sendEvent({
          type: 'PHASH_COMPLETE',
          payload: {
            success: false,
            message: `pHash 批量补算异常: ${err instanceof Error ? err.message : String(err)}`,
            processed: 0,
            total: 0
          }
        })
      }
      break
    }
    case 'DUPLICATE_MARK_START': {
      try {
        const result = await startDuplicateMark(msg.payload.dbPath)
        sendEvent({ type: 'DUPLICATE_COMPLETE', payload: result })
      } catch (err) {
        sendEvent({
          type: 'DUPLICATE_COMPLETE',
          payload: {
            success: false,
            message: `重复标记异常: ${err instanceof Error ? err.message : String(err)}`,
            markedDuplicates: 0,
            totalGroups: 0
          }
        })
      }
      break
    }
    case 'SIMILAR_FIND_START': {
      try {
        await startSimilarFind(msg.payload.dbPath, msg.payload.threshold)
      } catch (err) {
        workerLog('error', t('main.mediaWorker.log.similarStartFailed'), err)
        sendEvent({
          type: 'SIMILAR_COMPLETE',
          payload: {
            success: false,
            message: `相似检测启动异常: ${err instanceof Error ? err.message : String(err)}`,
            rows: [],
            totalCandidates: 0,
            totalRows: 0
          }
        })
      }
      break
    }
    case 'THUMBNAIL_STOP':
      shouldStopThumbnail = true
      break
    case 'PHASH_STOP':
      shouldStopPhash = true
      break
    case 'DUPLICATE_STOP':
      shouldStopDuplicate = true
      break
    case 'SIMILAR_STOP':
      shouldStopSimilar = true
      break
    case 'MEDIA_WORKER_DISPOSE':
      cleanupAndExit(0, true)
      break
  }
})

// ============ 兜底清理 ============

// process.exit 触发时清理（Node.js 原生事件，一定会触发）。
// FIX(组11-2): exit 事件期间不得再调用 process.exit（无意义且可能影响退出码），
// 仅做资源清理，退出码由原 fatal/normal 路径决定
process.on('exit', cleanupDb)

// 未捕获异常：发送 WORKER_ERROR 后以非零码清理退出（触发 bridge 的崩溃重启，见组11-2）
process.on('uncaughtException', (err) => {
  sendEvent({
    type: 'WORKER_ERROR',
    payload: { message: err.message, stack: err.stack }
  })
  cleanupAndExit(1)
})

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason))
  sendEvent({
    type: 'WORKER_ERROR',
    payload: { message: err.message, stack: err.stack }
  })
  cleanupAndExit(1)
})

// ============ 启动完成通知 ============

// 向主进程发送 WORKER_READY，表示 worker 已就绪可接收任务
sendEvent({ type: 'WORKER_READY' })
