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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import {
  composeLocalPhotoResolver,
  createLocalPhotoResolverAdapter
} from './local-photo-resolver-adapter'
import { buildScannerConfig } from './scanner-config'
import { loadDictionaryInputs } from './dictionary-manifest'
import type {
  EmbeddedRuntimeLike,
  InspirationRepositoryLike,
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
 * K7：上游 `scanner/ScanDiagnostics.ts` 的本仓最小面。
 * 上游注释承诺：仅计数，绝不序列化路径/UID/文件名/原始错误/参数——可直接进 IPC。
 */
interface ScanDiagnosticsSurface {
  scanDiagnosticSummary(scanner: unknown): unknown
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
  /** 兼容层（b422193）：K1/K3/K5 将消费的三个深入口（产物存在性由 verify:nikkisync 的 `NIKKISYNC_CAPABILITY_ARTIFACTS` 清单承担）。 */
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
  /** K7：扫描诊断深入口（可选同上）。 */
  scanDiagnostics?: ScanDiagnosticsSurface
  /**
   * N2：上游启动组合器与配置/缓存深入口。**可选**：老链接会话上这些字段可为
   * undefined，此时只保留既有单 resolver 行为，其余能力整节不挂出（不静默成功）。
   */
  metadataStartupComposition?: NikkiSyncModule
  metadataResolverConfigFile?: NikkiSyncModule
  metadataDictionaryRemoteConfigFile?: NikkiSyncModule
  metadataThumbnailCache?: NikkiSyncModule
  /** a49764bb：本地服装/效果图标包深入口（可选，老链接会话上缺席时不启用本地图标模式）。 */
  localClothingIconPack?: NikkiSyncModule
  /** 「电脑端优先本地解析照片」深入口（可选，缺席时沿用既有在线 resolver）。 */
  localPhotoMetadata?: NikkiSyncModule
  /** G4：本地字典 manifest 与服装名补充深入口（可选）。 */
  metadataDictionaryConfig?: NikkiSyncModule
  verifiedClothingNames?: NikkiSyncModule
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
 * `NIKKISYNC_CAPABILITY_ARTIFACTS` 清单与 pre-dist-check 打包断言承担。
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

/** K7 的扫描诊断深入口（上游 `scanner/ScanDiagnostics.js`；产物存在性同上守护）。 */
export const SCAN_DIAGNOSTICS_DEEP_ENTRY = ['scanner', 'ScanDiagnostics.js'] as const

/**
 * N2：上游 `windows-app.ts:88-113` 的启动组合器与其配置/缓存深入口。
 * 全部不在桶导出内，逐个经 `resolveDeepEntryUrl` 变量式装载；
 * 产物存在性由 `verify-nikkisync-link.ts` 的能力清单与 `LOAD_CHAIN_ROOTS` 守护。
 */
export const METADATA_STARTUP_COMPOSITION_DEEP_ENTRY = [
  'metadata',
  'MetadataStartupComposition.js'
] as const
export const METADATA_RESOLVER_CONFIG_DEEP_ENTRY = [
  'metadata',
  'MetadataResolverConfigFile.js'
] as const
export const METADATA_DICTIONARY_REMOTE_CONFIG_DEEP_ENTRY = [
  'metadata',
  'MetadataDictionaryRemoteConfigFile.js'
] as const
export const METADATA_THUMBNAIL_CACHE_DEEP_ENTRY = [
  'metadata',
  'MetadataThumbnailCache.js'
] as const

/**
 * N7：上游 PC 端控制页 / 微信画廊 / 本机后台服务的七个深入口。
 * 全部不在上游桶导出内，逐个经 `resolveDeepEntryUrl` 变量式装载；产物存在性由
 * `verify-nikkisync-link.ts` 的 `LOAD_CHAIN_ROOTS` / `NIKKISYNC_CAPABILITY_ARTIFACTS`
 * 守护（与既有 16 个入口同口径）。`GalleryRuntime.mjs` 是 esbuild 产物（非 .js），
 * 由 `SYNC_SERVER_REQUIRED_ARTIFACTS` 与能力清单双重点名。
 */
export const DESKTOP_CONTROL_SERVER_DEEP_ENTRY = ['desktop', 'DesktopControlServer.js'] as const
export const DESKTOP_STATUS_SERVICE_DEEP_ENTRY = ['desktop', 'DesktopStatusService.js'] as const
export const WECHAT_GALLERY_SERVICE_DEEP_ENTRY = ['wechat', 'WeChatGalleryService.js'] as const
export const GALLERY_RUNTIME_DEEP_ENTRY = ['wechat', 'GalleryRuntime.mjs'] as const
export const WECHAT_ICON_PROVIDER_DEEP_ENTRY = ['wechat', 'WeChatIconProvider.js'] as const
export const RUNTIME_MEMORY_MAINTENANCE_DEEP_ENTRY = ['RuntimeMemoryMaintenance.js'] as const
export const GAME_VERSION_UPDATE_SERVICE_DEEP_ENTRY = [
  'server',
  'GameVersionUpdateService.js'
] as const
/**
 * 4cb71e2（v1.0.31）新增：微信画廊的小程序灵感库 / 批量删除包装器。与上面七个入口同处境
 * （不在上游桶导出内、探针管不到，产物存在性由 `verify-nikkisync-link.ts` 的
 * `NIKKISYNC_CAPABILITY_ARTIFACTS` 与 `LOAD_CHAIN_ROOTS` 守护）；由
 * `pc-companion-services.loadPcCompanionSurface` 在消费节点就地装载（沿 N2「不预载未用符号」口径）。
 */
export const WECHAT_DELETION_DEEP_ENTRY = ['wechat', 'WeChatDeletion.js'] as const
export const WECHAT_INSPIRATION_DEEP_ENTRY = ['wechat', 'WeChatInspiration.js'] as const

/**
 * a49764bb（v1.0.39/1.0.40）：本地服装/拍摄效果图标包的装载深入口。
 * 导出 `loadLocalClothingIconPack` / `withLocalPhotoEffectIcons`，由 createRuntimeSession
 * 在会话构造期装载主包与滤镜补充包；产物存在性由 verify-nikkisync-link.ts 的能力清单守护。
 */
export const LOCAL_CLOTHING_ICON_PACK_DEEP_ENTRY = ['metadata', 'LocalClothingIconPack.js'] as const

/**
 * 「电脑端优先本地解析照片」：上游 `LocalPhotoMetadataResolver.js` 导出
 * `parseLocalPhotoMetadata` 与 `withLocalPhotoFallback`。本仓不实现 C# helper exe，
 * 而是把这两枚上游纯函数接到本仓 koffi 解码链产出的原始文本上（见
 * local-photo-resolver-adapter.ts）。产物已在能力清单，装载链根表同步新增一项。
 */
export const LOCAL_PHOTO_METADATA_DEEP_ENTRY = [
  'metadata',
  'LocalPhotoMetadataResolver.js'
] as const

/**
 * G4：本地字典 manifest 与已核验服装名补充的两个深入口。
 * `loadMetadataDictionaryFile` 产出的是 manifest（不是 provider），
 * `clothingNameSupplement` 产出服装名补充表；两者都只在本仓显式给出配置文件时才装载。
 */
export const METADATA_DICTIONARY_CONFIG_DEEP_ENTRY = [
  'metadata',
  'MetadataDictionaryConfigFile.js'
] as const
export const VERIFIED_CLOTHING_NAMES_DEEP_ENTRY = ['metadata', 'VerifiedClothingNames.js'] as const

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

/**
 * N4：当前已组装会话的只读访问面。
 *
 * 为什么需要模块级注册而不改 `runtime-manager.ts`（本节点禁止改）：灵感库四条 IPC
 * 通道要访问的是**会话**上的 `runtime.server.inspirations`（换根重建 / 端口变更时
 * 会话会被替换），而 `NikkiSyncRuntimeHandle`（`ctx.nikkisyncRuntime`）由 manager
 * 的闭包持有 session、句柄上没有公开的 session 访问器。注册表在
 * `createRuntimeSession` 成功返回前写入，因此每次会话重建都自动指向新仓储；
 * handler 先 `requireRuntime(ctx)` 复用「句柄未装配 ⇒ PRECONDITION_FAILED」口径，
 * 再经本面取会话，会话缺席同样给 PRECONDITION_FAILED。
 */
let activeRuntimeSession: NikkiSyncRuntimeSession | undefined

/** 仅供装配/测试注入；生产由 `createRuntimeSession` 自动调用。 */
export function setActiveRuntimeSession(session: NikkiSyncRuntimeSession | undefined): void {
  activeRuntimeSession = session
}

export function getActiveRuntimeSession(): NikkiSyncRuntimeSession | undefined {
  return activeRuntimeSession
}

function registerActiveSession(session: NikkiSyncRuntimeSession): NikkiSyncRuntimeSession {
  activeRuntimeSession = session
  return session
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
  /** a49764bb 图标包是新增可选深入口：老链接缺件时只不挂该面，不牵连整条装载链。 */
  const loadOptionalDeepModule = async (
    segments: readonly string[]
  ): Promise<NikkiSyncModule | undefined> => {
    try {
      return await loadDeepModule(segments)
    } catch {
      return undefined
    }
  }
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
  const scanDiagnostics = await loadDeepModule(SCAN_DIAGNOSTICS_DEEP_ENTRY)
  // N2：上游启动组合器深入口。与既有 12 个入口同为「必须存在」——缺件直接抛
  // ERR_MODULE_NOT_FOUND（由 verify:nikkisync 的清单提前拦住），绝不静默降级成半套能力。
  const metadataStartupComposition = await loadDeepModule(METADATA_STARTUP_COMPOSITION_DEEP_ENTRY)
  const metadataResolverConfigFile = await loadDeepModule(METADATA_RESOLVER_CONFIG_DEEP_ENTRY)
  const metadataDictionaryRemoteConfigFile = await loadDeepModule(
    METADATA_DICTIONARY_REMOTE_CONFIG_DEEP_ENTRY
  )
  const metadataThumbnailCache = await loadDeepModule(METADATA_THUMBNAIL_CACHE_DEEP_ENTRY)
  const localClothingIconPack = await loadOptionalDeepModule(LOCAL_CLOTHING_ICON_PACK_DEEP_ENTRY)
  const localPhotoMetadata = await loadOptionalDeepModule(LOCAL_PHOTO_METADATA_DEEP_ENTRY)
  const metadataDictionaryConfig = await loadOptionalDeepModule(
    METADATA_DICTIONARY_CONFIG_DEEP_ENTRY
  )
  const verifiedClothingNames = await loadOptionalDeepModule(VERIFIED_CLOTHING_NAMES_DEEP_ENTRY)
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
    extraScanDirectories: extraScanDirectories as unknown as ExtraScanDirectoriesSurface,
    scanDiagnostics: scanDiagnostics as unknown as ScanDiagnosticsSurface,
    metadataStartupComposition,
    metadataResolverConfigFile,
    metadataDictionaryRemoteConfigFile,
    metadataThumbnailCache,
    ...(localClothingIconPack ? { localClothingIconPack } : {}),
    ...(localPhotoMetadata ? { localPhotoMetadata } : {}),
    ...(metadataDictionaryConfig ? { metadataDictionaryConfig } : {}),
    ...(verifiedClothingNames ? { verifiedClothingNames } : {})
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
    database: unknown,
    allowedUids?: () => readonly string[] | undefined,
    sourceGroups?: () => ReadonlyArray<{ key: string; pathPrefixes: readonly string[] }>
  ) => SyncReadRepositoryLike
  // 1.0.27：作用域与上游 LocalSyncServer 共用同一个 AccountSyncSettings 实例
  // （`runtime.server.accounts` 构造期必建，老链接可能缺席 ⇒ 此时保持无作用域）。
  const accounts = runtime.server.accounts
  const repo = new ReadRepoCtor(
    runtime.database,
    accounts ? () => accounts.selection() : undefined,
    accounts ? () => accounts.sourceGroups() : undefined
  )
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
      // 判据逐字对齐上游 b397e0e（LocalSyncServer.listChanges:457）：账号选择或来源集合
      // 变化会让 accounts.revision 前移，落后于它的客户端必须整库重拉；老链接无 accounts ⇒ 0。
      const fullResyncRequired =
        after < (accounts?.revision() ?? 0) || (minimum !== undefined && after < minimum - 1)
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
  /**
   * 1.0.27：额外目录只能在本函数后段（runtime 构造之后）创建，而上游在 LocalSyncServer
   * 构造期就冻结 `accountSourceDirectories`。故先声明可变绑定、下传读取该绑定的 thunk：
   * 构造期冻结的是函数引用，运行期每次求值都拿到最新目录清单；赋值前调用回落空数组。
   */
  let extraDirectories: import('./runtime-types').ExtraScanDirectoriesLike | undefined
  const accountSourceDirectories = (): readonly unknown[] => {
    const state = extraDirectories?.state()
    if (typeof state !== 'object' || state === null) return []
    const directories = (state as { directories?: unknown }).directories
    return Array.isArray(directories) ? directories : []
  }
  const syncServer = embeddedServerConfig({
    ...(options.syncServer ?? {}),
    accountSourceDirectories
  })
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
   * K2 · 同意门（fail-closed）。仅在「解析开启 && consentFile 给出 && 深入口在位」时构造。
   * `initiallyDisabled` 取 `!existsSync(consentFile)`：同意文件不存在（干净安装）⇒ true
   * （强制不同意，比上游 fresh-install 默认放行更严，§14-Q3）；文件存在 ⇒ 交上游按内容
   * 判定（坏 JSON 走构造器 catch 分支同样 fail-closed）。叠加装配层的
   * `metadataResolverEnabled` 能力位 ⇒ 出站要同时越过能力位与用户同意两道门。
   *
   * B6 风险口径（用户明确决策：只把本门恢复 fail-closed，五个默认开启常量一律不动）：
   * 干净安装默认全开会让本机监听 `0.0.0.0`（LAN 同步服务）、发起 mDNS 组播，并在用户
   * 显式同意后对第三方元数据端点出站；逃生阀是 `NIKKI_NIKKISYNC_RUNTIME=0` 全局阀与
   * 六个 `NIKKI_NIKKISYNC_*=0` 分项阀，以及两份 `enabled:false` 离线 JSON。本门只保证
   * 「同意文件不存在时，用户同意前不得出站」，不撤销上游 PC 端默认全开的产品意图。
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
  /**
   * N2：复刻上游 `windows-app.ts:88-113` 的启动组合。
   * 能力位只认显式 `true`（外部输入默认不可信）；深入口缺席时 `call*` 返回 undefined，
   * 对应整节不挂出，会话其余能力照常——绝不把「没装载到」伪装成「用户关掉了」。
   */
  const switches = options.pcCompanion as Record<string, boolean> | undefined
  const pcOn = (key: string): boolean => switches?.[key] === true
  const callModule = <T>(
    mod: NikkiSyncModule | undefined,
    name: string,
    ...args: unknown[]
  ): T | undefined => {
    const fn = (mod as unknown as Record<string, unknown> | undefined)?.[name]
    return typeof fn === 'function' ? (fn as (...a: unknown[]) => T)(...args) : undefined
  }

  /**
   * a49764bb：复刻上游 `windows-app.ts:103-117` 的本地图标包装配。
   * 主包（服装 + pose/lighting/filter 效果）为必需，滤镜补充包可选合并；
   * 仅主包 `valid===true` 时切本地模式，其余一律保持在线图标模式并留 warn。
   * 全部读取复用上游 `loadLocalClothingIconPack` / `withLocalPhotoEffectIcons`，不重写校验。
   */
  const iconPackModule = surface.localClothingIconPack as unknown as
    Record<string, unknown> | undefined
  // F4：createRuntimeSession 允许被 CLI / 单测直调（此时没有 createManagerDependencies
  // 注入的 onWarning），缺省时用 console.warn 兜底，绝不静默吞掉图标包异常。
  const warn = (message: string): void => {
    if (options.onWarning) options.onWarning(message)
    else console.warn(message)
  }
  const loadIconPack = async (directory?: string): Promise<Record<string, unknown> | undefined> => {
    if (!directory || !path.isAbsolute(directory) || !iconPackModule) return undefined
    const loader = iconPackModule.loadLocalClothingIconPack
    if (typeof loader !== 'function') return undefined
    try {
      const pack = await loader(directory)
      return typeof pack === 'object' && pack !== null
        ? (pack as Record<string, unknown>)
        : undefined
    } catch (error) {
      warn(`[NIKKISYNC] icon pack load failed: ${String(error)}`)
      return undefined
    }
  }
  const mainIconPack = await loadIconPack(options.clothingIconsDir)
  const supplementIconPack = await loadIconPack(options.photoFilterIconsDir)
  const mergeIconPacks = iconPackModule?.withLocalPhotoEffectIcons
  let localClothingIcons: Record<string, unknown> | undefined
  if (mainIconPack?.valid === true) {
    // F4：合并调用不在 :961 的组装大 try 内，上游抛错会直接令会话失败；
    // 按 :806 约定回落在线图标模式并留 warn，不牵连整个会话。
    try {
      localClothingIcons =
        typeof mergeIconPacks === 'function'
          ? (mergeIconPacks(mainIconPack, supplementIconPack) as Record<string, unknown>)
          : mainIconPack
    } catch (error) {
      localClothingIcons = undefined
      warn(`[NIKKISYNC] icon pack merge failed; online icons retained: ${String(error)}`)
    }
  } else if (mainIconPack) {
    warn('[NIKKISYNC] icon pack manifest invalid; online icons retained')
  }

  const composition = surface.metadataStartupComposition
  const resolverFile = options.metadataResolverFile
    ? callModule<Record<string, unknown> | undefined>(
        surface.metadataResolverConfigFile,
        'loadMetadataResolverConfigFile',
        options.metadataResolverFile
      )
    : undefined
  const dictionaryRemote = options.metadataDictionaryRemoteFile
    ? callModule<Record<string, unknown> | undefined>(
        surface.metadataDictionaryRemoteConfigFile,
        'loadMetadataDictionaryRemoteConfigFile',
        options.metadataDictionaryRemoteFile
      )
    : undefined
  const dictionaryEnabled = pcOn('metadataDictionary')
  const dictionaryProvider = dictionaryEnabled
    ? callModule<unknown>(composition, 'composeMetadataDictionaryProvider', dictionaryRemote)
    : undefined
  const supplementProvider = dictionaryEnabled
    ? callModule<unknown>(
        composition,
        'composeMetadataDictionarySupplementProvider',
        dictionaryRemote
      )
    : undefined
  const ThumbnailCacheCtor = (
    surface.metadataThumbnailCache as unknown as Record<string, unknown> | undefined
  )?.MetadataThumbnailCache as (new (config: { cacheDir: string }) => unknown) | undefined
  /**
   * F1：server 侧沿用上游 windows-app.ts:111 的互斥语义（有本地包就不挂
   * metadataThumbnailCache），但 pcCompanionContext() 仍须下发同一个缓存实例：
   * 装配层在老链接缺 convertWeChatWebp / ffmpeg 时会 fail-closed 回落在线图标，
   * 若这里连缓存一起抽掉，本地与在线两条图标链会同时断开。
   */
  const onlineThumbnailCache =
    dictionaryEnabled && options.metadataThumbnailCacheDir && ThumbnailCacheCtor
      ? new ThumbnailCacheCtor({ cacheDir: options.metadataThumbnailCacheDir })
      : undefined
  const serverConfig = {
    ...syncServer,
    ...(onlineThumbnailCache && !localClothingIcons
      ? { metadataThumbnailCache: onlineThumbnailCache }
      : {}),
    // 必须传完整 pack：LocalSyncServer 会调 read()/readEffect()，只给 cacheVersion 会 TypeError
    ...(localClothingIcons ? { localClothingIcons } : {})
  }

  // G2：本地解码器在 createResolver 内构造，判据需要读到「本次是否真的挂上本地面」。
  let hasLocalPhotoResolver = false
  const metadataFragment = buildMetadataResolverConfig({
    enabled: metadataResolverEnabled,
    endpoint: NUAN5_METADATA_ENDPOINT,
    // 有本地解码器 ⇒ 即使未同意在线也允许解析；否则严格按 K2 同意门放行。
    canResolve: () =>
      hasLocalPhotoResolver || (metadataConsent ? metadataConsent.state().enabled : true),
    // 装配层注入诊断落盘（N3）；缺省为上游默认 no-op，绝不静默吞掉回调。
    onWorkSettled: () => options.onMetadataWorkSettled?.(),
    createResolver: (endpoint) => {
      // 转型只为复用 nikkisyncExport 的可诊断报错（"Expected export … run `npm run build`"）：
      // 深入口符号不在 NIKKISYNC_REQUIRED_EXPORTS 里，探针与桶导出都覆盖不到它们。
      // 该调用发生在 RuntimeCtor 构造**之前**，因此失败时还没有任何 SQLite 句柄需要归还。
      const composed =
        pcOn('metadataDictionary') || pcOn('remoteBridge')
          ? callModule<unknown>(
              composition,
              'composeMetadataResolver',
              // 无磁盘配置时给一份与披露文案同源的单 provider 配置，而不是吃上游默认值，
              // 保证「设置页写明的端点」与「实际出口」始终只有一个出处。
              resolverFile ?? {
                enabled: true,
                providers: [{ type: 'nuan5-compatible', endpoint }]
              },
              undefined
            )
          : undefined
      const resolver =
        composed ??
        (() => {
          const ResolverCtor = nikkisyncExport(
            surface.nuan5Resolver as unknown as NikkiSyncModule,
            'Nuan5CompatibleResolver'
          ) as new (config?: Record<string, unknown>) => unknown
          return new ResolverCtor({ endpoint })
        })()
      // 端点由驱动层校验后下传，这里不另取一份：保证披露文案与实际出口只有一个出处。
      // K2：同意在位 ⇒ 下发 guard 包装后的解析器（未同意时上游在 resolve 首行即抛，
      // 零出站）；深入口缺席（老会话）不包装，行为与 K2 之前逐字节一致。
      const guarded = metadataConsent
        ? (
            metadataConsent as unknown as {
              guard(resolver: unknown): unknown
            }
          ).guard(resolver)
        : resolver

      // 「电脑端优先本地解析照片」：仅当上游纯函数、本仓 koffi 解码缝同时在位时启用。
      // 任一缺席都保持既有在线 resolver，绝不把「没装载到」伪装成「本地解码成功」。
      const parseLocalPhotoMetadata = (
        surface.localPhotoMetadata as unknown as Record<string, unknown> | undefined
      )?.parseLocalPhotoMetadata
      const decodeRawTexts = options.decodeLocalPhotoRawTexts
      if (typeof parseLocalPhotoMetadata !== 'function' || typeof decodeRawTexts !== 'function') {
        return guarded
      }
      const local = createLocalPhotoResolverAdapter({
        decodeRawTexts,
        parseLocalPhotoMetadata: parseLocalPhotoMetadata as (
          cameraText: string,
          photoText: string
        ) => unknown
      })
      const withLocalPhotoFallback = (
        surface.localPhotoMetadata as unknown as Record<string, unknown> | undefined
      )?.withLocalPhotoFallback
      hasLocalPhotoResolver = true
      return composeLocalPhotoResolver({
        local,
        online: guarded,
        onlineEnabled: () => (metadataConsent ? metadataConsent.state().enabled : true),
        withLocalPhotoFallback:
          typeof withLocalPhotoFallback === 'function'
            ? (withLocalPhotoFallback as (
                local: unknown,
                online: unknown,
                onlineEnabled: () => boolean
              ) => unknown)
            : undefined
      })
    }
  })
  // G3/G6：上游构造期选项 + 5 个聚合诊断文件。诊断落盘由装配层注入，
  // 装载缝不直接依赖 app/shell（避免目录循环），且写入失败只是 warn-fallback。
  const diagnostics = (name: string, payload: unknown): void => {
    options.onDiagnostic?.(name, payload)
  }
  const readCachedInstallRoot = (): string | undefined => {
    const file = options.gameRootCacheFile
    if (!file || !existsSync(file)) return undefined
    try {
      const value = readFileSync(file, 'utf8').trim()
      return value.length > 0 && value.length <= 4096 ? value : undefined
    } catch {
      return undefined
    }
  }
  const extraAtConstruction = (() => {
    const file = options.extraDirectoriesFile
    const mod = surface.extraScanDirectories as unknown as NikkiSyncModule | undefined
    if (!file || !mod) return { extra: undefined, retired: undefined }
    return {
      extra: callModule<unknown>(mod, 'loadExtraScanDirectories', file),
      retired: callModule<unknown>(mod, 'loadRetiredExtraDirectories', file)
    }
  })()
  const cachedInstallRoot = readCachedInstallRoot()
  let progressReported = false
  const scannerConfig = buildScannerConfig({
    watcher: options.watcher,
    ...(options.gameRoot ? { gameRoot: options.gameRoot } : {}),
    ...(extraAtConstruction.extra === undefined
      ? {}
      : { extraDirectories: extraAtConstruction.extra }),
    ...(extraAtConstruction.retired === undefined
      ? {}
      : { retiredExtraDirectories: extraAtConstruction.retired }),
    ...(cachedInstallRoot ? { cachedInstallRoot } : {}),
    onProgress: () => {
      if (progressReported) return
      progressReported = true
      diagnostics('startup-service-timings.json', { stage: 'scanner', started: true })
    },
    onSettled: () => diagnostics('scan-status.json', { settled: true }),
    onDiscoveryComplete: (report) => diagnostics('game-discovery.log', { report })
  })
  // G4：只有显式给出本地字典配置文件才下传 manifest/supplement；
  // 干净安装保持既有「不下传」语义，避免误把 provider 当 manifest 触发上游 replaceManifest 报错。
  const dictionary = loadDictionaryInputs({
    dictionaryFile: options.metadataDictionaryFile,
    supplementFile: options.metadataDictionarySupplementFile,
    loadDictionary: (file) =>
      callModule<unknown>(
        surface.metadataDictionaryConfig as unknown as NikkiSyncModule | undefined,
        'loadMetadataDictionaryFile',
        file
      ),
    nameSupplement: (local) =>
      callModule<unknown>(
        surface.verifiedClothingNames as unknown as NikkiSyncModule | undefined,
        'clothingNameSupplement',
        local
      )
  })
  for (const warning of dictionary.warnings) options.onWarning?.(warning)
  const runtime = new RuntimeCtor({
    databaseFile: options.databaseFile,
    scanner: scannerConfig,
    server: serverConfig,
    ...dictionary.config,
    // 兼容层（b422193）：启动阶段回调透传缝（缺省时连键都不下发；K1 在本仓编排点自报阶段）
    ...(options.onStartupStage ? { onStartupStage: options.onStartupStage } : {}),
    // N2：上游 PC 端能力位。键只在能力真正可用时出现（不写死 true、不造半套配置）。
    ...(pcOn('remoteBridge') ? { remoteBridge: true } : {}),
    // 干净安装按上游 windows-app.ts 口径**不下传** metadataDictionary /
    // metadataDictionarySupplement：那两键要的是本地 manifest（上游 runtime.ts:69
    // 会调 replaceManifest，误传 provider 会抛 "schemaVersion must be 1"）。
    // provider 只作为 Remote / SupplementRemote 的 provider 下传，由上游 updater 拉取。
    ...(dictionaryProvider
      ? {
          metadataDictionaryRemote: {
            provider: dictionaryProvider,
            service: { enabled: true }
          }
        }
      : {}),
    ...(supplementProvider
      ? {
          metadataDictionarySupplementRemote: {
            provider: supplementProvider,
            service: { mode: 'supplement' }
          }
        }
      : {}),
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
     * `onSourcesChanged`（1.0.27）必须接上：目录来源标注变化后让账号作用域立刻刷新
     * 来源指纹（对齐上游 windows-app.ts:212），否则只在下次查询时被动发现。
     */
    extraDirectories =
      options.extraDirectoriesFile && surface.extraScanDirectories
        ? new (
            nikkisyncExport(
              surface.extraScanDirectories as unknown as NikkiSyncModule,
              'ExtraScanDirectories'
            ) as new (
              file: string,
              scanner: unknown,
              onScopeChanged?: () => Promise<void>,
              onSourcesChanged?: () => void
            ) => import('./runtime-types').ExtraScanDirectoriesLike
          )(
            options.extraDirectoriesFile,
            runtime.scanner,
            async () => {},
            () => runtime.server.accounts?.sourceDirectoriesChanged()
          )
        : undefined

    return registerActiveSession({
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
      // 1.0.27：账号作用域实例（与 LocalSyncServer 内部及查询面共用同一对象）
      ...(runtime.server.accounts ? { accounts: runtime.server.accounts } : {}),
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
      // G7：同意切换后清空 checked/retryAt 并重算下一轮；老链接无此面 ⇒ 安全 no-op。
      reconsiderMetadataResolver: () => metadataService?.reconsider?.(),
      // F2：本地照片解析器挂载观测（G1 可观测结果）。构造期已定格，闭包如实；
      // 深入口/解码缝缺席时为 false，绝不伪造。
      localPhotoResolverActive: () => hasLocalPhotoResolver,
      // F4：安装根缓存回写（对齐上游 windows-app.ts:221-224：启动后取
      // scanner.getStatus().installation.installRoot，非空才写，best-effort）。
      // 读侧 readCachedInstallRoot 的 trim + 4096 上限与此处写入判据咬合。
      ...(options.gameRootCacheFile
        ? {
            cacheInstallRoot: () => {
              const file = options.gameRootCacheFile as string
              const scannerStatus = runtime.scanner.getStatus() as {
                installation?: { installRoot?: unknown }
              } | null
              const installRoot = scannerStatus?.installation?.installRoot
              if (
                typeof installRoot !== 'string' ||
                installRoot.length === 0 ||
                installRoot.length > 4096
              ) {
                return
              }
              try {
                writeFileSync(file, `${installRoot}\n`, 'utf8')
              } catch {
                options.onWarning?.('game root cache write failed')
              }
            }
          }
        : {}),
      /**
       * N3：显式补偿上游 `runtime.start()` 的「background-services」阶段。
       * 本仓不调 `runtime.start()`（它会无条件启 LAN 服务），因此上游构造出的
       * metadataResolver / 两个字典 updater 从未被启动、字典 reenrich 从未发生。
       * 只驱动真实存在的上游句柄；已启动的记进闭包，stop 时逆序停，保证定时器不泄漏。
       */
      ...(() => {
        const upstream = runtime as unknown as Record<
          string,
          | {
              start?: () => void
              stop?: () => void
              reenrichResolvedAssets?: () => void
            }
          | undefined
        >
        const started: Array<{ stop?: () => void }> = []
        return {
          startBackgroundServices: (): void => {
            for (const key of [
              'metadataDictionaryUpdater',
              'metadataDictionarySupplementUpdater',
              'metadataResolver'
            ]) {
              const service = upstream[key]
              if (!service || typeof service.start !== 'function') continue
              // B4：先入列再 start —— start 抛错的服务也可能已部分初始化，必须纳入后续清理。
              started.push(service)
              service.start()
            }
            upstream.metadataDictionary?.reenrichResolvedAssets?.()
          },
          stopBackgroundServices: (): void => {
            // B4：逐步独立 try/catch，任一上游 stop 抛错都不得中断其余清理；
            // 首个错误在循环末尾上抛给 teardown 统一记日志（异常绝不静默）。
            let firstError: unknown
            for (const service of started.splice(0).reverse()) {
              try {
                service.stop?.()
              } catch (error) {
                if (firstError === undefined) firstError = error
              }
            }
            if (firstError !== undefined) throw firstError
          }
        }
      })(),
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
      // K7：扫描诊断闭包（深入口缺席即不挂键；绑定会话 scanner）
      ...(surface.scanDiagnostics
        ? { scanDiagnostics: () => surface.scanDiagnostics!.scanDiagnosticSummary(runtime.scanner) }
        : {}),
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
        ),
      // N4：上游构造期必建的灵感仓储（老链接 session.server.inspirations 缺席时不挂键）
      ...(runtime.server.inspirations
        ? { inspirations: runtime.server.inspirations as unknown as InspirationRepositoryLike }
        : {}),
      // 4cb71e2：缩略图缓存单实例（与 server 共享）；仅构造成功时挂出。
      // F1：即使本地图标包生效也要下发，供装配层在转换器缺席时回落在线图标。
      ...(onlineThumbnailCache ? { thumbnailCache: onlineThumbnailCache } : {}),
      // a49764bb：合并后的本地图标包，供 PC 端装配层在画廊侧复用同一实例
      ...(localClothingIcons ? { localClothingIcons } : {})
    })
  } catch (error) {
    // G6：只记聚合阶段与错误类别，绝不把本机路径/UID/原始异常文本写盘。
    diagnostics('startup-error.log', {
      stage: 'session-assembly',
      code: error instanceof Error ? error.name : 'unknown'
    })
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
    createSession: (options) =>
      createRuntimeSession({
        ...options,
        onWarning: options.onWarning ?? ((message) => log('warn', message))
      }),
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
