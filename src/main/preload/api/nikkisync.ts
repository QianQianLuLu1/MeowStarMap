// @core-change: K3 新增 resolveGameVersion 桥方法（游戏版本推断，纯本地静态表查询）。
//               （历史：阶段3-4 建查询/服务/扩容面、K2 增同意开关两方法——历次授权原因见各节点提交。）
// 内嵌运行时命名空间：对应主进程 handlers/nikkisync-handler.ts 注册的 nikkisync:* 通道。
// 返回体为 NikkiSync 协议 DTO（由上游 row-mappers 产出），本层不解包、不改字段名。
import { call, subscribe } from '../ipc'
import type {
  NikkiSyncAssetDetailInfo,
  NikkiSyncAssetPageInfo,
  NikkiSyncAssetQueryInfo,
  NikkiSyncChangesInfo,
  NikkiSyncChangesQueryInfo,
  NikkiSyncClothingSearchInfo,
  NikkiSyncMetadataConsentInfo,
  NikkiSyncMetadataConsentSetInput,
  NikkiSyncGameVersionInfo,
  NikkiSyncGameVersionQueryInfo,
  NikkiSyncPairedDeviceInfo,
  NikkiSyncPairingCodeInfo,
  NikkiSyncProfileStatsInfo,
  NikkiSyncResourceInfo,
  NikkiSyncResourceQueryInfo,
  NikkiSyncResourceRecordsFor,
  NikkiSyncRuntimeStatusInfo,
  NikkiSyncScanInputInfo,
  NikkiSyncSearchQueryInfo,
  NikkiSyncServerStatusInfo,
  NikkiSyncSuitSearchInfo,
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
  getAssetDetail: (assetId: string) =>
    call<NikkiSyncAssetDetailInfo>('nikkisync:get-asset-detail', assetId),
  /** 资源元信息（默认）或上游落库的绝对路径（mode:'path'） */
  getResource: (input: NikkiSyncResourceQueryInfo) =>
    call<NikkiSyncResourceInfo>('nikkisync:get-resource', input),
  // ---- 阶段 4：查询面扩容（图库数据层切换所需；均为一条通道一行转发）----
  /** 批量资源：一页资产一次往返，避免逐资产 500 次 IPC；mode 决定返回记录表还是路径表 */
  getResourceRecords: <M extends 'meta' | 'path'>(input: { assetIds: string[]; mode: M }) =>
    call<NikkiSyncResourceRecordsFor<M>>('nikkisync:get-resource-records', input),
  /** 增量变更（GET /v1/changes 的本地等价调用）；fullResyncRequired 为真时须重置游标 */
  getChanges: (input: NikkiSyncChangesQueryInfo) =>
    call<NikkiSyncChangesInfo>('nikkisync:get-changes', input),
  /** 套装搜索：转发上游 SuitSearchIndex，query 原样下传 */
  searchSuits: (input: NikkiSyncSearchQueryInfo) =>
    call<NikkiSyncSuitSearchInfo>('nikkisync:search-suits', input),
  /** 服装搜索：转发上游 ClothingSearchIndex */
  searchClothing: (input: NikkiSyncSearchQueryInfo) =>
    call<NikkiSyncClothingSearchInfo>('nikkisync:search-clothing', input),
  /** 档案统计：转发上游 ProfileStatsIndex */
  profileStats: () => call<NikkiSyncProfileStatsInfo>('nikkisync:profile-stats'),
  /** 订阅「资产库已变更」（扫描成功返回后由主进程推送）；返回退订函数 */
  onLibraryChanged: (cb: () => void) => subscribe('nikkisync:library-changed', cb),
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
    call<NikkiSyncPairedDeviceInfo[]>('nikkisync:revoke-device', deviceId),
  // ---- K2：在线解析同意（解析开启的会话上才有；否则 PRECONDITION_FAILED）----
  /** 同意状态（enabled/policyVersion/recipients，endpoint 由上游脱敏） */
  getMetadataConsent: () => call<NikkiSyncMetadataConsentInfo>('nikkisync:get-metadata-consent'),
  /** 写同意开关：policyVersion 必须取自 getMetadataConsent 的展示值原串带回 */
  setMetadataConsent: (input: NikkiSyncMetadataConsentSetInput) =>
    call<NikkiSyncMetadataConsentInfo>('nikkisync:set-metadata-consent', input),
  // ---- K3：游戏版本推断（上游静态表，纯本地无出站）----
  /** 按拍摄时间推断游戏版本；两键缺省 = 无法推断（早于 1.0 / 非法输入 / 未装配） */
  resolveGameVersion: (input?: NikkiSyncGameVersionQueryInfo) =>
    call<NikkiSyncGameVersionInfo>('nikkisync:resolve-game-version', input ?? {})
}
