// @core-change: 照片目录契约订正——set/resetGameRoot 由主进程落库后当场走运行期生效通道
//               （换根重建 + 全量扫描），返回体 needRestart 不再恒 true、新增可选
//               applied / applyError；本层只做透传，不改方法名与入参。
//               （历史：三通道与 admitDirectory 预检接入、K9 账号作用域、K6 目录面、K2/K3/K8
//               历次接入——见各节点提交。）
// 内嵌运行时命名空间：对应主进程 handlers/nikkisync-handler.ts 注册的 nikkisync:* 通道。
// 返回体为 NikkiSync 协议 DTO（由上游 row-mappers 产出），本层不解包、不改字段名。
import { call, subscribe } from '../ipc'
import type {
  NikkiSyncAdmitDirectoryInput,
  NikkiSyncAdmitDirectoryResult,
  NikkiSyncAssetDetailInfo,
  NikkiSyncAssetPageInfo,
  NikkiSyncAssetQueryInfo,
  NikkiSyncChangesInfo,
  NikkiSyncChangesQueryInfo,
  NikkiSyncClothingSearchInfo,
  NikkiSyncGameRootInfo,
  NikkiSyncMetadataConsentInfo,
  NikkiSyncMetadataConsentSetInput,
  NikkiSyncGameVersionInfo,
  NikkiSyncGameVersionQueryInfo,
  NikkiSyncExtraDirectoriesInfo,
  NikkiSyncExtraDirectoryProposalInfo,
  NikkiSyncExtraDirectorySourceInput,
  NikkiSyncOrganizerApproveInput,
  NikkiSyncOrganizerApproveResultInfo,
  NikkiSyncOrganizerDecideInput,
  NikkiSyncOrganizerItemInfo,
  NikkiSyncOrganizerViewInfo,
  NikkiSyncPairedDeviceInfo,
  NikkiSyncPairingCodeInfo,
  NikkiSyncProfileStatsInfo,
  NikkiSyncResetGameRootResult,
  NikkiSyncResourceInfo,
  NikkiSyncResourceQueryInfo,
  NikkiSyncResourceRecordsFor,
  NikkiSyncRuntimeStatusInfo,
  NikkiSyncScanInputInfo,
  NikkiSyncSearchQueryInfo,
  NikkiSyncServerStatusInfo,
  NikkiSyncSetGameRootInput,
  NikkiSyncSetGameRootResult,
  NikkiSyncSuitSearchInfo,
  NikkiSyncSyncAccountPreviewInfo,
  NikkiSyncSyncAccountSelectionInput,
  NikkiSyncSyncAccountsInfo,
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
    call<NikkiSyncGameVersionInfo>('nikkisync:resolve-game-version', input ?? {}),
  // ---- K6：额外照片目录（仅作用于同步库扫描器，不影响本地图库扫描目录）----
  /** 目录状态（directories/automaticRoots/busy；上游中文 message 已剔除） */
  getExtraDirectories: () => call<NikkiSyncExtraDirectoriesInfo>('nikkisync:get-extra-directories'),
  /** 预检目录（返回 id/images/videos/limited 提案；中文 hint 已剔除）；source 仅支持 spinning_momo */
  inspectExtraDirectory: (input: { path: string; source?: 'spinning_momo' }) =>
    call<NikkiSyncExtraDirectoryProposalInfo>('nikkisync:inspect-extra-directory', input),
  /** 按预检 id 加入目录清单（触发上游重扫） */
  addExtraDirectory: (input: { id: string }) =>
    call<NikkiSyncExtraDirectoriesInfo>('nikkisync:add-extra-directory', input),
  /** 按目录 id 移除（触发上游重扫） */
  removeExtraDirectory: (input: { id: string }) =>
    call<NikkiSyncExtraDirectoriesInfo>('nikkisync:remove-extra-directory', input),
  /** 标注目录来源（spinning_momo / other；仅 images 目录），并触发账号来源组刷新 */
  setExtraDirectorySource: (input: NikkiSyncExtraDirectorySourceInput) =>
    call<NikkiSyncExtraDirectoriesInfo>('nikkisync:set-extra-directory-source', input),
  /** 手动重扫全部目录 */
  rescanExtraDirectories: () =>
    call<NikkiSyncExtraDirectoriesInfo>('nikkisync:rescan-extra-directories'),
  // ---- 照片目录自定义（gameRoot 替代默认路径；admit 供 K6 手输预检）----
  /** 读取持久化的照片根目录（'' = 未设置，走上游自动发现；不经运行时，未启用也可读） */
  getGameRoot: () => call<NikkiSyncGameRootInfo>('nikkisync:get-game-root'),
  /** 校验并持久化自定义照片根目录，并当场换根重建 + 重扫；writable 仅提示（只读目录合法），
   * applied = 已立即生效，needRestart 仅在未能当场生效时为 true（applyError 给分类原因） */
  setGameRoot: (input: NikkiSyncSetGameRootInput) =>
    call<NikkiSyncSetGameRootResult>('nikkisync:set-game-root', input),
  /** 清空自定义照片根目录（回退上游自动发现），同样当场生效；未生效时才需要重启 */
  resetGameRoot: () => call<NikkiSyncResetGameRootResult>('nikkisync:reset-game-root'),
  /** K6 手输路径预检：主进程校验并登记 pathGuard，随后即可走 inspectExtraDirectory */
  admitDirectory: (input: NikkiSyncAdmitDirectoryInput) =>
    call<NikkiSyncAdmitDirectoryResult>('nikkisync:admit-directory', input),
  // ---- K9：账号同步作用域（手机只同步勾选账号；选择存上游 app_settings）----
  /** 账号分组与选择状态（上游中文 label 已剔除；null/undefined 选择在响应里体现为 all=true） */
  getSyncAccounts: () => call<NikkiSyncSyncAccountsInfo>('nikkisync:get-sync-accounts'),
  /** 账号样例缩略图（assetId → 上游优先资源；不存在时 NOT_FOUND） */
  previewSyncAccount: (input: { assetId: string }) =>
    call<NikkiSyncSyncAccountPreviewInfo>('nikkisync:preview-sync-account', input),
  /** 保存账号选择（null = 全部；[] = 不同步任何账号），返回更新后的状态并触发图库刷新 */
  setSyncAccountSelection: (input: NikkiSyncSyncAccountSelectionInput) =>
    call<NikkiSyncSyncAccountsInfo>('nikkisync:set-sync-account-selection', input),
  // ---- K8：整理队列（批量删除；开关默认关，破坏性动作由页面确认弹窗把关）----
  /** 队列视图（list 剔除中文 message + activity 计数；开关关闭时 PRECONDITION_FAILED） */
  getOrganizerQueue: () => call<NikkiSyncOrganizerViewInfo>('nikkisync:get-organizer-queue'),
  /** 单条批准/拒绝（返回更新后的队列行列表；not_pending/phone_offline 由通道映射错误码） */
  decideOrganizerItem: (input: NikkiSyncOrganizerDecideInput) =>
    call<NikkiSyncOrganizerItemInfo[]>('nikkisync:decide-organizer-item', input),
  /** 批量批准（1..500；返回 {items, approved, skipped}；重复 id 由上游 invalid_ids 拒绝） */
  approveOrganizerItems: (input: NikkiSyncOrganizerApproveInput) =>
    call<NikkiSyncOrganizerApproveResultInfo>('nikkisync:approve-organizer-items', input)
}
