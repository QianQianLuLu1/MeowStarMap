/**
 * 内嵌 NikkiSync Runtime 的装载 + 组装 + 只读查询门面（整合阶段 2）。
 *
 * 三条硬边界：
 * 1. **只用上游**：Runtime 由 `@nikkisync/pc-companion` 的 `PcCompanionRuntime` 构造，
 *    扫描交给 `runtime.scanner`（内含 ScanCoordinator / ScanReconciler / AssetResolver），
 *    建表交给 `DatabaseManager.initialize()`，查询交给 `SyncReadRepository`，
 *    局域网服务交给上游已经组装好的 `runtime.server`（本仓不实现任何 HTTP/TLS/WS/mDNS）。
 *    本文件不解析目录、不算哈希、不定义数据模型；唯一的 SQL 是 `PAIRED_DEVICES_SQL`
 *    这一条**只读** SELECT（上游缺 list API 的权宜，撤销仍走上游 `revoke()`）。
 * 2. **不做数据格式转换**：对外响应体逐字取自上游 `server/row-mappers.js`
 *    （`mapAssetSummary` / `mapAssetDetail` / `mapResourceRow`）与 `GET /v1/assets`
 *    的分页语义（`limit + 1` 前瞻 + base64url `{t,id}` 游标），保证与协议 DTO 一致；
 *    设备列表属管理视图（非协议 DTO），由 `sync-server-view.mapPairedDeviceRow` 收敛。
 * 3. **装载只能变量式动态 import**：上游 ESM 图含 top-level await，静态值导入会被
 *    打包器折叠成 `require()` 并在运行时抛 `ERR_REQUIRE_ASYNC_MODULE`；深入口
 *    （`server/row-mappers.js`）不在上游桶导出内，且 `@nikkisync/{core,database,protocol}`
 *    的 `exports` 只暴露 `"."` ⇒ 必须用 `resolveDeepEntryUrl` 给出的 `file://` URL。
 */

import { mkdirSync } from 'node:fs'
import path from 'node:path'

import {
  buildPackagingContext,
  resolveDeepEntryUrl,
  resolveModuleRoot,
  type PackagingContext
} from './embedding-paths'
import {
  NIKKISYNC_PACKAGES,
  hasNikkiSyncLink,
  loadNikkiSyncPackage,
  nikkisyncExport,
  type NikkiSyncModule
} from './runtime-loader'
import {
  defaultStopTimeoutMs,
  runWithTimeout,
  type RuntimeManagerDependencies
} from './runtime-manager'
import { embeddedServerConfig, mapPairedDeviceRow } from './sync-server-view'
import type {
  EmbeddedRuntimeLike,
  NikkiSyncPairedDeviceView,
  NikkiSyncRuntimeSession,
  NikkiSyncSessionOptions
} from './runtime-types'

/** 本阶段用到的上游行查询面（`packages/database/src/sync-read-repository.ts`）。 */
interface SyncReadRepositoryLike {
  currentRevision(): number
  listAssets(query: Record<string, unknown>): Record<string, unknown>[]
  getAsset(assetId: string): Record<string, unknown> | undefined
  listResources(assetId: string): Record<string, unknown>[]
  getResource(assetId: string, resourceId: string): Record<string, unknown> | undefined
}

/** 上游 `server/row-mappers.js` 的导出面（协议 DTO 映射，本文件零改写）。 */
interface RowMapperSurface {
  mapAssetSummary(row: Record<string, unknown>, resources: Record<string, unknown>[]): unknown
  mapAssetDetail(row: Record<string, unknown>, resources: Record<string, unknown>[]): unknown
  mapResourceRow(row: Record<string, unknown>): unknown
}

/**
 * 上游 `LocalTlsIdentityService` 的最小面（`server/LocalTlsIdentityService.ts:117-129`）。
 * 只有一个公开方法 `getOrCreate()`：身份存 `app_settings['server.tlsIdentity']`，
 * **不落盘、也没有路径可注入**——嵌入态因此不建 certs 目录（见计划 §4）。
 */
interface LocalTlsIdentityServiceLike {
  getOrCreate(): { keyPem: string; certPem: string; fingerprintSha256: string; createdAt: string }
}

/** 上游 `PairingRepository` 中被本阶段用到的最小面（注意：**没有 list 方法**）。 */
interface PairingRepositoryLike {
  getDevice(deviceId: string): Record<string, unknown> | undefined
  revoke(deviceId: string, revokedAt?: string): void
}

/** 已装载的运行时面。 */
export interface RuntimeSurface {
  pcCompanion: NikkiSyncModule
  database: NikkiSyncModule
  rowMappers: RowMapperSurface
}

/** `row-mappers.js` 的深入口相对路径（不在上游 `src/index.ts` 桶导出内）。 */
export const ROW_MAPPER_DEEP_ENTRY = ['server', 'row-mappers.js'] as const

/**
 * 已配对设备清单的**只读** SELECT。
 *
 * 为什么必须有这条 SQL：上游 `PairingRepository`
 * （`packages/database/src/pairing-repository.ts`）只提供 `getDevice` /
 * `countActiveDevices` / `pairDevice` / `revoke`，**没有任何 list 方法**
 * （全仓 grep 无 `listDevices`），而阶段 3 的验收要求 UI 能列出设备。
 * 因此这里沿用本仓既有先例（`readTableNames()` 读 `sqlite_master`）做只读查询；
 * 撤销仍走上游 `revoke()`，不写裸 UPDATE。上游若日后补 `listDevices`，改调它并删掉本常量。
 * 命中的是既有索引 `idx_paired_devices_active(revoked_at, last_seen_at DESC)`。
 */
export const PAIRED_DEVICES_SQL =
  'SELECT device_id, device_name, platform, app_version, paired_at, last_seen_at, revoked_at ' +
  'FROM paired_devices WHERE revoked_at IS NULL ' +
  'ORDER BY (last_seen_at IS NULL), last_seen_at DESC, paired_at DESC'

/** 分页游标（与上游 `LocalSyncServer` 的 `encodeCursor` 同格式）。 */
export interface PageCursorValue {
  t: string
  id: string
}

export function encodePageCursor(value: PageCursorValue): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/** 非法/缺省游标统一降级为 undefined（与上游 `decodeCursor` 行为一致）。 */
export function decodePageCursor(cursor?: string): PageCursorValue | undefined {
  if (!cursor) return undefined
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<
      Record<string, unknown>
    >
    if (typeof decoded.t === 'string' && typeof decoded.id === 'string') {
      return { t: decoded.t, id: decoded.id }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** 由 projectRoot / 打包态上下文推出装载所需的运行位置上下文。 */
export function packagingContextFor(
  projectRoot: string,
  context?: PackagingContext
): PackagingContext {
  return context ?? buildPackagingContext({ isPackaged: false, projectRoot })
}

/**
 * 装载运行时面：`pc-companion` + `database` + `server/row-mappers.js` 深入口。
 *
 * `core` / `protocol` 不在此装载：本阶段不直接调用它们（AssetResolver 由上游
 * ScanReconciler 内部使用，协议常量校验已由阶段 1 的 probe / drift 守护承担）。
 */
export async function loadRuntimeSurface(
  projectRoot: string,
  context?: PackagingContext
): Promise<RuntimeSurface> {
  const packaging = packagingContextFor(projectRoot, context)
  const pcCompanion = await loadNikkiSyncPackage('pcCompanion', packaging)
  const database = await loadNikkiSyncPackage('database', packaging)
  const root = resolveModuleRoot(NIKKISYNC_PACKAGES.pcCompanion, packaging)
  const deepEntry = resolveDeepEntryUrl(root.root, ROW_MAPPER_DEEP_ENTRY)
  // 变量式 import：URL 来自变量而非字面量，保持与 runtime-loader 同一护栏口径
  const rowMappers = (await import(/* @vite-ignore */ deepEntry)) as NikkiSyncModule
  return {
    pcCompanion,
    database,
    rowMappers: rowMappers as unknown as RowMapperSurface
  }
}

/** `sqlite_master` 中的表名（验收项「表结构完整」的事实来源，不维护副本清单）。 */
export function readTableNames(runtime: EmbeddedRuntimeLike): string[] {
  const rows = runtime.database.connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name?: unknown }>
  return rows.map((row) => String(row.name))
}

/** 由运行时面构造只读查询面（绑定到具体会话的库句柄）。 */
export function createQuerySurface(
  surface: RuntimeSurface,
  runtime: EmbeddedRuntimeLike
): NikkiSyncRuntimeSession['queries'] {
  const ReadRepoCtor = nikkisyncExport(surface.database, 'SyncReadRepository') as new (
    database: unknown
  ) => SyncReadRepositoryLike
  const repo = new ReadRepoCtor(runtime.database)
  const { mapAssetSummary, mapAssetDetail, mapResourceRow } = surface.rowMappers

  return {
    async listAssets(input) {
      const cursor = decodePageCursor(input.cursor)
      // 上游语义：多取一条判 hasMore，再裁回 limit
      const rows = repo.listAssets({
        limit: input.limit + 1,
        ...(cursor ? { cursorTime: cursor.t, cursorAssetId: cursor.id } : {}),
        ...(input.type ? { assetType: input.type } : {}),
        ...(input.afterRevision === undefined ? {} : { afterRevision: input.afterRevision }),
        includeDeleted: input.includeDeleted === true
      })
      const hasMore = rows.length > input.limit
      const pageRows = hasMore ? rows.slice(0, input.limit) : rows
      const items = pageRows.map((row) =>
        mapAssetSummary(row, repo.listResources(String(row.asset_id)))
      )
      const last = pageRows[pageRows.length - 1]
      const nextCursor =
        hasMore && last
          ? encodePageCursor({
              t: String(last.captured_at ?? last.discovered_at),
              id: String(last.asset_id)
            })
          : undefined
      return {
        items,
        ...(nextCursor ? { nextCursor } : {}),
        libraryRevision: repo.currentRevision()
      }
    },

    async getAssetDetail(assetId) {
      const row = repo.getAsset(assetId)
      if (!row) throw new Error(`NikkiSync asset not found: ${assetId}`)
      return mapAssetDetail(row, repo.listResources(assetId))
    },

    async getResource(assetId, resourceId, mode) {
      const row = repo.getResource(assetId, resourceId)
      if (!row) throw new Error(`NikkiSync resource not found: ${assetId}/${resourceId}`)
      // path 模式直接给上游落库的绝对路径原值，不包装、不改写
      if (mode === 'path') return String(row.source_path)
      return mapResourceRow(row)
    }
  }
}

/**
 * 装载 + 组装一个会话：上游 Runtime 构造期即建库并跑 migration，
 * 本函数返回的会话把 scanner、只读查询面与**上游同步服务器**交给上层编排。
 *
 * 阶段 3 的关键事实：`PcCompanionRuntime` 构造函数**已经**组装好一台带 TLS 的
 * `LocalSyncServer`（`runtime.ts:84-89`：未显式传 `tls` 时自动
 * `LocalTlsIdentityService.getOrCreate()`），本仓因此不新建任何服务对象，
 * 只做「构造期把 LAN 配置传进去」+「运行期按开关调 `start()/stop()`」。
 * 传 `mdns: true` 也**不会**在构造期组播——`mdns.start()` 只在 `server.start()` 内被调。
 */
export async function createRuntimeSession(
  options: NikkiSyncSessionOptions
): Promise<NikkiSyncRuntimeSession> {
  const surface = await loadRuntimeSurface(options.projectRoot, options.packagingContext)
  const RuntimeCtor = nikkisyncExport(surface.pcCompanion, 'PcCompanionRuntime') as new (
    config: Record<string, unknown>
  ) => EmbeddedRuntimeLike
  const syncServer = embeddedServerConfig(options.syncServer)
  const runtime = new RuntimeCtor({
    databaseFile: options.databaseFile,
    scanner: {
      ...(options.gameRoot ? { selectedInstallRoot: options.gameRoot } : {}),
      watcher: options.watcher
    },
    server: syncServer
  })
  const TlsCtor = nikkisyncExport(surface.pcCompanion, 'LocalTlsIdentityService') as new (
    database: unknown
  ) => LocalTlsIdentityServiceLike
  const tlsService = new TlsCtor(runtime.database)
  const PairingCtor = nikkisyncExport(surface.database, 'PairingRepository') as new (
    database: unknown
  ) => PairingRepositoryLike
  const pairing = new PairingCtor(runtime.database)

  return {
    runtime,
    scanner: runtime.scanner,
    queries: createQuerySurface(surface, runtime),
    tableNames: () => readTableNames(runtime),
    dispose: () => runtime.database.close(),
    server: runtime.server,
    tlsIdentity: () => {
      const identity = tlsService.getOrCreate()
      return { certPem: identity.certPem, fingerprintSha256: identity.fingerprintSha256 }
    },
    pairingUri: (host, ttlMs) =>
      typeof ttlMs === 'number'
        ? runtime.createPairingUri(host, ttlMs)
        : runtime.createPairingUri(host),
    listPairedDevices: () =>
      (runtime.database.connection.prepare(PAIRED_DEVICES_SQL).all() as unknown[])
        .map(mapPairedDeviceRow)
        .filter((device): device is NikkiSyncPairedDeviceView => device !== null),
    revokePairedDevice: (deviceId) => {
      const device = pairing.getDevice(deviceId)
      if (!device || device.revoked_at) return false
      // 上游 revoke() 是无条件 UPDATE，先验存在与未撤销才能给出可判定的 false
      pairing.revoke(deviceId)
      return true
    }
  }
}

/**
 * 生产依赖装配：把门面 + 文件系统 + 超时兜底接成状态机需要的依赖表。
 * `log` 由调用方注入（Electron 侧走 electronLogger，CLI 侧走 process.stdout），
 * `pairingHostResolver` 由装配层注入局域网地址（本模块不碰 `os`/`electron`，保持可单测）。
 */
export function createManagerDependencies(
  defaults: NikkiSyncSessionOptions,
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
  pairingHostResolver?: () => string
): RuntimeManagerDependencies {
  return {
    defaults,
    ...(pairingHostResolver ? { resolvePairingHost: pairingHostResolver } : {}),
    createSession: (options) => createRuntimeSession(options),
    isLinkReady: (projectRoot) => hasNikkiSyncLink(projectRoot),
    ensureDatabaseDirectory: (databaseFile) => {
      mkdirSync(path.dirname(databaseFile), { recursive: true })
    },
    log,
    withTimeout: (label, work) =>
      runWithTimeout(label, work, defaultStopTimeoutMs, (timedOut) =>
        log('warn', `${timedOut} timed out after ${defaultStopTimeoutMs}ms`)
      )
  }
}
