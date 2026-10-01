import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import os from 'os'
import { app } from 'electron'
import { t } from '../i18n'
import sharp from 'sharp'
import ffmpeg from 'fluent-ffmpeg'
// C-3：统一文件存在检查与视频扩展名判定
import { pathExists } from '../utils/file-utils'
import { isVideoExt } from '../utils/media-constants'
// P1-A7：统一从 ffmpeg-paths 导入，消除重复路径解析
import { ffmpegPath as ffmpegBinaryPath } from '../utils/ffmpeg-paths'
import { trackFfmpegCommand, untrackFfmpegCommand } from '../utils/process-registry'
import { maybeLogSpawnError } from '../utils/spawn-error-log'
// 损坏文件容错：错误日志写入 + 标记回调
import { logger } from '../utils/logger'
// 缩略图 worker 化：主进程↔worker 桥接层（注入式，未注入时降级到内联 sharp）
import type { ThumbnailWorkerBridge } from './worker-bridge'
import type { ThumbnailQuality } from './worker-protocol'
// 全局解码并发上限：复用既有并发工具，不引新库
import { createConcurrencyLimiter } from '../utils/concurrency'
// FIX(组19-1): LRU 元数据文件名迁至叶子常量模块共享（启动清理需豁免该文件）
import { CACHE_METADATA_FILENAME } from '../utils/constants'
// GamePlayPhotos 豁免：纯函数路径判定模块（无依赖，无循环依赖风险）
import { isGamePlayPhotosPath, resolveNativeThumbnailPath } from '../scanner/path-classifier'
// 纯色帧判定（修复视频缩略图纯白）：无 i18n / logger 依赖，主进程与 media worker 共用
import { isBlankImageFile, isBlankCachedThumbnail } from '../utils/video-frame'
// N2 原子落盘：临时文件 + rename 替换，消除 media:// 半截读取（裂图）与跨进程并发写撕裂
import { writeFileAtomic, tempSiblingPath, removeTempFileQuietly } from '../utils/atomic-file'

/**
 * 损坏文件标记回调类型。
 * - 调用方（Application）注入实现：根据 filePath 查询 mediaId，UPDATE is_corrupted=1。
 * - 文件不在库中（如未扫描的新文件）时回调应静默返回，不抛错。
 * - filePath 解码失败时调用 markCorrupted；解码成功后调用 clearCorrupted。
 */
export type CorruptedMarkerFn = (filePath: string, reason: string) => Promise<void>
export type CorruptedClearFn = (filePath: string) => Promise<void>

// A-S7：缩略图缓存大小上限（默认 2GB），超出后按 LRU 淘汰最久未访问的
// T10：改为可配置，由 setCacheLimit 运行时调整
const DEFAULT_CACHE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024
// R13：缓存上限下限（100MB），防止误设过小导致频繁淘汰。
// 导出供 IPC handler 在持久化前预校验，避免把非法值写入 DB。
export const MIN_CACHE_LIMIT_BYTES = 100 * 1024 * 1024
// A-S8：内容 hash 读取文件前 1MB，兼顾唯一性与性能
const CONTENT_HASH_READ_SIZE = 1024 * 1024

// 视频抽帧最大可寻址秒数（参数校验上限），避免传入异常 seek 值
const VIDEO_SEEK_MAX_SECONDS = 60
// 0s 抽帧失败后的重试位置（秒）
const VIDEO_RETRY_SEEK_SECONDS = 1
// 取帧阶梯的第三个位点（秒）：0s / 1s 均为纯色帧时继续向后取帧
const VIDEO_THIRD_SEEK_SECONDS = 3

// LRU 元数据持久化文件名：FIX(组19-1) 迁至 utils/constants.ts 共享
// （启动清理 startup-tasks.cleanupOrphanThumbnails 需豁免该文件），顶部统一 import

/**
 * 全局缩略图解码并发上限 = CPU 核数 × 2。
 * cpus() 在容器/权限受限环境可能返回空数组，兜底 1 核。
 */
const DECODE_CONCURRENCY = Math.max(1, os.cpus().length) * 2

/**
 * 模块级解码信号量（全实例共享，与请求来源无关）。
 *
 * 约束的是「同时在飞的解码任务数」，而非「同时在飞的 generate 调用数」：
 * - 缓存命中路径不经过这里，滚动大库时命中缓存的请求不会被排队拖慢
 * - worker 路径与 runSharpInline 降级路径都收敛到 runSharp 这一个入口，
 *   因此只需在 runSharp 取一次许可，避免同一信号量重入导致的自锁
 * - worker 的 30s 超时计时在 processImage 内部启动（即拿到许可之后），
 *   排队等待不计入超时预算，不会出现"堆积→集体超时→集体降级内联"的放大
 */
const decodeLimiter = createConcurrencyLimiter(DECODE_CONCURRENCY)

/**
 * 视频抽帧独立信号量（fix-thumbnail-skeleton-reveal N1）：
 * ffmpeg 抽帧（含纯白自愈）不再与图片 sharp 解码共用 decodeLimiter——
 * 慢视频走 0/1/3s seek 阶梯（每次 30s 超时）会长时间占满解码许可，
 * 把可视区按需生成的图片全部堵在队列后（表现为数十秒白屏）。
 * 固定并发 2：足够覆盖可视区连续视频封面生成，同时比原"视频挤占 decodeLimiter
 * 全部槽位（最多 CPU×2）"更保守，防止单进程 ffmpeg spawn 数量失控。
 */
const VIDEO_DECODE_CONCURRENCY = 2
const videoLimiter = createConcurrencyLimiter(VIDEO_DECODE_CONCURRENCY)

export class ThumbnailGenerator {
  private cacheDir: string
  private maxWidth = 320
  private maxHeight = 320
  private quality = 85
  // P1-03：低质量缩略图参数（首屏快速预览，滚动停止后替换为标准质量）
  private lowMaxWidth = 64
  private lowMaxHeight = 64
  private lowQuality = 30
  // 高清档位参数（高分屏 DPR ≥ 2 时使用）
  private highMaxWidth = 512
  private highMaxHeight = 512
  private highQuality = 90
  // T10：缓存上限可配置，默认 2GB
  private cacheLimitBytes = DEFAULT_CACHE_LIMIT_BYTES

  // 修复 C-S3：并发生成同一文件的缩略图时存在竞态条件
  // 使用 Map<string, Promise> 作为互斥锁，相同 filePath 的并发请求复用同一个 Promise
  private generatingLocks: Map<string, Promise<string | null>> = new Map()

  // N2 批量让位：主进程 generate() 在途请求计数（含 low/high 档与启动自愈；
  // 后台批量在 worker 进程内生成、不经过该入口，因此该计数即"用户正在等待"的信号）。
  // 0 ↔ >0 跳变时通知监听方（Application 装配为 MediaWorkerManager.setBatchYield）。
  private onDemandPending = 0
  private onDemandListener: ((active: boolean) => void) | null = null

  // A-S8：内容 hash 内存缓存，避免每次都读文件
  // key: filePath，value: { hash, mtime, size }，mtime/size 变化时重新计算
  private contentHashCache: Map<string, { hash: string; mtime: number; size: number }> = new Map()

  // 历史缓存自愈：已重建过的纯白视频缩略图 hash。
  // 进程内单次守卫，确保真正纯色的视频不会在每次访问时都重试重建。
  private blankHealedHashes: Set<string> = new Set()

  // A-S7：LRU 访问时间记录，key: 内容 hash，value: 最后访问时间戳
  private accessTimes: Map<string, number> = new Map()
  private accessTimesLoaded = false
  private accessCounter = 0

  // F-S5：内存维护缓存总大小计数器，避免每次生成都全目录扫描
  // -1 表示未初始化，首次 enforceCacheLimit 会全扫描校准
  private totalCacheSize = -1
  // F-S5：后台定时清理任务句柄（每 5 分钟校准 + 按需清理）
  private lruTimer: NodeJS.Timeout | null = null
  private static readonly LRU_CHECK_INTERVAL_MS = 5 * 60 * 1000
  // F-S5：超阈值 10% 才触发清理，避免频繁扫描
  private static readonly LRU_TRIGGER_RATIO = 1.1

  // 损坏文件容错：由 Application 注入的回调。
  // 未注入时（如单元测试）降级为仅日志写入，不阻塞主流程。
  private markCorruptedFn: CorruptedMarkerFn | null = null
  private clearCorruptedFn: CorruptedClearFn | null = null

  // 缩略图 worker 桥接层（worker 化改造）。
  // 由 Application 在 initialize 阶段通过 setWorkerBridge 注入。
  // 未注入或 worker 不可用时，runSharp 自动降级到 runSharpInline（保留原 sharp 调用）。
  private workerBridge: ThumbnailWorkerBridge | null = null

  constructor() {
    const userDataPath = app.getPath('userData')
    this.cacheDir = path.join(userDataPath, 'thumbnails')
    // 异步创建目录在首次 generate 时处理，避免构造器阻塞
  }

  /**
   * 注入 worker 桥接层（由 Application 在 initialize 阶段调用）。
   * 构造器内不 fork worker，避免阻塞应用启动；worker 在首次 processImage 时惰性启动。
   */
  setWorkerBridge(bridge: ThumbnailWorkerBridge): void {
    this.workerBridge = bridge
  }

  /**
   * 注入损坏文件标记回调（由 Application 在初始化时调用）。
   * - markCorrupted: 解码失败时调用，UPDATE is_corrupted=1
   * - clearCorrupted: 解码成功时调用，UPDATE is_corrupted=0（用于已修复文件的重扫场景）
   */
  setCorruptedMarker(mark: CorruptedMarkerFn | null, clear: CorruptedClearFn | null): void {
    this.markCorruptedFn = mark
    this.clearCorruptedFn = clear
  }

  /**
   * 注入按需活动监听（N2，由 Application 装配为 MediaWorkerManager.setBatchYield）：
   * generate() 在途计数 0 ↔ >0 跳变时回调 active。监听回调抛错仅吞掉，
   * 不影响生成主流程（让位是性能优化，不是正确性依赖）。
   */
  setOnDemandActivityListener(listener: ((active: boolean) => void) | null): void {
    this.onDemandListener = listener
  }

  /** 按需在途计数增减并按需通知监听方（仅在空闲 ↔ 忙碌边界回调，避免每文件抖动） */
  private bumpOnDemandPending(delta: 1 | -1): void {
    this.onDemandPending = Math.max(0, this.onDemandPending + delta)
    try {
      this.onDemandListener?.(this.onDemandPending > 0)
    } catch {
      // 监听回调异常不影响生成主流程
    }
  }

  /**
   * 标记文件为损坏并写入日志。
   * 回调未注入或抛错时仅记录日志，不阻断主流程（单个损坏文件不应影响其他文件加载）。
   */
  private async markCorrupted(filePath: string, reason: string): Promise<void> {
    try {
      logger.error(`[Thumbnail] 文件解码失败，标记为损坏: ${filePath}`, reason)
      if (this.markCorruptedFn) {
        await this.markCorruptedFn(filePath, reason)
      }
    } catch (err) {
      // 标记失败不应影响缩略图返回值，仅记录日志
      logger.error(t('main.thumbnail.log.markCorruptedCallbackFailed'), err)
    }
  }

  /**
   * 清除损坏标记（解码成功后调用）。
   * 回调未注入或抛错时静默忽略。
   */
  private async clearCorrupted(filePath: string): Promise<void> {
    try {
      if (this.clearCorruptedFn) {
        await this.clearCorruptedFn(filePath)
      }
    } catch (err) {
      logger.warn(t('main.thumbnail.log.clearCorruptedCallbackFailed'), err)
    }
  }

  /**
   * 自定义目录支持：设置缓存目录路径
   * 必须在首次 generate 之前调用（由 applyCustomDirectories 触发）
   * 切换目录后重置 accessTimesLoaded，强制重新加载新目录的 metadata
   */
  setDir(dir: string): void {
    this.cacheDir = dir
    this.accessTimesLoaded = false
    this.accessTimes.clear()
    // F-S5：目录变更后需重新校准计数器
    this.totalCacheSize = -1
  }

  getCacheDir(): string {
    return this.cacheDir
  }

  /**
   * T10：获取缓存统计信息（总大小 / 文件数 / 上限）
   */
  async getCacheStats(): Promise<{
    totalSize: number
    fileCount: number
    limit: number
    cacheDir: string
  }> {
    await this.ensureCacheDir()
    let totalSize = 0
    let fileCount = 0
    try {
      const entries = await fsp.readdir(this.cacheDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        if (entry.name === CACHE_METADATA_FILENAME) continue
        const stat = await fsp.stat(path.join(this.cacheDir, entry.name))
        totalSize += stat.size
        fileCount++
      }
    } catch {
      // 目录不存在或读取失败，返回 0
    }
    return { totalSize, fileCount, limit: this.cacheLimitBytes, cacheDir: this.cacheDir }
  }

  /**
   * T10：手动清理所有缩略图（保留 metadata 文件）
   * @returns 清理前的大小与文件数
   */
  async cleanAll(): Promise<{ clearedSize: number; clearedCount: number }> {
    await this.ensureCacheDir()
    let clearedSize = 0
    let clearedCount = 0
    try {
      const entries = await fsp.readdir(this.cacheDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        if (entry.name === CACHE_METADATA_FILENAME) continue
        const fullPath = path.join(this.cacheDir, entry.name)
        const stat = await fsp.stat(fullPath)
        await fsp.unlink(fullPath).catch(() => {})
        clearedSize += stat.size
        clearedCount++
      }
      // 清理后清空访问时间记录
      this.accessTimes.clear()
      await this.persistAccessTimes()
    } catch {
      // 忽略
    }
    return { clearedSize, clearedCount }
  }

  /**
   * T10：设置缓存上限，并立即检查是否需要淘汰
   */
  async setCacheLimit(limitBytes: number): Promise<{ applied: boolean; evicted: number }> {
    if (!Number.isFinite(limitBytes) || limitBytes < MIN_CACHE_LIMIT_BYTES) {
      // 下限 100MB，防止误设过小导致频繁淘汰
      return { applied: false, evicted: 0 }
    }
    this.cacheLimitBytes = limitBytes
    const before = await this.getCacheStats()
    await this.enforceCacheLimit(true)
    const after = await this.getCacheStats()
    return {
      applied: true,
      evicted: before.fileCount - after.fileCount
    }
  }

  /**
   * 仅设置上限值，不触发 LRU 淘汰
   * 用于启动时从数据库加载持久化的上限值
   */
  setCacheLimitBytes(limitBytes: number): void {
    if (Number.isFinite(limitBytes) && limitBytes >= MIN_CACHE_LIMIT_BYTES) {
      this.cacheLimitBytes = limitBytes
    }
  }

  /**
   * T10：启动后主动检查缓存大小（公开入口，供 index.ts 调用）
   */
  async enforceLimitNow(): Promise<{ evicted: number; totalSize: number; fileCount: number }> {
    await this.ensureCacheDir()
    await this.loadAccessTimes()
    const before = await this.getCacheStats()
    await this.enforceCacheLimit(true)
    const after = await this.getCacheStats()
    return {
      evicted: before.fileCount - after.fileCount,
      totalSize: after.totalSize,
      fileCount: after.fileCount
    }
  }

  /**
   * T10：退出前强制持久化访问时间，避免丢失最近访问记录
   */
  async flushAccessTimes(): Promise<void> {
    if (!this.accessTimesLoaded) return
    await this.persistAccessTimes()
  }

  private async ensureCacheDir(): Promise<void> {
    // C-3：统一文件存在检查
    if (!(await pathExists(this.cacheDir))) {
      await fsp.mkdir(this.cacheDir, { recursive: true })
    }
  }

  async generate(filePath: string, quality?: 'low' | 'standard' | 'high'): Promise<string | null> {
    // N2 批量让位（fix-thumbnail-skeleton-reveal）：主进程 generate 入口即"按需/自愈"请求
    // （后台批量在 worker 进程内部生成，不经过此入口），在途计数 >0 时通知监听方（manager →
    // worker）让后台批量任务让位。GamePlayPhotos 早退路径同样计入（快速 settle，零解码）。
    this.bumpOnDemandPending(1)
    try {
      return await this.generateLocked(filePath, quality)
    } finally {
      this.bumpOnDemandPending(-1)
    }
  }

  /** generate 的实际实现（进入前已计入按需在途计数） */
  private async generateLocked(
    filePath: string,
    quality?: 'low' | 'standard' | 'high'
  ): Promise<string | null> {
    // GamePlayPhotos 豁免（仅图片）：该目录下的游戏照片已有游戏原生低清缩略图（同名文件位于兄弟目录
    // NikkiPhotos_LowQuality），扫描入库时 thumbnail 列已直接指向原生路径。
    // 入口直接早退：不做任何解码/生成/写盘；用 access(R_OK) 校验推导出的原生 LQ 路径，
    // 存在 → 返回原生路径；不存在或不可推导 → 返回 null（维持“失败返回 null”
    // 旧语义）：绝不回退原路径、绝不触发生成——该路径下对图片禁用生成是硬性需求。
    // 视频例外（fix-gameplayphotos-video-thumbnail-null 节点2）：该目录 Videos/ 子树的视频
    // 没有原生低清缩略图，历史上被本豁免一并拦死（恒返回 null），令批量补算与重复页按需生成
    // 全部拿不到缩略图、「缓存/重复文件」板块视频纯白占位——视频必须放行走正常 seek 阶梯抽帧。
    const ext = path.extname(filePath).toLowerCase()
    if (isGamePlayPhotosPath(filePath) && !isVideoExt(ext)) {
      const native = resolveNativeThumbnailPath(filePath)
      if (native) {
        try {
          await fsp.access(native, fs.constants.R_OK)
          return native
        } catch {
          // 原生 LQ 不可读：落入下方统一返回 null（不回退原路径、不触发生成）
        }
      }
      return null
    }

    // F-S4 修复：低质量模式原直接调用 doGenerateLow 不经过 generatingLocks，
    // 多个并发请求同文件会重复生成。现纳入锁，key 区分 ${filePath}:low 与 ${filePath}:standard。
    // high 档位同理，锁 key 区分 :high，避免并发重复生成
    const lockKey =
      quality === 'low' ? `${filePath}:low` : quality === 'high' ? `${filePath}:high` : filePath
    const existing = this.generatingLocks.get(lockKey)
    if (existing) {
      return existing
    }

    const promise = (
      quality === 'low'
        ? this.doGenerateLow(filePath)
        : quality === 'high'
          ? this.doGenerateHigh(filePath)
          : this.doGenerate(filePath)
    ).finally(() => {
      // 生成完成后（无论成功或失败）清除锁
      this.generatingLocks.delete(lockKey)
    })

    this.generatingLocks.set(lockKey, promise)
    return promise
  }

  // P1-03：生成低质量缩略图（64px, q30）
  // 命名规则：${fileHash}_low.jpg，与标准版本 ${fileHash}.jpg 区分
  // 若低质量缓存命中直接返回；否则从标准缩略图缩放（若标准已存在），或从原文件生成
  private async doGenerateLow(filePath: string): Promise<string | null> {
    try {
      await this.ensureCacheDir()
      if (!(await pathExists(filePath))) return null

      const stats = await fsp.stat(filePath)
      const fileHash = await this.getFileHash(filePath, stats)
      const lowPath = path.join(this.cacheDir, `${fileHash}_low.jpg`)

      // FIX(组10-1): 维护 LRU 前必须先加载既有元数据——low 路径此前完全不维护
      // accessTimes，若不加载就 set+persist 会用仅含当前条目的 Map 覆盖整个 metadata 文件
      await this.loadAccessTimes()
      // FIX(组10-1): 缓存命中也更新访问记录（与 doGenerate 一致），否则 _low 淘汰时退化为 mtime 排序
      this.accessTimes.set(fileHash, Date.now())
      this.accessCounter++

      if (await pathExists(lowPath)) {
        await this.maybePersistAccessTimes()
        return lowPath
      }

      // worker 化改造：sharp 调用统一走 runSharp（worker 不可用时自动降级到内联）
      // processLow 内部自行决定源（标准缩略图优先，否则原文件），与原逻辑一致
      const result = await this.runSharp('low', filePath, fileHash)
      if (!result.path) return null

      // FIX(组10-1): 与 doGenerateHigh 对齐——生成后累加内存计数器并触发 LRU 检查，
      // 否则计数器长期偏低使清理触发滞后
      this.totalCacheSize = Math.max(0, this.totalCacheSize) + result.size
      await this.enforceCacheLimit()
      await this.maybePersistAccessTimes()
      return result.path
    } catch (error) {
      logger.error(t('main.thumbnail.log.lowQualityFailed'), error)
      return null
    }
  }

  // 高清档位生成（512px, q90）
  // 命名规则：${fileHash}_high.jpg，与 standard(${hash}.jpg) / low(${hash}_low.jpg) 区分
  // 高分屏（DPR ≥ 2）下使用，优先从原文件生成保证清晰度
  // 视频文件不生成 high 档位（视频帧提取耗时较高），降级返回 standard 路径
  private async doGenerateHigh(filePath: string): Promise<string | null> {
    try {
      await this.ensureCacheDir()
      if (!(await pathExists(filePath))) return null

      // 视频降级：直接返回 standard 档位
      const ext = path.extname(filePath).toLowerCase()
      if (isVideoExt(ext)) {
        return this.doGenerate(filePath)
      }

      const stats = await fsp.stat(filePath)
      const fileHash = await this.getFileHash(filePath, stats)
      const highPath = path.join(this.cacheDir, `${fileHash}_high.jpg`)

      // 缓存命中直接返回
      if (await pathExists(highPath)) return highPath

      // worker 化改造：sharp 调用统一走 runSharp（worker 不可用时自动降级到内联）
      // 注意：原 doGenerateHigh 解码失败时不调用 markCorrupted（仅日志 + 返回 null），
      // 此处保持原行为——doGenerateHigh 通常在 doGenerate 成功后被调用，文件已校验有效
      const result = await this.runSharp('high', filePath, fileHash)
      if (!result.path) {
        return null
      }

      // 累加缓存大小计数器（worker 回传 size，避免主进程再次 stat）
      this.totalCacheSize = Math.max(0, this.totalCacheSize) + result.size

      // 记录访问时间 + 触发 LRU 检查
      this.accessTimes.set(fileHash, Date.now())
      this.accessCounter++
      await this.enforceCacheLimit()
      await this.maybePersistAccessTimes()
      return highPath
    } catch (error) {
      logger.error(t('main.thumbnail.log.highQualityFailed'), error)
      return null
    }
  }

  private async doGenerate(filePath: string): Promise<string | null> {
    try {
      await this.ensureCacheDir()
      await this.loadAccessTimes()

      // C-3：统一文件存在检查
      if (!(await pathExists(filePath))) {
        logger.error(`[Thumbnail] 文件不存在: ${filePath}`)
        return null
      }

      const stats = await fsp.stat(filePath)
      // A-S8：基于内容 hash（文件前 1MB 的 sha256），文件移动后缓存仍有效
      const fileHash = await this.getFileHash(filePath, stats)
      const thumbnailPath = path.join(this.cacheDir, `${fileHash}.jpg`)

      // C-3：扩展名判定上移——缓存命中分支的视频纯白自愈依赖该判定
      const ext = path.extname(filePath).toLowerCase()
      const isVideo = isVideoExt(ext)

      // A-S7：记录访问时间（LRU），无论缓存命中还是新生成都需更新
      this.accessTimes.set(fileHash, Date.now())
      this.accessCounter++

      // C-3：统一文件存在检查
      if (await pathExists(thumbnailPath)) {
        // 历史缓存自愈：旧版抽帧逻辑会把片头纯白帧当作缩略图落盘（含其 _low 副本），
        // 命中即返回会让白图永久留存。此处对视频做一次纯色自检并重建，让存量白图自动修复。
        if (
          isVideo &&
          !this.blankHealedHashes.has(fileHash) &&
          (await isBlankCachedThumbnail(thumbnailPath))
        ) {
          this.blankHealedHashes.add(fileHash)
          try {
            // N1：视频抽帧走独立 videoLimiter，不再挤占图片解码许可（慢视频会堵死图片队列）
            await videoLimiter(() => this.extractVideoFrame(filePath, thumbnailPath))
            // 丢弃同源的白色低清副本并重建：网格优先展示 _low，只修标准档位仍会显示白图
            const lowPath = path.join(this.cacheDir, `${fileHash}_low.jpg`)
            await fsp.rm(lowPath, { force: true })
            await this.runSharp('low', filePath, fileHash)
          } catch (healErr) {
            // 自愈失败保留旧图：绝不因自愈失败让本次 generate 返回 null
            logger.warn(`[Thumbnail] 纯白缩略图自愈失败，保留原图: ${filePath}`, healErr)
          }
        }
        // 缓存命中：访问时间已在内存更新，定期持久化
        await this.maybePersistAccessTimes()
        // 缓存命中意味着此前已成功解码，文件非损坏。清除可能存在的过期损坏标记（文件已修复场景）
        await this.clearCorrupted(filePath)
        return thumbnailPath
      }

      // 损坏文件容错：解码阶段独立 try/catch，失败时标记损坏并返回 null，
      // 不影响外层缓存计数与 LRU 逻辑，也不影响其他文件的缩略图生成
      try {
        if (isVideo) {
          // 视频仍走主进程 ffmpeg（async spawn 子进程，不阻塞事件循环，无需迁移到 worker）。
          // N1（fix-thumbnail-skeleton-reveal）：视频抽帧走独立 videoLimiter，不再挤占
          // 图片解码许可——慢视频走 0/1/3s seek 阶梯（每次 30s 超时）最长可占用通道 90s，
          // 共用 decodeLimiter 时会把可视区按需生成的图片全部堵在队列后。
          await videoLimiter(() => this.extractVideoFrame(filePath, thumbnailPath))
          // FIX(组10-1): 视频帧提取落盘后 stat 累加内存计数器（sharp 分支由 worker 回传 size，
          // 视频分支此前完全漏记，使 totalCacheSize 长期偏低、LRU 清理触发滞后）
          const videoSize = (await fsp.stat(thumbnailPath).catch(() => ({ size: 0 }))).size
          this.totalCacheSize = Math.max(0, this.totalCacheSize) + videoSize
        } else {
          // worker 化改造：sharp 调用统一走 runSharp（worker 不可用时自动降级到内联）
          // processStandard 内部同步生成 _low（与原 doGenerate 第 421~436 行逻辑一致）
          const result = await this.runSharp('standard', filePath, fileHash)
          if (!result.path) {
            throw new Error(t('main.thumbnail.error.sharpResizeFailed'))
          }
          // F-S5：累加新生成文件大小到内存计数器（worker 已回传 size，避免主进程 stat）
          this.totalCacheSize = Math.max(0, this.totalCacheSize) + result.size
        }
      } catch (decodeErr) {
        // 解码失败：标记为损坏，写入详细错误日志，不抛出未捕获异常
        const reason = decodeErr instanceof Error ? decodeErr.message : String(decodeErr)
        await this.markCorrupted(
          filePath,
          t('main.thumbnail.log.decodeFailed', {
            kind: isVideo ? t('main.thumbnail.kindVideo') : t('main.thumbnail.kindImage'),
            reason
          })
        )
        return null
      }

      // _low 已由 runSharp 内部生成（standard 档位同步生成 _low，与原 doGenerate 一致）

      // A-S7：新生成缩略图后检查缓存大小，超阈值 10% 时按 LRU 淘汰
      await this.enforceCacheLimit()
      await this.maybePersistAccessTimes()
      // 解码成功：清除可能存在的过期损坏标记（文件已修复场景）
      await this.clearCorrupted(filePath)
      return thumbnailPath
    } catch (error) {
      // 外层兜底：fileHash 计算、stat、目录创建等非解码失败
      logger.error(t('main.thumbnail.log.generateFailed'), error)
      return null
    }
  }

  /**
   * 执行 sharp 缩放，优先委托 worker，失败/降级时回退到内联 sharp。
   * @param quality 档位（'low' / 'standard' / 'high'）
   * @param filePath 源文件路径
   * @param fileHash 文件内容 hash（主进程已计算）
   * @returns { path: 缩略图路径 | null, size: 新文件大小 }；path=null 表示 sharp 解码失败
   *
   * 降级触发场景（详见 worker-bridge.ts）：
   * - worker fork 失败 / WORKER_READY 超时 / 已 dispose → workerFailed=true
   * - worker 异常退出（pending 被 reject）
   * - processImage 30s 超时
   * sharp 解码失败（文件损坏）不降级（worker 与内联均会失败），返回 { path: null }
   *
   * 并发约束：整个方法体（worker 路径 + 内联降级路径）在 decodeLimiter 的一个许可内执行，
   * 全局同时解码数不超过 DECODE_CONCURRENCY。runSharpInline 只经由此处调用，
   * 故不再单独取许可——同一信号量重入会自锁。
   */
  private async runSharp(
    quality: ThumbnailQuality,
    filePath: string,
    fileHash: string
  ): Promise<{ path: string | null; size: number }> {
    return decodeLimiter(() => this.runSharpUnlimited(quality, filePath, fileHash))
  }

  /** runSharp 的实际实现，调用方必须已持有 decodeLimiter 许可 */
  private async runSharpUnlimited(
    quality: ThumbnailQuality,
    filePath: string,
    fileHash: string
  ): Promise<{ path: string | null; size: number }> {
    // worker 不可用：直接走内联 sharp（fallback）
    if (!this.workerBridge || !this.workerBridge.isAvailable()) {
      return this.runSharpInline(quality, filePath, fileHash)
    }

    try {
      const result = await this.workerBridge.processImage({
        requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filePath,
        fileHash,
        quality,
        cacheDir: this.cacheDir
      })
      if (result.success) {
        return { path: result.outputPath, size: result.outputSize }
      }
      // worker 不可用（非解码失败）：降级到内联 sharp
      if (result.errorMessage === 'worker unavailable') {
        return this.runSharpInline(quality, filePath, fileHash)
      }
      // sharp 解码失败（文件损坏等）：返回 null 由调用方决定是否 markCorrupted（不兜底）
      return { path: null, size: 0 }
    } catch (err) {
      // worker 调用异常（pending reject / 超时 / postMessage 失败）：降级到内联 sharp
      logger.warn(t('main.thumbnail.log.workerCallFailed'), err)
      return this.runSharpInline(quality, filePath, fileHash)
    }
  }

  /**
   * 内联 sharp 调用（fallback 路径，原 4 处 sharp 代码原样迁移至此）。
   *
   * 保留原 sharp 参数：fit=inside, withoutEnlargement=true, progressive=standard/high 档位启用。
   * standard 档位同步生成 _low（与原 doGenerate 第 421~436 行逻辑一致），失败不阻断主流程。
   */
  private async runSharpInline(
    quality: ThumbnailQuality,
    filePath: string,
    fileHash: string
  ): Promise<{ path: string | null; size: number }> {
    try {
      if (quality === 'low') {
        const lowPath = path.join(this.cacheDir, `${fileHash}_low.jpg`)
        const standardPath = path.join(this.cacheDir, `${fileHash}.jpg`)
        const sourcePath = (await pathExists(standardPath)) ? standardPath : filePath
        await writeFileAtomic(lowPath, (tmp) =>
          sharp(sourcePath)
            .resize(this.lowMaxWidth, this.lowMaxHeight, {
              fit: 'inside',
              withoutEnlargement: true
            })
            .jpeg({ quality: this.lowQuality })
            .toFile(tmp)
        )
        const size = (await fsp.stat(lowPath).catch(() => ({ size: 0 }))).size
        return { path: lowPath, size }
      }

      if (quality === 'high') {
        const highPath = path.join(this.cacheDir, `${fileHash}_high.jpg`)
        await writeFileAtomic(highPath, (tmp) =>
          sharp(filePath)
            .resize(this.highMaxWidth, this.highMaxHeight, {
              fit: 'inside',
              withoutEnlargement: true
            })
            .jpeg({ quality: this.highQuality, progressive: true })
            .toFile(tmp)
        )
        const size = (await fsp.stat(highPath).catch(() => ({ size: 0 }))).size
        return { path: highPath, size }
      }

      // standard：生成标准档位 + 同步生成 _low（与原 doGenerate 一致）
      const thumbnailPath = path.join(this.cacheDir, `${fileHash}.jpg`)
      await writeFileAtomic(thumbnailPath, (tmp) =>
        sharp(filePath)
          .resize(this.maxWidth, this.maxHeight, {
            fit: 'inside',
            withoutEnlargement: true
          })
          .jpeg({ quality: this.quality, progressive: true })
          .toFile(tmp)
      )

      // 同步生成 _low：从刚生成的标准缩略图缩放（更快），失败不阻断主流程
      const lowPath = path.join(this.cacheDir, `${fileHash}_low.jpg`)
      if (!(await pathExists(lowPath))) {
        try {
          await writeFileAtomic(lowPath, (tmp) =>
            sharp(thumbnailPath)
              .resize(this.lowMaxWidth, this.lowMaxHeight, {
                fit: 'inside',
                withoutEnlargement: true
              })
              .jpeg({ quality: this.lowQuality })
              .toFile(tmp)
          )
        } catch {
          // 低质量生成失败不影响标准缩略图返回
        }
      }

      const size = (await fsp.stat(thumbnailPath).catch(() => ({ size: 0 }))).size
      return { path: thumbnailPath, size }
    } catch (error) {
      logger.error(`[Thumbnail] 内联 sharp 失败: ${filePath}`, error)
      return { path: null, size: 0 }
    }
  }

  /**
   * 在 seek 阶梯 [0s, 1s, 3s] 上依次抽帧，返回第一个「非纯色」的帧。
   *
   * 背景：片头存在白闪 / 淡入 / 装饰帧的视频，0s 首帧是一张完全平坦的纯白 JPEG
   * （实测 320×180 仅 600~900 字节，正常帧 10~40 KB）。该帧能被正常解码，因此
   * 既不报错也不触发「ffmpeg 失败才重试」的旧逻辑，会作为缩略图永久命中缓存，
   * 表现为「缓存 / 重复文件板块视频缩略图概率显示为纯白色」。
   *
   * 规则：
   * - ffmpeg 失败（error / 超时 / 0 字节）→ 记 warn 后进下一位点；全部失败抛末次错误
   *   （保持 doGenerate 的 markCorrupted 分支行为不变）
   * - ffmpeg 成功但判定为纯色 → 非末位则进下一位点；末位仍纯色则保留该帧返回
   *   （降级优于失败，不标损坏）
   * - 首帧有内容时只跑一次，正常视频零额外开销
   */
  private async extractVideoFrame(videoPath: string, outputPath: string): Promise<void> {
    const ladder = [0, VIDEO_RETRY_SEEK_SECONDS, VIDEO_THIRD_SEEK_SECONDS]
    let lastError: unknown = null
    // N4 短视频兜底：是否已有成功落盘的帧
    let haveFrame = false

    for (let i = 0; i < ladder.length; i++) {
      const seek = ladder[i]
      try {
        await this.extractVideoFrameAtSeek(videoPath, outputPath, seek)
        haveFrame = true
      } catch (err) {
        lastError = err
        if (i === ladder.length - 1 && haveFrame) {
          // 末位点（3s）失败但此前已有成功帧：时长 <3s 的视频 seek 3s 会空输出抛错，
          // 若据此判失败会连同 markCorrupted 把完好短视频从图库隐藏。
          // 降级优于失败——保留末次成功帧返回（可能是纯色帧，交给白帧自愈后续处理）。
          logger.warn(
            `[ThumbnailGenerator] 末位抽帧失败但已保留 ${ladder[i - 1]}s 成功帧 (path: ${videoPath})`
          )
          return
        }
        if (i < ladder.length - 1) {
          logger.warn(
            `[ThumbnailGenerator] ffmpeg 抽帧 ${seek}s 失败 (${(err as Error)?.message}); 重试 ${
              ladder[i + 1]
            }s (path: ${videoPath})`
          )
        }
        continue
      }

      // 末位点无论是否纯色都保留（不重试、不报错）
      if (i === ladder.length - 1) return
      if (!(await isBlankImageFile(outputPath))) return
      logger.warn(
        `[ThumbnailGenerator] 抽帧 ${seek}s 为纯色帧，继续尝试 ${ladder[i + 1]}s (path: ${videoPath})`
      )
    }

    if (lastError !== null) throw lastError
  }

  /**
   * 在 `seekSeconds` 位置抽取单帧到 `outputPath`（使用 ffmpeg-static）。
   * - 入参校验：路径非空、seek 在合法区间。
   * - 输出校验：end 后确认输出文件存在且字节数 > 0，避免把 0 字节/损坏文件当成功缓存。
   * - 超时保护：30s 后 kill 子进程并 reject，防止 ffmpeg 进程泄漏。
   */
  private extractVideoFrameAtSeek(
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
      const ffmpegPath = ffmpegBinaryPath
      let settled = false
      // N2 原子落盘：ffmpeg 输出到同目录临时文件，校验通过后 rename 替换最终路径，
      // 避免 media:// 流式读到半截帧文件（裂图）与跨进程并发写撕裂
      const tmpOutputPath = tempSiblingPath(outputPath)

      const cleanup = (cmd: ReturnType<typeof import('fluent-ffmpeg')>) => {
        clearTimeout(timeout)
        untrackFfmpegCommand(cmd)
      }

      // 30 秒超时保护：超时后必须 kill 子进程，避免 ffmpeg 进程泄漏
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        command.kill('SIGKILL')
        cleanup(command)
        void removeTempFileQuietly(tmpOutputPath)
        reject(new Error(t('main.thumbnail.error.ffmpegFrameTimeout')))
      }, 30000)

      const command = ffmpeg(videoPath)
        .setFfmpegPath(ffmpegPath)
        .seekInput(seekSeconds)
        .frames(1)
        .output(tmpOutputPath)
        .outputOptions(
          '-vf',
          `scale=${this.maxWidth}:${this.maxHeight}:force_original_aspect_ratio=decrease`,
          '-f',
          'image2',
          '-update',
          '1'
        )
        // 合并为单一 end/error 监听，避免原实现重复注册导致的清理不一致
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
          // spawn EFTYPE/ENOENT 等子进程错误落盘诊断（阶梯重试会吞掉末次以外的错误）
          maybeLogSpawnError('thumbnail-generator', err)
          void removeTempFileQuietly(tmpOutputPath)
          reject(err)
        })

      trackFfmpegCommand(command)
      command.run()
    })
  }

  /**
   * A-S8：基于文件内容（前 1MB）计算 sha256 hash。
   * 文件移动后路径变化但内容不变，hash 仍相同，缓存可复用。
   * 使用内存缓存避免每次都读文件，mtime/size 变化时才重新计算。
   */
  private async getFileHash(filePath: string, stats: fs.Stats): Promise<string> {
    const mtime = stats.mtime.getTime()
    const size = stats.size
    const cached = this.contentHashCache.get(filePath)
    if (cached && cached.mtime === mtime && cached.size === size) {
      return cached.hash
    }

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
      const hashHex = hash.digest('hex').slice(0, 16)
      this.contentHashCache.set(filePath, { hash: hashHex, mtime, size })
      return hashHex
    } catch (err) {
      // 读取失败时降级为路径+mtime+size hash，保证功能可用
      // N8：与 media-worker/worker-entry.ts 的降级公式保持一致（补 size），
      // 否则同一文件在两侧得到不同缩略图文件名，缓存互不命中、重复生成
      logger.warn(`[Thumbnail] 内容 hash 计算失败，降级为路径 hash: ${filePath}`, err)
      const fallback = crypto
        .createHash('sha256')
        .update(`${filePath}:${mtime}:${size}`)
        .digest('hex')
        .slice(0, 16)
      return fallback
    }
  }

  /**
   * A-S7：加载 LRU 访问时间元数据（sidecar JSON），跨重启保留访问记录。
   * 建议改#10：对 JSON.parse 与字段类型加守卫，损坏文件不会让 for...of 抛错
   *
   * R6：损坏检测升级——JSON.parse 失败时删除损坏文件并记录日志（不再静默降级），
   * 避免下次启动再次尝试解析同一损坏文件。ENOENT（文件不存在）视为合法首次启动，静默忽略。
   */
  private async loadAccessTimes(): Promise<void> {
    if (this.accessTimesLoaded) return
    this.accessTimesLoaded = true
    const metaPath = path.join(this.cacheDir, CACHE_METADATA_FILENAME)
    let raw: string
    try {
      raw = await fsp.readFile(metaPath, 'utf-8')
    } catch (err) {
      // 文件不存在视为合法首次启动，静默忽略；其他读取错误记录日志
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        logger.warn(t('main.thumbnail.log.readCacheMetaFailed'), err)
      }
      return
    }
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch (err) {
      // R6：JSON 解析失败 → 文件损坏，删除并记录日志（不再静默降级）
      logger.warn(t('main.thumbnail.log.cacheMetaCorrupted'), err)
      try {
        await fsp.unlink(metaPath)
      } catch (unlinkErr) {
        // 删除失败不阻塞后续流程（可能并发已被清理）
        const code = (unlinkErr as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          logger.warn(t('main.thumbnail.log.deleteCorruptedMetaFailed'), unlinkErr)
        }
      }
      return
    }
    if (data && typeof data === 'object' && 'accessTimes' in data) {
      const accessTimes = (data as { accessTimes: unknown }).accessTimes
      if (typeof accessTimes === 'object' && accessTimes !== null) {
        for (const [k, v] of Object.entries(accessTimes as Record<string, unknown>)) {
          // 仅接受值为有限数字的条目，过滤掉损坏/非法字段
          const num = Number(v)
          if (Number.isFinite(num)) {
            this.accessTimes.set(k, num)
          }
        }
      }
    }
  }

  /**
   * A-S7：每 100 次访问持久化一次访问时间，避免频繁磁盘写入。
   */
  private async maybePersistAccessTimes(): Promise<void> {
    if (this.accessCounter % 100 !== 0) return
    await this.persistAccessTimes()
  }

  /**
   * T10：无条件持久化访问时间（用于 cleanAll / flushAccessTimes 等场景）
   *
   * R6：原子写入——先写 `.tmp` 临时文件，再 `rename` 替换原文件（同盘 rename 原子）。
   * 避免进程中途崩溃导致文件截断，LRU 访问时间全部丢失，淘汰策略退化为 mtime。
   * 写入失败时清理 `.tmp` 残留文件。
   */
  private async persistAccessTimes(): Promise<void> {
    const metaPath = path.join(this.cacheDir, CACHE_METADATA_FILENAME)
    const tmpPath = metaPath + '.tmp'
    try {
      const data = JSON.stringify({ accessTimes: Object.fromEntries(this.accessTimes) })
      await fsp.writeFile(tmpPath, data, 'utf-8')
      await fsp.rename(tmpPath, metaPath)
    } catch (err) {
      logger.warn(t('main.thumbnail.log.saveCacheMetaFailed'), err)
      // 清理可能残留的 .tmp 文件，避免占用磁盘
      try {
        await fsp.unlink(tmpPath)
      } catch (unlinkErr) {
        // ENOENT 表示 .tmp 未生成或已被 rename，正常情况，忽略
        const code = (unlinkErr as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          logger.warn(t('main.thumbnail.log.cleanTmpFailed'), unlinkErr)
        }
      }
    }
  }

  /**
   * A-S7：检查缓存总大小，超过 cacheLimitBytes 时按 LRU 淘汰最久未访问的缩略图。
   * F-S5：改为按需触发——仅当内存计数器超阈值 10% 或 force=true 时才全目录扫描，
   * 避免每次生成都 O(n) 扫描。后台定时任务每 5 分钟 force=true 校准计数器。
   */
  private async enforceCacheLimit(force = false): Promise<void> {
    // F-S5：未强制且未超阈值 10% 时跳过，避免每次生成都全目录扫描
    if (
      !force &&
      this.totalCacheSize >= 0 &&
      this.totalCacheSize <= this.cacheLimitBytes * ThumbnailGenerator.LRU_TRIGGER_RATIO
    ) {
      return
    }
    try {
      const entries = await fsp.readdir(this.cacheDir, { withFileTypes: true })
      const filesInfo: Array<{ name: string; fullPath: string; size: number; accessTime: number }> =
        []
      let totalSize = 0

      for (const entry of entries) {
        if (!entry.isFile()) continue
        if (entry.name === CACHE_METADATA_FILENAME) continue
        const fullPath = path.join(this.cacheDir, entry.name)
        const stat = await fsp.stat(fullPath)
        // 解析 hash：剥离 .jpg 后缀 + _low/_high 档位后缀，三档共享同一 accessTime 记录
        const hash = entry.name
          .replace(/\.jpg$/, '')
          .replace(/_low$/, '')
          .replace(/_high$/, '')
        // 访问时间优先取内存记录，缺失时降级为文件 mtime
        const accessTime = this.accessTimes.get(hash) ?? stat.mtime.getTime()
        filesInfo.push({ name: entry.name, fullPath, size: stat.size, accessTime })
        totalSize += stat.size
      }

      // F-S5：校准内存计数器为实际值
      this.totalCacheSize = totalSize

      if (totalSize <= this.cacheLimitBytes) return

      // 按 accessTime 升序，淘汰最久未访问的
      filesInfo.sort((a, b) => a.accessTime - b.accessTime)
      for (const f of filesInfo) {
        if (totalSize <= this.cacheLimitBytes) break
        await fsp.unlink(f.fullPath).catch(() => {})
        // 解析 hash：与上方统计阶段一致，三档同步淘汰避免孤儿文件
        const hash = f.name
          .replace(/\.jpg$/, '')
          .replace(/_low$/, '')
          .replace(/_high$/, '')
        this.accessTimes.delete(hash)
        totalSize -= f.size
        logger.info(`[Thumbnail] LRU 淘汰: ${f.name}`)
      }
      // F-S5：淘汰后更新计数器
      this.totalCacheSize = totalSize
    } catch (err) {
      logger.warn(t('main.thumbnail.log.lruCleanFailed'), err)
    }
  }

  /**
   * F-S5：启动后台定时校准 + 清理任务（每 5 分钟一次）
   * 应在 Application.initialize 中调用
   */
  startLruBackgroundTask(): void {
    if (this.lruTimer) return
    // unref：避免后台 interval 阻止进程退出（测试 / 异常退出路径下 stopLruBackgroundTask 未触发时也能让进程收尾）
    this.lruTimer = setInterval(() => {
      void this.enforceCacheLimit(true).catch(() => {})
    }, ThumbnailGenerator.LRU_CHECK_INTERVAL_MS).unref()
  }

  /**
   * F-S5：停止后台定时任务（before-quit 调用，避免定时器在 db.close 后触发）
   */
  stopLruBackgroundTask(): void {
    if (this.lruTimer) {
      clearInterval(this.lruTimer)
      this.lruTimer = null
    }
  }
}
