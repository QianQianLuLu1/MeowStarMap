// 应用设置命名空间：对应主进程 handlers/settings-handler.ts 注册的 settings:* 通道
import { call } from '../ipc'

/** electronAPI.settings：应用键值设置读写 */
export const settingsAPI = {
  get: (key: string, defaultValue?: unknown) => call<unknown>('settings:get', key, defaultValue),
  set: (key: string, value: unknown) => call<{ saved: boolean }>('settings:set', key, value)
}
