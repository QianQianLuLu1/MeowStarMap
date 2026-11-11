// @core-change: 图片类别去除类型强转，改用 shared 守卫做 fail-closed 校验

/**
 * 外部参考数据管道：manifest 检查 → 下载（完整性校验）→ aes-gcm-filebox 解密 →
 * protobuf 解码 → 内存查询面（世界地图瓦片 / 图片 CDN 地址模板）。
 *
 * 数据契约实采自上游 RanAxro/nikki_albums main @ dc1b30b（MIT，授权见总计划 §2）：
 * - manifest：`<manifestBaseUrl>/app_api/hot_update.json`，包数组 `{id, versionId, files[{path, downloadLink, sha256?}]}`
 * - 版本机制：包目录内 versionId 空标记文件（存在即视为该版本已就绪，跳过下载），staging 目录
 *   原子提交（对齐上游 hot_update_service.dart 的 `_commitUpdate`）
 * - 完整性：manifest 提供 sha256 时校验（不符重下一次）；缺失时（线上现状）由解密侧
 *   GCM 认证兜底——v1.db 篡改一字节必然解密失败
 * - 下载主机 file-nikki.ranaxro.com；UA `MeowStarMap/<版本>`（#20 条款 2）
 *
 * 设计约束（总计划 §5.1）：全链 fail-soft——查询永不抛错（不可用返回空数组）、
 * 检查永不 reject（失败记 lastError 降级用旧缓存）；失败冷却防高频重试（#20 条款 4）；
 * 缓存损坏自愈（删包重下）。manifest 镜像经设置键 `referenceData.manifestBaseUrl`
 * 覆盖（由调用方从设置表读出后传入）。
 *
 * 与 cloth-data-service 同款测试注入约定：setReferenceDataDeps / setReferenceDataConfig /
 * disposeReferenceDataService；错误不经 AppError（诊断经 lastError + 日志，渲染层无弹窗）。
 */

import fsp from 'fs/promises'
import fs from 'fs'
import path from 'path'
import { createHash } from 'node:crypto'
import { logger } from '../utils/logger'
import { assertSafeRemoteUrl, RemoteUrlGuardError } from '../utils/remote-url-guard'
import { writeFileAtomic } from '../utils/atomic-file'
import { decryptFilebox } from './reference-data/filebox-cipher'
import {
  decodeNuan5Config,
  NETWORK_IMAGE_KINDS,
  type DecodedNuan5Config
} from './reference-data/nuan5-config-proto'
import { isNetworkImageTemplateKind } from '../../shared/network-image-kinds'
import type {
  NetworkImageTemplateInfo,
  ReferenceDataPackageStatus,
  ReferenceDataStatus,
  WorldMapTileInfo
} from '../../shared/types/electron-api'

// ============================================================
// 配置（默认对齐 cloth-data 量级；测试可注入覆盖）
// ============================================================

const DEFAULT_REFERENCE_DATA_CONFIG = {
  /** manifest 请求超时（JSON 小体量） */
  manifestTimeoutMs: 8000,
  /** 单文件下载超时（v1.db 数 MB 量级） */
  fileTimeoutMs: 60000,
  /** manifest 响应体上限 */
  manifestMaxBytes: 1_000_000,
  /** 单文件上限（v1.db / .bin 均远小于此值；防异常响应撑爆内存） */
  fileMaxBytes: 20_000_000,
  /** 失败冷却（force 手动刷新绕过；#20 条款 4 禁高频） */
  retryCooldownMs: 5 * 60_000,
  /** 校验不符重下载之间的退避 */
  retryBackoffMs: 1000,
  /** 上游官方站点（镜像入口 referenceData.manifestBaseUrl 为空时使用） */
  defaultManifestBaseUrl: 'https://nikki.ranaxro.com',
  /** manifest 站内路径 */
  manifestPath: '/app_api/hot_update.json'
} as const

type ReferenceDataConfig = typeof DEFAULT_REFERENCE_DATA_CONFIG

let config: ReferenceDataConfig = { ...DEFAULT_REFERENCE_DATA_CONFIG }

// ============================================================
// 依赖注入（测试用；生产经 electron 惰性 require 取默认值）
// ============================================================

export interface ReferenceDataDeps {
  fetcher: typeof fetch
  getUserDataDir: () => string
  getAppVersion: () => string
  now: () => number
}

const DEFAULT_DEPS: ReferenceDataDeps = {
  fetcher: (...args) => globalThis.fetch(...args),
  getUserDataDir: () => {
    // 运行时惰性 require（测试环境无 electron，注入 userDataDir 后不会走到这里）
    const electron = require('electron') as { app?: { getPath?: (name: string) => string } }
    return electron.app?.getPath?.('userData') ?? ''
  },
  getAppVersion: () => {
    const electron = require('electron') as { app?: { getVersion?: () => string } }
    return electron.app?.getVersion?.() ?? '0.0.0'
  },
  now: () => Date.now()
}

let deps: ReferenceDataDeps = { ...DEFAULT_DEPS }

/** 注入依赖覆盖（null 恢复默认）；测试用，生产代码不调用 */
export function setReferenceDataDeps(overrides: Partial<ReferenceDataDeps> | null): void {
  deps = overrides ? { ...DEFAULT_DEPS, ...overrides } : { ...DEFAULT_DEPS }
}

/** 注入配置覆盖（null 恢复默认）；测试用，生产代码不调用 */
export function setReferenceDataConfig(overrides: Partial<ReferenceDataConfig> | null): void {
  config = overrides
    ? { ...DEFAULT_REFERENCE_DATA_CONFIG, ...overrides }
    : { ...DEFAULT_REFERENCE_DATA_CONFIG }
}

// ============================================================
// 内部错误与 manifest 类型
// ============================================================

class ReferenceDataHttpError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`)
    this.name = 'ReferenceDataHttpError'
  }
}

/** manifest 结构 / 响应形态类失败（内部控制流用） */
class ReferenceDataProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReferenceDataProtocolError'
  }
}

class ReferenceDataChecksumError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReferenceDataChecksumError'
  }
}

interface ManifestFile {
  path: string
  downloadLink: string
  sha256: string | null
}

interface ManifestPackage {
  id: string
  versionId: string
  files: ManifestFile[]
}

/** v1.db 包的固定 id 与数据文件名（上游 manifest 约定） */
const NUAN5_DATABASE_PACKAGE_ID = 'nuan5_database'
const NUAN5_DATABASE_FILE_PATH = 'v1.db'
/** versionId 标记文件名形态：上游为 GUID */
const VERSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ============================================================
// 模块级状态（测试经 disposeReferenceDataService 重置）
// ============================================================

interface ReferenceDataIndex {
  worldTiles: WorldMapTileInfo[]
  imageTemplates: NetworkImageTemplateInfo[]
}

let index: ReferenceDataIndex | null = null
/** 内存索引是否已从磁盘加载过（查询面懒加载一次） */
let indexLoaded = false
/** 包 id → 已安装 versionId（真相源为包目录内标记文件，此处为内存快照） */
const installedVersions = new Map<string, string | null>()
let lastCheckedAt: string | null = null
let lastError: string | null = null
let updating = false
/** 最近一次失败时间（冷却判定） */
let lastFailedAt = 0
/** 更新串行链（对齐上游 `_updateTail`：并发调用排队执行） */
let updateTail: Promise<ReferenceDataStatus> = Promise.resolve(buildStatus())

// ============================================================
// 路径布局（<userData>/reference-data/…）
// ============================================================

function rootDir(): string {
  const base = deps.getUserDataDir()
  if (!base) {
    // userData 不可得（正常只发生在 electron 缺失的非主进程环境）：拒绝写出相对路径，
    // 防止缓存数据落到进程 CWD；调用方各自的容错（检查 catch / 查询空态）按降级处理
    throw new ReferenceDataProtocolError(`userData 目录不可用，参考数据缓存已停用`)
  }
  return path.join(base, 'reference-data')
}

function packagesDir(): string {
  return path.join(rootDir(), 'packages')
}

function packageDir(id: string): string {
  return path.join(packagesDir(), id)
}

function metaPath(): string {
  return path.join(rootDir(), 'meta.json')
}

function nuan5DbPath(): string {
  return path.join(packageDir(NUAN5_DATABASE_PACKAGE_ID), NUAN5_DATABASE_FILE_PATH)
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target)
    return true
  } catch {
    return false
  }
}

async function removeQuietly(target: string): Promise<void> {
  try {
    await fsp.rm(target, { recursive: true, force: true })
  } catch (err) {
    logger.warn(`[ReferenceData] 清理失败（忽略）：${describeError(err)}`)
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ============================================================
// 对外 API
// ============================================================

/** 管道整体状态（同步快照；磁盘状态与索引在首次调用时懒加载，available 如实反映查询面就绪） */
export function getStatus(): ReferenceDataStatus {
  ensureIndexLoadedSync()
  return buildStatus()
}

/**
 * 版本检查 + 按需更新（永不 reject；失败降级旧缓存并记 lastError）。
 *
 * @param opts.force true = 手动刷新，绕过失败冷却；false = 冷却期内直接跳过
 * @param opts.manifestBaseUrl 镜像站点（设置键 referenceData.manifestBaseUrl 读出后传入；
 *   空/未传 = 上游官方站点）。仅协议与危险地址段受守卫约束，不设 host 白名单（镜像任意公网域）。
 */
export function checkForUpdate(opts?: {
  force?: boolean
  manifestBaseUrl?: string
}): Promise<ReferenceDataStatus> {
  // 串行链：前一次完成（无论成败）后才发起下一次，防并发下载写同一包目录
  const next = updateTail.catch(() => undefined).then(() => updateOnce(opts ?? {}))
  updateTail = next
  return next
}

/** 世界地图瓦片与坐标换算参数（不可用时返回空数组，不抛错） */
export function getWorldMapTiles(): WorldMapTileInfo[] {
  ensureIndexLoadedSync()
  return index ? [...index.worldTiles] : []
}

/** 各类图片 CDN 地址模板（不可用时返回空数组，不抛错） */
export function getNetworkImageTemplates(): NetworkImageTemplateInfo[] {
  ensureIndexLoadedSync()
  return index ? [...index.imageTemplates] : []
}

/** 清空内存状态并恢复默认配置/注入；应用退出与测试重置用 */
export function disposeReferenceDataService(): void {
  index = null
  indexLoaded = false
  installedVersions.clear()
  lastCheckedAt = null
  lastError = null
  updating = false
  lastFailedAt = 0
  updateTail = Promise.resolve(buildStatus())
  deps = { ...DEFAULT_DEPS }
  config = { ...DEFAULT_REFERENCE_DATA_CONFIG }
}

// ============================================================
// 状态构建
// ============================================================

function buildStatus(): ReferenceDataStatus {
  const packages: ReferenceDataPackageStatus[] = [...installedVersions.entries()].map(
    ([id, versionId]) => ({ id, versionId })
  )
  return {
    available: index !== null,
    packages,
    lastCheckedAt,
    lastError,
    updating
  }
}

/**
 * 懒加载磁盘状态：扫描包目录标记文件 → installedVersions；meta.json → 诊断信息。
 * 全部容错（目录不存在/JSON 损坏均视为空态重建）。
 */
function ensureDiskStateSync(): void {
  if (indexLoaded) return
  indexLoaded = true

  try {
    if (fs.existsSync(packagesDir())) {
      for (const entry of fs.readdirSync(packagesDir(), { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const marker = fs
          .readdirSync(path.join(packagesDir(), entry.name))
          .find((name) => VERSION_ID_PATTERN.test(name))
        installedVersions.set(entry.name, marker ?? null)
      }
    }
  } catch (err) {
    logger.warn(`[ReferenceData] 包目录扫描失败（视为空态）：${describeError(err)}`)
  }

  try {
    if (fs.existsSync(metaPath())) {
      const raw = JSON.parse(fs.readFileSync(metaPath(), 'utf-8')) as {
        lastCheckedAt?: unknown
        lastError?: unknown
      }
      if (typeof raw.lastCheckedAt === 'string') lastCheckedAt = raw.lastCheckedAt
      if (typeof raw.lastError === 'string') lastError = raw.lastError
    }
  } catch {
    // meta.json 损坏：仅诊断信息，重建即可（版本真相源在标记文件，不受影响）
    logger.warn(`[ReferenceData] meta.json 损坏，忽略并将在下次检查后重建`)
  }
}

/** 查询面前置：内存索引尚未建立时同步从磁盘加载（一次性，几 MB 文件毫秒级） */
function ensureIndexLoadedSync(): void {
  ensureDiskStateSync()
  if (index) return
  loadIndexFromDiskSync()
}

/**
 * 从磁盘密文重建内存索引。
 * 失败（损坏/结构不识别）时自愈：删包（含版本标记）→ 下次检查重新下载；
 * 已加载的旧索引保留继续服务（fail-soft），无旧索引则查询面保持空态。
 */
function loadIndexFromDiskSync(): boolean {
  const versionId = installedVersions.get(NUAN5_DATABASE_PACKAGE_ID)
  if (!versionId) return false
  try {
    index = buildIndex(decryptAndDecode(fs.readFileSync(nuan5DbPath())))
    return true
  } catch (err) {
    installedVersions.set(NUAN5_DATABASE_PACKAGE_ID, null)
    lastError = `[cache] ${describeError(err)}`
    logger.warn(`[ReferenceData] 本地 v1.db 损坏（${describeError(err)}），删除缓存待重下`)
    void removeQuietly(packageDir(NUAN5_DATABASE_PACKAGE_ID))
    return false
  }
}

// ============================================================
// 更新主流程（串行链内执行）
// ============================================================

async function updateOnce(opts: {
  force?: boolean
  manifestBaseUrl?: string
}): Promise<ReferenceDataStatus> {
  ensureDiskStateSync()

  if (!opts.force && deps.now() - lastFailedAt < config.retryCooldownMs) {
    logger.debug(`[ReferenceData] 失败冷却期内，跳过检查`)
    return buildStatus()
  }

  // 注意：updating 必须在 buildStatus() 之前复位——finally 先于返回值使用而执行，
  // 若在 finally 中复位会让返回的状态恒为 updating:true
  updating = true
  try {
    await runUpdate(opts)
  } catch (err) {
    // 失败簿记集中在此；串行链要求本函数永不 reject
    lastFailedAt = deps.now()
    lastCheckedAt = new Date(deps.now()).toISOString()
    lastError = describeError(err)
    logger.warn(`[ReferenceData] 更新失败，沿用本地缓存（降级）：${lastError}`)
    await writeMeta()
  } finally {
    updating = false
  }
  return buildStatus()
}

/** 更新主体（可抛错；簿记由 updateOnce 的 catch 统一收口） */
async function runUpdate(opts: { force?: boolean; manifestBaseUrl?: string }): Promise<void> {
  const manifestBaseUrl = (opts.manifestBaseUrl ?? '').trim() || config.defaultManifestBaseUrl
  const packages = await fetchManifest(manifestBaseUrl)

  let nuan5Changed = false
  for (const pkg of packages) {
    if (installedVersions.get(pkg.id) === pkg.versionId) continue // 命中缓存：标记文件存在即版本就绪
    await installPackage(pkg)
    installedVersions.set(pkg.id, pkg.versionId)
    if (pkg.id === NUAN5_DATABASE_PACKAGE_ID) nuan5Changed = true
  }

  // 索引就绪：nuan5_database 变更后重建；存在已装版本但索引未加载时兜底加载。
  // 加载失败（数据损坏）→ loadIndexFromDiskSync 已删包自愈并记 lastError
  if ((nuan5Changed || !index) && installedVersions.get(NUAN5_DATABASE_PACKAGE_ID)) {
    if (!loadIndexFromDiskSync()) {
      throw new ReferenceDataProtocolError(lastError ?? `v1.db 加载失败`)
    }
  }

  lastError = null
  lastCheckedAt = new Date(deps.now()).toISOString()
  await writeMeta()
  logger.debug(`[ReferenceData] 检查完成：${packages.length} 包`)
}

/** 诊断信息落盘（版本真相源在标记文件，这里只存 lastCheckedAt/lastError） */
async function writeMeta(): Promise<void> {
  try {
    await fsp.mkdir(rootDir(), { recursive: true })
    await writeFileAtomic(metaPath(), async (tmpPath) => {
      await fsp.writeFile(tmpPath, JSON.stringify({ lastCheckedAt, lastError }, null, 2), 'utf-8')
    })
  } catch (err) {
    logger.warn(`[ReferenceData] meta.json 写入失败（忽略）：${describeError(err)}`)
  }
}

// ============================================================
// manifest 获取与校验
// ============================================================

async function fetchManifest(manifestBaseUrl: string): Promise<ManifestPackage[]> {
  const url = `${manifestBaseUrl.replace(/\/+$/, '')}${config.manifestPath}`
  try {
    const body = await fetchBytes(url, config.manifestTimeoutMs, config.manifestMaxBytes)
    const parsed: unknown = JSON.parse(body.toString('utf-8'))
    return parseManifest(parsed)
  } catch (err) {
    if (err instanceof ReferenceDataProtocolError || err instanceof RemoteUrlGuardError) throw err
    throw new ReferenceDataProtocolError(`manifest 获取失败：${describeError(err)}`)
  }
}

/**
 * manifest → 包列表（结构校验对齐上游 `_validatePathSegment` / `_validateRelativePath` /
 * `_validateSha256`；路径逃逸与重复 path 一律拒绝）。
 */
function parseManifest(raw: unknown): ManifestPackage[] {
  if (!Array.isArray(raw)) {
    throw new ReferenceDataProtocolError(`manifest 顶层不是数组`)
  }
  const result: ManifestPackage[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      throw new ReferenceDataProtocolError(`manifest 包条目不是对象`)
    }
    const record = item as Record<string, unknown>
    const id = validatePathSegment(record.id, `包 id`)
    const versionId = validatePathSegment(record.versionId, 'versionId')
    if (!Array.isArray(record.files)) {
      throw new ReferenceDataProtocolError(`包 ${id} 的 files 不是数组`)
    }

    const files: ManifestFile[] = []
    const seenPaths = new Set<string>()
    for (const fileItem of record.files) {
      if (typeof fileItem !== 'object' || fileItem === null) {
        throw new ReferenceDataProtocolError(`包 ${id} 的文件条目不是对象`)
      }
      const fileRecord = fileItem as Record<string, unknown>
      const filePath = validateRelativePath(fileRecord.path)
      const pathKey = filePath.toLowerCase()
      if (seenPaths.has(pathKey)) {
        throw new ReferenceDataProtocolError(`包 ${id} 存在重复文件路径：${filePath}`)
      }
      seenPaths.add(pathKey)
      const downloadLink =
        typeof fileRecord.downloadLink === 'string' ? fileRecord.downloadLink : ''
      if (!downloadLink) {
        throw new ReferenceDataProtocolError(`包 ${id} 文件 ${filePath} 缺少 downloadLink`)
      }
      assertSafeRemoteUrl(downloadLink)
      files.push({ path: filePath, downloadLink, sha256: validateSha256(fileRecord.sha256) })
    }
    result.push({ id, versionId, files })
  }
  return result
}

/** 单路径段校验（包 id / versionId：非空、非 '.'/'..'、不含路径分隔符） */
function validatePathSegment(value: unknown, fieldName: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw new ReferenceDataProtocolError(`manifest ${fieldName} 非法：${String(value)}`)
  }
  return value
}

/**
 * 包内相对路径校验：posix 语义归一，拒绝绝对路径、'..' 逃逸与反斜杠
 * （manifest 数据不可信，防下载内容写出包目录）。
 */
function validateRelativePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new ReferenceDataProtocolError(`manifest 文件 path 非法：${String(value)}`)
  }
  if (value.includes('\\')) {
    throw new ReferenceDataProtocolError(`manifest 文件 path 含反斜杠：${value}`)
  }
  const normalized = path.posix.normalize(value)
  const parts = normalized.split('/')
  if (normalized.startsWith('/') || parts.includes('..') || parts[0] === '') {
    throw new ReferenceDataProtocolError(`manifest 文件 path 逃逸包目录：${value}`)
  }
  return normalized
}

/** sha256 可选字段：空缺为 null；给出则必须为 64 位 hex（对齐上游 `_validateSha256`） */
function validateSha256(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new ReferenceDataProtocolError(`manifest sha256 类型非法：${String(value)}`)
  }
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0) return null
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new ReferenceDataProtocolError(`manifest sha256 非法：${value}`)
  }
  return normalized
}

// ============================================================
// 下载与原子提交（staging 目录 → 标记文件 → rename，对齐上游 `_downloadUpdate`/`_commitUpdate`）
// ============================================================

async function installPackage(pkg: ManifestPackage): Promise<void> {
  await fsp.mkdir(packagesDir(), { recursive: true })
  const staging = await fsp.mkdtemp(path.join(packagesDir(), `.${pkg.id}.staging-`))
  let committed = false
  try {
    for (const file of pkg.files) {
      const target = path.join(staging, file.path)
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await downloadFileWithRetry(file, target)
    }
    // 版本标记随 staging 一起提交：标记存在 = 该版本文件齐全
    await fsp.writeFile(path.join(staging, pkg.versionId), '', 'utf-8')
    await commitPackage(staging, pkg.id)
    committed = true
  } finally {
    if (!committed) {
      await removeQuietly(staging)
    }
  }
}

/** 原子提交：旧目录先改名 backup，staging rename 就位后删除 backup；回滚失败如实上抛 */
async function commitPackage(staging: string, id: string): Promise<void> {
  const finalDir = packageDir(id)
  if (!(await pathExists(finalDir))) {
    await fsp.rename(staging, finalDir)
    return
  }
  const backup = path.join(
    packagesDir(),
    `.${id}.backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  )
  await fsp.rename(finalDir, backup)
  try {
    await fsp.rename(staging, finalDir)
  } catch (err) {
    try {
      await fsp.rename(backup, finalDir)
      logger.warn(`[ReferenceData] 包 ${id} 提交失败已回滚旧版本：${describeError(err)}`)
    } catch (rollbackErr) {
      logger.error(`[ReferenceData] 包 ${id} 回滚也失败：${describeError(rollbackErr)}`)
    }
    throw err
  }
  await removeQuietly(backup)
}

/** 单文件下载 + sha256 校验（字段存在时；不符重下一次，对齐总计划 §8.3） */
async function downloadFileWithRetry(file: ManifestFile, savePath: string): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const bytes = await fetchBytes(file.downloadLink, config.fileTimeoutMs, config.fileMaxBytes)
      if (file.sha256) {
        const actual = createHash('sha256').update(bytes).digest('hex')
        if (actual !== file.sha256) {
          throw new ReferenceDataChecksumError(
            `完整性校验失败（sha256 不符）：期望 ${file.sha256}，实际 ${actual}`
          )
        }
      }
      await fsp.writeFile(savePath, bytes)
      return
    } catch (err) {
      await removeQuietly(savePath)
      // 仅校验不符自动重下一次；其余失败（网络/HTTP/协议）交由下次检查重试
      if (attempt >= 2 || !(err instanceof ReferenceDataChecksumError)) throw err
      if (config.retryBackoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, config.retryBackoffMs))
      }
    }
  }
}

// ============================================================
// 字节获取与解密解码
// ============================================================

async function fetchBytes(url: string, timeoutMs: number, maxBytes: number): Promise<Buffer> {
  assertSafeRemoteUrl(url)
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new ReferenceDataProtocolError(`请求超时`)),
    timeoutMs
  )
  try {
    const res = await deps.fetcher(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { 'User-Agent': `MeowStarMap/${deps.getAppVersion()}` }
    })
    if (!res.ok) throw new ReferenceDataHttpError(res.status)
    const declaredLength = Number(res.headers.get('content-length') ?? NaN)
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new ReferenceDataProtocolError(`响应体超过大小上限（${declaredLength}B）`)
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length > maxBytes) {
      throw new ReferenceDataProtocolError(`响应体超过大小上限（${bytes.length}B）`)
    }
    return bytes
  } finally {
    clearTimeout(timer)
  }
}

/** v1.db 密文 → 明文 → Nuan5Config（两步失败语义不同：解密=损坏，解码=结构不识别） */
function decryptAndDecode(ciphertext: Buffer): DecodedNuan5Config {
  let plaintext: Buffer
  try {
    plaintext = decryptFilebox(ciphertext)
  } catch (err) {
    throw new ReferenceDataProtocolError(`v1.db 解密失败（${describeError(err)}）`)
  }
  try {
    return decodeNuan5Config(plaintext)
  } catch (err) {
    throw new ReferenceDataProtocolError(`v1.db 解码失败（结构不识别）：${describeError(err)}`)
  }
}

// ============================================================
// 内存索引
// ============================================================

function buildIndex(decoded: DecodedNuan5Config): ReferenceDataIndex {
  const worldTiles: WorldMapTileInfo[] = []
  for (const [key, world] of Object.entries(decoded.world ?? {})) {
    const tile = world?.mapTileInfo
    if (!tile) continue
    const worldId = Number(key)
    // 防御：键非法或参数残缺的条目跳过（单条损坏不拖垮整表）
    if (!Number.isSafeInteger(worldId) || worldId <= 0) continue
    if (typeof tile.urlTemplate !== 'string' || tile.urlTemplate.length === 0) continue
    worldTiles.push({
      worldId,
      urlTemplate: tile.urlTemplate,
      minZoom: tile.minZoom,
      maxZoom: tile.maxZoom,
      mapWidthOfMaxZoom: tile.mapWidthOfMaxZoom,
      mapHeightOfMaxZoom: tile.mapHeightOfMaxZoom,
      originalPointX: tile.originalPointX,
      originalPointY: tile.originalPointY,
      pxPreUnit: tile.pxPreUnit
    })
  }

  const imageTemplates: NetworkImageTemplateInfo[] = []
  for (const kind of NETWORK_IMAGE_KINDS) {
    // 外部解码结果不可信：类别须精确命中单一真相源，未登记值 fail-closed 跳过
    if (!isNetworkImageTemplateKind(kind)) continue
    const item = decoded.networkImage?.[kind]
    if (!item || typeof item.baseUrl !== 'string' || item.baseUrl.length === 0) continue
    imageTemplates.push({
      kind,
      baseUrl: item.baseUrl,
      replace: typeof item.replace === 'string' ? item.replace : ''
    })
  }

  return { worldTiles, imageTemplates }
}
