// 备份命名空间：对应主进程 handlers/backup.ts 注册的 backup:* 通道
import { call, subscribe } from '../ipc'
import type { BackupListResult, DirOpResult } from '../../../shared/types/electron-api'

/** electronAPI.backup：T01 数据库备份管理 */
export const backupAPI = {
  // P1-04：支持按档案备份（文件名加入 _{uid} 后缀以便识别）
  create: (options?: { accountUid?: string }) =>
    call<{ success: boolean; filePath?: string; message?: string }>('backup:create', options),
  list: () => call<BackupListResult>('backup:list'),
  restore: (filename: string) =>
    call<{ success: boolean; message?: string }>('backup:restore', filename),
  delete: (filename: string) =>
    call<{ success: boolean; message?: string }>('backup:delete', filename),
  // 自定义目录支持
  setDir: (dir: string) => call<DirOpResult>('backup:setDir', dir),
  resetDir: () => call<DirOpResult>('backup:resetDir'),
  getDir: () => call<string>('backup:getDir'),
  // R9：备份恢复后置修复事件——主进程在启动时检测到 restored_at 标志后广播，
  // 渲染进程订阅后显示"已从备份恢复，正在校验数据"提示
  onRestored: (
    callback: (payload: {
      restoredAt: string
      needPhashRecheck: boolean
      needDuplicateRecheck: boolean
    }) => void
  ) => subscribe('backup:restored', callback)
}
