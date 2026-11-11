// @core-change: 修复打包态模板源落空：兄弟服务已 bundling 进同 chunk，运行时 require 无兄弟文件可解析致全 unauthorized，改静态导入
/**
 * 参考数据 CDN 图片：应用层磁盘缓存 + 按需取图（阶段 5）。
 *
 * 授权条款落实（RanAxro/nikki_albums **#20**，主机 `cdn.nikkialbums.com`）：
 * - 条款 2「请求标识」：主进程 fetch 携带 `MeowStarMap/<应用真实版本>`。
 *   与既有 `app/cdn-user-agent.ts`（`cdn.gongeo.us` 固定串 UA，#218 已批准）**互不相干**——
 *   两套规则按主机各自独立，不混用、不全局一刀切，本服务不触碰 webRequest 拦截。
 * - 条款 3「本地缓存 + 约 7 天过期」：`<userData>/reference-data/reference-images/<sha256>.<ext>`，
 *   命中零网络；过期重取；损坏（0 字节 / 非图片魔数）删除后重取一次。
 *   禁二次分发/镜像/再托管：字节只落本机受控缓存目录，仅供 `media://` 本地展示。
 * - 条款 4「禁高频请求」：404 → 负缓存（30 分钟）；网络/5xx/校验失败 → per-key 冷却（5 分钟）；
 *   同 key 并发 in-flight 去重（一次展示多行引用只发一个请求）。
 *
 * 设计约束：**全链 fail-soft**——`resolveReferenceImage` 永不 reject，不可用时返回
 * `{ path: null, status }`，渲染层回退占位文字，不影响其余行与其余功能（对齐
 * `reference-data-service` 的查询面口径）。加速/镜像入口（设置键
 * `referenceData.imageMirrorBaseUrl`）经 `image-url.ts` 的 SSRF 守卫，应用不内置节点。
 *
 * 供图路径：渲染层拿到 `path` 后拼 `media://file?path=<path>`，由 `app/media-protocol.ts`
 * 的白名单规则（参考图片缓存目录）放行——渲染进程**永不直连** nikkialbums。
 */

import fsp from 'fs/promises'
import path from 'path'
import { logger } from '../utils/logger'
import { writeFileAtomic } from '../utils/atomic-file'
import { IMAGE_EXTENSIONS } from '../utils/media-constants'
import { resolveNetworkImageUrl, type ResolvedReferenceImage } from './reference-data/image-url'
// 静态导入：electron-vite 将本服务与 reference-data-service bundling 进同一 chunk，
// dist 无兄弟文件，运行时 require 会落空（打包态冒烟实测全 unauthorized）。两服务无环。
import { getNetworkImageTemplates } from './reference-data-service'
import type {
  NetworkImageTemplateInfo,
  ReferenceImageResolveResult
} from '../../shared/types/electron-api'

// ============================================================
// 配置（量级对齐 reference-data-service / cloth-data-config；测试可注入覆盖）
// ============================================================

const DEFAULT_REFERENCE_IMAGE_CONFIG = {
  /** 缓存有效期：7 天（#20 条款 3「约 7 天量级」） */
  cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
  /** 404 负缓存：资源确实不存在时避免每次展示都打一次网络（条款 4 禁高频） */
  missTtlMs: 30 * 60 * 1000,
  /** 网络/5xx/校验失败后的 per-key 冷却退避（与 reference-data 的 retryCooldownMs 同量级） */
  retryCooldownMs: 5 * 60 * 1000,
  /** 单图请求超时（CDN 缩略图体量小） */
  fetchTimeoutMs: 15000,
  /** 单图字节上限（防异常响应撑爆内存/磁盘） */
  maxBytes: 8_000_000,
  /** 缓存目录名（挂在参考数据根下，与 packages/ 同级） */
  cacheDirName: 'reference-images',
  /** 参考数据根目录名（与 reference-data-service 的 rootDir 保持一致） */
  rootDirName: 'reference-data'
} as const

type ReferenceImageConfig = typeof DEFAULT_REFERENCE_IMAGE_CONFIG

let config: ReferenceImageConfig = { ...DEFAULT_REFERENCE_IMAGE_CONFIG }

// ============================================================
// 依赖注入（测试用；生产经 electron 惰性 require 取默认值）
// ============================================================

export interface ReferenceImageDeps {
  fetcher: typeof fetch
  getUserDataDir: () => string
  getAppVersion: () => string
  now: () => number
  /** 地址模板快照（生产取自 reference-data-service.getNetworkImageTemplates） */
  getTemplates: () => NetworkImageTemplateInfo[]
}

const DEFAULT_DEPS: ReferenceImageDeps = {
  fetcher: (...args) => globalThis.fetch(...args),
  getUserDataDir: () => {
    const electron = require('electron') as { app?: { getPath?: (name: string) => string } }
    return electron.app?.getPath?.('userData') ?? ''
  },
  getAppVersion: () => {
    const electron = require('electron') as { app?: { getVersion?: () => string } }
    return electron.app?.getVersion?.() ?? '0.0.0'
  },
  now: () => Date.now(),
  getTemplates: () => getNetworkImageTemplates()
}

let deps: ReferenceImageDeps = { ...DEFAULT_DEPS }

/** 注入依赖覆盖（null 恢复默认）；测试用，生产代码不调用 */
export function setReferenceImageDeps(overrides: Partial<ReferenceImageDeps> | null): void {
  deps = overrides ? { ...DEFAULT_DEPS, ...overrides } : { ...DEFAULT_DEPS }
}

/** 注入配置覆盖（null 恢复默认）；测试用，生产代码不调用 */
export function setReferenceImageConfig(overrides: Partial<ReferenceImageConfig> | null): void {
  config = overrides
    ? { ...DEFAULT_REFERENCE_IMAGE_CONFIG, ...overrides }
    : { ...DEFAULT_REFERENCE_IMAGE_CONFIG }
}

// ============================================================
// 对外类型
// ============================================================

/**
 * 取图结果的语义化状态与返回体定义在 `src/shared/types/electron-api.ts`
 * （`ReferenceImageStatus` / `ReferenceImageResolveResult`）——跨进程契约的单一真相源，
 * preload 只能 type-only 引 shared，本文件不再留本地副本（两份定义必然漂移）。
 */

// ============================================================
// 模块级状态（测试经 disposeReferenceImageService 重置）
// ============================================================

interface EntryState {
  /** 最近一次判定「不存在」的时刻；0 = 无 */
  missAt: number
  /** 最近一次取图失败的时刻；0 = 无 */
  failedAt: number
}

const entryStates = new Map<string, EntryState>()
const inflight = new Map<string, Promise<ReferenceImageResolveResult>>()

/** 清空内存状态并恢复默认配置/注入；应用退出与测试重置用 */
export function disposeReferenceImageService(): void {
  entryStates.clear()
  inflight.clear()
  deps = { ...DEFAULT_DEPS }
  config = { ...DEFAULT_REFERENCE_IMAGE_CONFIG }
}

// ============================================================
// 路径与格式判定
// ============================================================

/**
 * 参考图片缓存目录（`media-protocol.ts` 白名单规则的事实来源）。
 * userData 不可得时返回 null = 缓存停用（拒绝落相对路径，防数据写进进程 CWD）。
 */
export function getReferenceImageCacheDir(): string | null {
  const base = deps.getUserDataDir()
  if (!base) return null
  return path.join(base, config.rootDirName, config.cacheDirName)
}

/**
 * 缓存文件扩展名：取自 URL pathname，落在图片白名单内才用；否则兜底 `.png`。
 * 扩展名只决定 `media://` 响应的 Content-Type——Chromium 的 `<img>` 解码按字节嗅探，
 * 故兜底值不会导致裂图；确定性（不依赖响应头）保证同一 key 的缓存路径可预测、查找零 IO。
 */
function cacheFileExt(fetchUrl: string): string {
  try {
    const ext = path.extname(new URL(fetchUrl).pathname).toLowerCase()
    return IMAGE_EXTENSIONS.has(ext) ? ext : '.png'
  } catch {
    return '.png'
  }
}

/** 图片魔数校验：拒收被 CDN 门户/代理替换成 HTML 或 JSON 的「假图片」 */
function looksLikeImage(bytes: Buffer): boolean {
  if (bytes.length < 4) return false
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true
  if (bytes.toString('ascii', 0, 4) === 'GIF8') return true
  if (bytes.toString('ascii', 0, 2) === 'BM') return true
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return true
  }
  // TIFF：II*\0（小端）/ MM\0*（大端）
  if (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) return true
  return bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a
}

// ============================================================
// 缓存读取（命中 / 过期 / 损坏三态）
// ============================================================

type CacheEntryState = 'fresh' | 'stale' | 'corrupt' | 'missing'

/**
 * 读缓存条目状态。只读文件头 16 字节做魔数校验，避免为校验把整图读进内存。
 * 任何 IO 异常按 `missing`/`corrupt` 归类，绝不抛给调用方。
 */
async function readCacheEntry(file: string): Promise<CacheEntryState> {
  let stat
  try {
    stat = await fsp.stat(file)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'corrupt'
  }
  if (!stat.isFile() || stat.size === 0) return 'corrupt'
  if (deps.now() - stat.mtimeMs > config.cacheTtlMs) return 'stale'

  let handle: fsp.FileHandle | null = null
  try {
    handle = await fsp.open(file, 'r')
    const head = Buffer.alloc(16)
    const { bytesRead } = await handle.read(head, 0, 16, 0)
    if (bytesRead < 4 || !looksLikeImage(head.subarray(0, bytesRead))) return 'corrupt'
    return 'fresh'
  } catch {
    // 句柄打不开/读不动：视为损坏，交由删除重取自愈
    return 'corrupt'
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function removeQuietly(target: string): Promise<void> {
  try {
    await fsp.rm(target, { force: true })
  } catch (err) {
    logger.warn(`[RefImage] 缓存清理失败（忽略）：${describeError(err)}`)
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ============================================================
// 对外 API
// ============================================================

/**
 * 按需解析一张参考图片，返回可直接供图的本机缓存路径。
 *
 * **永不 reject**：任何失败都收敛为 `{ path: null, status }`，渲染层据此回退占位。
 * 不做预取、不做批量——一次调用对应一张图，由展示侧懒加载触发。
 *
 * @param kind 图片类别（须属 NETWORK_IMAGE_KINDS 且落在已授权主机）
 * @param id 资源取值（正安全整数）
 * @param opts.mirrorBaseUrl 用户自配的加速/镜像入口（空 = 走原始地址）
 */
export async function resolveReferenceImage(
  kind: string,
  id: number,
  opts?: { mirrorBaseUrl?: string }
): Promise<ReferenceImageResolveResult> {
  const resolved = resolveNetworkImageUrl({
    kind,
    id,
    templates: safeTemplates(),
    mirrorBaseUrl: opts?.mirrorBaseUrl
  })
  if (!resolved) return { path: null, status: 'unauthorized' }

  const dir = getReferenceImageCacheDir()
  if (!dir) return { path: null, status: 'disabled' }

  const file = path.join(dir, `${resolved.cacheKey}${cacheFileExt(resolved.fetchUrl)}`)

  // 1. 缓存优先：命中即零网络返回；过期/损坏先清掉再走取图（损坏恢复只重取一次）
  const entry = await readCacheEntry(file)
  if (entry === 'fresh') return { path: file, status: 'cached' }
  if (entry === 'stale' || entry === 'corrupt') {
    logger.debug(`[RefImage] 缓存不可用（${entry}），删除后重取 key=${shortKey(resolved)}`)
    await removeQuietly(file)
  }

  // 2. 内存闸门：负缓存与失败冷却期内刻意不发请求（#20 条款 4 禁高频）
  const state = entryStates.get(resolved.cacheKey)
  if (state) {
    const now = deps.now()
    if (state.missAt > 0 && now - state.missAt < config.missTtlMs) {
      return { path: null, status: 'not-found' }
    }
    if (state.failedAt > 0 && now - state.failedAt < config.retryCooldownMs) {
      return { path: null, status: 'cooldown' }
    }
  }

  // 3. 同 key 并发去重：一次展示里多行引用同一资源只发一个请求
  const existing = inflight.get(resolved.cacheKey)
  if (existing) return existing

  const task: Promise<ReferenceImageResolveResult> = fetchAndStore(resolved, dir, file).finally(
    () => {
      if (inflight.get(resolved.cacheKey) === task) inflight.delete(resolved.cacheKey)
    }
  )
  inflight.set(resolved.cacheKey, task)
  return task
}

// ============================================================
// 取图与落盘
// ============================================================

function safeTemplates(): NetworkImageTemplateInfo[] {
  try {
    const templates = deps.getTemplates()
    return Array.isArray(templates) ? templates : []
  } catch (err) {
    logger.warn(`[RefImage] 模板查询失败（视为索引未就绪）：${describeError(err)}`)
    return []
  }
}

function shortKey(resolved: ResolvedReferenceImage): string {
  return resolved.cacheKey.slice(0, 8)
}

function markMiss(cacheKey: string): void {
  const prev = entryStates.get(cacheKey)
  entryStates.set(cacheKey, { missAt: deps.now(), failedAt: prev?.failedAt ?? 0 })
}

function markFailed(cacheKey: string): void {
  const prev = entryStates.get(cacheKey)
  entryStates.set(cacheKey, { missAt: prev?.missAt ?? 0, failedAt: deps.now() })
}

function clearState(cacheKey: string): void {
  entryStates.delete(cacheKey)
}

/**
 * 网络取图 + 校验 + 原子落盘。所有失败都收敛为结构化结果并记账（负缓存/冷却），不抛错。
 * 请求标识按主机策略选取：`versioned-ua` → `MeowStarMap/<版本>`（#20 条款 2）。
 */
async function fetchAndStore(
  resolved: ResolvedReferenceImage,
  dir: string,
  file: string
): Promise<ReferenceImageResolveResult> {
  const { cacheKey, fetchUrl } = resolved
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`请求超时`)), config.fetchTimeoutMs)
  try {
    const res = await deps.fetcher(fetchUrl, {
      signal: controller.signal,
      // 禁跟随重定向：CDN 若 302 到别的主机，等于绕过按主机授权核实
      redirect: 'error',
      headers: {
        'User-Agent': `MeowStarMap/${deps.getAppVersion()}`,
        Accept: 'image/*'
      }
    })

    // 404/403/410 = 资源不存在或不允许取用 → 负缓存，避免每次展示都打网络
    if (res.status === 404 || res.status === 403 || res.status === 410) {
      markMiss(cacheKey)
      logger.debug(`[RefImage] 资源不存在（HTTP ${res.status}）key=${shortKey(resolved)}`)
      return { path: null, status: 'not-found' }
    }
    if (!res.ok) {
      markFailed(cacheKey)
      logger.warn(`[RefImage] 取图失败（HTTP ${res.status}）key=${shortKey(resolved)}`)
      return { path: null, status: 'error' }
    }

    const declaredLength = Number(res.headers.get('content-length') ?? NaN)
    if (Number.isFinite(declaredLength) && declaredLength > config.maxBytes) {
      markFailed(cacheKey)
      logger.warn(`[RefImage] 响应体超过上限（${declaredLength}B）key=${shortKey(resolved)}`)
      return { path: null, status: 'error' }
    }

    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0 || bytes.length > config.maxBytes) {
      markFailed(cacheKey)
      logger.warn(`[RefImage] 响应体异常（${bytes.length}B）key=${shortKey(resolved)}`)
      return { path: null, status: 'error' }
    }
    // 校验失败：门户/代理把错误页当 200 返回时，落盘会让裂图固化 7 天
    if (!looksLikeImage(bytes)) {
      markFailed(cacheKey)
      logger.warn(`[RefImage] 响应体不是图片（魔数校验失败）key=${shortKey(resolved)}`)
      return { path: null, status: 'error' }
    }

    await fsp.mkdir(dir, { recursive: true })
    await writeFileAtomic(file, (tmpPath) => fsp.writeFile(tmpPath, bytes))
    clearState(cacheKey)
    logger.debug(`[RefImage] 已缓存 key=${shortKey(resolved)} bytes=${bytes.length}`)
    return { path: file, status: 'fetched' }
  } catch (err) {
    markFailed(cacheKey)
    logger.warn(`[RefImage] 取图异常（降级占位）key=${shortKey(resolved)}：${describeError(err)}`)
    return { path: null, status: 'error' }
  } finally {
    clearTimeout(timer)
  }
}
