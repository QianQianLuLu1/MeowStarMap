// 数据管理命名空间：对应主进程 handlers/data-handler.ts 注册的 data:* 通道
import { call } from '../ipc'

/** electronAPI.data：数据管理 */
export const dataAPI = {
  clear: () => call<{ message: string }>('data:clear')
}
