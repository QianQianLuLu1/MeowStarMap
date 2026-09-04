// 分享命名空间：对应主进程 handlers/share.ts 注册的 share:* 通道
import { call } from '../ipc'
import type {
  ShareCopyFilesResult,
  ShareDetectAppResult,
  ShareStartWifiResult
} from '../../../shared/types/electron-api'

/** electronAPI.share：T08 WiFi 局域网分享 + T09 剪贴板分享 */
export const shareAPI = {
  startWifi: (filePaths: string[]) => call<ShareStartWifiResult>('share:startWifi', filePaths),
  stopWifi: () => call<{ stopped: boolean }>('share:stopWifi'),
  // P0-D：删除 wifiStatus（已有 startWifi/stopWifi 满足需求）
  // T09：复制文件到剪贴板（CF_HDROP 格式）
  copyFiles: (filePaths: string[]) => call<ShareCopyFilesResult>('share:copyFiles', filePaths),
  // T09：检测渠道应用状态（installed + running + installPath）
  detectApp: (channelId: string) => call<ShareDetectAppResult>('share:detectApp', channelId),
  // T09：启动目标应用（已安装未运行时调用）
  launchApp: (channelId: string) => call<unknown>('share:launchApp', channelId)
}
