/**
 * HTTP 服务器层依赖的最小服务端口。
 *
 * - SyncApiServices：由装配层用 SyncReadRepository（阶段 2 读取仓储）+
 *   SyncMetadataRepository（revision/身份）+ AuthService（阶段 3 验签）+
 *   PairingService（阶段 3 配对）实现；测试注入内存替身
 *   （原生 better-sqlite3 无法在 vitest/Node 下加载，见集成测试文件头）。
 * - SyncEventSink：写路径 handler 的变更汇入口（装配层实现）——
 *   journal 永远写（服务器未运行也写，保证 /v1/changes 完整），广播仅运行时进行。
 */

import type {
  AssetDetailResponse,
  AssetListQuery,
  AssetListResponse,
  ChangeType,
  ChangesResponse,
  MediaResource,
  PairRequest,
  PairResponse,
  Revision,
  ServerInfoResponse
} from '../../../shared/sync/protocol'
import type { AuthRequestInput, AuthResult } from '../auth-service'

export interface SyncApiServices {
  getServerInfo(): Promise<ServerInfoResponse>
  getServerIdentity(): Promise<{ serverId: string; serverName: string }>
  getCurrentRevision(): Revision
  listAssets(query: AssetListQuery): AssetListResponse
  getAssetDetail(assetId: string): Promise<AssetDetailResponse | null>
  getResourceLocation(
    assetId: string,
    resourceId: string
  ): Promise<{ resource: MediaResource; absolutePath: string } | null>
  getChanges(after: Revision, limit?: number): Promise<ChangesResponse>
  verifyRequest(input: AuthRequestInput): Promise<AuthResult>
  redeemToken(request: PairRequest): Promise<PairResponse>
}

export interface AssetChangeInput {
  eventType: ChangeType
  assetId: string
}

export interface SyncEventSink {
  /** 单条变更：写 journal + 运行时广播 asset.created/updated/deleted */
  recordAssetChange(eventType: ChangeType, assetId: string): Promise<void>
  /** 批量变更（扫描）：逐条写 journal 但不逐条广播（避免移动端事件风暴） */
  recordAssetChanges(changes: ReadonlyArray<AssetChangeInput>): Promise<number>
  /** 广播 library.rescan.started（不写 journal，WsEvent 专属） */
  broadcastRescanStarted(): Promise<void>
  /** 广播 library.rescan.completed（不写 journal，WsEvent 专属） */
  broadcastRescanCompleted(changedAssets: number): Promise<void>
}

// ============================================================================
// 装配层句柄（类型放此处供 ipc/handler-context 引用，避免 ipc→app 类型循环依赖；
// 实现在 src/main/app/sync-server-setup.ts，纯接口无 electron 依赖）
// ============================================================================

export interface SyncServerStatusInfo {
  available: boolean
  running: boolean
  host: string
  port: number
  connections: number
  serverId: string | null
  serverName: string | null
  pairedDeviceCount: number
  tlsFingerprintSha256: string | null
  lanHost: string
}

export interface PairingQrInfo {
  /** NS1|... 七段二维码内容（渲染层直接生成 QR 图像） */
  content: string
  expiresAt: string
  serverId: string
  host: string
  port: number
  tlsFingerprintSha256: string
}

export interface SyncServerHandle {
  /** 事件汇：写路径 handler 经 ctx.syncEvents 调用（不依赖服务器运行状态） */
  events: SyncEventSink
  start(): Promise<void>
  stop(): Promise<void>
  getStatus(): Promise<SyncServerStatusInfo>
  createPairingQr(): Promise<PairingQrInfo>
}
