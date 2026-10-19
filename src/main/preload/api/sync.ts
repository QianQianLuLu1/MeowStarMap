// @core-change: sync-integration 阶段5：新增 sync 命名空间桥接（同步服务器状态/启停/配对二维码/设备管理）
// 同步服务命名空间（sync-integration 阶段5）：对应主进程 handlers/sync-handler.ts 注册的 sync:* 通道
import { call } from '../ipc'
import type {
  PairingQrInfo,
  SyncDeviceInfo,
  SyncServerStatusInfo
} from '../../../shared/types/electron-api'

/** electronAPI.sync：NikkiSync 同步服务器（状态/启停/配对二维码/设备管理） */
export const syncAPI = {
  getStatus: () => call<SyncServerStatusInfo>('sync:getStatus'),
  startServer: () => call<SyncServerStatusInfo>('sync:startServer'),
  stopServer: () => call<SyncServerStatusInfo>('sync:stopServer'),
  /** 一次性配对二维码内容（NS1 七段串）；服务器未运行时抛错（UI 以禁用态规避） */
  createPairingQr: () => call<PairingQrInfo>('sync:createPairingQr'),
  /** 已配对设备列表（仅活跃设备，撤销后不再返回） */
  listDevices: () => call<SyncDeviceInfo[]>('sync:listDevices'),
  /** 撤销设备（软删 revoked_at；不踢已建立 WS 连接），返回刷新后的活跃列表 */
  revokeDevice: (deviceId: string) => call<SyncDeviceInfo[]>('sync:revokeDevice', deviceId)
}
