// @core-change: sync-integration 阶段2：新增 nikkisync 命名空间桥接（内嵌 NikkiSync Runtime 的只读查询面）
// 内嵌运行时命名空间：对应主进程 handlers/nikkisync-handler.ts 注册的 nikkisync:* 通道。
// 返回体为 NikkiSync 协议 DTO（由上游 row-mappers 产出），本层不解包、不改字段名。
import { call } from '../ipc'
import type {
  NikkiSyncAssetPageInfo,
  NikkiSyncAssetQueryInfo,
  NikkiSyncResourceQueryInfo,
  NikkiSyncScanInputInfo,
  NikkiSyncRuntimeStatusInfo
} from '../../../shared/types/electron-api'

/** electronAPI.nikkisync：内嵌 NikkiSync Runtime（状态 / 扫描 / 资产只读查询） */
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
  getResource: (input: NikkiSyncResourceQueryInfo) => call<unknown>('nikkisync:get-resource', input)
}
