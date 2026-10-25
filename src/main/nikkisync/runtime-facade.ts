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

import { existsSync, mkdirSync } from 'node:fs'
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
import { registerNikkiSyncResourcePaths } from './resource-allowlist'
import { NUAN5_METADATA_ENDPOINT, buildMetadataResolverConfig } from './metadata-resolver-driver'
import type {
  EmbeddedRuntimeLike,
  NikkiSyncGameVersionView,
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
  /** 变更日志下界；日志表为空时上游返回 undefined。 */
  minimumJournalRevision(): number | undefined
  listChangesAfter(revision: number, limit: number): Record<string, unknown>[]
  /** 搜索/统计源：资产行与资源行（上游按 `asset_id` 分组前先摊平给出）。 */
  listSuitSearchAssets(): Record<string, unknown>[]
  listSuitSearchResources(): Record<string, unknown>[]
}

/** 上游 `server/row-mappers.js` 的导出面（协议 DTO 映射，本文件零改写）。 */
interface RowMapperSurface {
  mapAssetSummary(row: Record<string, unknown>, resources: Record<string, unknown>[]): unknown
  mapAssetDetail(row: Record<string, unknown>, resources: Record<string, unknown>[]): unknown
  mapResourceRow(row: Record<string, unknown>): unknown
  mapChangeRow(row: Record<string, unknown>): unknown
}

/** 上游 `MetadataDictionaryRepository` 中被搜索/统计用到的最小面（桶导出内）。 */
interface MetadataDictionaryRepositoryLike {
  getActiveManifest(): unknown
}

/**
 * 上游搜索索引的输入元素（`server/SuitSearchIndex.ts:9` 的 `SuitSearchAsset`）。
 * 本仓自声明形状，不 `import type` 上游包（AGENTS.md 硬性约定 1）。
 */
interface SuitSearchSourceItem {
  asset: unknown
  metadataJson?: string
}

/** 上游三个索引函数的最小面（各自是独立深入口，不在 pc-companion 桶导出内）。 */
interface SearchIndexSurface {
  searchSuitLibrary(assets: SuitSearchSourceItem[], manifest: unknown, query: string): unknown
}
interface ClothingIndexSurface {
  searchClothingLibrary(assets: SuitSearchSourceItem[], manifest: unknown, query: string): unknown
}
interface ProfileStatsIndexSurface {
  buildProfileStats(assets: SuitSearchSourceItem[], manifest: unknown, revision: number): unknown
}

/**
 * 上游 `metadata/Nuan5CompatibleResolver.ts:64` 的本仓最小面（阶段 6）。
 * 构造参数 `{endpoint?,id?,version?,timeoutMs?,minIntervalMs?}`；本仓**显式传 endpoint**
 * 而不吃默认值，以保证设置页的隐私披露文案与实际出口逐字同源。
 * 该模块运行时零上游依赖（只 `import type`），装载它不产生任何网络副作用。
 */
interface Nuan5ResolverSurface {
  Nuan5CompatibleResolver: new (config?: Record<string, unknown>) => unknown
}

/**
 * 上游 `metadata/MetadataResolutionDiagnostics.ts:3` 的本仓最小面。
 * 纯 SELECT 聚合计数（`withCompleteEnvelope/resolved/failed/withOutfit/withCamera/motionPhotos`
 * + 失败分类），上游注释即承诺「绝不序列化行、原始信封或错误原文」，因此可直接进状态快照。
 */
interface MetadataDiagnosticsSurface {
  metadataResolutionDiagnostics(database: unknown, resolverEnabled: boolean): unknown
}

/**
 * 上游 `metadata/CachedDecodedMetadataService.ts` 的本仓最小面（兼容层 b422193）。
 * 构造器仅存储引用（零副作用）；`runOnce()` 同步返回本次升级的 asset 计数。
 * K1 在启动后与手动扫描后各驱动一次，不接上游 `runtime.start()` 的自动阶段。
 */
interface CachedDecodedMetadataSurface {
  CachedDecodedMetadataService: new (
    database: unknown,
    dictionary?: unknown
  ) => { runOnce(): number }
}

/**
 * 上游 `server/LanAddress.ts` 的本仓最小面（兼容层 b422193）。两个纯函数；
 * 入参 `interfaces` 缺省时上游自取 `os.networkInterfaces()`（`listLanIpv4` 排序
 * 去重后截 8）。K5 消费（配对 host 解析 + `connectionHosts` 数据源）。
 */
interface LanAddressSurface {
  selectLanIpv4(interfaces?: unknown): string | undefined
  listLanIpv4(interfaces?: unknown): string[]
}

/**
 * 上游 `server/GameVersionCalendar.ts` 的本仓最小面（兼容层 b422193）。
 * 纯本地静态表推断（无出站）；远程刷新与 Steam 英文名拉取按 02 计划 §11/Q6 不做。
 * K3 消费。
 */
interface GameVersionCalendarSurface {
  inferInfinityNikkiGameVersion(
    capturedAt: string | undefined,
    releases?: unknown
  ): string | undefined
  getGameVersionReleases(): unknown[]
}

/**
 * 上游 `metadata/MetadataOnlineConsent.ts` 的本仓最小面（K2）。
 * 同意文件 JSON 由上游读写（0600、原子 rename）；`state()` 的 endpoint 已脱敏。
 */
interface MetadataOnlineConsentSurface {
  MetadataOnlineConsent: new (
    file: string,
    recipients: Array<{ name: string; endpoint: string; fields: string[] }>,
    initiallyDisabled?: boolean
  ) => import('./runtime-types').NikkiSyncMetadataConsent & {
    guard(resolver: unknown): unknown
  }
}

/**
 * 上游 `scanner/ExtraScanDirectories.ts` 的本仓最小面（K6）。
 * 构造器 `(file, scanner, onScopeChanged?)`；目录清单持久化在上游 0600 JSON。
 */
interface ExtraScanDirectoriesSurface {
  ExtraScanDirectories: new (
    file: string,
    scanner: unknown,
    onScopeChanged?: () => Promise<void>
  ) => import('./runtime-types').ExtraScanDirectoriesLike
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
  /** 阶段 4：搜索与统计各自是独立深入口。 */
  suitSearchIndex: SearchIndexSurface
  clothingSearchIndex: ClothingIndexSurface
  profileStatsIndex: ProfileStatsIndexSurface
  /** 阶段 6：元数据解析器与解析诊断，各自是独立深入口。 */
  nuan5Resolver: Nuan5ResolverSurface
  metadataDiagnostics: MetadataDiagnosticsSurface
  /** 兼容层（b422193）：K1/K3/K5 将消费的三个深入口（产物存在性由 verify:nikkisync 第 12 项承担）。 */
  cachedDecodedMetadataService: CachedDecodedMetadataSurface
  lanAddress: LanAddressSurface
  gameVersionCalendar: GameVersionCalendarSurface
  /**
   * K2：在线解析同意深入口。**可选**：老链接会话（predecessor 深入口缺席）上
   * 该字段可为 undefined，构造期据此走「不包装」分支——解析行为与 K2 之前完全一致。
   */
  metadataOnlineConsent?: MetadataOnlineConsentSurface
  /** K6：额外照片目录深入口（可选同上——老链接会话据此走「不挂面」分支）。 */
  extraScanDirectories?: ExtraScanDirectoriesSurface
}

/** `row-mappers.js` 的深入口相对路径（不在上游 `src/index.ts` 桶导出内）。 */
export const ROW_MAPPER_DEEP_ENTRY = ['server', 'row-mappers.js'] as const

/**
 * 阶段 4 的三个索引深入口。
 *
 * 为什么必须逐个数：`searchSuitLibrary` / `searchClothingLibrary` / `buildProfileStats`
 * 都**不在** `server/index.ts` 桶导出内（同 `row-mappers.js` 的处境，见 §装载注释第 3 条），
 * 且上游包 `exports` 只暴露 `"."` ⇒ 只能以 `resolveDeepEntryUrl` 组出的 `file://` URL 装载。
 * 三者各自独立成模块，因此是三条入口而非一条。
 */
export const SUIT_SEARCH_DEEP_ENTRY = ['server', 'SuitSearchIndex.js'] as const
export const CLOTHING_SEARCH_DEEP_ENTRY = ['server', 'ClothingSearchIndex.js'] as const
export const PROFILE_STATS_DEEP_ENTRY = ['server', 'ProfileStatsIndex.js'] as const

/**
 * 阶段 6 的两个元数据解析深入口。
 *
 * 上游 `dist/src/index.js` 的桶只 re-export `metadata/MetadataResolverPipeline.js` 与
 * `metadata/types.js`（已实测），`Nuan5CompatibleResolver` 与
 * `metadataResolutionDiagnostics` 都在桶外 ⇒ 与 `server/*` 三入口同类处境。
 *
 * 为什么不把它们加进 `NIKKISYNC_REQUIRED_EXPORTS`：那张表由 `probe.ts` 拿去在**桶导出**上
 * 做存在性判定，桶里没有的符号写进去只会在正确的构建产物上误报红。产物存在性改由
 * `scripts/verify-nikkisync-link.ts` 的深入口清单承担（见该文件 REQUIRED_METADATA_ARTIFACTS）。
 */
export const NUAN5_RESOLVER_DEEP_ENTRY = ['metadata', 'Nuan5CompatibleResolver.js'] as const
export const METADATA_DIAGNOSTICS_DEEP_ENTRY = [
  'metadata',
  'MetadataResolutionDiagnostics.js'
] as const

/**
 * 兼容层（上游 b422193 同步）的三个能力深入口——`CachedDecodedMetadataService`（K1）、
 * `LanAddress`（K5）、`GameVersionCalendar`（K3）。与既有深入口同处境：都不在上游桶导出
 * 内、探针管不到，产物存在性由 `scripts/verify-nikkisync-link.ts` 的
 * `NIKKISYNC_CAPABILITY_ARTIFACTS`（第 12 项检查）与 pre-dist-check 打包断言承担。
 * K2（MetadataOnlineConsent）、K6（ExtraScanDirectories）、K7（ScanDiagnostics）的
 * 深入口按 02 计划在各自消费节点就地增载，此处不预载未用符号。
 */
export const CACHED_DECODED_METADATA_DEEP_ENTRY = [
  'metadata',
  'CachedDecodedMetadataService.js'
] as const
export const LAN_ADDRESS_DEEP_ENTRY = ['server', 'LanAddress.js'] as const
export const GAME_VERSION_CALENDAR_DEEP_ENTRY = ['server', 'GameVersionCalendar.js'] as const

/**
 * K2 的同意深入口。与上面三入口同处境（不在桶导出内、探针管不到，产物存在性由
 * `verify-nikkisync-link.ts` 的 `NIKKISYNC_CAPABILITY_ARTIFACTS` 承担）。
 */
export const METADATA_ONLINE_CONSENT_DEEP_ENTRY = ['metadata', 'MetadataOnlineConsent.js'] as const

/**
 * K6 的额外照片目录深入口（上游 `scanner/ExtraScanDirectories.js`；同上由
 * `NIKKISYNC_CAPABILITY_ARTIFACTS` 守护产物存在性）。
 */
export const EXTRA_SCAN_DIRECTORIES_DEEP_ENTRY = ['scanner', 'ExtraScanDirectories.js'] as const

/**
 * K2-0 落档（上游 `Nuan5CompatibleResolver.resolve` 的实际出站体，逐字段核实于 b422193）：
 * `POST {photos: {[uid]: [[nativeParamNuan5Md5, 编码元组]]}, raw_data: true, raw_id: true}`，
 * 请求头 `x-client: SpinningMomo`；编码元组 = 照片内嵌参数信封的 hash 段 + 数据段（Base64）。
 * **不含照片字节本身**。披露 UI 的字段清单以此处为唯一出处（与实际出口同源）。
 */
export const NUAN5_METADATA_CONSENT_RECIPIENTS: Array<{
  name: string
  endpoint: string
  fields: string[]
}> = [
  {
    name: 'Nuan5 metadata service',
    endpoint: NUAN5_METADATA_ENDPOINT,
    fields: [
      'photo UID',
      'NUAN5 JPEG-prefix parameter MD5 digest',
      'embedded parameter envelope (hash + data segments, base64)',
      'raw_data / raw_id request flags',
      'x-client request header'
    ]
  }
]

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
 * 装载运行时面：`pc-companion` + `database` + `server/*` 与 `metadata/*` 深入口。
 *
 * `core` / `protocol` 不在此装载：本阶段不直接调用它们（AssetResolver 由上游
 * ScanReconciler 内部使用，协议常量校验已由阶段 1 的 probe / drift 守护承担）。
 *
 * 装载本身**不产生任何网络副作用**：`Nuan5CompatibleResolver` 只是拿到一个类，
 * 真正的 `fetch` 只在 `MetadataResolverService.runOnce()` 内经本仓显式驱动时发生。
 */
export async function loadRuntimeSurface(
  projectRoot: string,
  context?: PackagingContext
): Promise<RuntimeSurface> {
  const packaging = packagingContextFor(projectRoot, context)
  const pcCompanion = await loadNikkiSyncPackage('pcCompanion', packaging)
  const database = await loadNikkiSyncPackage('database', packaging)
  const root = resolveModuleRoot(NIKKISYNC_PACKAGES.pcCompanion, packaging)
  // 变量式 import：URL 来自变量而非字面量，保持与 runtime-loader 同一护栏口径
  const loadDeepModule = async (segments: readonly string[]): Promise<NikkiSyncModule> =>
    await import(/* @vite-ignore */ resolveDeepEntryUrl(root.root, segments))
  const rowMappers = await loadDeepModule(ROW_MAPPER_DEEP_ENTRY)
  const suitSearchIndex = await loadDeepModule(SUIT_SEARCH_DEEP_ENTRY)
  const clothingSearchIndex = await loadDeepModule(CLOTHING_SEARCH_DEEP_ENTRY)
  const profileStatsIndex = await loadDeepModule(PROFILE_STATS_DEEP_ENTRY)
  const nuan5Resolver = await loadDeepModule(NUAN5_RESOLVER_DEEP_ENTRY)
  const metadataDiagnostics = await loadDeepModule(METADATA_DIAGNOSTICS_DEEP_ENTRY)
  const cachedDecodedMetadataService = await loadDeepModule(CACHED_DECODED_METADATA_DEEP_ENTRY)
  const lanAddress = await loadDeepModule(LAN_ADDRESS_DEEP_ENTRY)
  const gameVersionCalendar = await loadDeepModule(GAME_VERSION_CALENDAR_DEEP_ENTRY)
  const metadataOnlineConsent = await loadDeepModule(METADATA_ONLINE_CONSENT_DEEP_ENTRY)
  const extraScanDirectories = await loadDeepModule(EXTRA_SCAN_DIRECTORIES_DEEP_ENTRY)
  return {
    pcCompanion,
    database,
    rowMappers: rowMappers as unknown as RowMapperSurface,
    suitSearchIndex: suitSearchIndex as unknown as SearchIndexSurface,
    clothingSearchIndex: clothingSearchIndex as unknown as ClothingIndexSurface,
    profileStatsIndex: profileStatsIndex as unknown as ProfileStatsIndexSurface,
    nuan5Resolver: nuan5Resolver as unknown as Nuan5ResolverSurface,
    metadataDiagnostics: metadataDiagnostics as unknown as MetadataDiagnosticsSurface,
    cachedDecodedMetadataService:
      cachedDecodedMetadataService as unknown as CachedDecodedMetadataSurface,
    lanAddress: lanAddress as unknown as LanAddressSurface,
    gameVersionCalendar: gameVersionCalendar as unknown as GameVersionCalendarSurface,
    metadataOnlineConsent: metadataOnlineConsent as unknown as MetadataOnlineConsentSurface,
    extraScanDirectories: extraScanDirectories as unknown as ExtraScanDirectoriesSurface
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
  const { mapAssetSummary, mapAssetDetail, mapResourceRow, mapChangeRow } = surface.rowMappers
  const DictionaryCtor = nikkisyncExport(surface.database, 'MetadataDictionaryRepository') as new (
    database: unknown
  ) => MetadataDictionaryRepositoryLike
  const dictionary = new DictionaryCtor(runtime.database)

  /**
   * 搜索与统计的资产源：**逐字复刻**上游 `LocalSyncServer.suitSearchSource`
   * （`apps/pc-companion/src/server/LocalSyncServer.ts:326-347`）的装配——
   * 资源行按 `asset_id` 分组，资产行喂 `mapAssetSummary`，`metadata_json` 一律 `String()`。
   *
   * 为什么连 `String(null) === 'null'` 也要照抄：上游索引的跳过条件是
   * `if (!searchable.metadataJson) continue`，而它自己给 NULL 行的就是字符串 `'null'`
   * （真值，**不**跳过，随后 `JSON.parse('null')` 得 null 再被安全忽略）。
   * 本层若改成 `undefined` 就会让同一行被跳过，与真实 `/v1/search/*` 端点行为分叉——
   * 该一致性由 `library-paging.linked.test.ts` 与上游端点逐字比对守住。
   *
   * 失效判据同上游：按 `libraryRevision` 缓存，revision 前进即重建。
   */
  let searchSourceCache: { revision: number; items: SuitSearchSourceItem[] } | undefined
  const searchSource = (): SuitSearchSourceItem[] => {
    const revision = repo.currentRevision()
    if (searchSourceCache && searchSourceCache.revision === revision) {
      return searchSourceCache.items
    }
    const resourcesByAsset = new Map<string, Record<string, unknown>[]>()
    for (const resource of repo.listSuitSearchResources()) {
      const assetId = String(resource.asset_id)
      const bucket = resourcesByAsset.get(assetId)
      if (bucket) bucket.push(resource)
      else resourcesByAsset.set(assetId, [resource])
    }
    const items = repo.listSuitSearchAssets().map((row): SuitSearchSourceItem => ({
      asset: mapAssetSummary(row, resourcesByAsset.get(String(row.asset_id)) ?? []),
      metadataJson: String(row.metadata_json)
    }))
    searchSourceCache = { revision, items }
    return items
  }

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
    },

    async listResourceRecords(assetIds, mode) {
      const byAsset: Record<string, unknown> = {}
      const displayed: string[] = []
      for (const assetId of assetIds) {
        const rows = repo.listResources(assetId)
        if (mode === 'path') {
          const paths: Record<string, string> = {}
          for (const row of rows) {
            const value = String(row.source_path)
            paths[String(row.resource_id)] = value
            displayed.push(value)
          }
          byAsset[assetId] = paths
        } else {
          byAsset[assetId] = rows.map(mapResourceRow)
        }
      }
      // path 模式送出去的每一条绝对路径同时进入 media:// 授权表：
      // 「能被显示的」必须恰好是「被我们主动给出去的那批」，不开放目录级授权。
      // revision 取当前值 ⇒ 扫描推进后旧表整批失效（见 resource-allowlist 安全口径）。
      if (mode === 'path') registerNikkiSyncResourcePaths(repo.currentRevision(), displayed)
      return { byAsset }
    },

    async listChanges(after, limit) {
      const libraryRevision = repo.currentRevision()
      const minimum = repo.minimumJournalRevision()
      // 判据逐字取自上游 LocalSyncServer.listChanges（:439）：after < minimum - 1
      const fullResyncRequired = minimum !== undefined && after < minimum - 1
      const changes = fullResyncRequired
        ? []
        : repo.listChangesAfter(after, limit).map(mapChangeRow)
      return { changes, libraryRevision, fullResyncRequired }
    },

    async searchSuits(query) {
      // query 原样下传：trim / 空判由上游索引内部负责，本层不做预处理
      return surface.suitSearchIndex.searchSuitLibrary(
        searchSource(),
        dictionary.getActiveManifest(),
        query
      )
    },

    async searchClothing(query) {
      return surface.clothingSearchIndex.searchClothingLibrary(
        searchSource(),
        dictionary.getActiveManifest(),
        query
      )
    },

    async profileStats() {
      return surface.profileStatsIndex.buildProfileStats(
        searchSource(),
        dictionary.getActiveManifest(),
        repo.currentRevision()
      )
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
 *
 * `preloadedSurface` 仅供测试注入（默认走真实装载）：组装中段（导出缺失 /
 * 查询面装配）失败的句柄归还要可单测判定。
 */
export async function createRuntimeSession(
  options: NikkiSyncSessionOptions,
  preloadedSurface?: RuntimeSurface
): Promise<NikkiSyncRuntimeSession> {
  const surface =
    preloadedSurface ?? (await loadRuntimeSurface(options.projectRoot, options.packagingContext))
  const RuntimeCtor = nikkisyncExport(surface.pcCompanion, 'PcCompanionRuntime') as new (
    config: Record<string, unknown>
  ) => EmbeddedRuntimeLike
  const syncServer = embeddedServerConfig(options.syncServer)
  /**
   * 阶段 6 · 唯一注入缝。
   *
   * 关闭时 `buildMetadataResolverConfig` 返回 `{}`，展开后**连键都不存在** ⇒
   * 上游 `runtime.ts:74-81` 的条件分支不成立、根本不构造 `MetadataResolverService`，
   * 因此既没有出站请求也没有 15s 定时器。这比传 `{ enabled: false }` 更严格：
   * 后者会保留服务实例，而上游 `runOnce()` 首行就因 `!enabled` 返回 0，
   * 把「关掉」误实现成「开着但什么都不做」。
   */
  const metadataResolverEnabled = options.metadataResolverEnabled === true
  /**
   * K2 · 同意门（fail-closed）。仅在「解析开启 && consentFile 给出 && 深入口在位」时
   * 构造。`initiallyDisabled` 按上游真实语义取值（`windows-app.js:105` 传
   * `resolverFile?.enabled === false`，即「功能整体关闭 ⇒ 无视文件强制不同意」）：
   * 恒传 true 会让已同意文件在重启后失效，因此本仓取「同意文件不存在（首次安装）
   * ⇒ true（fail-closed，比上游 fresh-install 默认放行更严，§14-Q3）；文件存在 ⇒
   * 交上游按内容判定（坏 JSON 走构造器 catch 分支同样 fail-closed）」。
   * 叠加既有 `nikkisync.metadataResolverEnabled` 默认 false ⇒ 实际出站为双重门。
   */
  let metadataConsent: import('./runtime-types').NikkiSyncMetadataConsent | undefined
  if (metadataResolverEnabled && options.consentFile && surface.metadataOnlineConsent) {
    const ConsentCtor = nikkisyncExport(
      surface.metadataOnlineConsent as unknown as NikkiSyncModule,
      'MetadataOnlineConsent'
    ) as new (
      file: string,
      recipients: Array<{ name: string; endpoint: string; fields: string[] }>,
      initiallyDisabled?: boolean
    ) => import('./runtime-types').NikkiSyncMetadataConsent
    metadataConsent = new ConsentCtor(
      options.consentFile,
      NUAN5_METADATA_CONSENT_RECIPIENTS,
      !existsSync(options.consentFile)
    )
  }
  const metadataFragment = buildMetadataResolverConfig({
    enabled: metadataResolverEnabled,
    endpoint: NUAN5_METADATA_ENDPOINT,
    createResolver: (endpoint) => {
      // 转型只为复用 nikkisyncExport 的可诊断报错（"Expected export … run `npm run build`"）：
      // 深入口符号不在 NIKKISYNC_REQUIRED_EXPORTS 里，探针与桶导出都覆盖不到它们。
      // 该调用发生在 RuntimeCtor 构造**之前**，因此失败时还没有任何 SQLite 句柄需要归还。
      const ResolverCtor = nikkisyncExport(
        surface.nuan5Resolver as unknown as NikkiSyncModule,
        'Nuan5CompatibleResolver'
      ) as new (config?: Record<string, unknown>) => unknown
      // 端点由驱动层校验后下传，这里不另取一份：保证披露文案与实际出口只有一个出处。
      // K2：同意在位 ⇒ 下发 guard 包装后的解析器（未同意时上游在 resolve 首行即抛，
      // 零出站）；深入口缺席（老会话）不包装，行为与 K2 之前逐字节一致。
      const resolver = new ResolverCtor({ endpoint })
      return metadataConsent
        ? (
            metadataConsent as unknown as {
              guard(resolver: unknown): unknown
            }
          ).guard(resolver)
        : resolver
    }
  })
  const runtime = new RuntimeCtor({
    databaseFile: options.databaseFile,
    scanner: {
      ...(options.gameRoot ? { selectedInstallRoot: options.gameRoot } : {}),
      watcher: options.watcher
    },
    server: syncServer,
    // 兼容层（b422193）：启动阶段回调透传缝（缺省时连键都不下发；K1 在本仓编排点自报阶段）
    ...(options.onStartupStage ? { onStartupStage: options.onStartupStage } : {}),
    ...metadataFragment
  })
  // runtime 构造期即建库并跑 migration：其后任一步（TLS/配对导出缺失、查询面装配）
  // 抛错都必须先关库再上抛——否则泄漏的 SQLite 句柄会在 Windows 上锁死
  // nikkisync.db，后续 start 全部报 "database is locked" 直至重启。
  try {
    const TlsCtor = nikkisyncExport(surface.pcCompanion, 'LocalTlsIdentityService') as new (
      database: unknown
    ) => LocalTlsIdentityServiceLike
    const tlsService = new TlsCtor(runtime.database)
    const PairingCtor = nikkisyncExport(surface.database, 'PairingRepository') as new (
      database: unknown
    ) => PairingRepositoryLike
    const pairing = new PairingCtor(runtime.database)
    // 上游只在配置里存在 metadataResolver 键时才构造该服务 ⇒ undefined 即「本会话未开启解析」
    const metadataService = runtime.metadataResolver
    // 兼容层（b422193）：预构造缓存解码服务（上游构造器仅存储引用，零副作用）；
    // 仅深入口模块在位时挂出闭包（沿 metadataRunOnce「仅存在时挂出」先例），
    // K1 在扫描完成后驱动，上游 runOnce(): number 的同步返回值逐字透传。
    const cachedDecodedMetadata = surface.cachedDecodedMetadataService
      ? new (
          nikkisyncExport(
            surface.cachedDecodedMetadataService as unknown as NikkiSyncModule,
            'CachedDecodedMetadataService'
          ) as new (database: unknown, dictionary?: unknown) => { runOnce(): number }
        )(runtime.database)
      : undefined

    /**
     * K6：额外照片目录管理面。仅「extraDirectoriesFile 给出 && 深入口在位」时构造；
     * 目录清单持久化在上游 0600 JSON（文件即单一真相源，本仓不落设置键）。
     * `onScopeChanged` 先空实现——上游在 add/remove/rescan 后回调它做联动（上游
     * 桌面壳用它刷新页面），本仓渲染层在响应返回后自行刷新，保留缝不吞调用。
     */
    const extraDirectories: import('./runtime-types').ExtraScanDirectoriesLike | undefined =
      options.extraDirectoriesFile && surface.extraScanDirectories
        ? new (
            nikkisyncExport(
              surface.extraScanDirectories as unknown as NikkiSyncModule,
              'ExtraScanDirectories'
            ) as new (
              file: string,
              scanner: unknown,
              onScopeChanged?: () => Promise<void>
            ) => import('./runtime-types').ExtraScanDirectoriesLike
          )(options.extraDirectoriesFile, runtime.scanner, async () => {})
        : undefined

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
      pairingUri: (host, ttlMs, hosts) =>
        hosts !== undefined
          ? runtime.createPairingUri(host, ttlMs, hosts)
          : typeof ttlMs === 'number'
            ? runtime.createPairingUri(host, ttlMs)
            : runtime.createPairingUri(host),
      // 兼容层（b422193）：上游构造期必建的整理队列，同一引用透传（动作面归 K8）
      deletions: runtime.deletions,
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
      },
      stopMetadataResolver: () => {
        // 上游 stop() 对 undefined timer 安全（幂等）；未开启时句柄整个不存在
        metadataService?.stop()
      },
      // 仅在服务存在时挂出驱动面：编排层据此判 0 轮，无需重复读开关
      ...(metadataService ? { metadataRunOnce: () => metadataService.runOnce() } : {}),
      // 兼容层（b422193）：缓存解码同步驱动闭包（模块缺席即不挂键）
      ...(cachedDecodedMetadata
        ? { cachedMetadataRunOnce: () => cachedDecodedMetadata.runOnce() }
        : {}),
      // K2：同意面（构造条件见上方 metadataConsent；缺席即不挂键）
      ...(metadataConsent ? { metadataConsent } : {}),
      // K6：额外目录面（构造条件见上方 extraDirectories；缺席即不挂键）
      ...(extraDirectories ? { extraDirectories } : {}),
      /**
       * K3：游戏版本推断（上游静态表纯函数）。深入口缺席（老 surface）时恒返回
       * 两键缺省，不抛——推断是纯展示增强，不得因缺件牵连会话可用性。
       */
      resolveGameVersion: (capturedAt?: string): NikkiSyncGameVersionView => {
        const calendar = surface.gameVersionCalendar
        if (!calendar) return {}
        const version = calendar.inferInfinityNikkiGameVersion(capturedAt)
        if (!version) return {}
        const release = calendar
          .getGameVersionReleases()
          .find((item) => String((item as { version?: unknown }).version) === version) as
          | {
              effectiveAt?: unknown
            }
          | undefined
        return {
          version,
          ...(typeof release?.effectiveAt === 'string' ? { effectiveAt: release.effectiveAt } : {})
        }
      },
      metadataDiagnostics: () =>
        surface.metadataDiagnostics.metadataResolutionDiagnostics(
          runtime.database,
          metadataResolverEnabled
        )
    }
  } catch (error) {
    try {
      runtime.database.close()
    } catch {
      // 关库失败不掩盖组装失败的原始原因（原始错误才是可诊断信息）
    }
    throw error
  }
}

/**
 * 生产依赖装配：把门面 + 文件系统 + 超时兜底接成状态机需要的依赖表。
 * `log` 由调用方注入（Electron 侧走 electronLogger，CLI 侧走 process.stdout），
 * `pairingHostResolver` 由装配层注入局域网地址（本模块不碰 `os`/`electron`，保持可单测）。
 * K5：`pairingHostsResolver` 仅在设置键开启且深入口可装载时注入（见 loadLanAddressLister）。
 */
export function createManagerDependencies(
  defaults: NikkiSyncSessionOptions,
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
  pairingHostResolver?: () => string,
  pairingHostsResolver?: () => string[]
): RuntimeManagerDependencies {
  return {
    defaults,
    ...(pairingHostResolver ? { resolvePairingHost: pairingHostResolver } : {}),
    ...(pairingHostsResolver ? { resolvePairingHosts: pairingHostsResolver } : {}),
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

/**
 * K5：装载上游 `listLanIpv4` 深入口并返回同步取值器（仅枚举本机网卡地址，
 * **不做子网扫描**；上游排序去重截 8）。仅在设置键 `nikkisync.multiHostPairing`
 * 开启时由装配层调用；装载失败（老链接缺件）由调用方降级为单 host，不影响既有配对。
 */
export async function loadLanAddressLister(
  options: NikkiSyncSessionOptions
): Promise<() => string[]> {
  const surface = await loadRuntimeSurface(options.projectRoot, options.packagingContext)
  return () => surface.lanAddress.listLanIpv4()
}
