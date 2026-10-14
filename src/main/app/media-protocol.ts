import { protocol } from 'electron'
import path from 'path'
import fs from 'fs'
import type Database from 'better-sqlite3'
import type { HandlerContext } from '../ipc/handler-context'
import type { AppContext } from './app-context'
import { MEDIA_EXTENSIONS, getMimeType } from '../utils/media-constants'
import { MEDIA_CACHE_TTL_MS } from '../utils/constants'
import { isPathUnderDir } from '../utils/ipc-validate'
// 阶段 4：media:// 第 4 条规则的事实来源（NikkiSync 资源路径精确授权表）
import { isNikkiSyncResourcePath } from '../nikkisync/resource-allowlist'
import { logger } from '../utils/logger'
// 文件读流的生命周期管理统一走公共工具（含 error 监听 + abort 取消 + fd 归还），
// 本文件不再自带实现，避免与 WiFi 分享服务出现两份易漂移的副本
import { createManagedReadStream, type ByteRange } from '../utils/managed-read-stream'
import { t } from '../i18n'

// media:// 协议白名单内存缓存（修复 A-S1/C-S2：原实现每次请求都全表扫描）
// pathCache: 路径 → 是否允许，带 TTL（5分钟）
// sourcePathCache: 已索引 source_path 列表，带 TTL（5分钟）
// 模块级单例：拆分前为 Application 类私有字段，拆分后迁移到模块级
const mediaPathCache: Map<string, { allowed: boolean; expiresAt: number }> = new Map()
let mediaSourcePathCache: { paths: string[]; expiresAt: number } | null = null

// C-G3：media:// 协议白名单缓存 TTL 使用共享常量
const MEDIA_CACHE_TTL = MEDIA_CACHE_TTL_MS
// P1-C：路径缓存条目上限，超过时清空（避免长期运行内存膨胀）
const MEDIA_PATH_CACHE_MAX = 1000

// realpath 解引用缓存：避免每次请求都 syscall
// key 为 path.resolve 后、realpath 前的请求路径；value 为 fs.realpath 返回的真实路径
// 满上限时整体 clear() 重建——realpath 结果稳定，无需 LRU
const realpathCache: Map<string, string> = new Map()
const REALPATH_CACHE_MAX = 5000

// 缓存策略（fix-thumbnail-loading-latency 节点1 + N7 放宽）：
// - 缩略图：ETag 协商缓存。自愈/重生成就地覆盖同名文件（内容 hash 命名，URL 不变），
//   一年强缓存会让渲染层持续命中旧字节（视频白帧长期不消失的机制性根因）。
//   N7：max-age 0 → 300——内容 hash 命名下 URL 基本不变，5 分钟内同一 URL 直接命中
//   本地缓存，消除滚动/广播期间每张可见卡回主进程 stat+ETag 的往返；代价是自愈重建
//   同名文件后浏览器最长 5 分钟后才看到新字节（权衡已确认接受）。
// - 原图/视频：保持一年强缓存（用户文件内容不可变假设，视频播放 Range 性能不受影响）。
const THUMBNAIL_CACHE_CONTROL = 'public, max-age=300, must-revalidate'
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000'

/**
 * 由 stat 结果构造缩略图弱 ETag（mtimeMs + size 十六进制）。
 * mtimeMs 缺失（mock/异常 stat 结果）时以 0 兜底，不抛错——最坏情况是 304 判定失效回 200。
 */
function buildThumbnailEtag(fileStat: { mtimeMs?: number }, fileSize: number): string {
  const mtime =
    typeof fileStat.mtimeMs === 'number' && Number.isFinite(fileStat.mtimeMs)
      ? Math.round(fileStat.mtimeMs)
      : 0
  return `W/"${mtime.toString(16)}-${fileSize.toString(16)}"`
}

/**
 * If-None-Match 匹配：支持多值列表、W/ 前缀与引号差异、`*` 通配。
 * 解析失败/不匹配一律返回 false（fail-open 回 200，绝不因头部异常拒绝服务）。
 */
function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const normalize = (value: string): string =>
    value
      .trim()
      .replace(/^W\//i, '')
      .replace(/^"(.*)"$/, '$1')
  return ifNoneMatch.split(',').some((candidate) => {
    const c = normalize(candidate)
    if (!c) return false
    return c === '*' || c === normalize(etag)
  })
}

/**
 * 注册 media:// 协议 handler（支持视频 Range 请求 + 图片流式响应）。
 * 将渲染进程的图片/视频请求映射到本地文件，受白名单校验保护。
 */
export function registerMediaProtocol(ctx: AppContext): void {
  try {
    protocol.unhandle('media')
  } catch {
    // 协议未注册时忽略错误
  }

  protocol.handle('media', async (request) => {
    try {
      const url = new URL(request.url)
      const encodedPath = url.searchParams.get('path')
      if (!encodedPath) {
        logger.warn(t('main.mediaProtocol.log.missingPathParam'), request.url)
        return new Response('Missing path', { status: 400 })
      }

      // FIX(组6-1): url.searchParams.get 已按 URL 规范完成一次百分号解码，渲染端
      // （utils/file.ts）也仅 encodeURIComponent 一次——此处再 decodeURIComponent 属于
      // 二次解码：含 % 的文件名（如 100%20photos.jpg）被解码成错误路径（404/白图），
      // 或因 %ZZ 等非法序列抛 URIError（500）。直接使用 searchParams 的解码结果。
      const filePath = encodedPath
      const normalizedPath = path.resolve(filePath)
      const realPath = await resolveRealPath(normalizedPath)
      if (realPath === null) {
        logger.warn(t('main.mediaProtocol.log.realpathFailed'), filePath)
        return new Response('File not found', { status: 404 })
      }

      // 阶段 4 · 第 4 条规则：NikkiSync 资产路径授权。
      // 查询面（runtime-facade 的 path 模式）把上游 `resources.source_path` 交给渲染层时
      // 逐项登记，这里只做**确切路径**的精确匹配——不给目录级授权，判的是解引用之后的
      // realPath（因此符号链接指向表外仍然落空），并沿用同一道扩展名白名单：
      // 登记过也不放非媒体文件。本 App 的 DB 是否就绪与该规则无关（两份库彼此独立）。
      const nikkisyncAllowed =
        MEDIA_EXTENSIONS.has(path.extname(realPath).toLowerCase()) &&
        isNikkiSyncResourcePath(realPath)

      // 路径白名单校验：仅允许访问已索引的媒体文件或已知缩略图
      if (!nikkisyncAllowed && !isMediaPathAllowed(ctx, realPath)) {
        logger.warn(t('main.mediaProtocol.log.denyNotWhitelisted'), filePath)
        return new Response('Forbidden', { status: 403 })
      }

      try {
        await fs.promises.access(realPath, fs.constants.R_OK)
      } catch {
        logger.warn(t('main.mediaProtocol.log.fileNotFoundOrNoPerm'), filePath)
        return new Response('File not found', { status: 404 })
      }

      const ext = path.extname(normalizedPath).toLowerCase()
      const mimeType = getMimeType(ext)

      // 视频与图片走同一条流式路径：都支持 Range（视频 seek 必需），
      // 都避免整文件读入内存。原实现为两段逐字复制的分支，Range 越界 bug 也因此出现两次。
      const fileStat = await fs.promises.stat(realPath)
      const fileSize = fileStat.size

      // 缩略图协商缓存：白帧自愈/重新生成时会就地覆盖同名文件（内容 hash 命名，URL 不变），
      // 一年强缓存会让渲染层持续命中旧字节（典型表现：视频白帧长期不消失）。
      // 仅对缩略图缓存目录内的响应改用 ETag 协商缓存（未变 304 零字节，变更 200 新字节）；
      // 原图/视频为用户文件，保持一年强缓存。修复详见 docs/plans/2026-09-29-fix-thumbnail-loading-latency.md
      const isThumbnail = isPathUnderDir(realPath, path.resolve(ctx.thumbnailGen.getCacheDir()))
      const thumbnailEtag = isThumbnail ? buildThumbnailEtag(fileStat, fileSize) : null
      if (thumbnailEtag) {
        const ifNoneMatch = request.headers.get('if-none-match')
        if (ifNoneMatch && etagMatches(ifNoneMatch, thumbnailEtag)) {
          return new Response(null, {
            status: 304,
            headers: {
              ETag: thumbnailEtag,
              'Cache-Control': THUMBNAIL_CACHE_CONTROL,
              // media:// 相对 app://renderer 页面为跨源，canvas 消费需 CORS 放行（对齐 renderer-protocol.ts）
              'Access-Control-Allow-Origin': '*'
            }
          })
        }
      }

      const range = parseRangeHeader(request.headers.get('range'), fileSize)

      // Range 越界：必须回 416 且不能带负数 Content-Length，否则渲染进程会拿到损坏响应
      if (range === RANGE_UNSATISFIABLE) {
        return new Response(null, {
          status: 416,
          headers: {
            'Content-Range': `bytes */${fileSize}`,
            'Accept-Ranges': 'bytes'
          }
        })
      }

      if (range) {
        const stream = createManagedReadStream(realPath, { signal: request.signal, range })
        return new Response(stream as unknown as ReadableStream, {
          status: 206,
          headers: {
            'Content-Type': mimeType,
            'Content-Range': `bytes ${range.start}-${range.end}/${fileSize}`,
            'Content-Length': String(range.end - range.start + 1),
            'Accept-Ranges': 'bytes',
            'Cache-Control': IMMUTABLE_CACHE_CONTROL,
            // media:// 相对 app://renderer 页面为跨源，canvas 消费需 CORS 放行（对齐 renderer-protocol.ts）
            'Access-Control-Allow-Origin': '*'
          }
        })
      }

      // 无 Range 头：返回完整文件流
      const stream = createManagedReadStream(realPath, { signal: request.signal })
      return new Response(stream as unknown as ReadableStream, {
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(fileSize),
          'Accept-Ranges': 'bytes',
          // 缩略图走协商缓存（自愈覆盖同名文件后必须对渲染层可见）；原图/视频保持一年强缓存
          'Cache-Control': thumbnailEtag ? THUMBNAIL_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL,
          ...(thumbnailEtag ? { ETag: thumbnailEtag } : {}),
          // media:// 相对 app://renderer 页面为跨源，canvas 消费需 CORS 放行（对齐 renderer-protocol.ts）
          'Access-Control-Allow-Origin': '*'
        }
      })
    } catch (error) {
      logger.error(t('main.mediaProtocol.log.handleRequestFailed'), error)
      return new Response('Internal error', { status: 500 })
    }
  })
}

/** parseRangeHeader 的哨兵返回值：Range 语法合法但落在文件范围外，调用方须回 416 */
const RANGE_UNSATISFIABLE = Symbol('range-unsatisfiable')

/**
 * 解析 Range 头并把区间收敛到 [0, size-1]。
 *
 * 返回值三态：
 *   null                 → 无 Range / 语法无法识别，调用方返回完整文件（200）
 *   RANGE_UNSATISFIABLE  → 起点越界或区间倒置，调用方返回 416
 *   ByteRange            → 已收敛的合法区间，end 保证 < size 且 >= start
 *
 * 原实现直接 parseInt 后相减，播放器发来 `bytes=0-999999999`（大于文件尺寸）或
 * seek 到结尾附近时会算出越界 end、甚至负数 Content-Length，读流随即抛错并残留句柄。
 */
function parseRangeHeader(
  rangeHeader: string | null,
  size: number
): ByteRange | typeof RANGE_UNSATISFIABLE | null {
  if (!rangeHeader) return null

  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
  if (!match) return null

  const rawStart = match[1]
  const rawEnd = match[2]
  if (!rawStart && !rawEnd) return null

  // 后缀区间 `bytes=-N`：请求最后 N 字节
  if (!rawStart) {
    const suffixLength = parseInt(rawEnd, 10)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0 || size === 0) {
      return RANGE_UNSATISFIABLE
    }
    return { start: Math.max(0, size - suffixLength), end: size - 1 }
  }

  const start = parseInt(rawStart, 10)
  // size === 0 时任何 start 都越界，这里一并被 start >= size 拦下
  if (!Number.isFinite(start) || start >= size) return RANGE_UNSATISFIABLE

  const requestedEnd = rawEnd ? parseInt(rawEnd, 10) : size - 1
  const end = Math.min(Number.isFinite(requestedEnd) ? requestedEnd : size - 1, size - 1)
  if (end < start) return RANGE_UNSATISFIABLE

  return { start, end }
}

/**
 * 检查 media:// 请求路径是否在白名单内。
 * 安全策略：
 *   1. 缩略图缓存目录下的文件（受控目录）
 *   2. 数据库中已索引的媒体文件（file_path 精确匹配）或其缩略图路径（thumbnail 精确匹配）
 *   3. 已索引 source_path 目录下的媒体文件（扩展名必须在白名单内，防止读取任意文件）
 * 注：媒体扩展名白名单已抽到 utils/media-constants.ts 的 MEDIA_EXTENSIONS 常量
 * 已修复 A-S2/C-F5：原实现 source_path 前缀匹配无扩展名限制，扫描 D:\ 后可读取整盘任意文件
 * 已修复 A-S1/C-S2：原实现每次请求都执行数据库查询，现使用内存缓存（TTL 5分钟）
 */
export function isMediaPathAllowed(ctx: HandlerContext, filePath: string): boolean {
  const db = ctx.dbManager.getDatabase()
  if (!db) return false

  try {
    const thumbnailDir = path.resolve(ctx.thumbnailGen.getCacheDir())
    const normalizedRequest = path.resolve(filePath)

    // 0. 检查路径级缓存（命中则直接返回，避免数据库查询）
    // P1-A4：命中时 delete+set 把 key 移到 Map 末尾，实现 LRU 最近访问优先
    const cached = mediaPathCache.get(normalizedRequest)
    if (cached && cached.expiresAt > Date.now()) {
      // LRU：移到末尾（最近访问）
      mediaPathCache.delete(normalizedRequest)
      mediaPathCache.set(normalizedRequest, cached)
      return cached.allowed
    }

    let allowed = false

    // 1. 允许访问缩略图缓存目录下的文件（受控目录，仅含生成的缩略图）
    // Windows 大小写不敏感：DB 存 D:\Photos、请求 d:\photos 须归一比较，否则裂图
    if (isPathUnderDir(normalizedRequest, thumbnailDir)) {
      allowed = true
    }

    // 2. 允许访问数据库中已索引的媒体文件或缩略图路径（精确匹配）
    // P1-A4：原 `WHERE file_path = ? OR thumbnail = ?` 可能走全表扫描
    //        拆为两次查询：先查 file_path（UNIQUE 索引，最快），未命中再查 thumbnail（idx_media_files_thumbnail）
    if (!allowed) {
      const fpRow = db
        .prepare('SELECT 1 FROM media_files WHERE file_path = ? LIMIT 1')
        .get(normalizedRequest) as { 1: number } | undefined
      if (fpRow) {
        allowed = true
      } else {
        const thRow = db
          .prepare('SELECT 1 FROM media_files WHERE thumbnail = ? LIMIT 1')
          .get(normalizedRequest) as { 1: number } | undefined
        if (thRow) allowed = true
      }
    }

    // 3. 仅允许访问已索引 source_path 目录下、且扩展名在媒体白名单内的文件
    //    防止扫描宽目录（如 D:\）后可读取该目录下任意类型文件（如 .txt/.exe/.json 等敏感文件）
    if (!allowed) {
      const ext = path.extname(normalizedRequest).toLowerCase()
      if (MEDIA_EXTENSIONS.has(ext)) {
        const sourcePaths = getCachedSourcePaths(db)
        for (const sourcePath of sourcePaths) {
          const resolvedSource = path.resolve(sourcePath)
          if (isPathUnderDir(normalizedRequest, resolvedSource)) {
            allowed = true
            break
          }
        }
      }
    }

    // 写入缓存（包括否定结果，避免重复查询不存在的路径）
    // P1-A4：原实现 cache 满 1000 条时 clear() 全清，热门路径被一起清空引发性能抖动
    //        改用 LRU 策略：命中时 delete+set 移到末尾（最近访问），满时删除最早 key（最久未访问）
    if (mediaPathCache.size >= MEDIA_PATH_CACHE_MAX) {
      // 删除最久未访问的 key（Map 迭代顺序 = 插入顺序，首个 key 即 LRU）
      const oldestKey = mediaPathCache.keys().next().value
      if (oldestKey !== undefined) {
        mediaPathCache.delete(oldestKey)
      }
    }
    mediaPathCache.set(normalizedRequest, {
      allowed,
      expiresAt: Date.now() + MEDIA_CACHE_TTL
    })

    return allowed
  } catch (error) {
    logger.error(t('main.mediaProtocol.log.whitelistCheckFailed'), error)
    return false
  }
}

/**
 * 获取已索引 source_path 列表（带内存缓存，避免每次请求都 DISTINCT 全表扫描）
 */
function getCachedSourcePaths(db: Database.Database): string[] {
  if (mediaSourcePathCache && mediaSourcePathCache.expiresAt > Date.now()) {
    return mediaSourcePathCache.paths
  }
  const rows = db
    .prepare('SELECT DISTINCT source_path FROM media_files WHERE source_path IS NOT NULL')
    .all() as Array<{ source_path: string }>
  const paths = rows.map((r) => r.source_path)
  mediaSourcePathCache = {
    paths,
    expiresAt: Date.now() + MEDIA_CACHE_TTL
  }
  return paths
}

/**
 * 解析路径的真实路径（解引用符号链接），失败返回 null。
 * 用于在白名单校验前消除符号链接伪装，防止已索引目录下的软链读出系统任意文件。
 * 抛错（ENOENT/EACCES 等）一律视为拒绝访问，不缓存否定结果——悬空链接下次仍尝试解析。
 */
async function resolveRealPath(p: string): Promise<string | null> {
  const cached = realpathCache.get(p)
  if (cached) return cached

  try {
    const real = await fs.promises.realpath(p)
    // 满上限先清空再写入，避免无界增长
    if (realpathCache.size >= REALPATH_CACHE_MAX) {
      realpathCache.clear()
    }
    realpathCache.set(p, real)
    return real
  } catch {
    return null
  }
}

/**
 * 失效 media:// 协议白名单缓存（在媒体数据变更后调用）。
 * - 传入 paths：仅删除对应路径级判定；source_path 与 realpath 结果不受影响。
 * - 不传参数：保持媒体整体更新时的全清语义。
 */
export function invalidateMediaPathCache(paths?: string[]): void {
  if (paths !== undefined) {
    if (!Array.isArray(paths)) return
    for (const filePath of paths) {
      if (typeof filePath !== 'string' || filePath.length === 0) continue
      mediaPathCache.delete(path.resolve(filePath))
    }
    return
  }

  mediaPathCache.clear()
  mediaSourcePathCache = null
  realpathCache.clear()
}
