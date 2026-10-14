// @core-change: sync-integration 阶段3：新增 NikkiSync 同步服务的启停/配对码/设备管理 6 个方法
// 内嵌运行时命名空间：对应主进程 handlers/nikkisync-handler.ts 注册的 nikkisync:* 通道。
// 返回体为 NikkiSync 协议 DTO（由上游 row-mappers 产出），本层不解包、不改字段名。
import { call } from '../ipc'
import type {
  NikkiSyncAssetPageInfo,
  NikkiSyncAssetQueryInfo,
  NikkiSyncPairedDeviceInfo,
  NikkiSyncPairingCodeInfo,
  NikkiSyncResourceQueryInfo,
  NikkiSyncRuntimeStatusInfo,
  NikkiSyncScanInputInfo,
  NikkiSyncServerStatusInfo,
  NikkiSyncSyncStartInputInfo
} from '../../../shared/types/electron-api'

/** electronAPI.nikkisync：内嵌 NikkiSync Runtime（状态 / 扫描 / 资产只读查询 / 局域网同步服务） */
export const nikkisyncAPI = {
  /** 状态机快照：未启用/未建链也能拿到可读原因与修复指令 */
  getRuntimeStatus: () => call<NikkiSyncRuntimeStatusInfo>('nikkisync:runtime-status'),
  /** 触发上游扫描（缺省全量；path 走按 uid 收敛的增量；gameRoot 变更由主进程重建会话） */
  startScan: (input?: NikkiSyncScanInputInfo) => call<unknown>('nikkisync:start-scan', input ?? {}),
  /** 分页查询资产摘要（游标为上游 base64url `{t,id}` 编码，原样回传即可翻页） */
  getAssets: (input?: NikkiSyncAssetQueryInfo) =>
    call<NikkiSyncAssetPageInfo>('nikkisync:get-assets', input ?? {}),
  /** 单资产详情：含 resources 与 motion 配对段（motion_photo 的静图+视频聚合结论） */
  getAssetDetail: (assetId: string) => call<unknown>('nikkisync:get-asset-detail', assetId),
  /** 资源元信息（默认）或上游落库的绝对路径（mode:'path'） */
  getResource: (input: NikkiSyncResourceQueryInfo) =>
    call<unknown>('nikkisync:get-resource', input),
  // ---- 阶段 3：上游 LocalSyncServer 的启停与配对管理 ----
  /** 同步服务状态；句柄未装配时 `{ available: false }`（不抛） */
  getServerStatus: () => call<NikkiSyncServerStatusInfo>('nikkisync:server-status'),
  /** 启动同步服务（端口/mdns 变更由主进程重建会话；端口占用以 error=PORT_IN_USE 呈现） */
  startServer: (input?: NikkiSyncSyncStartInputInfo) =>
    call<NikkiSyncServerStatusInfo>('nikkisync:start-server', input ?? {}),
  stopServer: () => call<NikkiSyncServerStatusInfo>('nikkisync:stop-server'),
  /** 一次性配对二维码内容（NS1 七段；TTL 5 分钟、单次消费，SVG 渲染属渲染层） */
  getPairingCode: () => call<NikkiSyncPairingCodeInfo>('nikkisync:get-pairing-code'),
  /** 已配对设备列表（直接查 NikkiSync 的 paired_devices，仅未撤销） */
  getPairedDevices: () => call<NikkiSyncPairedDeviceInfo[]>('nikkisync:get-paired-devices'),
  /** 撤销设备（上游 PairingRepository.revoke，软删 revoked_at；不断已有 WS 连接） */
  revokeDevice: (deviceId: string) =>
    call<NikkiSyncPairedDeviceInfo[]>('nikkisync:revoke-device', deviceId)
}
