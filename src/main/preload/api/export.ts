// 导出偏好命名空间：对应主进程 handlers/export-pref-handler.ts 注册的 export:* 通道
import { call } from '../ipc'

/** electronAPI.export：安全敏感导出偏好专用通道 */
export const exportAPI = {
  // 安全敏感项专用通道，settings:set 会拒绝 export.defaultDir / export.namingPattern
  setDefaultDir: (dir: string) => call<{ saved: boolean }>('export:setDefaultDir', dir),
  setNamingPattern: (pattern: string) =>
    call<{ saved: boolean }>('export:setNamingPattern', pattern)
}
