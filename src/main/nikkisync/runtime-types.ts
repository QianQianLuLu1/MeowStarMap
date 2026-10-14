/**
 * NikkiSync 内嵌运行时的本仓结构面类型（整合阶段 2）。
 *
 * 为什么自己声明而不是 `import type '@nikkisync/*'`（阶段 9 自包含决策，见
 * docs/sync-integration/09-legacy-debt-remediation-plan.md §1）：`@nikkisync/*` 不是
 * `package.json` 声明依赖，未建链的机器（CI）上任何上游类型引用都会退化成 4×TS2307，
 * 直接阻塞 `tsc -b`。这里只声明「本阶段真正调用到的最小面」，运行时的真实性由
 * `runtime-loader.ts` 的 `NIKKISYNC_REQUIRED_EXPORTS` 探针与 `protocol-drift.test.ts` 承担。
 *
 * 上游对应物（`NikkiSync@main`）：
 * - `EmbeddedRuntimeLike` ← `apps/pc-companion/src/runtime.ts` 的 `PcCompanionRuntime`
 * - `ScannerServiceLike`  ← `apps/pc-companion/src/scanner/ScannerService.ts`
 * - `DatabaseManagerLike` ← `packages/database/src/database-manager.ts`
 * - `NikkiSyncQuerySurface` ← `packages/database/src/sync-read-repository.ts` + `server/row-mappers.ts`
 * - `LocalSyncServerLike` / `NikkiSyncSyncServer*` ← `apps/pc-companion/src/server/LocalSyncServer.ts`
 *   （阶段 3：本仓只声明并调用上游已有的服务面，不新增任何网络实现）
 *
 * 字符串字面量保持英文（src/** 的中文硬编码护栏为 error）。
 */

import type { PackagingContext } from './embedding-paths'

/** 内嵌 Runtime 的进程内状态（唯一真相源：`runtime-manager.ts` 的状态机）。 */
export type NikkiSyncRuntimeState =
  'unavailable' | 'idle' | 'starting' | 'running' | 'scanning' | 'degraded' | 'stopping' | 'error'

/** 渲染进程可见的状态快照（`nikkisync:runtime-status` 的响应体）。 */
export interface NikkiSyncRuntimeStatus {
  state: NikkiSyncRuntimeState
  /** NikkiSync 库文件绝对路径（userData 下，非上游默认 %LOCALAPPDATA%）。 */
  dbPath: string
  /** `node_modules/@nikkisync/*` 四包是否齐备（按包内 package.json 判定）。 */
  linkReady: boolean
  /** 上游 `scanner.getStatus().status`（stopped/discovering/scanning/reconciling/running/error）。 */
  scannerStatus?: string
  /** 上游发现的安装结果 `InfinityNikkiInstallation`（installRoot / x6GameRoot / photoRoots / motionRoots / source）。 */
  installation?: unknown
  /** 上游最近一次 `ScanResult` 原样透传。 */
  lastScan?: unknown
  /** 已建的表名（`sqlite_master` 原样），未建库时缺省。 */
  tables?: string[]
  /** 最近一次失败的原始原因（英文）。 */
  error?: string
  /** 失败时给出可直接执行的修复指令（英文）。 */
  hint?: string
  /** 局域网同步服务状态（阶段 3；未组装会话时缺省）。 */
  sync?: NikkiSyncSyncServerStatus
}

/** `DatabaseManager` 中被本阶段用到的最小面。 */
export interface DatabaseConnectionLike {
  prepare(sql: string): { all(...values: unknown[]): unknown[]; get(...values: unknown[]): unknown }
  exec(sql: string): void
  close(): void
}

export interface DatabaseManagerLike {
  readonly connection: DatabaseConnectionLike
  initialize(schemaSql?: string): void
  close(): void
}

/** `ScannerService` 中被本阶段用到的最小面（扫描逻辑全部留在上游）。 */
export interface ScannerServiceLike {
  start(): Promise<unknown>
  stop(): Promise<void>
  fullScan(): Promise<unknown>
  rescanPath(filePath: string): Promise<unknown>
  getStatus(): unknown
}

/** `PcCompanionRuntime` 中被本阶段用到的最小面。 */
export interface EmbeddedRuntimeLike {
  readonly database: DatabaseManagerLike
  readonly scanner: ScannerServiceLike
  /** 上游构造期即组装好的局域网同步服务器（含 TLS 身份、鉴权、配对、WS、mDNS）。 */
  readonly server: LocalSyncServerLike
  /** 上游一次性配对二维码内容（`NS1|` 七段）。 */
  createPairingUri(host: string, ttlMs?: number): string
}

/**
 * 上游 `LocalSyncServerConfig` 的本仓最小面（`server/LocalSyncServer.ts:39-55`）。
 * **在构造期冻结**：端口/mdns 之后不可改，变更只能重建会话。
 */
export interface NikkiSyncSyncServerConfig {
  host: string
  port: number
  mdns: boolean
  name: string
  journalPollMs?: number
}

/** 上游 `LocalSyncServerAddress`（`start()` 回显的**实际**绑定地址）。 */
export interface NikkiSyncSyncServerAddress {
  host: string
  port: number
  secure: boolean
}

/**
 * 上游 `LocalSyncServer` 中被本阶段调用的最小面。
 * 注意 `AuthService` / `PairingService` / `WebSocketHub` / `MdnsAdvertiser` 都是它内部
 * `new` 的私有成员，本仓**不**单独实例化任何一件（上游 `LocalSyncServer.ts:153-157`）。
 */
export interface LocalSyncServerLike {
  readonly serverId: string
  /** 幂等：已在监听时直接回显原地址（`LocalSyncServer.ts:175`）。 */
  start(): Promise<NikkiSyncSyncServerAddress>
  /** 置空内部句柄 ⇒ 可再次 `start()`（`LocalSyncServer.ts:193-201`）。 */
  stop(): Promise<void>
  createPairingPayload(host: string, ttlMs?: number): Record<string, unknown>
}

/** `paired_devices` 行的管理视图：只透传非敏感列（公钥与凭据哈希不出库）。 */
export interface NikkiSyncPairedDeviceView {
  deviceId: string
  deviceName: string
  platform: 'ios' | 'android'
  appVersion?: string
  pairedAt: string
  lastSeenAt: string | null
}

/** 同步服务状态快照（`nikkisync:server-status` 的响应体内核）。 */
export interface NikkiSyncSyncServerStatus {
  running: boolean
  /** 运行中取上游回显地址；未运行时回落配置值（端口冲突也要能把配置端口显示出来）。 */
  host: string
  port: number
  /** 仅在真实监听时给出（未运行时不下「是否安全」的判断）。 */
  secure?: boolean
  serverId?: string
  mdnsEnabled: boolean
  tlsFingerprintSha256?: string
  /** 自签证书 PEM（公开材料，供客户端/脚本做真校验，不含私钥）。 */
  serverCertificatePem?: string
  /** 配对二维码实际写出的局域网地址（解析不到时为回环）。 */
  lanHost?: string
  pairedDeviceCount?: number
  /** 启停失败原因；端口占用归一化为 `PORT_IN_USE`。 */
  error?: string
}

/** 一次性配对二维码内容。 */
export interface NikkiSyncPairingCode {
  content: string
  expiresAt: string
  serverId: string
  host: string
  port: number
  tlsFingerprintSha256: string
}

/** 分页查询入参：与上游 `SyncReadRepository.AssetPageQuery` 同形（游标另编）。 */
export interface NikkiSyncAssetPageQuery {
  limit: number
  cursorTime?: string
  cursorAssetId?: string
  assetType?: string
  afterRevision?: number
  includeDeleted?: boolean
}

/**
 * 只读查询面：入参/出参全部沿用上游 `SyncReadRepository` + `server/row-mappers.ts`
 * 的形状，内嵌层不做任何字段重命名或结构包装。
 */
export interface NikkiSyncQuerySurface {
  /** `{ items, nextCursor?, libraryRevision }`：与上游 `GET /v1/assets` 响应同形。 */
  listAssets(input: {
    limit: number
    cursor?: string
    type?: string
    afterRevision?: number
    includeDeleted?: boolean
  }): Promise<unknown>
  /** `AssetDetailResponse`（`mapAssetDetail` 产出）。 */
  getAssetDetail(assetId: string): Promise<unknown>
  /** `mode:'meta'` → `MediaResource`；`mode:'path'` → `resources.source_path` 原值。 */
  getResource(assetId: string, resourceId: string, mode: 'meta' | 'path'): Promise<unknown>
  /**
   * 阶段 4：批量资源记录。一次往返覆盖整页，避免逐资产 500 次 IPC。
   * `'meta'` → `{ byAsset: { [assetId]: MediaResource[] } }`；
   * `'path'` → `{ byAsset: { [assetId]: { [resourceId]: source_path } } }`（上游原值）。
   */
  listResourceRecords(assetIds: string[], mode: 'meta' | 'path'): Promise<unknown>
  /**
   * 阶段 4：增量变更。响应与上游 `GET /v1/changes` 同形
   * （`{ changes, libraryRevision, fullResyncRequired }`），判据照抄上游不作改。
   */
  listChanges(after: number, limit: number): Promise<unknown>
  /** 阶段 4：套装搜索，转发上游 `searchSuitLibrary`。 */
  searchSuits(query: string): Promise<unknown>
  /** 阶段 4：服装搜索，转发上游 `searchClothingLibrary`。 */
  searchClothing(query: string): Promise<unknown>
  /** 阶段 4：档案统计，转发上游 `buildProfileStats`。 */
  profileStats(): Promise<unknown>
}

/** 装载 + 组装后的会话句柄（`runtime-facade.ts` 产出，`runtime-manager.ts` 持有）。 */
export interface NikkiSyncRuntimeSession {
  runtime: EmbeddedRuntimeLike
  scanner: ScannerServiceLike
  queries: NikkiSyncQuerySurface
  /** `sqlite_master` 中的表名（验收项「表结构完整」用）。 */
  tableNames(): string[]
  dispose(): void
  /** 上游同步服务器本体（本仓不重新实现任何网络层，只调 start/stop）。 */
  server: LocalSyncServerLike
  /** 自签 TLS 身份（证书公开、私钥不外泄）；指纹供配对与展示。 */
  tlsIdentity(): { certPem: string; fingerprintSha256: string }
  /** 上游 `runtime.createPairingUri`：一次性配对二维码内容。 */
  pairingUri(host: string, ttlMs?: number): string
  /** 已配对（未撤销）设备列表。 */
  listPairedDevices(): NikkiSyncPairedDeviceView[]
  /** 走上游 `PairingRepository.revoke`；设备不存在或已撤销返回 false。 */
  revokePairedDevice(deviceId: string): boolean
}

/** 创建会话所需的全部输入（不含 Electron API，便于纯逻辑单测）。 */
export interface NikkiSyncSessionOptions {
  /** NikkiSync 库文件绝对路径。 */
  databaseFile: string
  /** 手工指定游戏安装根；缺省时交给上游 game-directory-discovery。 */
  gameRoot?: string
  /** 是否开启上游 fs.watch 增量监听（默认关，避免与原扫描器常态化争用）。 */
  watcher: boolean
  projectRoot: string
  packagingContext?: PackagingContext
  /** 打包态显式传入的 schema SQL 文本；开发态缺省由上游 `import.meta.url` 定位。 */
  schemaSql?: string
  /**
   * 局域网同步服务配置（阶段 3）。上游把它冻结在 `LocalSyncServer` 构造期，
   * 因此改端口/mdns 只能重建会话。**构造本身不产生任何网络副作用**：
   * `listen` 与 mDNS 组播都只在 `server.start()` 内发生。
   */
  syncServer?: NikkiSyncSyncServerConfig
}

/** IPC / 装配层消费的句柄（`ctx.nikkisyncRuntime`）。 */
export interface NikkiSyncRuntimeHandle {
  status(): NikkiSyncRuntimeStatus
  start(options: NikkiSyncSessionOptions): Promise<NikkiSyncRuntimeStatus>
  /** 触发扫描（必要时惰性启动 / 换根重建）。 */
  scan(input: { gameRoot?: string; path?: string }): Promise<unknown>
  /** 优雅停止：scanner.stop() → database.close()，幂等。 */
  stop(): Promise<void>
  listAssets(input: {
    limit: number
    cursor?: string
    type?: string
    afterRevision?: number
    includeDeleted?: boolean
  }): Promise<unknown>
  getAssetDetail(assetId: string): Promise<unknown>
  getResource(assetId: string, resourceId: string, mode?: 'meta' | 'path'): Promise<unknown>
  /** 阶段 4：批量资源记录（`queries.listResourceRecords` 的薄委托）。 */
  listResourceRecords(assetIds: string[], mode?: 'meta' | 'path'): Promise<unknown>
  /** 阶段 4：增量变更（`queries.listChanges` 的薄委托）。 */
  listChanges(after: number, limit?: number): Promise<unknown>
  /** 阶段 4：套装搜索。 */
  searchSuits(query: string): Promise<unknown>
  /** 阶段 4：服装搜索。 */
  searchClothing(query: string): Promise<unknown>
  /** 阶段 4：档案统计。 */
  profileStats(): Promise<unknown>
  /**
   * 同步服务状态（只读、无副作用地读内存状态；TLS 身份与设备数来自上游会话）。
   * 未组装会话时 `running=false` 且回落配置值。
   */
  syncStatus(): NikkiSyncSyncServerStatus
  /**
   * 启动局域网同步服务：**永不上抛**。失败（如端口占用）归一化进 `syncStatus().error`。
   * 无会话时惰性启动；`port` / `mdns` 变更走会话重建（上游配置冻结在构造期）。
   */
  startSyncServer(input?: {
    port?: number
    mdnsEnabled?: boolean
  }): Promise<NikkiSyncSyncServerStatus>
  stopSyncServer(): Promise<NikkiSyncSyncServerStatus>
  /** 一次性配对二维码；服务未运行由上游原生抛错（本层不吞、不改写文案）。 */
  pairingCode(): Promise<NikkiSyncPairingCode>
  listPairedDevices(): Promise<NikkiSyncPairedDeviceView[]>
  /** 撤销设备并返回撤销后的列表；设备不存在/已撤销上抛（由 handler 映射 notFound）。 */
  revokeDevice(deviceId: string): Promise<NikkiSyncPairedDeviceView[]>
}
