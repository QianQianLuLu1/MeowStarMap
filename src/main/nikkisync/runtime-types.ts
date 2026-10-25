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
  /** 元数据解析状态（阶段 6；未组装会话时缺省）。 */
  metadata?: NikkiSyncMetadataResolutionStatus
  /** 兼容层（b422193）：真实发生的启动阶段记录（K1 在自身编排点自报，非上游枚举照抄）。 */
  startupStages?: { stage: string; at: string }[]
  /** 兼容层（b422193）：扫描诊断聚合计数（K7 消费；上游承诺不含路径/UID/错误原文）。 */
  scanDiagnostics?: unknown
}

/**
 * 上游 `metadata/MetadataResolutionDiagnostics.ts` 的返回形状（阶段 6，逐字对齐、不改字段名）。
 * 全部是**聚合计数**：上游注释即承诺绝不序列化行、原始信封或错误原文，因此可直接进 IPC 响应体。
 */
export interface NikkiSyncMetadataCounters {
  schemaVersion: number
  generatedAt: string
  resolverEnabled: boolean
  ordinaryPhotos: number
  withNativeToken: number
  withCompleteEnvelope: number
  resolved: number
  failed: number
  pending: number
  withOutfit: number
  withCamera: number
  motionPhotos: number
  /** 失败归类（`networkOrTimeout` / `http` / `incompleteEnvelope` / `invalidResponse` / …）。 */
  failureCategories: Record<string, number>
}

/** 元数据解析快照：开关事实 + 实际下传的端点 + 上游计数 + 本次驱动的结果。 */
export interface NikkiSyncMetadataResolutionStatus {
  enabled: boolean
  /** 显式下传的 https 端点（不来自渲染层输入，供设置页逐字披露）。 */
  endpoint: string
  /** 上游聚合计数；库尚未建成时缺省。 */
  counters?: NikkiSyncMetadataCounters
  /** 最近一次扫描后驱动的统计（轮次 / 解析条数 / 是否被代次或故障收尾）。 */
  lastDrive?: { passes: number; resolved: number; aborted: boolean; failed: boolean }
}

/** 同意状态（`nikkisync:get-metadata-consent` 的响应体形状）。 */
export interface NikkiSyncMetadataConsentState {
  enabled: boolean
  policyVersion: string
  recipients: Array<{ name: string; endpoint: string; fields: string[] }>
}

/**
 * K3：游戏版本推断结果（上游 `GameVersionCalendar` 静态表，纯本地无出站）。
 * 两键缺省 = 无法推断（早于 1.0 / 缺 capturedAt / 非法输入）——不伪造版本。
 */
export interface NikkiSyncGameVersionView {
  version?: string
  /** 命中版本的生效时间（维护开服边界，上游表反查）。 */
  effectiveAt?: string
}

/**
 * 上游 `metadata/MetadataOnlineConsent.ts` 的本仓最小面（K2）。
 * 仅在「解析开启 && consentFile 给出 && 深入口在位」时挂上会话；`guard()` 是
 * facade 内部的包装动作，不出会话面。`state().recipients[].endpoint` 由上游脱敏
 * （剥 userinfo/query/hash），可直接进 IPC 响应体。
 */
export interface NikkiSyncMetadataConsent {
  state(): NikkiSyncMetadataConsentState
  /** policyVersion 不匹配时上游抛错（中文原生文案，handler 层映射、不透传渲染层）。 */
  setEnabled(enabled: boolean, policyVersion?: string): void
  /** 撤回时中止在途请求（上游 `setEnabled(false)` 内部也会调用）。 */
  abortPending(): void
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
  /** 兼容层（b422193）：全部扫描根（自动根 + 额外目录，上游做父目录折叠去重）。 */
  getScanRoots(): unknown[]
  /** 兼容层（b422193）：游戏安装推断的自动扫描根（photo/motion/supplemental，K6 消费）。 */
  getAutomaticRoots(): unknown[]
  /** 兼容层（b422193）：已配置的额外照片目录数（K6 消费）。 */
  getExtraDirectoryCount(): number
  /** 兼容层（b422193）：设置额外照片目录并触发重扫（K6 消费；上限 16 由上游自校验）。 */
  setExtraDirectories(dirs: unknown[]): Promise<unknown>
}

/**
 * 上游 `organizer/DeletionQueue.ts` 的本仓最小面（兼容层 b422193，构造期必建于
 * `runtime.ts:65`）。五个公开方法逐字对齐上游签名；**刻意不含 `sync`**——那是手机端
 * 经 `POST /v1/organizer/sync` 路由的动作，本仓不直调；`preview` 同理留待 K8 需要
 * 时再声明。上游抛错（`not_pending` / `phone_offline` / `invalid_ids` / `stopping`）
 * 原样上抛，由 handler 层映射（02 计划 K8-c）；`stop()` 仅在会话拆除链调用。
 */
export interface DeletionQueueLike {
  list(device?: string): unknown[]
  decide(id: string, approve: boolean): Promise<unknown>
  approveMany(ids: string[]): Promise<unknown>
  activity(): unknown
  stop(): Promise<void>
}

/**
 * K6：上游 `scanner/ExtraScanDirectories.ts` 的本仓最小面。
 * 目录清单持久化在上游 0600 JSON（`extraDirectoriesFile` 指定路径，**单一真相源**，
 * 不落本仓设置键）；上限 16、模式折叠、重叠判定全由上游实现承担。
 * `state()`/`inspect()` 的返回含上游中文串（message/hint）——handler 层剔除后透出。
 */
export interface ExtraScanDirectoriesLike {
  state(): unknown
  inspect(selected: string): Promise<unknown>
  add(id: string): Promise<unknown>
  remove(id: string): Promise<unknown>
  rescan(): Promise<unknown>
}

/** `PcCompanionRuntime` 中被本阶段用到的最小面。 */
export interface EmbeddedRuntimeLike {
  readonly database: DatabaseManagerLike
  readonly scanner: ScannerServiceLike
  /** 上游构造期即组装好的局域网同步服务器（含 TLS 身份、鉴权、配对、WS、mDNS）。 */
  readonly server: LocalSyncServerLike
  /**
   * 上游一次性配对二维码内容：单 host 为 `NS1|` 七段；携带多 host 时为
   * `nikki-sync://pair?` 查询串（兼容层 b422193，行为面 K5 接入）。
   */
  createPairingUri(host: string, ttlMs?: number, hosts?: readonly string[]): string
  /**
   * 兼容层（b422193）：上游构造期即组装的整理队列（批量删除）。本轮仅暴露引用，
   * PC 侧动作归 K8；未接入前不产生任何行为（`POST /v1/organizer/sync` 由上游
   * 内建 404 兜底对旧客户端语义安全）。
   */
  readonly deletions: DeletionQueueLike
  /**
   * 阶段 6：上游元数据解析服务。仅当构造时下发了 `metadataResolver` 配置键才存在
   * （`runtime.ts:74-81` 的条件构造），未开启时为 undefined ⇒ 拆除面的 no-op 分支。
   */
  readonly metadataResolver?: MetadataResolverServiceLike
}

/**
 * 上游 `metadata/MetadataResolverService.ts` 的本仓最小面（阶段 6）。
 *
 * 三个方法都逐字对齐上游公开面；其中 **`start()` 本仓永不调用**：
 * 它是上游 15s 自轮询的唯一 arm 点，而上游 `runtime.start()` 把 `scanner.start()`
 * 当硬前置并随后无条件启 LAN 服务（绑 `0.0.0.0`），本仓的 LAN 服务是显式 opt-in 的。
 * 解析改由本仓在扫描结束后有界驱动 `runOnce()`，并在拆除期调 `stop()` 兜底。
 */
export interface MetadataResolverServiceLike {
  start(): void
  stop(): void
  runOnce(): Promise<number>
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
  /**
   * 兼容层（b422193）：`/v1/server` 响应的备选地址回调（上游截 8 条）。
   * 构造期冻结、缺省时连键都不下发（响应不含 `connectionHosts`）；K5 接线。
   */
  connectionHosts?: () => string[]
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
  /** 兼容层（b422193）：`/v1/server` 下发的备选地址（≤8；未配置时缺省，K5）。 */
  connectionHosts?: string[]
  /** 兼容层（b422193）：连接诊断快照（K4 自建观测面，仅聚合既有状态，不做主动探测）。 */
  diagnostics?: unknown
}

/** 一次性配对二维码内容。 */
export interface NikkiSyncPairingCode {
  content: string
  expiresAt: string
  serverId: string
  host: string
  port: number
  tlsFingerprintSha256: string
  /** 兼容层（b422193）：多 host 配对时的备选地址（单 host NS1 形态缺省；K5）。 */
  hosts?: string[]
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
  /**
   * 上游 `runtime.createPairingUri`：一次性配对二维码内容。第三参 `hosts`
   * 为兼容层（b422193）透传缝，行为面 K5 接入；单 host 形态逐字节不变。
   */
  pairingUri(host: string, ttlMs?: number, hosts?: readonly string[]): string
  /** 兼容层（b422193）：上游构造期必建的整理队列（同一引用透传，动作面归 K8）。 */
  deletions: DeletionQueueLike
  /** 已配对（未撤销）设备列表。 */
  listPairedDevices(): NikkiSyncPairedDeviceView[]
  /** 走上游 `PairingRepository.revoke`；设备不存在或已撤销返回 false。 */
  revokePairedDevice(deviceId: string): boolean
  /**
   * 阶段 6：停上游元数据服务。**未开启时是 no-op**（上游句柄为 undefined）。
   * 拆除期必须早于 `dispose()`：库关闭后 `runOnce()` 的 DB 错误会以未捕获 rejection 上抛。
   */
  stopMetadataResolver(): void
  /**
   * 阶段 6：**仅在上游服务存在时**才有此方法（编排层据此判 0 轮，不必再读开关）。
   * 写成属性而非方法：契约是「已绑定好的闭包」，驱动层把它摘下来单独调用时不依赖 `this`
   * （`runtime-facade` 正是以箭头函数赋值，上游 `runOnce()` 内部的 `this` 已在闭包内绑定）。
   * 返回值 = 本轮解析成功的资产数，逐字透传上游 `runOnce()`。
   */
  metadataRunOnce?: () => Promise<number>
  /**
   * 阶段 6：上游聚合诊断（纯 SELECT）。未开启时同样可读——用于如实呈现
   * 「有 N 张照片带完整信封但一条都没解析」这类状态，而不是伪装成空。
   */
  metadataDiagnostics(): unknown
  /**
   * 兼容层（b422193）：缓存解码元数据的**同步**驱动闭包（上游
   * `CachedDecodedMetadataService.runOnce(): number` 返回值逐字透传）。
   * 仅在深入口模块装载成功时挂出（沿 `metadataRunOnce` 的「仅存在时挂出」先例）；
   * K1 在启动后与手动扫描后各调用一次，本层不接定时器。
   */
  cachedMetadataRunOnce?: () => number
  /**
   * K2：在线解析同意面。仅「解析开启 && consentFile 给出 && 深入口在位」时挂出；
   * 缺席 = 该会话没有可管理的同意（解析关闭或老链接），manager 层据此抛
   * unavailable、handler 映射 PRECONDITION_FAILED。
   */
  metadataConsent?: NikkiSyncMetadataConsent
  /**
   * K3：按拍摄时间推断游戏版本（上游静态表纯函数经 facade 接线）。
   * 深入口缺席（老 surface）时恒返回两键缺省，不抛。
   */
  resolveGameVersion(capturedAt?: string): NikkiSyncGameVersionView
  /**
   * K6：额外照片目录管理面（上游 ExtraScanDirectories 深入口）。
   * 仅 `extraDirectoriesFile` 给出且深入口在位时挂出；缺席 ⇒ manager 抛 unavailable。
   */
  extraDirectories?: ExtraScanDirectoriesLike
  /**
   * K7：扫描诊断快照闭包（上游 `scanDiagnosticSummary(scanner)`——仅计数，绝不
   * 序列化路径/UID/文件名/原始错误）。仅深入口在位时挂出；manager 在扫描完成后
   * 调用一次并把结果放进 `runtime-status.scanDiagnostics`。
   */
  scanDiagnostics?: () => unknown
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
  /**
   * 阶段 6：是否启用上游远端元数据解析（默认关，且**关闭时连配置键都不下发**）。
   * 只能由主进程设置（env 或 `app_settings`），不接受渲染层传入的任意字符串：
   * 该开关一旦为真即产生对第三方端点的出站请求。
   */
  metadataResolverEnabled?: boolean
  /**
   * 兼容层（b422193）：上游启动阶段回调透传缝。本仓编排不调 `runtime.start()`
   * （它会无条件启 LAN 服务），上游六阶段在本仓编排下不会自然发生；K1 由
   * runtime-manager 在自身编排点自报**真实发生**的阶段，缺省时连键都不下发。
   */
  onStartupStage?: (stage: string) => void
  /**
   * 兼容层（b422193）：在线解析同意文件路径（K2 的 `MetadataOnlineConsent`
   * 深入口消费，落 `{userData}/nikkisync/metadata-online-consent.json`）。
   * 本轮仅声明透传缝，不产生行为。
   */
  consentFile?: string
  /**
   * K6：额外照片目录清单文件路径（上游 0600 JSON，`{version, directories,
   * retiredRoots}` 形状——上游文件即单一真相源，本仓不落设置键）。
   */
  extraDirectoriesFile?: string
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
  /**
   * K2：在线解析同意状态。会话未装配或同意面缺席（解析关闭/老链接）时抛
   * unavailable 语义错误，由 handler 映射 PRECONDITION_FAILED。
   */
  metadataConsentState(): NikkiSyncMetadataConsentState
  /** K2：写同意开关（policyVersion 必须与当前策略一致，上游校验）；返回更新后的状态。 */
  setMetadataConsent(enabled: boolean, policyVersion: string): NikkiSyncMetadataConsentState
  /** K3：按拍摄时间推断游戏版本（两键缺省 = 无法推断）。 */
  resolveGameVersion(capturedAt?: string): Promise<NikkiSyncGameVersionView>
  /** K6：目录状态（directories/automaticRoots/busy/scannerStatus；中文 message 由 handler 剔除）。 */
  extraDirectoriesState(): unknown
  /** K6：预检目录（提案 id/roots/images/videos/limited；中文 hint 由 handler 剔除）。 */
  inspectExtraDirectory(path: string): Promise<unknown>
  /** K6：按预检 id 加入目录清单（触发上游重扫）。 */
  addExtraDirectory(id: string): Promise<unknown>
  /** K6：按目录 id 移除（触发上游重扫）。 */
  removeExtraDirectory(id: string): Promise<unknown>
  /** K6：手动重扫全部目录。 */
  rescanExtraDirectories(): Promise<unknown>
}
