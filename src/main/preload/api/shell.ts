// 系统命名空间：对应主进程 handlers/shell-handler.ts 注册的 shell:* 通道
import { call } from '../ipc'

/** electronAPI.shell：系统外壳操作（打开链接 / 目录 / 资源管理器定位） */
export const shellAPI = {
  openExternal: (url: string) => call<{ opened: boolean }>('shell:openExternal', url),
  openPath: (dirPath: string) => call<{ opened: boolean }>('shell:openPath', dirPath),
  // 在资源管理器中打开文件所在位置并选中该文件
  showItemInFolder: (filePath: string) =>
    call<{ opened: boolean }>('shell:showItemInFolder', filePath)
}
