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
  /** 已启用同步器时：`scanner.getStatus()` 原样透传（installation / lastScan / status）。 */
  scanner?: unknown
  /** 已建的表名（`sqlite_master` 原样），未建库时缺省。 */
  tables?: string[]
  /** 最近一次失败的原始原因（英文）。 */
  error?: string
  /** 失败时给出可直接执行的修复指令（英文）。 */
  hint?: string
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

/** `PcCompanionRuntime` 中被本阶段用到的最小面（本阶段不触碰 `server`）。 */
export interface EmbeddedRuntimeLike {
  readonly database: DatabaseManagerLike
  readonly scanner: ScannerServiceLike
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
}

/** 装载 + 组装后的会话句柄（`runtime-facade.ts` 产出，`runtime-manager.ts` 持有）。 */
export interface NikkiSyncRuntimeSession {
  runtime: EmbeddedRuntimeLike
  scanner: ScannerServiceLike
  queries: NikkiSyncQuerySurface
  /** `sqlite_master` 中的表名（验收项「表结构完整」用）。 */
  tableNames(): string[]
  dispose(): void
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
}
