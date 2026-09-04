// 日志命名空间：对应主进程 handlers/log.ts 注册的 log:* 通道
import { call } from '../ipc'
import type {
  DirOpResult,
  LogClearResult,
  LogDirectoryPathResult,
  LogExportZipResult,
  LogFaultDetailResult,
  LogFaultListResult,
  LogStats
} from '../../../shared/types/electron-api'

/** electronAPI.log：日志与故障记录管理 */
export const logAPI = {
  // 获取所有故障列表（按时间倒序）
  listFaults: () => call<LogFaultListResult>('log:listFaults'),
  // 获取单个故障详情
  getFaultDetail: (id: string) => call<LogFaultDetailResult>('log:getFaultDetail', id),
  // 打开日志目录
  openDirectory: () => call<{ opened: boolean }>('log:openDirectory'),
  // 获取日志目录路径
  getDirectoryPath: () => call<LogDirectoryPathResult>('log:getDirectoryPath'),
  // 获取日志统计信息
  getStats: () => call<LogStats>('log:getStats'),
  // 导出全部日志为 zip（主进程会弹出保存对话框）
  exportZip: () => call<LogExportZipResult>('log:exportZip'),
  // 清空所有日志
  clear: () => call<LogClearResult>('log:clear'),
  // 自定义目录支持
  setDir: (dir: string) => call<DirOpResult>('log:setDir', dir),
  resetDir: () => call<DirOpResult>('log:resetDir'),
  getDir: () => call<string>('log:getDir'),
  // P0-2：渲染进程错误上报到主进程 faults 日志
  reportRendererError: (payload: {
    message: string
    stack?: string
    componentStack?: string
    filename?: string
    lineno?: number
    colno?: number
    source: 'ErrorBoundary' | 'window.onerror' | 'unhandledrejection'
  }) => call<{ reported: boolean }>('log:reportRendererError', payload)
}
