// 导入根命名空间：对应主进程 handlers/import-root-handler.ts 注册的 import:roots 等通道
import { call } from '../ipc'

/** electronAPI.importRoot：指定目录扫描——已登记导入根（import_roots）的管理 */
export const importRootAPI = {
  // 列出全部已登记目录
  list: () => call<string[]>('import:roots'),
  // 移除单个目录；clearRecords=true 时同时软删该目录下的媒体索引记录（进回收站，可恢复）
  // 返回：{ removed: 是否成功移出管理, cleared: 被软删的媒体记录数,
  //         clearFailed: 媒体软删是否失败（区分"无记录"与"软删失败"）, clearErrorMessage: 失败原因 }
  removeRoot: (rootPath: string, clearRecords: boolean) =>
    call<{
      removed: boolean
      cleared: number
      clearFailed: boolean
      clearErrorMessage?: string
    }>('import:removeRoot', rootPath, clearRecords)
}
