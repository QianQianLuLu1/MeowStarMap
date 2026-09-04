// 对话框命名空间：对应主进程 handlers/dialog-handler.ts 注册的 dialog:* 通道
import { call } from '../ipc'

/** electronAPI.dialog：系统对话框（目录选择 / 文件打开保存 / 消息框） */
export const dialogAPI = {
  // dialog:* 系列在用户取消时返回 null（由主进程 handler 决定），不抛错
  selectDirectory: () => call<string | null>('dialog:selectDirectory'),
  openFile: (options?: {
    properties?: (
      | 'openFile'
      | 'openDirectory'
      | 'multiSelections'
      | 'showHiddenFiles'
      | 'createDirectory'
      | 'promptToCreate'
      | 'noResolveAliases'
      | 'treatPackageAsDirectory'
      | 'dontAddToRecent'
    )[]
    filters?: { name: string; extensions: string[] }[]
  }) => call<string | null>('dialog:openFile', options),
  saveFile: (options?: {
    defaultPath?: string
    filters?: { name: string; extensions: string[] }[]
  }) => call<string | null>('dialog:saveFile', options),
  showMessageBox: (options: {
    type?: 'none' | 'info' | 'error' | 'question' | 'warning'
    title?: string
    message: string
    buttons?: string[]
  }) => call<number>('dialog:showMessageBox', options)
}
