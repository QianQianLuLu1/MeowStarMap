// @core-change: settings:set 返回类型对齐 { saved, synced?, skipped? } 真实响应结构
// 应用设置命名空间：对应主进程 handlers/settings-handler.ts 注册的 settings:* 通道
import { call } from '../ipc'

/** settings:set 的 launchAtLogin 分支额外回传 OS 登录项同步结果，其余分支仅有 saved */
export interface SettingsSetResult {
  saved: boolean
  synced?: boolean
  skipped?: 'dev'
}

/** electronAPI.settings：应用键值设置读写 */
export const settingsAPI = {
  get: (key: string, defaultValue?: unknown) => call<unknown>('settings:get', key, defaultValue),
  set: (key: string, value: unknown) => call<SettingsSetResult>('settings:set', key, value)
}
